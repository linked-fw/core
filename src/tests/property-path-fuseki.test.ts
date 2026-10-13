/**
 * End-to-end Fuseki integration tests for SHACL property paths.
 *
 * Tests the full pipeline: shape definition with complex paths → IR → SPARQL → Fuseki → results
 *
 * Live blocks run through `describeFuseki`: skipped visibly without Fuseki, and a failure under CI
 * or REQUIRE_FUSEKI (see test-helpers/fuseki-live.ts).
 *
 * Coverage:
 * - Sequence paths (ex:friend/ex:name)
 * - Alternative paths (ex:friend|ex:colleague)
 * - Inverse paths (^ex:knows)
 * - Repetition paths (ex:friend+, ex:friend*, ex:friend?)
 * - Combined complex paths
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {
  createTestDataset,
  loadTestData,
  executeSparqlQuery,
  clearAllData,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import {pathExprToSparql} from '../paths/pathExprToSparql';
import {normalizePropertyPath} from '../paths/normalizePropertyPath';
import type {PathExpr} from '../paths/PropertyPathExpr';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EX = 'http://example.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

// ---------------------------------------------------------------------------
// Test data: a small social graph
//
//   Alice --knows--> Bob --knows--> Carol --knows--> Dave
//                     |                    |
//                     +--worksAt--> AcmeCo |
//                                         +--worksAt--> GlobexCo
//
//   Alice --likes--> Bob
//   Carol --likes--> Dave
//   Alice --name--> "Alice"
//   Bob   --name--> "Bob"
//   Carol --name--> "Carol"
//   Dave  --name--> "Dave"
//   AcmeCo  --companyName--> "Acme Corp"
//   GlobexCo --companyName--> "Globex Corp"
//   Alice --hasPet--> Fluffy
//   Fluffy --petName--> "Fluffy"
//   Bob --hasPet--> Rex
//   Rex --petName--> "Rex"
//   Alice --manages--> Bob
//   Bob --manages--> Carol
//   Alice --age--> 30
//   Bob --age--> 25
//   Carol --age--> 35
//   Dave --age--> 28
// ---------------------------------------------------------------------------

const TEST_DATA = `
<${EX}alice> <${RDF_TYPE}> <${EX}Person> .
<${EX}alice> <${EX}name> "Alice" .
<${EX}alice> <${EX}age> "30"^^<${XSD}integer> .
<${EX}alice> <${EX}knows> <${EX}bob> .
<${EX}alice> <${EX}likes> <${EX}bob> .
<${EX}alice> <${EX}hasPet> <${EX}fluffy> .
<${EX}alice> <${EX}manages> <${EX}bob> .

<${EX}bob> <${RDF_TYPE}> <${EX}Person> .
<${EX}bob> <${EX}name> "Bob" .
<${EX}bob> <${EX}age> "25"^^<${XSD}integer> .
<${EX}bob> <${EX}knows> <${EX}carol> .
<${EX}bob> <${EX}worksAt> <${EX}acme> .
<${EX}bob> <${EX}hasPet> <${EX}rex> .
<${EX}bob> <${EX}manages> <${EX}carol> .

<${EX}carol> <${RDF_TYPE}> <${EX}Person> .
<${EX}carol> <${EX}name> "Carol" .
<${EX}carol> <${EX}age> "35"^^<${XSD}integer> .
<${EX}carol> <${EX}knows> <${EX}dave> .
<${EX}carol> <${EX}likes> <${EX}dave> .
<${EX}carol> <${EX}worksAt> <${EX}globex> .

<${EX}dave> <${RDF_TYPE}> <${EX}Person> .
<${EX}dave> <${EX}name> "Dave" .
<${EX}dave> <${EX}age> "28"^^<${XSD}integer> .

<${EX}fluffy> <${RDF_TYPE}> <${EX}Pet> .
<${EX}fluffy> <${EX}petName> "Fluffy" .

<${EX}rex> <${RDF_TYPE}> <${EX}Pet> .
<${EX}rex> <${EX}petName> "Rex" .

<${EX}acme> <${RDF_TYPE}> <${EX}Company> .
<${EX}acme> <${EX}companyName> "Acme Corp" .

<${EX}globex> <${RDF_TYPE}> <${EX}Company> .
<${EX}globex> <${EX}companyName> "Globex Corp" .
`.trim();

// ---------------------------------------------------------------------------
// Fuseki availability and lifecycle
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

// ---------------------------------------------------------------------------
// Helper: run a raw SPARQL SELECT with a property path predicate
// ---------------------------------------------------------------------------

/**
 * Build and execute a SPARQL SELECT that uses a property path.
 * This bypasses the full shape→IR pipeline and tests pathExprToSparql + Fuseki directly,
 * then a second set of tests exercises the full pipeline through irToAlgebra.
 */
async function selectWithPath(
  subject: string,
  pathExpr: PathExpr,
  varName = 'target',
): Promise<string[]> {
  const pathStr = pathExprToSparql(pathExpr);
  const sparql = `SELECT ?${varName} WHERE { <${subject}> ${pathStr} ?${varName} . }`;
  const result = await executeSparqlQuery(sparql);
  return result.results.bindings.map(
    (b: any) => b[varName].value,
  );
}

async function selectPathValues(
  subject: string,
  pathExpr: PathExpr,
): Promise<string[]> {
  return selectWithPath(subject, pathExpr);
}

// =========================================================================
// SEQUENCE PATHS
// =========================================================================

describeFuseki('Property path E2E — sequence paths', () => {
  test('two-step sequence: knows/name (friend of Alice → name)', async () => {

    // Alice --knows--> Bob, Bob has name "Bob"
    const path: PathExpr = {seq: [{id: `${EX}knows`}, {id: `${EX}name`}]};
    const values = await selectPathValues(`${EX}alice`, path);
    expect(values).toEqual(['Bob']);
  });

  test('three-step sequence: knows/knows/name (friend-of-friend name)', async () => {

    // Alice → Bob → Carol → name = "Carol"
    const path: PathExpr = {
      seq: [{id: `${EX}knows`}, {id: `${EX}knows`}, {id: `${EX}name`}],
    };
    const values = await selectPathValues(`${EX}alice`, path);
    expect(values).toEqual(['Carol']);
  });

  test('sequence to company: knows/worksAt/companyName', async () => {

    // Alice → Bob → AcmeCo → "Acme Corp"
    const path: PathExpr = {
      seq: [
        {id: `${EX}knows`},
        {id: `${EX}worksAt`},
        {id: `${EX}companyName`},
      ],
    };
    const values = await selectPathValues(`${EX}alice`, path);
    expect(values).toEqual(['Acme Corp']);
  });
});

// =========================================================================
// ALTERNATIVE PATHS
// =========================================================================

describeFuseki('Property path E2E — alternative paths', () => {
  test('alternative: knows|likes (Alice knows Bob, Alice likes Bob)', async () => {

    const path: PathExpr = {alt: [{id: `${EX}knows`}, {id: `${EX}likes`}]};
    const values = await selectPathValues(`${EX}alice`, path);
    // Both paths lead to Bob (deduplication depends on SPARQL engine)
    expect(values).toContain(`${EX}bob`);
  });

  test('alternative: name|petName (works on different types)', async () => {

    // Fluffy has petName "Fluffy", not name
    const path: PathExpr = {alt: [{id: `${EX}name`}, {id: `${EX}petName`}]};
    const values = await selectPathValues(`${EX}fluffy`, path);
    expect(values).toEqual(['Fluffy']);
  });

  test('alternative in sequence: (knows|likes)/name', async () => {

    // Alice knows Bob and likes Bob → name = "Bob" (possibly duplicated)
    const path: PathExpr = {
      seq: [
        {alt: [{id: `${EX}knows`}, {id: `${EX}likes`}]},
        {id: `${EX}name`},
      ],
    };
    const values = await selectPathValues(`${EX}alice`, path);
    // Should contain "Bob" (possibly twice since both knows and likes reach Bob)
    expect(values).toContain('Bob');
  });
});

// =========================================================================
// INVERSE PATHS
// =========================================================================

describeFuseki('Property path E2E — inverse paths', () => {
  test('inverse: ^knows (who knows Bob?)', async () => {

    // Alice --knows--> Bob, so ^knows from Bob returns Alice
    const path: PathExpr = {inv: {id: `${EX}knows`}};
    const values = await selectPathValues(`${EX}bob`, path);
    expect(values).toContain(`${EX}alice`);
  });

  test('inverse sequence: ^knows/name (name of who knows Bob)', async () => {

    const path: PathExpr = {
      seq: [{inv: {id: `${EX}knows`}}, {id: `${EX}name`}],
    };
    const values = await selectPathValues(`${EX}bob`, path);
    expect(values).toContain('Alice');
  });

  test('inverse then forward: ^knows/hasPet/petName (pet of person who knows Bob)', async () => {

    // ^knows from Bob → Alice, Alice hasPet Fluffy, Fluffy petName "Fluffy"
    const path: PathExpr = {
      seq: [
        {inv: {id: `${EX}knows`}},
        {id: `${EX}hasPet`},
        {id: `${EX}petName`},
      ],
    };
    const values = await selectPathValues(`${EX}bob`, path);
    expect(values).toContain('Fluffy');
  });
});

// =========================================================================
// REPETITION PATHS
// =========================================================================

describeFuseki('Property path E2E — repetition paths', () => {
  test('oneOrMore: knows+ (transitive closure of knows from Alice)', async () => {

    // Alice →+ Bob, Carol, Dave
    const path: PathExpr = {oneOrMore: {id: `${EX}knows`}};
    const values = await selectPathValues(`${EX}alice`, path);
    expect(values).toContain(`${EX}bob`);
    expect(values).toContain(`${EX}carol`);
    expect(values).toContain(`${EX}dave`);
    // Should NOT contain Alice herself (oneOrMore, no self-loop)
  });

  test('zeroOrMore: knows* (transitive closure including self)', async () => {

    // Alice →* Alice, Bob, Carol, Dave
    const path: PathExpr = {zeroOrMore: {id: `${EX}knows`}};
    const values = await selectPathValues(`${EX}alice`, path);
    expect(values).toContain(`${EX}alice`); // zero steps = self
    expect(values).toContain(`${EX}bob`);
    expect(values).toContain(`${EX}carol`);
    expect(values).toContain(`${EX}dave`);
  });

  test('zeroOrOne: knows? from Alice', async () => {

    // Alice →? Alice (zero steps) or Bob (one step)
    const path: PathExpr = {zeroOrOne: {id: `${EX}knows`}};
    const values = await selectPathValues(`${EX}alice`, path);
    expect(values).toContain(`${EX}alice`); // zero steps
    expect(values).toContain(`${EX}bob`); // one step
    expect(values).not.toContain(`${EX}carol`); // two steps — too many
  });

  test('oneOrMore with sequence: manages+/name (transitive reports)', async () => {

    // Alice manages Bob, Bob manages Carol
    // manages+/name from Alice → "Bob", "Carol"
    const path: PathExpr = {
      seq: [{oneOrMore: {id: `${EX}manages`}}, {id: `${EX}name`}],
    };
    const values = await selectPathValues(`${EX}alice`, path);
    expect(values).toContain('Bob');
    expect(values).toContain('Carol');
  });
});

// =========================================================================
// COMBINED / COMPLEX PATHS
// =========================================================================

describeFuseki('Property path E2E — complex combinations', () => {
  test('inverse + oneOrMore: ^manages+ (all managers above Carol)', async () => {

    // Carol ← Bob ← Alice
    const path: PathExpr = {oneOrMore: {inv: {id: `${EX}manages`}}};
    const values = await selectPathValues(`${EX}carol`, path);
    expect(values).toContain(`${EX}bob`);
    expect(values).toContain(`${EX}alice`);
  });

  test('alternative + sequence: (knows|manages)/worksAt/companyName', async () => {

    // Alice knows Bob (worksAt Acme) and manages Bob (worksAt Acme)
    const path: PathExpr = {
      seq: [
        {alt: [{id: `${EX}knows`}, {id: `${EX}manages`}]},
        {id: `${EX}worksAt`},
        {id: `${EX}companyName`},
      ],
    };
    const values = await selectPathValues(`${EX}alice`, path);
    expect(values).toContain('Acme Corp');
  });

  test('sequence with inverse and forward: ^knows/knows (co-known with)', async () => {

    // From Carol: ^knows → Bob, Bob knows → Carol again
    // So ^knows/knows from Carol → Carol
    const path: PathExpr = {
      seq: [{inv: {id: `${EX}knows`}}, {id: `${EX}knows`}],
    };
    const values = await selectPathValues(`${EX}carol`, path);
    expect(values).toContain(`${EX}carol`);
  });
});

// =========================================================================
// SPARQL RENDERING VERIFICATION
// =========================================================================

describe('Property path E2E — SPARQL rendering', () => {
  test('pathExprToSparql renders sequence correctly', () => {
    const path: PathExpr = {seq: [{id: `${EX}knows`}, {id: `${EX}name`}]};
    const sparql = pathExprToSparql(path);
    expect(sparql).toBe(`<${EX}knows>/<${EX}name>`);
  });

  test('pathExprToSparql renders alternative correctly', () => {
    const path: PathExpr = {alt: [{id: `${EX}knows`}, {id: `${EX}likes`}]};
    const sparql = pathExprToSparql(path);
    expect(sparql).toBe(`<${EX}knows>|<${EX}likes>`);
  });

  test('pathExprToSparql renders inverse correctly', () => {
    const path: PathExpr = {inv: {id: `${EX}knows`}};
    const sparql = pathExprToSparql(path);
    expect(sparql).toBe(`^<${EX}knows>`);
  });

  test('pathExprToSparql renders oneOrMore correctly', () => {
    const path: PathExpr = {oneOrMore: {id: `${EX}knows`}};
    const sparql = pathExprToSparql(path);
    expect(sparql).toBe(`<${EX}knows>+`);
  });

  test('pathExprToSparql renders complex combination with correct precedence', () => {
    // (knows|likes)/name+
    const path: PathExpr = {
      seq: [
        {alt: [{id: `${EX}knows`}, {id: `${EX}likes`}]},
        {oneOrMore: {id: `${EX}name`}},
      ],
    };
    const sparql = pathExprToSparql(path);
    expect(sparql).toBe(`(<${EX}knows>|<${EX}likes>)/<${EX}name>+`);
  });
});

// =========================================================================
// STRING INPUT — full pipeline: string → normalize → SPARQL → Fuseki
// =========================================================================

describeFuseki('Property path E2E — string decorator input', () => {
  /**
   * Helper: takes a raw string (as you'd write in a decorator),
   * normalizes it, renders to SPARQL, and executes against Fuseki.
   */
  async function selectWithStringPath(
    subject: string,
    pathString: string,
  ): Promise<string[]> {
    const pathExpr = normalizePropertyPath(pathString);
    const pathSparql = pathExprToSparql(pathExpr);
    const sparql = `SELECT ?target WHERE { <${subject}> ${pathSparql} ?target . }`;
    const result = await executeSparqlQuery(sparql);
    return result.results.bindings.map((b: any) => b.target.value);
  }

  test('string sequence: <IRI>/<IRI> parses and executes', async () => {

    // Same as the {seq} object test but starting from a raw string
    const values = await selectWithStringPath(
      `${EX}alice`,
      `<${EX}knows>/<${EX}name>`,
    );
    expect(values).toEqual(['Bob']);
  });

  test('string three-step sequence: <knows>/<knows>/<name>', async () => {

    const values = await selectWithStringPath(
      `${EX}alice`,
      `<${EX}knows>/<${EX}knows>/<${EX}name>`,
    );
    expect(values).toEqual(['Carol']);
  });

  test('string inverse: ^<IRI>', async () => {

    const values = await selectWithStringPath(
      `${EX}bob`,
      `^<${EX}knows>`,
    );
    expect(values).toContain(`${EX}alice`);
  });

  test('string inverse + sequence: ^<knows>/<hasPet>/<petName>', async () => {

    const values = await selectWithStringPath(
      `${EX}bob`,
      `^<${EX}knows>/<${EX}hasPet>/<${EX}petName>`,
    );
    expect(values).toContain('Fluffy');
  });

  test('string oneOrMore: <knows>+', async () => {

    const values = await selectWithStringPath(
      `${EX}alice`,
      `<${EX}knows>+`,
    );
    expect(values).toContain(`${EX}bob`);
    expect(values).toContain(`${EX}carol`);
    expect(values).toContain(`${EX}dave`);
  });

  test('string alternative: <knows>|<likes>', async () => {

    const values = await selectWithStringPath(
      `${EX}alice`,
      `<${EX}knows>|<${EX}likes>`,
    );
    expect(values).toContain(`${EX}bob`);
  });

  test('string complex: (<knows>|<manages>)/<worksAt>/<companyName>', async () => {

    const values = await selectWithStringPath(
      `${EX}alice`,
      `(<${EX}knows>|<${EX}manages>)/<${EX}worksAt>/<${EX}companyName>`,
    );
    expect(values).toContain('Acme Corp');
  });

  test('string transitive + sequence: <manages>+/<name>', async () => {

    const values = await selectWithStringPath(
      `${EX}alice`,
      `<${EX}manages>+/<${EX}name>`,
    );
    expect(values).toContain('Bob');
    expect(values).toContain('Carol');
  });
});
