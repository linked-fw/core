/**
 * Golden tests for the SPARQL ASK pipeline:
 *   query factory → IR → algebra → SPARQL string
 *
 * `.exists()` normalises the query before dispatching, so these capture the IR
 * that normalisation produces and run it through `askToSparql`. Every fixture
 * here has a `SELECT … LIMIT 1` twin in `sparql-select-golden.test.ts`: the two
 * forms are the same WHERE body, and that is asserted directly below.
 */
import {describe, expect, test} from '@jest/globals';
import {
  existsFactories,
  personClass,
  tmpEntityBase,
  propBase,
} from '../test-helpers/query-fixtures';
import {Shape} from '../shapes/Shape';
import {captureQuery} from '../test-helpers/query-capture-store';
import {askToAlgebra, askToSparql} from '../sparql/irToAlgebra';
import {setQueryContext} from '../queries/QueryContext';
import {Person} from '../test-helpers/query-fixtures';

import '../ontologies/rdf';
import '../ontologies/xsd';

setQueryContext('user', {id: 'user-1'}, Person);

// Shape IRI (property predicates derive from it) and the separate class node it
// declares as targetClass, which is what appears as rdf:type.
const P = 'https://linked.cm/shape/core/Person';
// Property predicates are the declared `sh:path`, not derived from the shape IRI.
const PROP = propBase;
const PT = personClass.id;
const entity = (suffix: string) => ({id: `${tmpEntityBase}${suffix}`});

const goldenAsk = async (factory: () => Promise<unknown>): Promise<string> => {
  const ir = await captureQuery(factory);
  return askToSparql(ir);
};

// ---------------------------------------------------------------------------
// Golden output
// ---------------------------------------------------------------------------

describe('SPARQL golden — ASK', () => {
  test('existsById', async () => {
    const sparql = await goldenAsk(existsFactories.existsById);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
ASK WHERE {
  ?a0 rdf:type <${PT}> .
  FILTER(?a0 = <linked://tmp/entities/p1>)
}`);
  });

  test('existsWhere', async () => {
    const sparql = await goldenAsk(existsFactories.existsWhere);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
ASK WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}name> ?a0_name .
  FILTER(?a0_name = "Semmy")
}`);
  });

  test('no projection, no solution modifiers reach the output', async () => {
    for (const factory of Object.values(existsFactories)) {
      const sparql = await goldenAsk(factory);
      expect(sparql).toContain('ASK WHERE {');
      expect(sparql).not.toContain('SELECT');
      expect(sparql).not.toContain('LIMIT');
      expect(sparql).not.toContain('OFFSET');
      expect(sparql).not.toContain('ORDER BY');
      expect(sparql).not.toContain('DISTINCT');
    }
  });

  test('existsNormalised / existsPaginated collapse onto existsById', async () => {
    const bare = await goldenAsk(existsFactories.existsById);
    expect(await goldenAsk(existsFactories.existsNormalised)).toBe(bare);
    expect(await goldenAsk(existsFactories.existsPaginated)).toBe(bare);
  });
});

// ---------------------------------------------------------------------------
// Shapeless ask — no rdf:type constraint at all
// ---------------------------------------------------------------------------

describe('SPARQL golden — shapeless ASK', () => {
  test('Shape.exists(uri) asks about the node itself, under any type or none', async () => {
    const ir = await captureQuery(() => Shape.exists('https://example.org/thing'));
    expect(askToSparql(ir)).toBe(
`ASK WHERE {
  <https://example.org/thing> ?p ?o .
}`);
  });

  test('no rdf:type triple is emitted, and no shape IRI appears', async () => {
    const ir = await captureQuery(() => Shape.exists('https://example.org/thing'));
    const sparql = askToSparql(ir);
    expect(sparql).not.toContain('rdf:type');
    expect(sparql).not.toContain('linked.cm/shape');
    expect(ir.root).toBeUndefined();
  });

  test('a shaped ask still constrains by rdf:type — the two are different questions', async () => {
    const shapeless = askToSparql(await captureQuery(() => Shape.exists(entity('p1'))));
    const shaped = askToSparql(await captureQuery(() => Person.exists(entity('p1'))));
    expect(shapeless).not.toContain('rdf:type');
    expect(shaped).toContain(`rdf:type <${personClass.id}>`);
  });

  test('a shapeless ask with no subject is rejected — it would match everything', () => {
    expect(() => askToAlgebra({kind: 'ask', patterns: []})).toThrow(/needs a subject/);
  });
});

// ---------------------------------------------------------------------------
// Loud refusals
// ---------------------------------------------------------------------------

describe('ask refusals', () => {
  test('an aggregate in the where clause is refused, not silently unfiltered', async () => {
    // `.size().gt(2)` lowers to HAVING over a per-subject GROUP BY. askToAlgebra
    // keeps only the pattern, so the filter used to vanish and the ASK answered the
    // UNFILTERED question — `true` for any store holding one Person, no matter how
    // many friends anyone has. See backlog 042.
    const ir = await captureQuery(() =>
      Person.select().where((p) => p.friends.size().gt(2)).exists(),
    );
    expect(() => askToAlgebra(ir)).toThrow(/aggregate/i);
    expect(() => askToAlgebra(ir)).toThrow(/HAVING/);
    // Belt and braces: whatever the wording, the filter must not be dropped.
    expect(() => askToSparql(ir)).toThrow();
  });
});
