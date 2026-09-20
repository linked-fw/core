/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Golden tests for the root-COUNT pipeline:
 *   builder → IR → algebra → SPARQL string
 *
 * `.count()` normalises the query before dispatching, so these capture the IR that
 * normalisation produces and run it through `countToSparql`. The invariants that
 * matter are asserted directly rather than left implicit in the strings:
 *
 * - the count is `COUNT(DISTINCT ?root)`, not `COUNT(?root)` (rows ≠ subjects);
 * - no `GROUP BY` appears (the root alias is NOT projected as a plain variable);
 * - no `LIMIT`/`OFFSET`/`ORDER BY` survives, for any input builder.
 *
 * `COUNT(` is uppercase because `algebraToString` upper-cases every aggregate
 * name on the way out, in the same voice as the other keywords it emits; the IR
 * itself still carries the plain lowercase `'count'`.
 */
import {describe, expect, test} from '@jest/globals';
import {
  countFactories,
  personClass,
  employeeClass,
  tmpEntityBase,
  propBase,
  Person,
} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
import {countToAlgebra, countToSparql} from '../sparql/irToAlgebra';
import {lower} from '../queries/lower';
import {setQueryContext, UnresolvedContextError} from '../queries/QueryContext';
import type {IRCountQuery} from '../queries/IntermediateRepresentation';

import '../ontologies/rdf';
import '../ontologies/xsd';

setQueryContext('user', {id: 'user-1'}, Person);

const PROP = propBase;
const PT = personClass.id;
const ET = employeeClass.id;
const RDF_PREFIX = 'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>';

const captureCount = async (
  factory: () => Promise<unknown>,
): Promise<IRCountQuery> => (await captureQuery(factory)) as IRCountQuery;

const goldenCount = async (factory: () => Promise<unknown>): Promise<string> =>
  countToSparql(await captureCount(factory));

// ---------------------------------------------------------------------------
// IR
// ---------------------------------------------------------------------------

describe('IR golden — count', () => {
  test('countAll — a shape scan, an alias, and nothing else', async () => {
    const ir = await captureCount(countFactories.countAll);
    expect(ir).toEqual({
      kind: 'count',
      root: {kind: 'shape_scan', shape: Person.shape.id, alias: 'a0'},
      patterns: [],
      alias: 'count',
    });
  });

  test('the IR carries no projection, orderBy, limit or offset — for any input', async () => {
    const forbidden = ['projection', 'orderBy', 'limit', 'offset', 'resultMap', 'singleResult'];
    const offenders: string[] = [];
    for (const [name, factory] of Object.entries(countFactories)) {
      const ir = await captureCount(factory);
      expect(ir.kind).toBe('count');
      // Not "undefined" — absent. IRCountQuery has no such field to carry.
      for (const field of forbidden) {
        if (Object.keys(ir).includes(field)) offenders.push(`${name}.${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('countWhere keeps the filter', async () => {
    const ir = await captureCount(countFactories.countWhere);
    expect(ir.where).toEqual({
      kind: 'binary_expr',
      operator: '=',
      left: {
        kind: 'property_expr',
        sourceAlias: 'a0',
        property: `${Person.shape.id}/name`,
      },
      right: {kind: 'literal_expr', value: 'Semmy'},
    });
  });

  test('countById keeps the subject', async () => {
    const ir = await captureCount(countFactories.countById);
    expect(ir.subjectId).toBe(`${tmpEntityBase}p1`);
  });

  test('countBySubjects keeps every subject', async () => {
    const ir = await captureCount(countFactories.countBySubjects);
    expect(ir.subjectIds).toEqual([`${tmpEntityBase}p1`, `${tmpEntityBase}p2`]);
  });

  test('a resolved context subject lowers to that one node', async () => {
    // The dangerous case is the UNRESOLVED one (see the refusal below): a context
    // that has not landed would otherwise count the whole shape. A resolved one must
    // count exactly its node.
    const ir = await captureCount(countFactories.countByContextSubject);
    expect(ir.subjectId).toBe('user-1');
  });

  test('countMinus keeps the MINUS pattern', async () => {
    const ir = await captureCount(countFactories.countMinus);
    expect(ir.patterns).toEqual([
      {kind: 'minus', pattern: {kind: 'shape_scan', shape: expect.any(String), alias: 'a0'}},
    ]);
  });
});

// ---------------------------------------------------------------------------
// Golden SPARQL
// ---------------------------------------------------------------------------

describe('SPARQL golden — count', () => {
  test('countAll', async () => {
    expect(await goldenCount(countFactories.countAll)).toBe(
`${RDF_PREFIX}
SELECT (COUNT(DISTINCT ?a0) AS ?count)
WHERE {
  ?a0 rdf:type <${PT}> .
}`);
  });

  test('countWhere', async () => {
    expect(await goldenCount(countFactories.countWhere)).toBe(
`${RDF_PREFIX}
SELECT (COUNT(DISTINCT ?a0) AS ?count)
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}name> ?a0_name .
  FILTER(?a0_name = "Semmy")
}`);
  });

  test('countById', async () => {
    expect(await goldenCount(countFactories.countById)).toBe(
`${RDF_PREFIX}
SELECT (COUNT(DISTINCT ?a0) AS ?count)
WHERE {
  ?a0 rdf:type <${PT}> .
  FILTER(?a0 = <${tmpEntityBase}p1>)
}`);
  });

  test('countBySubjects', async () => {
    expect(await goldenCount(countFactories.countBySubjects)).toBe(
`${RDF_PREFIX}
SELECT (COUNT(DISTINCT ?a0) AS ?count)
WHERE {
  VALUES ?a0 { <${tmpEntityBase}p1> <${tmpEntityBase}p2> }
  ?a0 rdf:type <${PT}> .
}`);
  });

  test('countMinus', async () => {
    expect(await goldenCount(countFactories.countMinus)).toBe(
`${RDF_PREFIX}
SELECT (COUNT(DISTINCT ?a0) AS ?count)
WHERE {
  ?a0 rdf:type <${PT}> .
  MINUS {
    ?a0 rdf:type <${ET}> .
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// The invariants — these are the point of the feature
// ---------------------------------------------------------------------------

describe('count invariants', () => {
  /** Every fixture's SPARQL, keyed by fixture name so a failure names the culprit. */
  const allSparql = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const [name, factory] of Object.entries(countFactories)) {
      out[name] = await goldenCount(factory);
    }
    return out;
  };

  const fixturesWhere = (
    all: Record<string, string>,
    predicate: (sparql: string) => boolean,
  ): string[] => Object.entries(all).filter(([, s]) => predicate(s)).map(([n]) => n);

  test('every fixture counts DISTINCT subjects, never rows', async () => {
    const all = await allSparql();
    expect(
      fixturesWhere(all, (s) => !s.includes('(COUNT(DISTINCT ?a0) AS ?count)')),
    ).toEqual([]);
  });

  test('no GROUP BY — the root alias is not projected as a plain variable', async () => {
    // This is the failure mode a select-with-aggregate-projection would have had:
    // `SELECT ?a0 (COUNT(…) AS ?count) … GROUP BY ?a0` is one row per entity, each
    // counting 1.
    const all = await allSparql();
    expect(fixturesWhere(all, (s) => s.includes('GROUP BY'))).toEqual([]);
    expect(
      fixturesWhere(all, (s) => /SELECT\s+\?a0/.test(s.split('\n')[1] ?? '')),
    ).toEqual([]);
  });

  test('no solution modifiers reach the output, for any input builder', async () => {
    const all = await allSparql();
    for (const modifier of [
      'LIMIT',
      'OFFSET',
      'ORDER BY',
      // No `SELECT DISTINCT` — the DISTINCT belongs inside the aggregate.
      'SELECT DISTINCT',
      'HAVING',
    ]) {
      expect(fixturesWhere(all, (s) => s.includes(modifier))).toEqual([]);
    }
  });

  test('a paginated / projected / sorted builder collapses onto the bare one', async () => {
    // Requirement: limit/offset are DROPPED, not honoured and not rejected. The
    // count of a window is the count of the whole match set.
    const bare = await goldenCount(countFactories.countWhere);
    expect(await goldenCount(countFactories.countNormalised)).toBe(bare);
    expect(await goldenCount(countFactories.countPaginated)).toBe(bare);
  });

  test('the plan itself carries no window, group or order', async () => {
    const plan = countToAlgebra(await captureCount(countFactories.countPaginated));
    expect(plan.limit).toBeUndefined();
    expect(plan.offset).toBeUndefined();
    expect(plan.orderBy).toBeUndefined();
    expect(plan.groupBy).toBeUndefined();
    expect(plan.having).toBeUndefined();
    expect(plan.distinct).toBeUndefined();
    expect(plan.projection).toEqual([
      {
        kind: 'aggregate',
        alias: 'count',
        expression: {
          kind: 'aggregate_expr',
          name: 'count',
          distinct: true,
          args: [{kind: 'variable_expr', name: 'a0'}],
        },
      },
    ]);
  });

  test('a multi-valued filter still counts subjects', async () => {
    // `nickNames` has no maxCount, so the join yields one row per nickname. Without
    // DISTINCT this count would be inflated by exactly that factor.
    const sparql = await goldenCount(countFactories.countMultiValuedWhere);
    expect(sparql).toContain('(COUNT(DISTINCT ?a0) AS ?count)');
    expect(sparql).toContain(`?a0 <${PROP}nickName> ?a0_nickNames .`);
  });
});

// ---------------------------------------------------------------------------
// Loud refusals
// ---------------------------------------------------------------------------

describe('count refusals', () => {
  test('an aggregate in the where clause is refused, not silently uncounted', async () => {
    // `.size().gt(2)` lowers to HAVING over a per-subject GROUP BY. countToAlgebra
    // keeps only the pattern, so the filter would vanish and the count would be of
    // the UNFILTERED set — a plausible-looking wrong number.
    const ir = await captureCount(() =>
      Person.select().where((p) => p.friends.size().gt(2)).count(),
    );
    expect(() => countToAlgebra(ir)).toThrow(/aggregate/i);
    expect(() => countToAlgebra(ir)).toThrow(/HAVING/);
  });

  test('lowering a count with no subject is refused', async () => {
    // `.for(null)` answers 0 without querying; a store that lowers the builder
    // anyway must not get a pattern that counts every instance of the shape.
    const builder = Person.select().for(null).toCount();
    expect(() => lower(builder)).toThrow(/no subject/i);
  });

  test('an unresolved context subject is refused at lowering, not counted', async () => {
    // The bug this guards: a `{"@ctx"}` subject that has not resolved would narrow to
    // `subjectId: undefined`, and the emitted query would count EVERY instance of the
    // shape while the caller believes it counted one node. `CountBuilder.exec`
    // short-circuits to 0 before dispatching, but a receiver that rehydrates the
    // envelope and hands the builder straight to a store reaches lowering directly.
    const {CountBuilder} = await import('../queries/CountBuilder');
    const rehydrated = CountBuilder.fromJSON({
      op: 'count',
      shape: Person.shape.id,
      subject: {'@ctx': 'never-set-anywhere'},
    } as never);
    expect(() => lower(rehydrated)).toThrow(UnresolvedContextError);
  });

  test('countToAlgebra refuses a rootless IR', () => {
    expect(() =>
      countToAlgebra({kind: 'count', patterns: [], alias: 'count'} as never),
    ).toThrow(/shape to scan/);
  });

  test('Shape.count() on the base class is refused', async () => {
    const {Shape} = await import('../shapes/Shape');
    await expect(Shape.count()).rejects.toThrow(/base class/);
  });
});
