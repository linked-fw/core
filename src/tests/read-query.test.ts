/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * `IDataset.readQuery`: one read method, told apart by the query's kind. The result type follows
 * the kind (type probes below, compiled by `npm run typecheck`), the kind is read from
 * `__queryKind` or `kind` and never from the structure, and the features a read needs are
 * checked before it is sent (the ask the one kind answered without its feature, as a select).
 */
import {describe, expect, test} from '@jest/globals';
import {Person} from '../test-helpers/query-fixtures';
import {SelectBuilder} from '../queries/QueryBuilder';
import {Expr} from '../expressions/Expr';
import {AskBuilder} from '../queries/AskBuilder';
import {CreateBuilder} from '../queries/CreateBuilder';
import type {CountQuery} from '../queries/CountQuery';
import type {AskQuery} from '../queries/AskQuery';
import type {SelectQuery} from '../queries/SelectQuery';
import type {SelectResult} from '../queries/IntermediateRepresentation';
import type {IDataset} from '../interfaces/IDataset';
import {
  readFeaturesOf,
  readKindOf,
  readKindOfJSON,
  type ReadQuery,
  type ReadResult,
} from '../queries/readQuery';
import type {Triple, TriplesQuery, TriplesTermsQuery} from '../queries/triplesQuery';
import {parseTriplesTermsQuery} from '../queries/triplesQuery';
import {
  assertReadSupported,
  dispatchRead,
  resolveRead,
  subscribeQueryDispatch,
  type QueryDispatchEvent,
} from '../queries/queryDispatch';
import {ALL_QUERY_FEATURES, parseRequires, type QueryFeature} from '../queries/queryFeatures';
import {WIRE_VERSION} from '../queries/wireVersion';
import {InMemoryDataset} from '../memory/InMemoryDataset';
import {LinkedStorage} from '../utils/LinkedStorage';
import {readQueryOf} from '../test-helpers/read-double';
import {unusedDatasetMethods} from '../test-helpers/test-utils';

// ---------------------------------------------------------------------------
// Type probes: the answer type follows the kind
// ---------------------------------------------------------------------------

/** Compile-time assertion that `T` is exactly `Expected` (invariant, not assignable). */
type Exact<T, Expected> = [T] extends [Expected] ? ([Expected] extends [T] ? true : false) : false;
const exact =
  <Expected>() =>
  <T>(_probe: T & (Exact<T, Expected> extends true ? unknown : never)) => {};

declare const dataset: IDataset;
async function probes(): Promise<void> {
  exact<number>()(await dataset.readQuery(SelectBuilder.from(Person).toCount()));
  exact<number>()(await dataset.readQuery({} as CountQuery));
  exact<boolean>()(await dataset.readQuery({} as AskQuery));
  exact<boolean>()(await dataset.readQuery(AskBuilder.forNode('https://example.org/n')));
  exact<SelectResult>()(await dataset.readQuery({} as SelectQuery));
  exact<SelectResult>()(await dataset.readQuery(SelectBuilder.from(Person)));
  exact<Triple[]>()(await dataset.readQuery({kind: 'triples', subject: 'https://example.org/s'}));
  exact<string[]>()(await dataset.readQuery({kind: 'triples_terms', objects: ['https://example.org/o']}));
  // A count is not a select: the discriminant decides, not the members they share.
  exact<number>()({} as ReadResult<CountQuery>);
  exact<SelectResult>()({} as ReadResult<SelectQuery>);
  exact<Triple[]>()({} as ReadResult<TriplesQuery>);
  exact<string[]>()({} as ReadResult<TriplesTermsQuery>);
  // An unknown read answers any of them.
  exact<number | boolean | SelectResult | Triple[] | string[]>()({} as ReadResult<ReadQuery>);
}
void probes;

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const S = 'https://example.org/data/s';
const O = 'https://example.org/data/o';
const G = 'https://example.org/graph/g';

/** A dataset that records what it is sent and answers per kind. */
function recorder(supports: QueryFeature[], answers: {select?: unknown; ask?: unknown; triples?: unknown; terms?: unknown} = {}) {
  const sent: Array<{kind: string; json?: unknown}> = [];
  const store: IDataset = {
    ...unusedDatasetMethods,
    supports,
    readQuery: readQueryOf({
      select: async (q) => {
        sent.push({kind: readKindOf(q), json: q.toJSON()});
        return answers.select ?? [];
      },
      ask: async () => {
        sent.push({kind: 'ask'});
        return answers.ask ?? true;
      },
      triples: async () => {
        sent.push({kind: 'triples'});
        return answers.triples ?? [];
      },
      terms: async () => {
        sent.push({kind: 'triples_terms'});
        return answers.terms ?? [];
      },
    }),
  };
  return {store, sent};
}

// ---------------------------------------------------------------------------
// readKindOf, readKindOfJSON, readFeaturesOf
// ---------------------------------------------------------------------------

describe('the kind of a read', () => {
  test('live queries by __queryKind, plain data by kind', () => {
    expect(readKindOf(SelectBuilder.from(Person))).toBe('select');
    expect(readKindOf(SelectBuilder.from(Person).toCount())).toBe('count');
    expect(readKindOf(AskBuilder.forNode(S))).toBe('ask');
    expect(readKindOf({kind: 'triples', subject: S})).toBe('triples');
    expect(readKindOf({kind: 'triples_terms', objects: [O]})).toBe('triples_terms');
  });

  test('anything that is not a read is refused: a mutation, a graph query, an object of neither form', () => {
    const create = CreateBuilder.from(Person).set({name: 'A'});
    expect(() => readKindOf(create as unknown as ReadQuery)).toThrow(/a write, not a read/);
    expect(() => readKindOf({kind: 'graph_drop', graph: G} as unknown as ReadQuery)).toThrow(/send it with graphQuery/);
    expect(() => readKindOf({} as ReadQuery)).toThrow(/no read kind/);
    // A select-shaped object without its discriminant is not taken for a select.
    expect(() => readKindOf({shape: Person.shape} as unknown as ReadQuery)).toThrow(/no read kind/);
  });

  test('the wire form: op (absent = select) or kind', () => {
    expect(readKindOfJSON({shape: Person.shape.id})).toBe('select');
    expect(readKindOfJSON({op: 'select', shape: Person.shape.id})).toBe('select');
    expect(readKindOfJSON({op: 'count', shape: Person.shape.id})).toBe('count');
    expect(readKindOfJSON({op: 'ask'})).toBe('ask');
    expect(readKindOfJSON({kind: 'triples', subject: S})).toBe('triples');
    expect(readKindOfJSON({kind: 'triples_terms', objects: [O]})).toBe('triples_terms');
    expect(readKindOfJSON(SelectBuilder.from(Person).toCount().toJSON())).toBe('count');
  });

  test('the wire form refuses writes, graph queries, unknown ops and kinds, and non-objects', () => {
    for (const op of ['create', 'update', 'upsert', 'delete']) {
      expect(() => readKindOfJSON({op})).toThrow(/a write, not a read/);
    }
    expect(() => readKindOfJSON({kind: 'graph_replace', graph: G})).toThrow(/graph query/);
    expect(() => readKindOfJSON({op: 'frobnicate'})).toThrow(/Unknown query op/);
    expect(() => readKindOfJSON({kind: 'quads'})).toThrow(/no read kind/);
    for (const json of [null, 'select', 42, []]) {
      expect(() => readKindOfJSON(json)).toThrow(/must be a JSON object/);
    }
  });

  test('the features a read needs', () => {
    expect(readFeaturesOf(SelectBuilder.from(Person))).toEqual([]);
    const grouped = Person.select((p) => ({hobby: p.hobby, n: Expr.count()})).groupBy('hobby');
    expect(readFeaturesOf(grouped as unknown as ReadQuery)).toEqual(['groupBy']);
    expect(readFeaturesOf(AskBuilder.forNode(S))).toEqual(['ask']);
    expect(readFeaturesOf({kind: 'triples', subject: S})).toEqual(['triples']);
    expect(readFeaturesOf({kind: 'triples', object: O, graphs: [G]})).toEqual(['triples', 'triplesPattern']);
    expect(readFeaturesOf({kind: 'triples_terms', objects: [O]})).toEqual(['triplesTerms', 'triplesPattern']);
  });
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

describe('the read features', () => {
  test('ALL_QUERY_FEATURES lists the read features (not transactions); the wire knows them', () => {
    for (const feature of ['ask', 'triples', 'triplesTerms'] as const) {
      expect(ALL_QUERY_FEATURES).toContain(feature);
    }
    expect(ALL_QUERY_FEATURES).not.toContain('transactions');
    expect(parseRequires(['ask', 'triples', 'triplesTerms'])).toEqual(['ask', 'triples', 'triplesTerms']);
  });

  test('InMemoryDataset answers asks natively, and no triples reads', async () => {
    const memory = new InMemoryDataset();
    expect(memory.supports).toEqual(['shapelessDelete', 'transactions', 'ask']);
    await expect(memory.readQuery({kind: 'triples', subject: S})).rejects.toThrow(/does not answer this query: a triples read/);
  });

  test('a transaction does not claim the triples and terms reads', () => {
    const tx = LinkedStorage.begin();
    expect(tx.supports).toContain('ask');
    expect(tx.supports).not.toContain('triples');
    expect(tx.supports).not.toContain('triplesTerms');
    return tx.rollback();
  });

  test('DSL-JSON 1.10', () => {
    expect(WIRE_VERSION).toBe('1.10');
    expect(parseTriplesTermsQuery({v: '1.9', kind: 'triples_terms', objects: [O]})).toEqual({
      kind: 'triples_terms',
      objects: [O],
    });
  });
});

// ---------------------------------------------------------------------------
// resolveRead: refused before it is sent; the ask fallback; the answer checks
// ---------------------------------------------------------------------------

describe('resolveRead', () => {
  test('a triples read is refused, before it is sent, by a dataset without triples', async () => {
    const {store, sent} = recorder([]);
    await expect(resolveRead(store, {kind: 'triples', subject: S})).rejects.toThrow(/does not declare 'triples'/);
    await expect(resolveRead(store, {kind: 'triples_terms', objects: [O]})).rejects.toThrow(
      /does not declare 'triplesTerms'/,
    );
    const pattern = recorder(['triples', 'triplesTerms']);
    await expect(resolveRead(pattern.store, {kind: 'triples', object: O, graphs: [G]})).rejects.toThrow(/'triplesPattern'/);
    await expect(resolveRead(pattern.store, {kind: 'triples_terms', objects: [O]})).rejects.toThrow(/'triplesPattern'/);
    expect([...sent, ...pattern.sent]).toEqual([]);
    expect(() => assertReadSupported(store, {kind: 'triples', subject: S})).toThrow(/does not declare 'triples'/);
  });

  test('a dataset that declares them is sent them, and its answers are checked', async () => {
    const triple: Triple = {subject: {id: S}, predicate: {id: O}, object: {id: O}};
    const {store} = recorder(['triples', 'triplesTerms', 'triplesPattern'], {triples: [triple], terms: [O, 'https://example.org/other']});
    await expect(resolveRead(store, {kind: 'triples', subject: S})).resolves.toEqual([triple]);
    // Only the list's own terms are kept.
    await expect(resolveRead(store, {kind: 'triples_terms', objects: [O]})).resolves.toEqual([O]);
    const odd = recorder(['triples', 'triplesTerms', 'triplesPattern'], {triples: {}, terms: 'x'});
    await expect(resolveRead(odd.store, {kind: 'triples', subject: S})).rejects.toThrow(/array of triples/);
    await expect(resolveRead(odd.store, {kind: 'triples_terms', objects: [O]})).rejects.toThrow(/array of IRIs/);
  });

  test("an ask goes to a dataset with 'ask'; without it, it is sent as a select LIMIT 1", async () => {
    const ask = Person.select().for({id: S}) as unknown as {exists(target: IDataset): Promise<boolean>};
    const native = recorder(['ask'], {ask: false});
    await expect(ask.exists(native.store)).resolves.toBe(false);
    expect(native.sent).toEqual([{kind: 'ask'}]);
    const fallback = recorder([], {select: [{id: S}]});
    await expect(ask.exists(fallback.store)).resolves.toBe(true);
    expect(fallback.sent).toHaveLength(1);
    expect(fallback.sent[0]).toMatchObject({kind: 'select', json: {subject: S, limit: 1}});
    // A shapeless ask has no select to send.
    await expect(resolveRead(fallback.store, AskBuilder.forNode(S))).rejects.toThrow(/shapeless ask/);
    // A native answer must be a real boolean.
    const odd = recorder(['ask'], {ask: 'yes'});
    await expect(resolveRead(odd.store, AskBuilder.forNode(S))).rejects.toThrow(/must be answered with a boolean/);
  });

  test('a count must be answered with a non-negative integer', async () => {
    const count = SelectBuilder.from(Person).toCount();
    await expect(resolveRead(recorder([], {select: 3}).store, count)).resolves.toBe(3);
    await expect(resolveRead(recorder([], {select: []}).store, count)).rejects.toThrow(/an array of rows/);
  });

  test('dispatchRead(query, target) is observed with the kinds listeners know', async () => {
    const {store} = recorder(['ask', 'triples', 'triplesTerms', 'triplesPattern'], {select: 2});
    const events: QueryDispatchEvent[] = [];
    const off = subscribeQueryDispatch((e) => events.push(e));
    try {
      await dispatchRead(SelectBuilder.from(Person).toCount(), store);
      await dispatchRead(SelectBuilder.from(Person), store);
      await dispatchRead(AskBuilder.forNode(S), store);
      await dispatchRead({kind: 'triples', subject: S}, store);
      await dispatchRead({kind: 'triples_terms', objects: [O]}, store);
    } finally {
      off();
    }
    expect(events.map((e) => [e.kind, e.target === store])).toEqual([
      ['select', true],
      ['select', true],
      ['ask', true],
      ['triples', true],
      ['triplesTerms', true],
    ]);
  });

  test('an explicit target is checked itself, so the refusal names it', async () => {
    class NamedStore {
      readonly supports: QueryFeature[] = [];
      readQuery = readQueryOf({});
    }
    await expect(dispatchRead({kind: 'triples', subject: S}, new NamedStore() as unknown as IDataset)).rejects.toThrow(
      /\(NamedStore\) does not declare 'triples'/,
    );
  });
});
