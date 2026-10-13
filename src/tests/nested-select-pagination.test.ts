/**
 * Tests for nested-select inner LIMIT/OFFSET — CONTAINED, single-parent only
 * (Option A).
 *
 * A nested `select()` on a related collection may carry `.limit()`/`.offset()`/
 * `.orderBy()`. Because a plain SPARQL sub-SELECT is uncorrelated, its LIMIT
 * bounds GLOBALLY — which only equals per-parent windowing when the outer query
 * targets a SINGLE root subject. In that case the subject is inlined into a
 * sub-SELECT that bounds the child collection; otherwise the pipeline throws.
 *
 * Covers:
 *   1. IR → SPARQL golden (always runs)
 *   2. Execution against Fuseki (skip-if-unavailable)
 *   3. Multi-parent rejection
 *   4. Regression: no inner limit lowers to the existing OPTIONAL left-join
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, tmpEntityBase,
  personClass,
  propBase,
} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
import {selectToSparql} from '../sparql/irToAlgebra';
import {mapSparqlSelectResult} from '../sparql/resultMapping';
import {setQueryContext} from '../queries/QueryContext';
import type {IRSelectQuery, ResultRow} from '../queries/IntermediateRepresentation';
import {
  createTestDataset,
  loadTestData,
  executeSparqlQuery,
  clearAllData,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';

import '../ontologies/rdf';
import '../ontologies/xsd';

setQueryContext('user', {id: `${tmpEntityBase}pp1`}, Person);

// ---------------------------------------------------------------------------
// URI shorthands
// ---------------------------------------------------------------------------

const P = 'https://linked.cm/shape/core/Person';
// Property predicates are the declared `sh:path`, not derived from the shape IRI.
const PROP = propBase;
// The separate class node Person declares as targetClass — the only thing that
// appears as an rdf:type. (Temporary IRI in these fixtures.)
const PT = personClass.id;
const ENT = tmpEntityBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const ref = (suffix: string) => ({id: `${ENT}${suffix}`});

// ---------------------------------------------------------------------------
// Test data: ONE parent pp1 with four friends (f1..f4) named A,B,C,D.
// An additional unrelated parent pp2 with two friends (to prove the inner
// window is scoped to pp1 and not global).
// ---------------------------------------------------------------------------

const TEST_DATA = `
<${ENT}pp1> <${RDF_TYPE}> <${PT}> .
<${ENT}pp1> <${PROP}name> "Parent1" .
<${ENT}pp1> <${PROP}hasFriend> <${ENT}f1> .
<${ENT}pp1> <${PROP}hasFriend> <${ENT}f2> .
<${ENT}pp1> <${PROP}hasFriend> <${ENT}f3> .
<${ENT}pp1> <${PROP}hasFriend> <${ENT}f4> .

<${ENT}f1> <${RDF_TYPE}> <${PT}> .
<${ENT}f1> <${PROP}name> "A" .
<${ENT}f2> <${RDF_TYPE}> <${PT}> .
<${ENT}f2> <${PROP}name> "B" .
<${ENT}f3> <${RDF_TYPE}> <${PT}> .
<${ENT}f3> <${PROP}name> "C" .
<${ENT}f4> <${RDF_TYPE}> <${PT}> .
<${ENT}f4> <${PROP}name> "D" .

<${ENT}pp2> <${RDF_TYPE}> <${PT}> .
<${ENT}pp2> <${PROP}name> "Parent2" .
<${ENT}pp2> <${PROP}hasFriend> <${ENT}g1> .
<${ENT}pp2> <${PROP}hasFriend> <${ENT}g2> .

<${ENT}g1> <${RDF_TYPE}> <${PT}> .
<${ENT}g1> <${PROP}name> "G1" .
<${ENT}g2> <${RDF_TYPE}> <${PT}> .
<${ENT}g2> <${PROP}name> "G2" .

<${ENT}lonely> <${RDF_TYPE}> <${PT}> .
<${ENT}lonely> <${PROP}name> "Lonely" .
`.trim();

// ---------------------------------------------------------------------------
// DSL fixtures (single-subject root via .for())
// ---------------------------------------------------------------------------

const nestedLimit = (n: number) =>
  Person.select((p: any) => p.friends.select((f: any) => f.name).limit(n)).for(ref('pp1'));

const nestedOffset = (m: number) =>
  Person.select((p: any) => p.friends.select((f: any) => f.name).offset(m)).for(ref('pp1'));

const nestedLimitOffset = (n: number, m: number) =>
  Person.select((p: any) =>
    p.friends.select((f: any) => f.name).offset(m).limit(n),
  ).for(ref('pp1'));

const nestedOrderDescLimit = (n: number) =>
  Person.select((p: any) =>
    p.friends.select((f: any) => f.name).orderBy('name', 'DESC').limit(n),
  ).for(ref('pp1'));

// Same as nestedOrderDescLimit but using the proxy-callback orderBy form
// (consistent with the rest of the DSL) instead of a property-name string.
const nestedOrderDescLimitProxy = (n: number) =>
  Person.select((p: any) =>
    p.friends.select((f: any) => f.name).orderBy((f: any) => f.name, 'DESC').limit(n),
  ).for(ref('pp1'));

const nestedNoLimit = () =>
  Person.select((p: any) => p.friends.select((f: any) => f.name)).for(ref('pp1'));

const nestedLimitOnLonely = (n: number) =>
  Person.select((p: any) => p.friends.select((f: any) => f.name).limit(n)).for(ref('lonely'));

// Multi-parent (scan) + inner limit → must throw.
const scanNestedLimit = () =>
  Person.select((p: any) => p.friends.select((f: any) => f.name).limit(2));

// ---------------------------------------------------------------------------
// 1. IR → SPARQL golden (always runs)
// ---------------------------------------------------------------------------

describe('nested-select pagination — IR → SPARQL golden', () => {
  test('inner .limit(2) emits a sub-SELECT with LIMIT 2, no outer LIMIT', async () => {
    const ir = (await captureQuery(() => nestedLimit(2))) as IRSelectQuery;
    const sparql = selectToSparql(ir);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    {
      SELECT ?a1 WHERE {
        <${ENT}pp1> <${PROP}hasFriend> ?a1 .
      } ORDER BY ASC(?a1) LIMIT 2
    }
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
  }
  FILTER(?a0 = <${ENT}pp1>)
}`);
    // The inner LIMIT must NOT appear as a top-level LIMIT clause.
    expect(ir.limit).toBeUndefined();
    expect(/\n}\nLIMIT/.test(sparql)).toBe(false);
  });

  test('inner .offset(1) emits a sub-SELECT with OFFSET 1, no outer LIMIT/OFFSET', async () => {
    const ir = (await captureQuery(() => nestedOffset(1))) as IRSelectQuery;
    const sparql = selectToSparql(ir);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    {
      SELECT ?a1 WHERE {
        <${ENT}pp1> <${PROP}hasFriend> ?a1 .
      } ORDER BY ASC(?a1) OFFSET 1
    }
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
  }
  FILTER(?a0 = <${ENT}pp1>)
}`);
    expect(ir.limit).toBeUndefined();
    expect(ir.offset).toBeUndefined();
  });

  test('inner .orderBy(name, DESC).limit(2) orders the window by the child property', async () => {
    const ir = (await captureQuery(() => nestedOrderDescLimit(2))) as IRSelectQuery;
    const sparql = selectToSparql(ir);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    {
      SELECT ?a1 WHERE {
        <${ENT}pp1> <${PROP}hasFriend> ?a1 .
        ?a1 <${PROP}name> ?a1_name .
      } ORDER BY DESC(?a1_name) LIMIT 2
    }
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
  }
  FILTER(?a0 = <${ENT}pp1>)
}`);
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-parent rejection
// ---------------------------------------------------------------------------

describe('nested-select pagination — multi-parent rejection', () => {
  test('scan outer query + inner limit throws (single subject)', async () => {
    const ir = (await captureQuery(scanNestedLimit)) as IRSelectQuery;
    expect(() => selectToSparql(ir)).toThrow(/single subject/i);
  });

  test('subjectIds.length > 1 + inner limit throws', async () => {
    const ir = (await captureQuery(() =>
      Person.select((p: any) => p.friends.select((f: any) => f.name).limit(2)).forAll([
        ref('pp1'),
        ref('pp2'),
      ]),
    )) as IRSelectQuery;
    expect(() => selectToSparql(ir)).toThrow(/single subject/i);
  });

  test('bare .limit() on a traversal (no .select) throws loudly, not a silent no-op', async () => {
    await expect(
      captureQuery(() => Person.select((p: any) => p.friends.limit(2)).for(ref('pp1'))),
    ).rejects.toThrow(/\.select\(\.\.\.\)\.limit/i);
  });

  test('deeper (grandchild) pagination under a single subject throws', async () => {
    // Single root subject, but the inner limit is on friends.friends — the parent
    // collection (friends) is multi-valued, so this is effectively multi-parent.
    const ir = (await captureQuery(() =>
      Person.select((p: any) =>
        p.friends.select((f: any) => f.friends.select((g: any) => g.name).limit(2)),
      ).for(ref('pp1')),
    )) as IRSelectQuery;
    expect(() => selectToSparql(ir)).toThrow(/deeper|grandchild|multi-parent/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Regression — no inner limit lowers to the existing OPTIONAL left-join
// ---------------------------------------------------------------------------

describe('nested-select pagination — regression (no inner limit)', () => {
  test('no inner limit → optional traverse + OPTIONAL property (projection-only left-join)', async () => {
    const ir = (await captureQuery(nestedNoLimit)) as IRSelectQuery;
    const sparql = selectToSparql(ir);
    // Projection-only multi-valued traversal lowers to a nested OPTIONAL so a
    // parent with no friends is preserved (friends: []), not inner-joined away.
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
  }
  FILTER(?a0 = <${ENT}pp1>)
}`);
    // No sub-SELECT emitted when there is no inner pagination.
    expect(sparql.includes('SELECT ?a1 WHERE')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2 + 5. Execution against Fuseki (skip-if-unavailable)
// ---------------------------------------------------------------------------


beforeAll(async () => {
  if (!fusekiLive) return;
  await createTestDataset();
  await clearAllData();
  await loadTestData(TEST_DATA);
}, 30000);

afterAll(async () => {
  if (!fusekiLive) return;
  await clearAllData();
});

const runMapped = async (factory: () => Promise<unknown>) => {
  const ir = (await captureQuery(factory)) as IRSelectQuery;
  const sparql = selectToSparql(ir);
  const results = await executeSparqlQuery(sparql);
  return mapSparqlSelectResult(results, ir);
};

const friendNames = (row: ResultRow): string[] =>
  ((row.friends as ResultRow[]) || []).map((f) => f.name as string).sort();

describeFuseki('nested-select pagination — Fuseki execution', () => {
  test('inner .limit(2) returns exactly 2 friends (the ordered window)', async () => {
    const row = (await runMapped(() => nestedLimit(2))) as ResultRow;
    expect(row).not.toBeNull();
    expect(row.id).toContain('pp1');
    const names = friendNames(row);
    expect(names).toHaveLength(2);
    // Default ascending window over ?a1 (the URI). f1..f4 sort by URI,
    // so the first two are f1,f2 → names A,B.
    expect(names).toEqual(['A', 'B']);
  });

  test('inner .offset(2) slides the window past the first two', async () => {
    const row = (await runMapped(() => nestedOffset(2))) as ResultRow;
    const names = friendNames(row);
    // 4 friends total, offset 2 → last two (f3,f4) → C,D.
    expect(names).toEqual(['C', 'D']);
  });

  test('inner .offset(1).limit(2) returns the middle window', async () => {
    const row = (await runMapped(() => nestedLimitOffset(2, 1))) as ResultRow;
    const names = friendNames(row);
    expect(names).toEqual(['B', 'C']);
  });

  test('inner .orderBy(name, DESC).limit(2) returns the two highest names', async () => {
    const row = (await runMapped(() => nestedOrderDescLimit(2))) as ResultRow;
    const names = friendNames(row);
    expect(names).toEqual(['C', 'D']);
  });

  test('inner .orderBy(f => f.name, DESC).limit(2) — proxy form matches the string form', async () => {
    const row = (await runMapped(() => nestedOrderDescLimitProxy(2))) as ResultRow;
    const names = friendNames(row);
    expect(names).toEqual(['C', 'D']);
  });

  test('inner window is scoped to the single subject (not global)', async () => {
    // pp1 has 4 friends; limit 2 over pp1 must not be diluted by pp2's friends.
    const row = (await runMapped(() => nestedLimit(2))) as ResultRow;
    const names = friendNames(row);
    expect(names.every((n) => ['A', 'B', 'C', 'D'].includes(n))).toBe(true);
  });

  test('empty child set: parent still returned', async () => {
    const row = (await runMapped(() => nestedLimitOnLonely(2))) as ResultRow;
    expect(row).not.toBeNull();
    expect(row.id).toContain('lonely');
    expect(((row.friends as ResultRow[]) || [])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Option B reference — multi-parent per-parent Top-N via a correlated rank
// rewrite. This is RAW SPARQL, NOT produced by the DSL: it documents and proves
// (against Fuseki/Jena) that per-parent windowing IS achievable, so the
// multi-parent case (rejected by Option A's loud error) can be implemented
// later. The contrast: a plain uncorrelated sub-SELECT LIMIT n returns only n
// children TOTAL across all parents (dropping whole parents); the rank rewrite
// below returns the top-n children FOR EACH parent independently.
//
// Rank = number of same-parent friends whose IRI sorts <= this friend's IRI.
// Top-n-per-parent ascending == FILTER(?rank <= n). Order key here is the IRI.
// ---------------------------------------------------------------------------

describeFuseki('nested-select pagination — Option B reference (multi-parent rank rewrite, raw SPARQL)', () => {
  const topNPerParentSparql = (n: number) => `
SELECT ?p ?cname WHERE {
  ?p <${PROP}hasFriend> ?c .
  ?c <${PROP}name> ?cname .
  {
    SELECT ?p ?c (COUNT(?hi) AS ?rank) WHERE {
      ?p <${PROP}hasFriend> ?c .
      ?p <${PROP}hasFriend> ?hi .
      FILTER(STR(?hi) <= STR(?c))
    } GROUP BY ?p ?c
  }
  FILTER(?rank <= ${n})
} ORDER BY ?p ?cname`;

  test('returns the top-2 children FOR EACH parent (both parents present)', async () => {
    const result = await executeSparqlQuery(topNPerParentSparql(2));
    const byParent: Record<string, string[]> = {};
    for (const b of result.results.bindings) {
      const p = b.p.value.replace(ENT, '');
      (byParent[p] ||= []).push(b.cname.value);
    }
    // Naive global sub-SELECT LIMIT 2 would return only pp1's first two and drop
    // pp2 entirely. The rank rewrite gives each parent its own window:
    expect(byParent['pp1']).toEqual(['A', 'B']); // 2 of pp1's 4 friends (lowest IRIs)
    expect(byParent['pp2']).toEqual(['G1', 'G2']); // pp2's 2 friends, NOT dropped
    expect(Object.keys(byParent).sort()).toEqual(['pp1', 'pp2']);
  });
});
