/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The DSL-JSON wire form of a count query, and the dispatch contract behind it.
 *
 * A count travels as its own envelope, discriminated by `op: 'count'` — the same
 * field ask and mutations use. It carries a pattern and nothing else, so there is no
 * `fields`, `limit`, `offset`, `sortBy` or `one` for a receiver to validate or
 * ignore. Unlike an ask, `shape` is required: a shapeless count would count every
 * node in the store.
 *
 * The dispatch half matters as much as the format: a count that reports a broken
 * store as `0` renders an empty table that is indistinguishable from real data, so
 * every failure mode below must *reject*.
 */
import {describe, expect, test, beforeAll} from '@jest/globals';
import {Person, tmpEntityBase} from '../test-helpers/query-fixtures';
import {CountBuilder, isCountQuery} from '../queries/CountBuilder';
import {SelectBuilder} from '../queries/QueryBuilder';
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import {resolveCount} from '../queries/queryDispatch';
import {countToSparql} from '../sparql/irToAlgebra';
import {mapSparqlCountResult} from '../sparql/resultMapping';
import {
  setQueryContext,
  getQueryContext,
  PendingQueryContext,
  UnresolvedContextError,
} from '../queries/QueryContext';
// Imported for its side effect: it installs the global query dispatch that the
// PromiseLike (`await builder`) path below uses.
import '../test-helpers/query-capture-store';
import {WIRE_VERSION} from '../queries/wireVersion';
import type {IRCountQuery} from '../queries/IntermediateRepresentation';
import type {CountQuery} from '../queries/CountQuery';

import '../ontologies/rdf';
import '../ontologies/xsd';

const entity = (s: string) => ({id: `${tmpEntityBase}${s}`});

beforeAll(() => {
  setQueryContext('user', {id: 'user-1'}, Person);
});

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

describe('count envelope — shape', () => {
  test('a count by subject', () => {
    expect(SelectBuilder.from(Person).for(entity('p1')).toCount().toJSON()).toEqual({
      v: WIRE_VERSION,
      op: 'count',
      shape: Person.shape.id,
      subject: entity('p1').id,
    });
  });

  test('a where clause rides along; no answer-shaping fields appear', () => {
    const json = SelectBuilder.from(Person)
      .select((p) => [p.name])
      .where((p) => p.name.equals('Semmy'))
      .orderBy((p) => p.name)
      .limit(20)
      .offset(40)
      .toCount()
      .toJSON();
    expect(json.op).toBe('count');
    expect(json.shape).toBe(Person.shape.id);
    expect(json.where).toBeDefined();
    // The window, the projection and the sort are not merely undefined — the
    // envelope type has no field for them.
    for (const key of ['fields', 'limit', 'offset', 'sortBy', 'one']) {
      expect(Object.keys(json)).not.toContain(key);
    }
  });

  test('a pending context subject travels as a reference, not as a resolved IRI', () => {
    // Narrowing it here would resolve it against THIS process's context map, and the
    // count would travel as a concrete IRI where the equivalent select travels as
    // `{"@ctx": name}` for the receiver to resolve.
    const json = SelectBuilder.from(Person)
      .for(new PendingQueryContext('user'))
      .toCount()
      .toJSON();
    expect(json.subject).toEqual({'@ctx': 'user'});
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('count envelope — round trip', () => {
  test('fromJSON routes `op: count` to a CountBuilder', () => {
    const json = SelectBuilder.from(Person)
      .where((p) => p.name.equals('Semmy'))
      .toCount()
      .toJSON();
    const rehydrated = fromJSON(json);
    expect(rehydrated).toBeInstanceOf(CountBuilder);
    expect(isCountQuery(rehydrated)).toBe(true);
  });

  test('the round trip is IR-identical', () => {
    const original = SelectBuilder.from(Person)
      .where((p) => p.name.equals('Semmy'))
      .minus((p) => p.hobby)
      .toCount();
    const rehydrated = fromJSON(original.toJSON()) as CountBuilder;
    expect(lower(rehydrated)).toEqual(lower(original));
    expect(countToSparql(lower(rehydrated))).toBe(countToSparql(lower(original)));
  });

  test('the round trip is envelope-identical', () => {
    const json = SelectBuilder.from(Person).for(entity('p1')).toCount().toJSON();
    expect((fromJSON(json) as CountBuilder).toJSON()).toEqual(json);
  });

  test('an envelope with no shape is refused', () => {
    expect(() =>
      CountBuilder.fromJSON({v: WIRE_VERSION, op: 'count'} as never),
    ).toThrow(/must name a `shape`/);
  });

  test('an unknown op is still refused, not read as a select', () => {
    expect(() => fromJSON({v: WIRE_VERSION, op: 'tally'} as never)).toThrow(
      /Unknown query op "tally"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Dispatch contract — resolveCount
// ---------------------------------------------------------------------------

describe('resolveCount contract', () => {
  const query = SelectBuilder.from(Person).toCount() as unknown as CountQuery;

  // A count is dispatched over the SELECT channel: it is a select with an aggregate
  // projection, not a query form of its own, so there is no count-specific member to
  // look for and no router that can forget to forward it.
  test('a real count is returned', async () => {
    await expect(resolveCount({selectQuery: async () => 42}, query)).resolves.toBe(42);
  });

  test('0 is a real answer, not an error', async () => {
    await expect(resolveCount({selectQuery: async () => 0}, query)).resolves.toBe(0);
  });

  test('a store with no selectQuery rejects, naming the method', async () => {
    await expect(resolveCount({}, query)).rejects.toThrow(/IDataset\.selectQuery/);
  });

  test('a store that answers with rows rejects, saying it ran a row query', async () => {
    // The failure mode the select channel makes possible: a store that ignored the
    // count and ran the pattern as a select. `[].length` would have been a plausible
    // number; the rows are refused instead.
    await expect(
      resolveCount({selectQuery: async () => [{id: 'a'}, {id: 'b'}]}, query),
    ).rejects.toThrow(/an array of rows/);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '42'],
    ['NaN', NaN],
    ['a float', 1.5],
    ['a negative', -1],
  ])('%s is rejected, never coerced', async (_label, answer) => {
    await expect(
      resolveCount({selectQuery: async () => answer as never}, query),
    ).rejects.toThrow(/non-negative integer/);
  });

  test('a store failure rejects — it is never reported as 0', async () => {
    await expect(
      resolveCount(
        {
          selectQuery: async () => {
            throw new Error('store unreachable');
          },
        },
        query,
      ),
    ).rejects.toThrow('store unreachable');
  });
});

// ---------------------------------------------------------------------------
// exec() — the answers given without querying
// ---------------------------------------------------------------------------

describe('count exec — no subject to count', () => {
  test('.for(null) answers 0 without dispatching', async () => {
    let dispatched = false;
    const target = {
      selectQuery: async () => {
        dispatched = true;
        return 7;
      },
    };
    const answer = await SelectBuilder.from(Person)
      .for(null)
      .toCount()
      .exec(target as never);
    expect(answer).toBe(0);
    expect(dispatched).toBe(false);
  });

  test('an unresolved pending-context subject answers 0 without dispatching', async () => {
    let dispatched = false;
    const target = {
      selectQuery: async () => {
        dispatched = true;
        return 7;
      },
    };
    const answer = await SelectBuilder.from(Person)
      .for(new PendingQueryContext('nobody-set-this'))
      .toCount()
      .exec(target as never);
    expect(answer).toBe(0);
    expect(dispatched).toBe(false);
  });

  test('.count(target) goes through the target dataset', async () => {
    const target = {selectQuery: async () => 11};
    await expect(
      SelectBuilder.from(Person).where((p) => p.name.equals('Semmy')).count(target as never),
    ).resolves.toBe(11);
  });

  test('await on the CountBuilder executes it', async () => {
    // The PromiseLike path uses the global dispatch, which the capture store sets
    // to answer 0.
    await expect(SelectBuilder.from(Person).toCount()).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

describe('mapSparqlCountResult', () => {
  const ir = lower(SelectBuilder.from(Person).toCount()) as IRCountQuery;
  const bindings = (value: string) => ({
    head: {vars: ['count']},
    results: {bindings: [{count: {type: 'literal' as const, value}}]},
  });

  test('reads the bound number', () => {
    expect(mapSparqlCountResult(bindings('17'), ir)).toBe(17);
  });

  test('a genuine zero is returned', () => {
    expect(mapSparqlCountResult(bindings('0'), ir)).toBe(0);
  });

  test('an empty result set throws rather than reading as 0', () => {
    expect(() =>
      mapSparqlCountResult({head: {vars: ['count']}, results: {bindings: []}}, ir),
    ).toThrow(/no binding for \?count/);
  });

  test.each([
    ['a non-numeric binding', 'lots'],
    // `Number('')` is 0 and `Number.isFinite(0)` is true, so a blank lexical form is
    // the one value this function must not invent.
    ['an empty binding', ''],
    ['a whitespace binding', '   '],
    ['a fractional count', '1.5'],
    ['a negative count', '-1'],
  ])('%s throws rather than reading as a number', (_label, value) => {
    expect(() => mapSparqlCountResult(bindings(value), ir)).toThrow(
      /non-negative integer/,
    );
  });

  test('an ASK response throws', () => {
    expect(() => mapSparqlCountResult({head: {}, boolean: true}, ir)).toThrow(
      /SELECT result set/,
    );
  });
});

// ---------------------------------------------------------------------------
// A failure is never a plausible answer
// ---------------------------------------------------------------------------

describe('count never flattens a failure into 0', () => {
  /**
   * A store that lowers what it is given, the way a real one does — so an
   * unresolved context surfaces from lowering rather than from a missing method.
   */
  const loweringStore = {
    selectQuery: async (q: never) => lower(q) as never,
  };

  test('an unresolved context in a WHERE clause rejects — where select answers null', async () => {
    // `exec()` deliberately reports an unresolved context reference as `null`
    // ("not ready"), which a reactive layer re-runs once the context lands. A count
    // must NOT flatten that into 0: 0 renders an empty table and looks like data.
    // This is the same distinction `.exists()` draws for a boolean.
    const builder = SelectBuilder.from(Person).where((p) =>
      (p as any).bestFriend.equals(getQueryContext('nobody-has-set-this') as never),
    );
    await expect(builder.exec(loweringStore as never)).resolves.toBeNull();
    await expect(builder.count(loweringStore as never)).rejects.toThrow(
      UnresolvedContextError,
    );
  });

  test('a lowering failure inside the store rejects', async () => {
    // The store lowers, and lowering throws (a `.for(null)` builder handed straight
    // to a store, off the exec() path). The rejection must reach the caller.
    const builder = SelectBuilder.from(Person).for(null).toCount();
    expect(() => lower(builder)).toThrow(/no subject/i);
    await expect(
      resolveCount(
        {
          selectQuery: async (q) => lower(q as never) as never,
        },
        builder as unknown as CountQuery,
      ),
    ).rejects.toThrow(/no subject/i);
  });
});

// ---------------------------------------------------------------------------
// `exists` and `count` must agree about the match set
// ---------------------------------------------------------------------------

describe('count and exists describe the same match set', () => {
  // Both reduce a select through the same `_patternSpec()`. If those normalisations
  // ever drifted, the same builder could report `count === 0` next to
  // `exists === true`. Comparing the two envelopes pins them together.
  const builders = {
    bare: () => SelectBuilder.from(Person),
    byId: () => SelectBuilder.from(Person).for(entity('p1')),
    filtered: () => SelectBuilder.from(Person).where((p) => p.name.equals('Semmy')),
    minus: () => SelectBuilder.from(Person).minus((p) => p.hobby),
    windowedAndProjected: () =>
      SelectBuilder.from(Person)
        .select((p) => [p.name])
        .orderBy((p) => p.name)
        .limit(5)
        .offset(10),
    nullSubject: () => SelectBuilder.from(Person).for(null),
  };

  test.each(Object.keys(builders))('%s — same pattern in both envelopes', (name) => {
    const builder = builders[name as keyof typeof builders]();
    const {op: countOp, ...countPattern} = builder.toCount().toJSON();
    const {op: askOp, ...askPattern} = (builder as any)._toAsk().toJSON();
    expect(countOp).toBe('count');
    expect(askOp).toBe('ask');
    expect(countPattern).toEqual(askPattern);
  });
});

// ---------------------------------------------------------------------------
// Subjects — plural and context-resolved
// ---------------------------------------------------------------------------

describe('count over explicit subjects', () => {
  test('forAll(ids) rides the envelope and the round trip', () => {
    const builder = SelectBuilder.from(Person).forAll([entity('p1'), entity('p2')]);
    const json = builder.toCount().toJSON();
    expect(json.subjects).toEqual([entity('p1').id, entity('p2').id]);
    expect(json.subject).toBeUndefined();
    const rehydrated = fromJSON(json) as CountBuilder;
    expect(lower(rehydrated)).toEqual(lower(builder.toCount()));
    expect(lower(rehydrated).subjectIds).toEqual([entity('p1').id, entity('p2').id]);
  });

  test('a context already set travels as its concrete subject', () => {
    setQueryContext('countCtx', entity('p1'), Person);
    // `getQueryContext` hands back the real value when the context is set, so there
    // is no reference left to carry.
    const builder = SelectBuilder.from(Person).for(getQueryContext('countCtx'));
    expect(builder.toCount().toJSON().subject).toBe(entity('p1').id);
    expect(lower(builder.toCount()).subjectId).toBe(entity('p1').id);
  });

  test('a context set only at the receiver: reference on the wire, resolved at lowering', () => {
    // The interesting case for a router: the sender has no value, so the envelope
    // carries `{"@ctx"}` and the RECEIVER resolves it against its own map. It must
    // lower to that subject — not to a bare shape scan counting everything.
    const builder = SelectBuilder.from(Person).for(
      new PendingQueryContext('receiver-side-ctx'),
    );
    const json = builder.toCount().toJSON();
    expect(json.subject).toEqual({'@ctx': 'receiver-side-ctx'});
    setQueryContext('receiver-side-ctx', entity('p2'), Person);
    expect(lower(fromJSON(json) as CountBuilder).subjectId).toBe(entity('p2').id);
  });

  test('an unresolved context subject is refused at lowering', () => {
    const rehydrated = CountBuilder.fromJSON({
      op: 'count',
      shape: Person.shape.id,
      subject: {'@ctx': 'still-not-set'},
    } as never);
    // Not 0, and emphatically not a count of every Person.
    expect(() => lower(rehydrated)).toThrow(UnresolvedContextError);
  });
});

// ---------------------------------------------------------------------------
// The public entry points, against a dispatch that cannot count
// ---------------------------------------------------------------------------

describe('a store that cannot count says so, through every entry point', () => {
  // A store that has a select channel but does not recognise a count on it: it runs
  // the pattern as a row query and hands back rows. Every entry point must reject —
  // measuring that array is precisely the unbounded read nothing here will do on a
  // store's behalf.
  const cannotCount = {selectQuery: async () => []};

  test('SelectBuilder.count()', async () => {
    await expect(
      SelectBuilder.from(Person).count(cannotCount as never),
    ).rejects.toThrow(/non-negative integer/);
  });

  test('Shape.count()', async () => {
    await expect(Person.count(cannotCount as never)).rejects.toThrow(
      /non-negative integer/,
    );
  });

  test('await on the builder', async () => {
    await expect(
      SelectBuilder.from(Person).toCount().exec(cannotCount as never),
    ).rejects.toThrow(/non-negative integer/);
  });

  test('and a store with no select channel at all names the method', async () => {
    await expect(Person.count({} as never)).rejects.toThrow(/IDataset\.selectQuery/);
  });
});

// ---------------------------------------------------------------------------
// Serialization refusal
// ---------------------------------------------------------------------------

describe('count serialization', () => {
  test('a shape with no id is refused at toJSON, where the caller can act', () => {
    const builder = CountBuilder.of({shapeClass: {shape: {}} as never});
    expect(() => builder.toJSON()).toThrow(/must name a shape/);
  });
});
