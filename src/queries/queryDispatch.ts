import type {SelectQuery} from './SelectQuery.js';
import type {CreateQuery} from './CreateQuery.js';
import type {UpdateQuery} from './UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from './DeleteQuery.js';
import type {IDataset} from '../interfaces/IDataset.js';
import type {AskQuery} from './AskQuery.js';
import type {CountQuery} from './CountQuery.js';
import type {GraphQuery, GraphResult} from './IntermediateRepresentation.js';
import {
  triplesQueryFeatures,
  triplesTermsOf,
  type Triple,
  type TriplesQuery,
  type TriplesTermsQuery,
} from './triplesQuery.js';
import {unsupportedGraphQuery} from './graphQuery.js';
import {readKindOf, type ReadQuery, type ReadResult} from './readQuery.js';
import {catalogOf, withShapeCatalog} from '../utils/ShapeClass.js';
import type {QueryFeature} from './queryFeatures.js';
import {inTransaction, txIdOf} from './transactionQuery.js';

/**
 * Abstraction boundary between the DSL layer (Shape) and the storage layer
 * (LinkedStorage / IDataset). Both sides import this module; neither imports
 * the other. (Its own imports are used only inside functions: the shape-catalog
 * helpers, and the select builder, loaded on demand for the ask fallback.)
 *
 * Return types are intentionally `any` — the DSL layer threads precise
 * result types through its own generics; the dispatch is a runtime bridge.
 */
export interface QueryDispatch {
  /**
   * Answer a read: a select, a count, an ask, a triples read or a terms read (see
   * `queries/readQuery.ts`). Callers send it through {@link resolveRead}, which checks the features
   * the read needs against {@link supports} and checks the answer.
   */
  readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>>;
  createQuery<R = any>(query: CreateQuery): Promise<R>;
  updateQuery<R = any>(query: UpdateQuery): Promise<R>;
  deleteQuery(query: DeleteQuery): Promise<DeleteResponse>;
  /**
   * Run a graph query (`IDataset.graphQuery`), a write. Optional here because a dispatch installed
   * by an older copy of core has no such method; {@link resolveGraphQuery} treats a missing one as
   * a dataset without graph support.
   */
  graphQuery?(query: GraphQuery): Promise<GraphResult>;
  /**
   * The query features this dispatch answers (as `IDataset.supports`). A router that checks each
   * routed dataset itself (`LinkedStorage`) lists every feature; absent = the baseline only.
   */
  readonly supports?: readonly QueryFeature[];
}

/** Something a select is sent to: a dataset, a router, or the global dispatch. */
type FeatureTarget = {readonly supports?: readonly QueryFeature[]} | undefined | null;

/** A query that may use features beyond the baseline (a select builder has `requiredFeatures`). */
type FeatureQuery = object & {requiredFeatures?(): readonly QueryFeature[]};

/**
 * Refuse a select whose features `target` does not declare (`IDataset.supports`).
 *
 * The check runs where a query is handed to a store: the select builder's `exec` on its target
 * (or the global dispatch), and `LinkedStorage` on the dataset it routed to. It is the reason a
 * grouped select needs no query kind of its own: a store that does not know grouping is never
 * asked, rather than asked and trusted to notice.
 *
 * A query that runs in a store transaction (it carries a `txId`) needs `'transactions'`: a store
 * that does not hold transactions would run it directly, outside the transaction it belongs to.
 */
export function assertQuerySupported(target: FeatureTarget, query: object): void {
  const txId = txIdOf(query);
  if (txId !== undefined && !(target?.supports ?? []).includes('transactions')) {
    const name = (target as {constructor?: {name?: string}} | null)?.constructor?.name;
    throw new Error(
      `This query runs in transaction "${txId}", and the dataset it was sent ` +
        `to${name && name !== 'Object' ? ` (${name})` : ''} does not declare 'transactions' in ` +
        '`supports`. It is refused rather than run outside its transaction.',
    );
  }
  const {requiredFeatures} = query as FeatureQuery;
  assertFeaturesSupported(target, typeof requiredFeatures === 'function' ? requiredFeatures.call(query) : []);
}

/** Refuse `required` features that `target` does not declare (see {@link assertQuerySupported}). */
function assertFeaturesSupported(target: FeatureTarget, required: readonly QueryFeature[]): void {
  if (required.length === 0) return;
  const supported = new Set(target?.supports ?? []);
  const missing = required.filter((feature) => !supported.has(feature));
  if (missing.length === 0) return;
  const name = (target as {constructor?: {name?: string}} | null)?.constructor?.name;
  throw new Error(
    `This query uses ${missing.map((f) => `'${f}'`).join(', ')}, which the dataset it was sent ` +
    `to${name && name !== 'Object' ? ` (${name})` : ''} does not declare in \`supports\`. ` +
    'It is refused rather than sent: a store that does not know the feature would answer ' +
    'without it (ungrouped rows, no aggregate), and the answer would look real. Send it to a ' +
    'dataset that supports it (SparqlDataset does), or declare `supports` on the dataset once ' +
    'it implements the feature.',
  );
}

/** Something a read is sent to: a dataset, a router, or the global dispatch. */
export type ReadTarget = Pick<IDataset, 'readQuery' | 'supports'>;

/** A target's class name for a message, when it has one. */
function targetName(target: unknown): string {
  const name = (target as {constructor?: {name?: string}} | null | undefined)?.constructor?.name;
  return name && name !== 'Object' ? ` (${name})` : '';
}

/**
 * Refuse a read that `target` cannot answer, before anything is sent: a select, count or ask whose
 * features or transaction it does not declare ({@link assertQuerySupported}; an ask without `ask`
 * is not refused, it is answered as a select), a triples read without `triples`, a terms read
 * without `triplesTerms`, and either without `triplesPattern` when it fixes or lists the predicate
 * or the object. A router that sends one read to several datasets checks each of them before it
 * asks the first.
 */
export function assertReadSupported(target: FeatureTarget, query: ReadQuery): void {
  const kind = readKindOf(query);
  if (kind !== 'triples' && kind !== 'triples_terms') {
    assertQuerySupported(target, query);
    return;
  }
  const supported = new Set(target?.supports ?? []);
  if (kind === 'triples' && !supported.has('triples')) {
    throw new Error(
      `The dataset this triples read was sent to${targetName(target)} does not declare 'triples' ` +
        'in `supports`, so a triples read (a graph, node or predicate read) cannot be answered. ' +
        'SparqlDataset answers it; a router forwards it to the dataset that holds the data.',
    );
  }
  if (kind === 'triples_terms' && !supported.has('triplesTerms')) {
    throw new Error(
      `The dataset this terms read was sent to${targetName(target)} does not declare ` +
        "'triplesTerms' in `supports`, so a terms read (TriplesBuilder.whichExist()) cannot be " +
        'answered. SparqlDataset answers it; a router forwards it to the dataset that holds the data.',
    );
  }
  assertFeaturesSupported(target, triplesQueryFeatures(query as TriplesQuery | TriplesTermsQuery));
}

/**
 * Send a read to `target` — the one entry point for every read in the library: the builders
 * (`exec()`, `.exists()`, `.whichExist()`), `LinkedStorage.readQuery` on each dataset it routes
 * to, and the observing wrapper of the dispatch all come here rather than calling
 * `readQuery` directly, so every store is held to the same contract:
 *
 * - **refused before it is sent** when `target` does not declare what the read needs
 *   ({@link assertReadSupported});
 * - a **select** answers what the store answers;
 * - a **count** must answer a finite, non-negative integer (see {@link CountQuery}): anything else
 *   rejects rather than being coerced, since `0` is a plausible count and an unreachable store
 *   reported as `0` renders an empty table that looks real;
 * - an **ask** goes to a store that declares `ask` and must answer a real boolean (a truthy
 *   non-boolean would read as "exists"). A store without `ask` is sent the ask's pattern as a
 *   select of ids with `LIMIT 1`, `true` when a row comes back; a shapeless ask has no select to
 *   write, so on such a store it is refused;
 * - a **triples read** must answer an array of triples;
 * - a **terms read** must answer an array of IRIs, of which only the list's own are kept (each
 *   once, in the list's order); an empty list answers `[]` without asking.
 *
 * Errors propagate: "could not read" is never an empty answer, `false` or `0`.
 */
export async function resolveRead<Q extends ReadQuery>(
  target: ReadTarget | undefined | null,
  query: Q,
): Promise<ReadResult<Q>> {
  assertReadSupported(target, query);
  const kind = readKindOf(query);
  if (kind === 'ask' && !(target?.supports ?? []).includes('ask')) {
    return existenceBySelect(target, query as AskQuery) as Promise<ReadResult<Q>>;
  }
  if (kind === 'triples_terms' && triplesTermsOf(query as TriplesTermsQuery).length === 0) {
    return [] as string[] as ReadResult<Q>;
  }
  if (typeof target?.readQuery !== 'function') {
    throw new Error(
      `The dataset this ${kind === 'triples_terms' ? 'terms' : kind} read was sent to does not implement ` +
        'IDataset.readQuery(query), so it cannot be answered.',
    );
  }
  const answer: unknown = await target.readQuery(query);
  switch (kind) {
    case 'count':
      return checkCount(answer) as ReadResult<Q>;
    case 'ask':
      if (typeof answer !== 'boolean') {
        throw new Error(
          `An ask must be answered with a boolean; got ${answer === null ? 'null' : typeof answer}. ` +
            'An ask query will not coerce a non-boolean into an answer — a truthy ' +
            'value would silently read as "exists".',
        );
      }
      return answer as ReadResult<Q>;
    case 'triples':
      if (!Array.isArray(answer)) {
        throw new Error(
          `A triples read must be answered with an array of triples; got ${answer === null ? 'null' : typeof answer}.`,
        );
      }
      return answer as ReadResult<Q>;
    case 'triples_terms': {
      if (!Array.isArray(answer)) {
        throw new Error(
          `A terms read must be answered with an array of IRIs; got ${answer === null ? 'null' : typeof answer}.`,
        );
      }
      const found = new Set(answer);
      return triplesTermsOf(query as TriplesTermsQuery).filter((term) => found.has(term)) as ReadResult<Q>;
    }
    default:
      return answer as ReadResult<Q>;
  }
}

/**
 * The answer to a count, checked: a finite, non-negative integer. A store that ran the pattern as a
 * row query answered rows instead; it must branch on the lowered IR's `kind === 'count'` and emit
 * an aggregate (`SELECT (COUNT(DISTINCT ?s) AS ?count)`). There is deliberately no translation of
 * a count into a row query anywhere in this package: that would hide an unbounded read behind a
 * call that looks cheap.
 */
function checkCount(answer: unknown): number {
  if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0) {
    throw new Error(
      `A count query must be answered with a non-negative integer; got ${
        answer === null
          ? 'null'
          : typeof answer === 'number'
            ? String(answer)
            : Array.isArray(answer)
              ? 'an array of rows'
              : typeof answer
      }. It is not coerced — a NaN or a missing value that fell through as 0 would ` +
        'silently read as "no matches". A store that answered with rows ran the ' +
        'pattern as a row query instead of counting it: it must branch on the lowered ' +
        "IR's `kind === 'count'` and emit an aggregate.",
    );
  }
  return answer;
}

/**
 * Answer an ask on a dataset without `ask`: the ask's pattern as a select of ids with `LIMIT 1`.
 * The select builder is imported on demand (it imports this module).
 */
async function existenceBySelect(target: ReadTarget | undefined | null, query: AskQuery): Promise<boolean> {
  if (typeof target?.readQuery !== 'function') {
    throw new Error(
      'The dataset this ask was sent to does not implement IDataset.readQuery(query), so the ask ' +
        'cannot be answered.',
    );
  }
  const {op: _op, nullSubject, txId, ...pattern} = query.toJSON();
  // `.for(null)`: no subject to ask about. AskBuilder.exec answers false before this, but a
  // rehydrated ask can arrive here directly, and without a subject the select would match any
  // instance.
  if (nullSubject) return false;
  if (!pattern.shape) {
    throw new Error(
      "This dataset does not declare 'ask' in `supports`, and a shapeless ask " +
        '("does a node with this IRI exist at all") has no shape to select by. ' +
        'Answer asks on the dataset (and declare it), or ask through a shape.',
    );
  }
  const {SelectBuilder} = await import('./QueryBuilder.js');
  const bare = withShapeCatalog(catalogOf(query), () =>
    SelectBuilder.fromJSON({...pattern, shape: pattern.shape as string, limit: 1}),
  );
  // In a transaction, the select answers inside it, as the ask would have.
  const select = txId === undefined ? bare : inTransaction(bare, txId);
  assertQuerySupported(target, select);
  const answer: unknown = await target.readQuery(select);
  // A select with one subject is a single-result query: a row or null. Otherwise rows.
  if (answer === null || answer === undefined) return false;
  if (Array.isArray(answer)) return answer.length > 0;
  if (typeof answer === 'object') return true;
  throw new Error(
    `Answering an ask with a select LIMIT 1 expected rows, a row or null; got ${typeof answer}.`,
  );
}

/** A target that may answer a graph query. */
type GraphTarget = {graphQuery?(query: GraphQuery): Promise<GraphResult>};

/**
 * Run a graph query against `target` — the entry point every graph static and router goes
 * through. A target without a `graphQuery` function (a dataset class built against an older
 * core, or a dispatch set by one) is treated exactly like a dataset that throws
 * `unsupported-query-kind`, so callers have one refusal to handle.
 */
export async function resolveGraphQuery(
  target: GraphTarget | undefined,
  query: GraphQuery,
): Promise<GraphResult> {
  if (typeof target?.graphQuery !== 'function') {
    throw unsupportedGraphQuery(query, 'it has no graphQuery method');
  }
  return target.graphQuery(query);
}

// Global-backed so it is SHARED across duplicate copies of this module. In dev,
// `@_linked/core` can be evaluated twice (Vite/`src` + Node/`lib` — an accepted
// 2-instance state, see report-011). The module REGISTRY already lives on the
// shared global; the query dispatch must too, or `setDefaultDataset()` on one
// copy is invisible to queries on the other ("No query dispatch configured").
// Whichever copy runs the storage config sets it; every copy reads it.
const dispatchGlobal: any =
  typeof globalThis !== 'undefined' ? globalThis : ({} as any);
if (!('__linkedQueryDispatch' in dispatchGlobal)) {
  dispatchGlobal.__linkedQueryDispatch = {
    current: null as QueryDispatch | null,
    listeners: new Set<QueryDispatchListener>(),
  };
} else if (!dispatchGlobal.__linkedQueryDispatch.listeners) {
  // An older copy of this module created the record before listeners existed.
  dispatchGlobal.__linkedQueryDispatch.listeners = new Set<QueryDispatchListener>();
}

/**
 * One query passing through the dispatch, reported to {@link subscribeQueryDispatch}
 * listeners. `query` is the very builder handed to the store (same identity), and
 * `result` is the store's answer as a promise — not yet settled when the event fires.
 */
export type QueryDispatchEvent = (
  | {kind: 'select'; query: SelectQuery | CountQuery; result: Promise<unknown>}
  | {kind: 'ask'; query: AskQuery; result: Promise<boolean>}
  | {kind: 'create'; query: CreateQuery; result: Promise<unknown>}
  | {kind: 'update'; query: UpdateQuery; result: Promise<unknown>}
  | {kind: 'delete'; query: DeleteQuery; result: Promise<DeleteResponse>}
  | {kind: 'graph'; query: GraphQuery; result: Promise<GraphResult>}
  | {kind: 'triples'; query: TriplesQuery; result: Promise<Triple[]>}
  | {kind: 'triplesTerms'; query: TriplesTermsQuery; result: Promise<string[]>}
) & {
  /** The explicit dataset of an `exec(target)` call; absent for the global dispatch. */
  target?: IDataset;
};

/** Listener notified for every query that runs through the dispatch. */
export type QueryDispatchListener = (event: QueryDispatchEvent) => void;

/**
 * Observe every query that runs through the dispatch. Returns an unsubscribe function.
 *
 * Listeners are notified **synchronously at call time**, as soon as the store has
 * been handed the query, with the result promise attached — so an observer can both
 * see what was asked and await what came back. Listeners never alter the result:
 * the promise the caller receives is the store's own, whatever any listener does
 * with it. A listener that throws is logged (`console.error`) and isolated — it
 * neither rejects the query nor stops later listeners.
 *
 * A write in a store transaction is reported twice: when it runs (`target` is the transaction,
 * which declares `authoritativeChanges`) and when the transaction commits (`target` is the store;
 * see {@link notifyCommittedWrites}). A listener that acts on changed data acts on the second.
 *
 * The listener set lives on `globalThis`, beside `current`, for the same reason the
 * dispatch itself does: core can be evaluated twice in dev, and a subscription made
 * through one copy must see queries dispatched through the other.
 */
export function subscribeQueryDispatch(listener: QueryDispatchListener): () => void {
  const listeners = dispatchGlobal.__linkedQueryDispatch.listeners as Set<QueryDispatchListener>;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyDispatch(event: QueryDispatchEvent): void {
  const listeners = dispatchGlobal.__linkedQueryDispatch.listeners as Set<QueryDispatchListener>;
  // Snapshot so a listener that (un)subscribes during notification can't mutate
  // the set mid-iteration.
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error('[linked] query dispatch listener failed', err);
    }
  }
}

/** A write that ran in a store transaction, as reported when that transaction commits. */
export type CommittedWrite =
  | {kind: 'create'; query: CreateQuery; result: unknown}
  | {kind: 'update'; query: UpdateQuery; result: unknown}
  | {kind: 'delete'; query: DeleteQuery; result: DeleteResponse};

/**
 * Report the writes of a committed transaction to the dispatch listeners, each with the store it
 * was written to as `target`. A transaction's writes are not visible outside it before the
 * commit, so the live-query store (which refetches on a write) hears of them only now: the
 * transaction declares `authoritativeChanges`, and its exec-time events are not acted on.
 * @internal `utils/Transaction.ts` calls it.
 */
export function notifyCommittedWrites(writes: ReadonlyArray<CommittedWrite & {target: IDataset}>): void {
  for (const write of writes) {
    notifyDispatch({...write, result: Promise.resolve(write.result)} as QueryDispatchEvent);
  }
}

/** The event of a read, by its kind: a count is reported as a select, as it always was. */
function readEventOf(query: ReadQuery, result: Promise<unknown>): QueryDispatchEvent {
  switch (readKindOf(query)) {
    case 'ask':
      return {kind: 'ask', query: query as AskQuery, result: result as Promise<boolean>};
    case 'triples':
      return {kind: 'triples', query: query as TriplesQuery, result: result as Promise<Triple[]>};
    case 'triples_terms':
      return {kind: 'triplesTerms', query: query as TriplesTermsQuery, result: result as Promise<string[]>};
    default:
      return {kind: 'select', query: query as SelectQuery | CountQuery, result};
  }
}

/** Marker on a dispatch object that is already wrapped by {@link instrumentDispatch}. */
const INSTRUMENTED = '__instrumented';

/**
 * Wrap a dispatch so every method call is reported to the listeners. Each method
 * forwards to `d`, normalises the return to a promise, notifies, and returns that same
 * promise. Idempotent: an already-instrumented dispatch is returned as is, so re-setting
 * the current dispatch with itself never double-reports.
 */
function instrumentDispatch(d: QueryDispatch, target?: IDataset): QueryDispatch {
  if ((d as any)?.[INSTRUMENTED]) return d;
  // `target` is only set for an explicit `exec(target)`: the wrapper is created
  // per call and the user's dataset object is never marked or mutated.
  const wrapped: QueryDispatch = {
    readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>> {
      const result = resolveRead(d, query);
      notifyDispatch({...readEventOf(query, result), target});
      return result;
    },
    createQuery<R = any>(query: CreateQuery): Promise<R> {
      const result = Promise.resolve(d.createQuery<R>(query));
      notifyDispatch({kind: 'create', query, result, target});
      return result;
    },
    updateQuery<R = any>(query: UpdateQuery): Promise<R> {
      const result = Promise.resolve(d.updateQuery<R>(query));
      notifyDispatch({kind: 'update', query, result, target});
      return result;
    },
    deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
      const result = Promise.resolve(d.deleteQuery(query));
      notifyDispatch({kind: 'delete', query, result, target});
      return result;
    },
    graphQuery(query: GraphQuery): Promise<GraphResult> {
      const result = resolveGraphQuery(d, query);
      notifyDispatch({kind: 'graph', query, result, target});
      return result;
    },
    // The wrapped dispatch answers what it forwards to, no more and no less.
    ...(d.supports ? {supports: d.supports} : {}),
  };
  Object.defineProperty(wrapped, INSTRUMENTED, {value: true, enumerable: false});
  return wrapped;
}

/**
 * Send a graph query through the explicit `target` dataset (observed like the global path), or
 * through the global dispatch. Either way a missing `graphQuery` is refused with
 * `unsupported-query-kind` (see {@link resolveGraphQuery}).
 */
export function dispatchGraphQuery(query: GraphQuery, target?: IDataset): Promise<GraphResult> {
  const dispatch = target
    ? instrumentDispatch(target as unknown as QueryDispatch, target)
    : getQueryDispatch();
  return resolveGraphQuery(dispatch, query);
}

/**
 * Send a read through the explicit `target` dataset (observed like the global path), or through
 * the global dispatch, by {@link resolveRead}. An explicit target is checked itself first, so a
 * refusal names it (the observing wrapper is a plain object).
 */
export async function dispatchRead<Q extends ReadQuery>(query: Q, target?: IDataset): Promise<ReadResult<Q>> {
  if (target) assertReadSupported(target, query);
  const dispatch = target
    ? instrumentDispatch(target as unknown as QueryDispatch, target)
    : getQueryDispatch();
  return resolveRead(dispatch, query);
}

export function setQueryDispatch(d: QueryDispatch): void {
  dispatchGlobal.__linkedQueryDispatch.current = instrumentDispatch(d);
}

export function getQueryDispatch(): QueryDispatch {
  const dispatch = dispatchGlobal.__linkedQueryDispatch.current as QueryDispatch | null;
  if (!dispatch) {
    throw new Error(
      'No query dispatch configured. Call LinkedStorage.setDefaultDataset() first.',
    );
  }
  return dispatch;
}

/**
 * The mutating query kinds. Required on `IDataset`, but a dataset class built against an older
 * core may still lack one, so an explicit target is checked.
 */
export type MutationKind = 'create' | 'update' | 'delete';

/**
 * Pick the object a mutation `exec(target?)` dispatches through: the explicit `target`
 * dataset (validated to implement the op) when a target is given, otherwise the global
 * dispatch. A target that can't perform `kind` (a dataset class built against an older core,
 * when these methods were optional) is a caller error.
 *
 * Throws synchronously if the target lacks the method — callers invoke this from within an
 * `async exec`, so the throw surfaces as a rejected promise rather than a synchronous throw.
 */
export function resolveMutationDispatch(
  kind: MutationKind,
  target?: IDataset,
): QueryDispatch {
  if (!target) return getQueryDispatch();
  if (typeof target[`${kind}Query`] !== 'function') {
    throw new Error(`The target dataset does not support ${kind} queries.`);
  }
  // Instrumented so `builder.exec(target)` is observed like the global path.
  return instrumentDispatch(target as unknown as QueryDispatch, target);
}
