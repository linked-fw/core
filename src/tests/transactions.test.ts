/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Store transactions (backlog 090): `LinkedStorage.begin()` binds to a store at its first query,
 * every later query carries the txId, `commit()` / `rollback()` end it; the in-memory store holds
 * it for real (snapshot, swap on commit). A store without support warns once and runs the
 * queries directly; a second store gets its own transaction, with a warning.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {linkedPackage} from '../utils/Package';
import {LinkedStorage} from '../utils/LinkedStorage';
import {Transaction, TransactionEndedError} from '../utils/Transaction';
import {InMemoryDataset, InMemoryQueryRefusal} from '../memory/InMemoryDataset';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import type {IDataset} from '../interfaces/IDataset';
import type {DatasetFeature} from '../queries/queryFeatures';
import {fromJSON, type QueryJSON} from '../queries/fromJSON';
import {CreateBuilder} from '../queries/CreateBuilder';
import {SelectBuilder} from '../queries/QueryBuilder';
import {inTransaction, txIdOf} from '../queries/transactionQuery';
import {subscribeQueryDispatch, type QueryDispatchEvent} from '../queries/queryDispatch';
import {WIRE_VERSION} from '../queries/wireVersion';
import {isLinkedError} from '../utils/linkedError';
import '../ontologies/rdf';
import '../ontologies/xsd';

const {linkedShape} = linkedPackage('transactions-test');
const P = 'https://tx.example/';

@linkedShape
class TxConfig extends Shape {
  static targetClass = {id: `${P}Config`};
  @literalProperty({path: {id: `${P}name`}, maxCount: 1})
  get name(): string {
    return '';
  }
  @literalProperty({path: {id: `${P}tag`}})
  get tags(): string[] {
    return [];
  }
}

@linkedShape
class TxApp extends Shape {
  static targetClass = {id: `${P}App`};
  @literalProperty({path: {id: `${P}title`}, maxCount: 1})
  get title(): string {
    return '';
  }
  @objectProperty({path: {id: `${P}config`}, maxCount: 1, shape: TxConfig})
  get config(): TxConfig {
    return null as any;
  }
}

/** A SPARQL store without transaction support: records the updates it is sent. */
class PlainStore extends SparqlDataset {
  updates: string[] = [];
  constructor(readonly id: string) {
    super({dataRoot: 'https://tx.example/data'});
  }
  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

/**
 * A forwarder as `RemoteDataset` is one: every query crosses as DSL-JSON (`toJSON()`, through
 * `JSON.stringify`) and is rehydrated with `fromJSON()` on the far side, where the store answers
 * it. Begin, commit and rollback are forwarded too.
 */
class WireDataset implements IDataset {
  readonly supports: readonly DatasetFeature[] = ['transactions'];
  sent: unknown[] = [];
  constructor(private readonly far: InMemoryDataset) {}
  private cross(query: {toJSON(): unknown}): any {
    const wire = JSON.parse(JSON.stringify(query.toJSON()));
    this.sent.push(wire);
    return fromJSON(wire as QueryJSON);
  }
  selectQuery(q: any) {
    return this.far.selectQuery(this.cross(q));
  }
  askQuery(q: any) {
    return this.far.askQuery(this.cross(q));
  }
  createQuery(q: any) {
    return this.far.createQuery(this.cross(q));
  }
  updateQuery(q: any) {
    return this.far.updateQuery(this.cross(q));
  }
  deleteQuery(q: any) {
    return this.far.deleteQuery(this.cross(q));
  }
  graphQuery(q: any) {
    return this.far.graphQuery(q);
  }
  beginTransaction() {
    return this.far.beginTransaction();
  }
  commit(txId: string) {
    return this.far.commit(txId);
  }
  rollback(txId: string) {
    return this.far.rollback(txId);
  }
}

let store: InMemoryDataset;
let warn: jest.SpiedFunction<typeof console.warn>;

const names = async (target?: IDataset) =>
  ((await TxConfig.select((c) => c.name).exec(target)) as Array<{name: string}>).map((r) => r.name).sort();

beforeEach(() => {
  store = new InMemoryDataset({id: 'mem-a'});
  LinkedStorage.setDefaultDataset(store);
  LinkedStorage.unsetDatasetForShape(TxApp);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe('commit', () => {
  test('binds at the first query, reads its own writes, shows nothing outside until commit', async () => {
    const old = await TxConfig.create({name: 'old'});
    const tx = LinkedStorage.begin();
    expect(store.openTransactions).toBe(0); // nothing is sent yet

    await TxConfig.delete(old.id).exec(tx);
    expect(store.openTransactions).toBe(1);
    const created = await TxConfig.create({name: 'new', tags: ['a', 'b']}).exec(tx);
    await TxConfig.update({tags: ['a', 'b', 'c']}).for(created.id).exec(tx);

    // exec(tx) resolved once the store applied it inside the transaction:
    expect(await names(tx)).toEqual(['new']);
    expect(await TxConfig.select((c) => c.tags).for(created.id).exec(tx)).toEqual({
      id: created.id,
      tags: ['a', 'b', 'c'],
    });
    expect(await TxConfig.select().where((c) => c.name.equals('new')).count(tx)).toBe(1);
    expect(await TxConfig.select().for(created.id).exists(tx)).toBe(true);
    expect(await TxConfig.select().for(old.id).exists(tx)).toBe(false);
    // ...and outside it, nothing has changed.
    expect(await names()).toEqual(['old']);

    await tx.commit();
    expect(tx.state).toBe('committed');
    expect(store.openTransactions).toBe(0);
    expect(await names()).toEqual(['new']);
  });

  test('transaction(fn) commits when fn returns and resolves what fn resolves', async () => {
    const id = await LinkedStorage.transaction(async (tx) => {
      const c = await TxConfig.create({name: 'x'}).exec(tx);
      await TxApp.create({title: 'app', config: {id: c.id}}).exec(tx);
      return c.id;
    });
    expect(await names()).toEqual(['x']);
    expect(await TxApp.select((a) => [a.title, a.config]).exec()).toEqual([
      {id: expect.any(String), title: 'app', config: {id}},
    ]);
  });

  test('a commit refused by the store (written after the transaction began) rolls back', async () => {
    const tx = LinkedStorage.begin();
    await TxConfig.create({name: 'in tx'}).exec(tx);
    await TxConfig.create({name: 'outside'});
    await expect(tx.commit()).rejects.toThrow(/written after it began/);
    expect(tx.state).toBe('rolledBack');
    expect(await names()).toEqual(['outside']);
  });
});

describe('rollback', () => {
  test('rollback() drops every write', async () => {
    const tx = LinkedStorage.begin();
    await TxConfig.create({name: 'a'}).exec(tx);
    await tx.rollback();
    expect(tx.state).toBe('rolledBack');
    expect(store.openTransactions).toBe(0);
    expect(await names()).toEqual([]);
  });

  test('a throw in transaction(fn) rolls back and passes the error on', async () => {
    await expect(
      LinkedStorage.transaction(async (tx) => {
        await TxConfig.create({name: 'a'}).exec(tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(store.openTransactions).toBe(0);
    expect(await names()).toEqual([]);
  });

  test('a failed query fails the transaction: rolled back, error passed on, then ended', async () => {
    const tx = LinkedStorage.begin();
    await TxConfig.create({name: 'a'}).exec(tx);
    // Sorting is outside what the in-memory store answers: refused.
    const refused = TxConfig.select((c) => c.name).orderBy((c) => c.name).exec(tx);
    await expect(refused).rejects.toThrow(/does not answer this query: sorting/);
    expect(tx.state).toBe('rolledBack');
    expect(store.openTransactions).toBe(0);
    expect(await names()).toEqual([]);
    await expect(TxConfig.create({name: 'b'}).exec(tx)).rejects.toThrow(TransactionEndedError);
    await expect(tx.commit()).rejects.toThrow(/rolled back after a failed query/);
    // A catch that rolls back does not hide the error that ended it.
    await expect(tx.rollback()).resolves.toBeUndefined();
  });
});

describe('edges', () => {
  test('transaction(fn) rejects when a query failed and fn went on', async () => {
    const run = LinkedStorage.transaction(async (tx) => {
      await TxConfig.create({name: 'a'}).exec(tx);
      await TxConfig.select((c) => c.name).orderBy((c) => c.name).exec(tx).catch(() => null);
      return 'done';
    });
    await expect(run).rejects.toThrow(/rolled back after a failed query/);
    expect(await names()).toEqual([]);
  });

  test('a transaction that only read commits without a conflict', async () => {
    const reader = LinkedStorage.begin();
    const writer = LinkedStorage.begin();
    await names(reader);
    await TxConfig.create({name: 'w'}).exec(writer);
    await reader.commit();
    await writer.commit();
    expect(await names()).toEqual(['w']);
  });

  test('a second rollback() while one is under way resolves with it', async () => {
    const tx = LinkedStorage.begin();
    await TxConfig.create({name: 'a'}).exec(tx);
    await Promise.all([tx.rollback(), tx.rollback()]);
    expect(tx.state).toBe('rolledBack');
  });

  test('exec(target) of a create or update with a txId is refused by a store without transactions', async () => {
    const plain = new PlainStore('fuseki-like');
    await expect(inTransaction(TxConfig.create({name: 'a'}), 't').exec(plain)).rejects.toThrow(
      /does not declare 'transactions'/,
    );
    await expect(
      inTransaction(TxConfig.update({name: 'a'}).for(`${P}x`), 't').exec(plain),
    ).rejects.toThrow(/does not declare 'transactions'/);
    expect(plain.updates).toHaveLength(0);
  });

  test('fromJSON refuses a txId on a graph query envelope as before (it is not a builder)', () => {
    expect(() => fromJSON({kind: 'graph_drop', graph: 'urn:g', txId: 't'} as any)).toThrow(/graph query/);
  });
});

describe('expiry', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('an abandoned transaction expires in the store after 30 seconds idle and is rolled back', async () => {
    jest.useFakeTimers();
    expect(store.transactionTimeoutMs).toBe(30_000);
    const tx = LinkedStorage.begin();
    await TxConfig.create({name: 'a'}).exec(tx);
    jest.advanceTimersByTime(29_999);
    expect(store.openTransactions).toBe(1);
    jest.advanceTimersByTime(1);
    expect(store.openTransactions).toBe(0);
    await expect(tx.commit()).rejects.toThrow(/unknown or expired/);
    expect(await names()).toEqual([]);
  });

  test('every query restarts the idle timer', async () => {
    jest.useFakeTimers();
    const quick = new InMemoryDataset({id: 'mem-busy', transactionTimeoutMs: 40});
    LinkedStorage.setDefaultDataset(quick);
    const tx = LinkedStorage.begin();
    for (let i = 0; i < 4; i++) {
      await TxConfig.create({name: `n${i}`}).exec(tx);
      jest.advanceTimersByTime(30);
    }
    await tx.commit();
    expect(await names()).toEqual(['n0', 'n1', 'n2', 'n3']);
  });
});

describe('a second store', () => {
  test('gets its own transaction, with a warning that the two are not atomic', async () => {
    const other = new InMemoryDataset({id: 'mem-b'});
    LinkedStorage.setDatasetForShapes(other, TxApp);
    const tx = LinkedStorage.begin();
    await TxConfig.create({name: 'c'}).exec(tx);
    await TxApp.create({title: 't'}).exec(tx);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/reaches mem-b as well as mem-a.*not atomic/);
    expect(store.openTransactions).toBe(1);
    expect(other.openTransactions).toBe(1);

    await tx.commit();
    expect(await names()).toEqual(['c']);
    expect(await TxApp.select((a) => a.title).exec()).toEqual([{id: expect.any(String), title: 't'}]);
  });

  test('a rollback rolls back both', async () => {
    const other = new InMemoryDataset({id: 'mem-b'});
    LinkedStorage.setDatasetForShapes(other, TxApp);
    const tx = LinkedStorage.begin();
    await TxConfig.create({name: 'c'}).exec(tx);
    await TxApp.create({title: 't'}).exec(tx);
    await tx.rollback();
    expect(store.openTransactions + other.openTransactions).toBe(0);
    expect(await names()).toEqual([]);
    expect(await TxApp.select().exec()).toEqual([]);
  });
});

describe('a store without support', () => {
  test('warns once per store, loudly, and runs the writes directly', async () => {
    const plain = new PlainStore('fuseki-like');
    LinkedStorage.setDefaultDataset(plain);
    const tx = LinkedStorage.begin();
    await TxConfig.create({name: 'a'}).exec(tx);
    // Sent at once, without a txId: it has been written already.
    expect(plain.updates).toHaveLength(1);
    expect(plain.updates[0]).not.toMatch(/tx-/);
    await TxConfig.create({name: 'b'}).exec(tx);
    expect(plain.updates).toHaveLength(2);
    await tx.rollback(); // nothing to roll back there
    expect(plain.updates).toHaveLength(2);

    const again = LinkedStorage.begin();
    await TxConfig.create({name: 'c'}).exec(again);
    await again.commit();

    const unsupported = warn.mock.calls.filter((c) => /does not support transactions/.test(String(c[0])));
    expect(unsupported).toHaveLength(1);
    expect(String(unsupported[0][0])).toBe(
      '[linked] store fuseki-like does not support transactions; these writes are not atomic. ' +
        'The queries of a transaction run directly on it, one by one.',
    );

    // Another store without support is warned about once too.
    const plain2 = new PlainStore('fuseki-2');
    LinkedStorage.setDefaultDataset(plain2);
    await LinkedStorage.transaction((t) => TxConfig.create({name: 'd'}).exec(t));
    expect(warn.mock.calls.filter((c) => /does not support transactions/.test(String(c[0])))).toHaveLength(2);
  });

  test('a query carrying a txId is refused by a store that does not declare transactions', async () => {
    const plain = new PlainStore('fuseki-like');
    LinkedStorage.setDefaultDataset(plain);
    const query = inTransaction(TxConfig.create({name: 'a'}), 'some-tx');
    await expect(query.exec()).rejects.toThrow(/runs in transaction "some-tx".*does not declare 'transactions'/);
    await expect(inTransaction(TxConfig.select(), 't').exec(plain)).rejects.toThrow(/does not declare 'transactions'/);
    expect(plain.updates).toHaveLength(0);
  });
});

describe('settled behaviours', () => {
  test('commit twice throws; so does a query on an ended transaction, and rollback after commit', async () => {
    const tx = LinkedStorage.begin();
    await TxConfig.create({name: 'a'}).exec(tx);
    await tx.commit();
    const second = tx.commit();
    await expect(second).rejects.toThrow(TransactionEndedError);
    await expect(second).rejects.toThrow('This transaction was committed; you cannot commit() it.');
    // A select passes its store's error on as its cause.
    const select = await TxConfig.select().exec(tx).catch((err) => err);
    expect((select as {cause?: unknown}).cause).toBeInstanceOf(TransactionEndedError);
    await expect(TxConfig.create({name: 'b'}).exec(tx)).rejects.toThrow(TransactionEndedError);
    await expect(tx.rollback()).rejects.toThrow(TransactionEndedError);
    // Branded, so another copy of core recognises it.
    await tx.commit().catch((err) => expect(isLinkedError(err, TransactionEndedError)).toBe(true));
  });

  test('a commit while another is under way throws', async () => {
    const tx = LinkedStorage.begin();
    await TxConfig.create({name: 'a'}).exec(tx);
    const first = tx.commit();
    await expect(tx.commit()).rejects.toThrow(/is ending/);
    await first;
  });

  test('nested begin() is refused', () => {
    const tx = LinkedStorage.begin();
    expect(() => tx.begin()).toThrow(/Nested transactions are refused/);
    expect(() => tx.transaction()).toThrow(/Nested transactions are refused/);
  });

  test('update().for(id) on a missing node behaves inside a transaction as outside it', async () => {
    const missing = `${P}data/missing`;
    const outside = await TxConfig.update({name: 'n'}).for(missing);
    const tx = LinkedStorage.begin();
    const inside = await TxConfig.update({name: 'n'}).for(missing).exec(tx);
    await tx.commit();
    expect(inside).toEqual(outside);
    expect(inside).toEqual({id: missing, name: 'n'});
    expect(await names()).toEqual([]);
    const noMatch = warn.mock.calls.filter((c) => /matched no node/.test(String(c[0])));
    expect(noMatch).toHaveLength(2);
  });

  test('a graph query or a triples read does not run in a transaction', async () => {
    const tx = LinkedStorage.begin();
    await expect(tx.graphQuery({} as any)).rejects.toThrow(/does not run in a transaction/);
    await expect(tx.triplesQuery({} as any)).rejects.toThrow(/does not run in a transaction/);
  });

  test('queries in flight settle before the commit', async () => {
    const tx = LinkedStorage.begin();
    const writes = [TxConfig.create({name: 'a'}).exec(tx), TxConfig.create({name: 'b'}).exec(tx)];
    await tx.commit();
    await Promise.all(writes);
    expect(await names()).toEqual(['a', 'b']);
    expect(store.openTransactions).toBe(0);
  });
});

describe('on the wire', () => {
  test('the txId travels on DSL-JSON (1.5) and fromJSON() returns the transaction view', () => {
    expect(WIRE_VERSION).toBe('1.5');
    const query = inTransaction(TxConfig.create({name: 'a'}), 'tx-1');
    const json = JSON.parse(JSON.stringify(query.toJSON()));
    expect(json).toMatchObject({v: '1.5', op: 'create', txId: 'tx-1'});
    const back = fromJSON(json);
    expect(txIdOf(back)).toBe('tx-1');
    expect(back.toJSON()).toEqual(json);
    expect(back).toBeInstanceOf(CreateBuilder);
    // The caller's query is not changed.
    expect(txIdOf(TxConfig.create({name: 'a'}))).toBeUndefined();
    expect(() => fromJSON({...json, txId: 7})).toThrow(/"txId" must be a non-empty string/);
    // A builder's own fromJSON would drop it, so it refuses.
    expect(() => CreateBuilder.fromJSON(json)).toThrow(/Decode it with fromJSON\(\)/);
    expect(() => SelectBuilder.fromJSON({...TxConfig.select().toJSON(), txId: 't'})).toThrow(/fromJSON\(\)/);
  });

  test('a transaction round-trips through a forwarder that sends DSL-JSON', async () => {
    const far = new InMemoryDataset({id: 'far'});
    const wire = new WireDataset(far);
    LinkedStorage.setDefaultDataset(wire);
    const tx = LinkedStorage.begin();
    const c = await TxConfig.create({name: 'w'}).exec(tx);
    await TxConfig.update({name: 'w2'}).for(c.id).exec(tx);
    expect(await names(tx)).toEqual(['w2']);
    expect(await TxConfig.select().for(c.id).exists(tx)).toBe(true);
    expect(await names()).toEqual([]);
    await tx.commit();
    expect(await names()).toEqual(['w2']);
    const txIds = wire.sent.map((j) => (j as {txId?: string}).txId);
    expect(txIds.slice(0, 4)).toEqual(Array(4).fill('far#tx-1'));
    expect(txIds.slice(4)).toEqual([undefined]);
  });
});

describe('live queries', () => {
  test('the dispatch listeners hear of a transaction\'s writes at commit, with the store as target', async () => {
    const events: QueryDispatchEvent[] = [];
    const off = subscribeQueryDispatch((e) => events.push(e));
    try {
      const tx = LinkedStorage.begin();
      expect(tx).toBeInstanceOf(Transaction);
      expect(tx.authoritativeChanges).toBe(true);
      await TxConfig.create({name: 'a'}).exec(tx);
      const atStore = () => events.filter((e) => e.kind === 'create' && e.target === store);
      expect(atStore()).toHaveLength(0);
      await tx.commit();
      expect(atStore()).toHaveLength(1);

      const rolled = LinkedStorage.begin();
      await TxConfig.create({name: 'b'}).exec(rolled);
      await rolled.rollback();
      expect(atStore()).toHaveLength(1);
    } finally {
      off();
    }
  });
});

describe('InMemoryDataset outside transactions', () => {
  test('refuses what it does not answer, never a partial answer', async () => {
    const nested = await TxApp.select((a) => a.config.name).exec().catch((err) => err);
    expect((nested as {cause?: unknown}).cause).toBeInstanceOf(InMemoryQueryRefusal);
    await expect(TxConfig.update({name: 'x'}).forAll().exec()).rejects.toThrow(/forAll \/ where/);
  });
});
