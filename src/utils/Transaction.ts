/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {IDataset} from '../interfaces/IDataset.js';
import type {SelectQuery} from '../queries/SelectQuery.js';
import type {CountQuery} from '../queries/CountQuery.js';
import type {AskQuery} from '../queries/AskQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery.js';
import type {
  CreateResult,
  GraphQuery,
  GraphResult,
  UpdateResult,
} from '../queries/IntermediateRepresentation.js';
import {ALL_QUERY_FEATURES, type QueryFeature} from '../queries/queryFeatures.js';
import {readKindOf, type ReadQuery, type ReadResult} from '../queries/readQuery.js';
import {inTransaction} from '../queries/transactionQuery.js';
import {notifyCommittedWrites, type CommittedWrite} from '../queries/queryDispatch.js';
import {brandLinkedClass, brandLinkedError, isLinkedError} from './linkedError.js';
import {UnresolvedContextError} from '../queries/QueryContext.js';
import {sharedState} from './sharedState.js';

/**
 * A store transaction, as `LinkedStorage.begin()` opens it (backlog 090, report 103).
 *
 * ```ts
 * const tx = LinkedStorage.begin();             // nothing is sent yet
 * await AppConfig.delete(oldId).exec(tx);       // routed to store X: X.beginTransaction() → t1
 * await AppConfig.create(cfg).exec(tx);         // sent at once, with t1
 * const c = await AppConfig.select().exec(tx);  // X answers with t1's own writes
 * await tx.commit();                            // X.commit(t1)
 * ```
 *
 * - **No dataset is named.** The transaction binds to a store when shape routing first sends one
 *   of its queries there, and calls that store's `beginTransaction()`. It holds only
 *   `{store → txId}`; the store holds the transaction itself.
 * - **Every later query** to that store carries the txId (`query.txId`, and `txId` in its
 *   DSL-JSON) and is sent at once. Nothing is buffered here. `exec(tx)` resolves when the store
 *   has applied the write inside the transaction.
 * - **A store without support** (no `'transactions'` in `supports`: `SparqlDataset`, so Fuseki)
 *   is warned about once per store, and the queries run directly. Nothing is emulated.
 * - **A second store** gets its own transaction (or runs directly), with a warning that the
 *   stores together are not atomic. `commit()` commits them one after the other.
 * - **A failed query fails the transaction**: every store it opened is rolled back, the error is
 *   passed on, and the transaction has ended.
 * - **Ended means ended**: a query, a `commit()` after the end, or a `rollback()` after a commit
 *   throws {@link TransactionEndedError}. A `rollback()` of a rolled back transaction is a no-op,
 *   so a `catch` that rolls back never hides the error that ended it.
 * - **No nesting**: `tx.begin()` and `tx.transaction()` throw. Core has no async context, so a
 *   `LinkedStorage.begin()` elsewhere is a transaction of its own; pass `tx` on instead.
 *
 * A transaction is an `IDataset` only so `exec(tx)` accepts it; it is never a dataset to route to.
 */
export type TransactionState = 'open' | 'committed' | 'rolledBack' | 'failed';

/** A transaction was used after it ended (committed, rolled back, or failed). */
export class TransactionEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
brandLinkedError(TransactionEndedError, '@_linked/core', 'TransactionEndedError');

/** What a transaction needs from the router that opened it (`LinkedStorage`). @internal */
export interface TransactionRouter {
  /** The dataset a query of the transaction is routed to; throws when there is none. */
  datasetFor(query: object): IDataset;
  /** Route a select, count or ask (the reads that run in a transaction). */
  readQuery(query: SelectQuery | CountQuery | AskQuery): Promise<unknown>;
  createQuery(query: CreateQuery): Promise<unknown>;
  updateQuery(query: UpdateQuery): Promise<unknown>;
  deleteQuery(query: DeleteQuery): Promise<DeleteResponse>;
}

/** One store the transaction reached: its txId, or undefined when the store runs queries directly. */
type Binding = {dataset: IDataset; txId: Promise<string | undefined>};

/** Stores already warned about (once per store per process, across copies of this module). */
const warned = sharedState('@_linked/core', 'Transaction.warnedUnsupported', () => ({
  stores: new WeakSet<object>(),
}));

/** A dataset's name for a warning: its `id` when it has one, else its class. */
export function datasetName(dataset: IDataset): string {
  const id = (dataset as {id?: unknown}).id;
  if (typeof id === 'string' && id) return id;
  const name = (dataset as {constructor?: {name?: string}}).constructor?.name;
  return name && name !== 'Object' ? name : 'an unnamed dataset';
}

/** Whether a dataset holds transactions: it declares `'transactions'`, and has the three methods. */
export function supportsTransactions(dataset: IDataset): boolean {
  if (!(dataset.supports ?? []).includes('transactions')) return false;
  const missing = (['beginTransaction', 'commit', 'rollback'] as const).filter(
    (method) => typeof dataset[method] !== 'function',
  );
  if (missing.length) {
    throw new Error(
      `The dataset ${datasetName(dataset)} declares 'transactions' in \`supports\` but has no ` +
        `${missing.join(', ')}.`,
    );
  }
  return true;
}

/** The reads that do not run in a transaction: a transaction does not claim them. */
const NOT_IN_A_TRANSACTION = new Set<QueryFeature>(['triples', 'triplesTerms']);

export class Transaction implements IDataset {
  /**
   * Every feature but the triples and terms reads (they do not run in a transaction): the dataset
   * each query is routed to is checked by the router.
   */
  readonly supports: readonly QueryFeature[] = Object.freeze(
    ALL_QUERY_FEATURES.filter((feature) => !NOT_IN_A_TRANSACTION.has(feature)),
  );
  /**
   * The live-query store waits: a write in a transaction is not visible outside it, so it is
   * reported when the transaction commits (or at once, for a store that runs it directly).
   */
  readonly authoritativeChanges = true;

  private _state: TransactionState = 'open';
  /** Set once `commit()` or `rollback()` was called: no query may start after it. */
  private ending = false;
  private failure?: unknown;
  private rollingBack?: Promise<void>;
  private readonly bindings = new Map<IDataset, Binding>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly writes: Array<CommittedWrite & {target: IDataset}> = [];

  /** @internal Opened by `LinkedStorage.begin()`. */
  constructor(private readonly router: TransactionRouter) {}

  /** `'open'`, `'committed'`, `'rolledBack'`, or `'failed'` (a commit that applied in some stores only). */
  get state(): TransactionState {
    return this._state;
  }

  /**
   * The error that ended the transaction: a failed query (it was rolled back then) or a failed
   * commit. Undefined while it is open, and after a commit or a rollback that was asked for.
   */
  get failedWith(): unknown {
    return this.failure;
  }

  // ---------------------------------------------------------------------------
  // The dispatch surface `exec(tx)` calls
  // ---------------------------------------------------------------------------

  /**
   * Run a select, count or ask in the transaction. A triples or terms read is refused: it does not
   * run in a transaction (send it with `exec()` or `exec(dataset)`).
   */
  readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>> {
    let kind: ReturnType<typeof readKindOf>;
    try {
      kind = readKindOf(query);
    } catch (err) {
      return Promise.reject(err);
    }
    if (kind === 'triples') {
      return Promise.reject(
        new Error('A triples read does not run in a transaction: send it with exec() or exec(dataset).'),
      );
    }
    if (kind === 'triples_terms') {
      return Promise.reject(
        new Error('A terms read does not run in a transaction: send it with whichExist() or whichExist(dataset).'),
      );
    }
    return this.run(query as SelectQuery | CountQuery | AskQuery, (q) => this.router.readQuery(q)) as Promise<
      ReadResult<Q>
    >;
  }

  createQuery(query: CreateQuery): Promise<CreateResult> {
    return this.run(query, (q) => this.router.createQuery(q), 'create') as Promise<CreateResult>;
  }

  updateQuery(query: UpdateQuery): Promise<UpdateResult> {
    return this.run(query, (q) => this.router.updateQuery(q), 'update') as Promise<UpdateResult>;
  }

  deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
    return this.run(query, (q) => this.router.deleteQuery(q), 'delete');
  }

  /** Refused: a graph query is one transaction in its store already, and runs outside this one. */
  graphQuery(_query: GraphQuery): Promise<GraphResult> {
    return Promise.reject(
      new Error('A graph query does not run in a transaction: send it with exec() or exec(dataset).'),
    );
  }


  // ---------------------------------------------------------------------------
  // Ending
  // ---------------------------------------------------------------------------

  /**
   * Commit in every store the transaction opened, one after the other, once its queries in flight
   * have settled. Throws {@link TransactionEndedError} when it has ended (or a commit is under
   * way), also when one of its queries failed (the transaction was rolled back then). When a
   * store refuses the commit, the stores not yet committed are rolled back and the error is
   * thrown; the state is `'rolledBack'` when none had committed, else `'failed'`.
   */
  async commit(): Promise<void> {
    this.assertOpen('commit');
    this.ending = true;
    await this.settle();
    if (this.failure !== undefined) throw this.endedError('commit');
    const bound = await this.openedStores();
    let committed = 0;
    try {
      for (const {dataset, txId} of bound) {
        await dataset.commit!(txId);
        committed++;
      }
    } catch (err) {
      // The store that refused is rolled back too (a no-op when it did so itself).
      await this.rollbackStores(bound.slice(committed));
      this._state = committed === 0 ? 'rolledBack' : 'failed';
      this.failure = err;
      // What did commit is visible now: report those writes.
      const done = new Set(bound.slice(0, committed).map((b) => b.dataset));
      notifyCommittedWrites(this.writes.splice(0).filter((w) => done.has(w.target)));
      if (committed > 0) {
        const partial = new Error(
          `The transaction committed in ${bound
            .slice(0, committed)
            .map((b) => datasetName(b.dataset))
            .join(', ')} and failed in ${datasetName(bound[committed].dataset)}: ` +
            `${err instanceof Error ? err.message : String(err)}. The stores together were not atomic.`,
        );
        // `cause` as an own non-enumerable property: this package targets es6.
        Object.defineProperty(partial, 'cause', {value: err, writable: true, configurable: true});
        throw partial;
      }
      throw err;
    }
    this._state = 'committed';
    notifyCommittedWrites(this.writes.splice(0));
  }

  /**
   * Roll back in every store the transaction opened, once its queries in flight have settled.
   * A no-op on a transaction that is rolled back already (a second call while one is under way
   * resolves with it); throws {@link TransactionEndedError} after a commit (or while one is under
   * way).
   */
  rollback(): Promise<void> {
    if (this.rollingBack) return this.rollingBack;
    if (this._state === 'rolledBack') return Promise.resolve();
    try {
      this.assertOpen('rollback');
    } catch (err) {
      return Promise.reject(err);
    }
    this.ending = true;
    this.rollingBack = (async () => {
      await this.settle();
      if (this._state === 'open') {
        this._state = 'rolledBack';
        await this.rollbackStores(await this.openedStores());
      }
      this.writes.length = 0;
    })();
    return this.rollingBack;
  }

  /** Refused: a transaction never opens another. Run the queries in this one (pass `tx` on). */
  begin(): never {
    throw new Error(
      'Nested transactions are refused: this is a transaction already. Run the queries in it ' +
        '(exec(tx)), or commit it before you begin another.',
    );
  }

  /** Refused, as {@link begin}. */
  transaction(): never {
    return this.begin();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private run<R>(
    query: object,
    send: (query: any) => Promise<R>,
    write?: CommittedWrite['kind'],
  ): Promise<R> {
    try {
      this.assertOpen('query');
    } catch (err) {
      return Promise.reject(err);
    }
    let dataset: IDataset;
    try {
      dataset = this.router.datasetFor(query);
    } catch (err) {
      return this.failWith(err);
    }
    const result = (async () => {
      const txId = await this.bind(dataset).txId;
      // The transaction may have failed while this store was being opened. (A commit called
      // meanwhile waits for this query, so only the state counts here.)
      if (this._state !== 'open') throw this.endedError('query');
      const answer = await send(txId === undefined ? query : inTransaction(query as any, txId));
      if (write) {
        const record = {kind: write, query, result: answer, target: dataset} as CommittedWrite & {target: IDataset};
        // A store that ran it directly has applied it: say so now.
        if (txId === undefined) notifyCommittedWrites([record]);
        else this.writes.push(record);
      }
      return answer;
    })();
    const tracked = result.catch((err) =>
      // A select whose where-context has not landed yet answers "not ready" (null): the query did
      // not run, so it does not fail the transaction.
      isLinkedError(err, UnresolvedContextError) ? Promise.reject(err) : this.failWith<R>(err),
    );
    this.pending.add(tracked);
    tracked.then(
      () => this.pending.delete(tracked),
      () => this.pending.delete(tracked),
    );
    return tracked;
  }

  /** The store's binding, opening its transaction (or warning) the first time it is reached. */
  private bind(dataset: IDataset): Binding {
    const existing = this.bindings.get(dataset);
    if (existing) return existing;
    const others = [...this.bindings.keys()];
    let txId: Promise<string | undefined>;
    if (supportsTransactions(dataset)) {
      txId = dataset.beginTransaction!().then((id) => {
        if (typeof id !== 'string' || !id) {
          throw new Error(
            `${datasetName(dataset)}.beginTransaction() must answer a non-empty string; got ${
              id === null ? 'null' : typeof id
            }.`,
          );
        }
        return id;
      });
    } else {
      if (!warned.stores.has(dataset)) {
        warned.stores.add(dataset);
        console.warn(
          `[linked] store ${datasetName(dataset)} does not support transactions; these writes are ` +
            'not atomic. The queries of a transaction run directly on it, one by one.',
        );
      }
      txId = Promise.resolve(undefined);
    }
    if (others.length) {
      console.warn(
        `[linked] This transaction now reaches ${datasetName(dataset)} as well as ` +
          `${others.map(datasetName).join(', ')}: each store has a transaction of its own, and ` +
          'the stores together are not atomic.',
      );
    }
    const binding = {dataset, txId};
    this.bindings.set(dataset, binding);
    return binding;
  }

  /** A failed query (or a refused one) fails the transaction: roll back, end, pass the error on. */
  private async failWith<R>(err: unknown): Promise<R> {
    if (this.failure === undefined && this._state === 'open') {
      this.failure = err;
      this._state = 'rolledBack';
      await this.rollbackStores(await this.openedStores());
      this.writes.length = 0;
    }
    throw err;
  }

  /** The stores this transaction opened a transaction in, with their txIds. */
  private async openedStores(): Promise<Array<{dataset: IDataset; txId: string}>> {
    const opened: Array<{dataset: IDataset; txId: string}> = [];
    for (const {dataset, txId} of this.bindings.values()) {
      try {
        const id = await txId;
        if (id !== undefined) opened.push({dataset, txId: id});
      } catch {
        // beginTransaction failed: there is nothing to commit or roll back there.
      }
    }
    return opened;
  }

  /** Roll back each store; a store that fails to is logged (its transaction expires there). */
  private async rollbackStores(stores: Array<{dataset: IDataset; txId: string}>): Promise<void> {
    for (const {dataset, txId} of stores) {
      try {
        await dataset.rollback!(txId);
      } catch (err) {
        console.error(
          `[linked] rolling back transaction ${txId} in ${datasetName(dataset)} failed; it expires ` +
            'there instead.',
          err,
        );
      }
    }
  }

  /** Wait for the queries in flight. */
  private async settle(): Promise<void> {
    while (this.pending.size) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private assertOpen(action: 'query' | 'commit' | 'rollback'): void {
    if (this._state === 'open' && !this.ending) return;
    throw this.endedError(action);
  }

  private endedError(action: 'query' | 'commit' | 'rollback'): TransactionEndedError {
    const how =
      this._state === 'open'
        ? 'is ending (commit() or rollback() was called)'
        : this._state === 'committed'
          ? 'was committed'
          : this._state === 'failed'
            ? 'failed to commit in every store'
            : this.failure !== undefined
              ? `was rolled back after a failed query (${
                  this.failure instanceof Error ? this.failure.message : String(this.failure)
                })`
              : 'was rolled back';
    const what = action === 'query' ? 'run a query in it' : `${action}() it`;
    return new TransactionEndedError(`This transaction ${how}; you cannot ${what}.`);
  }
}
brandLinkedClass(Transaction, '@_linked/core', 'Transaction');
