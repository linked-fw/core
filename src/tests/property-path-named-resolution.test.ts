/**
 * Named-property structured-path resolution (the fallback resolver fix).
 *
 * Background: in the normal fluent pipeline a complex `sh:path` is inlined into the IR as `pathExpr`
 * during desugaring, so it never reaches the named-property fallback. The fallback
 * (`resolvePropertyPredicateTerm` in src/sparql/irToAlgebra.ts) is hit when an IR pattern carries a
 * `property` (a SHACL property-shape id) but NO inline `pathExpr` — e.g. directly-constructed IR,
 * `context_property_expr`, or mutation / blank-node sites.
 *
 * Before the fix the fallback returned the property's own (shadow) IRI for any structured path, so the
 * query matched nothing. These tests reproduce the fallback condition by capturing real IR and stripping
 * its inline `pathExpr`, then assert the generated SPARQL reconstructs the property path from the
 * property id alone — and (when Fuseki is available) that the path actually matches rows.
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {ShapeSet} from '../collections/ShapeSet';
import {captureQuery} from '../test-helpers/query-capture-store';
import {selectToSparql} from '../sparql/irToAlgebra';
import {setQueryContext} from '../queries/QueryContext';
import {NodeReferenceValue} from '../queries/QueryFactory';
import {
  createTestDataset,
  loadTestData,
  executeSparqlQuery,
  clearAllData,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';

// Ensure prefixes are registered
import '../ontologies/rdf';
import '../ontologies/xsd';
import '../ontologies/rdfs';

// ---------------------------------------------------------------------------
// Property / class references
// ---------------------------------------------------------------------------

const base = 'linked://named-path/';
const prop = (suffix: string): NodeReferenceValue => ({id: `${base}${suffix}`});
const cls = (suffix: string): NodeReferenceValue => ({id: `${base}type/${suffix}`});

const P_member = `${base}member`;
const P_role = `${base}role`;
const P_parent = `${base}parent`;
const P_rel1 = `${base}rel1`;
const P_rel2 = `${base}rel2`;
const P_name = `${base}name`;
const P_label = `${base}label`;

// ---------------------------------------------------------------------------
// Test shapes — each structured path is a NAMED property
// ---------------------------------------------------------------------------

@linkedShape
class NamedLeafShape extends Shape {
  static targetClass = cls('Leaf');

  @literalProperty({path: prop('name'), maxCount: 1})
  get name(): string {
    return '';
  }

  @literalProperty({path: prop('label'), maxCount: 1})
  get label(): string {
    return '';
  }
}

@linkedShape
class OrgShape extends Shape {
  static targetClass = cls('Org');

  // (b) sequence: member / role
  @objectProperty({path: {seq: [{id: P_member}, {id: P_role}]}, shape: NamedLeafShape})
  get memberRoles(): ShapeSet<NamedLeafShape> {
    return null;
  }

  // (d) regression: a simple single-predicate named object property
  @objectProperty({path: prop('member'), shape: NamedLeafShape})
  get members(): ShapeSet<NamedLeafShape> {
    return null;
  }
}

@linkedShape
class ParentShape extends Shape {
  static targetClass = cls('Parent');

  // (a) inverse single-step: ^parent  → the children that point back via `parent`
  @objectProperty({path: {inv: {id: P_parent}}, shape: NamedLeafShape})
  get children(): ShapeSet<NamedLeafShape> {
    return null;
  }
}

@linkedShape
class AnchorShape extends Shape {
  static targetClass = cls('Anchor');

  // (c) sequence + inverse: rel1 / ^rel2
  @objectProperty({path: {seq: [{id: P_rel1}, {inv: {id: P_rel2}}]}, shape: NamedLeafShape})
  get linked(): ShapeSet<NamedLeafShape> {
    return null;
  }
}

// Query pipeline requires a context
setQueryContext('user', {id: 'test-user'}, NamedLeafShape);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-clone the IR and delete every inline `pathExpr` — reproducing the fallback condition
 * (an IR pattern carrying `property` but no `pathExpr`). The resolver must then rebuild the path
 * from the property shape's `sh:path` alone.
 */
function stripPathExpr<T>(ir: T): T {
  const clone = JSON.parse(JSON.stringify(ir));
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if ('pathExpr' in obj) delete obj.pathExpr;
      for (const key of Object.keys(obj)) walk(obj[key]);
    }
  };
  walk(clone);
  return clone;
}

/** Capture IR from a fluent query, strip inline pathExpr, generate SPARQL via the fallback resolver. */
const fallbackSelect = async (factory: () => Promise<unknown>): Promise<string> => {
  const ir = await captureQuery(factory);
  return selectToSparql(stripPathExpr(ir));
};

// ---------------------------------------------------------------------------
// 2.1 — IR → SPARQL round-trip (always runs, no external deps)
// ---------------------------------------------------------------------------

describe('named structured-path resolution → SPARQL (fallback resolver)', () => {
  test('(a) inverse single-step ^p emits ^<p>', async () => {
    const sparql = await fallbackSelect(() => ParentShape.select((p) => p.children.name));
    expect(sparql).toContain(`^<${P_parent}>`);
    // The inverse predicate must not collapse to a forward shadow predicate.
    expect(sparql).not.toMatch(new RegExp(`(?<!\\^)<${P_parent.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}>`));
  });

  test('(b) sequence [a,b] emits <a>/<b>', async () => {
    const sparql = await fallbackSelect(() => OrgShape.select((p) => p.memberRoles.label));
    expect(sparql).toContain(`<${P_member}>/<${P_role}>`);
  });

  test('(c) sequence + inverse [a, ^b] emits <a>/^<b>', async () => {
    const sparql = await fallbackSelect(() => AnchorShape.select((p) => p.linked.name));
    expect(sparql).toContain(`<${P_rel1}>/^<${P_rel2}>`);
  });

  test('(d) regression — simple single-predicate named property emits a plain IRI predicate', async () => {
    const sparql = await fallbackSelect(() => OrgShape.select((p) => p.members.name));
    expect(sparql).toContain(`<${P_member}>`);
    // No property-path operators introduced for a simple path.
    expect(sparql).not.toContain('^<');
    expect(sparql).not.toContain('>/<');
    expect(sparql).not.toContain('>|<');
  });
});

// ---------------------------------------------------------------------------
// 2.1 — execution against Fuseki (skipped gracefully if unavailable)
//
//   org1   -member-> alice ; alice -role-> roleAdmin ; roleAdmin -label-> "Admin"
//   parent1 <-parent- kid1 ; kid1 -name-> "Kiddo"
//   anchor1 -rel1-> mid ; zed1 -rel2-> mid ; zed1 -name-> "Zed"
//   org1   -member-> alice ; alice -name-> "Alice"   (for the simple-property case)
// ---------------------------------------------------------------------------

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const TEST_DATA = `
<${base}org1> <${RDF_TYPE}> <${base}type/Org> .
<${base}org1> <${P_member}> <${base}alice> .
<${base}alice> <${RDF_TYPE}> <${base}type/Leaf> .
<${base}alice> <${P_role}> <${base}roleAdmin> .
<${base}alice> <${P_name}> "Alice" .
<${base}roleAdmin> <${RDF_TYPE}> <${base}type/Leaf> .
<${base}roleAdmin> <${P_label}> "Admin" .

<${base}parent1> <${RDF_TYPE}> <${base}type/Parent> .
<${base}kid1> <${RDF_TYPE}> <${base}type/Leaf> .
<${base}kid1> <${P_parent}> <${base}parent1> .
<${base}kid1> <${P_name}> "Kiddo" .

<${base}anchor1> <${RDF_TYPE}> <${base}type/Anchor> .
<${base}anchor1> <${P_rel1}> <${base}mid> .
<${base}zed1> <${RDF_TYPE}> <${base}type/Leaf> .
<${base}zed1> <${P_rel2}> <${base}mid> .
<${base}zed1> <${P_name}> "Zed" .
`.trim();

/** Collect every literal-binding value across all rows, regardless of variable name. */
function allLiteralValues(result: {results: {bindings: Record<string, {type: string; value: string}>[]}}): string[] {
  const out: string[] = [];
  for (const row of result.results.bindings) {
    for (const cell of Object.values(row)) {
      if (cell.type === 'literal' || cell.type === 'typed-literal') out.push(cell.value);
    }
  }
  return out;
}

describeFuseki('named structured-path resolution — execution (Fuseki)', () => {
  beforeAll(async () => {
    await createTestDataset();
    await clearAllData();
    await loadTestData(TEST_DATA);
  }, 60000);

  afterAll(async () => {
    await clearAllData();
  });

  test('(a) inverse single-step returns the inverse-related rows', async () => {
    const sparql = await fallbackSelect(() => ParentShape.select((p) => p.children.name));
    const values = allLiteralValues(await executeSparqlQuery(sparql));
    expect(values).toContain('Kiddo');
  });

  test('(b) sequence returns the two-hop rows', async () => {
    const sparql = await fallbackSelect(() => OrgShape.select((p) => p.memberRoles.label));
    const values = allLiteralValues(await executeSparqlQuery(sparql));
    expect(values).toContain('Admin');
  });

  test('(c) sequence + inverse returns the combined-path rows', async () => {
    const sparql = await fallbackSelect(() => AnchorShape.select((p) => p.linked.name));
    const values = allLiteralValues(await executeSparqlQuery(sparql));
    expect(values).toContain('Zed');
  });

  test('(d) regression — simple named property returns its rows', async () => {
    const sparql = await fallbackSelect(() => OrgShape.select((p) => p.members.name));
    const values = allLiteralValues(await executeSparqlQuery(sparql));
    expect(values).toContain('Alice');
  });
});
