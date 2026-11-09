/**
 * `limit`/`offset` page over root subjects even when the data holds more values than a path
 * declares (`maxCount: 1` with two values, as with a label in two languages), and ties on the
 * sort key are broken by the subject IRI, so consecutive pages neither repeat nor skip one.
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, Employee, tmpEntityBase, personClass, employeeClass, propBase} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';
import {mapSparqlSelectResult} from '../sparql/resultMapping';
import type {IRSelectQuery, ResultRow} from '../queries/IntermediateRepresentation';
import {createTestDataset, loadTestData, executeSparqlQuery, clearAllData} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import '../ontologies/rdf';
import '../ontologies/xsd';

const ENT = tmpEntityBase;
const PROP = propBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const person = (id: string, names: string[], type = personClass.id) =>
  [
    `<${ENT}${id}> <${RDF_TYPE}> <${type}> .`,
    ...names.map((n) => `<${ENT}${id}> <${PROP}name> "${n}" .`),
  ].join('\n');

// `name` is declared `maxCount: 1`; a1 has two. a3–a5 tie on "Same", a6 and a7 have none.
// e1 is an Employee, which a `.minus(Employee)` leaves out.
const DATA = [
  person('a1', ['Ann', 'Anna']),
  person('a2', ['Bob']),
  person('a3', ['Same']),
  person('a4', ['Same']),
  person('a5', ['Same']),
  person('a6', []),
  person('a7', []),
  person('e1', ['Aaron'], employeeClass.id),
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const run = async (q: unknown) => {
  const ir = irOf(q);
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir);
};
const ids = (rows: unknown) => (rows as ResultRow[]).map((r) => String(r.id).replace(ENT, ''));

const byName = () => Person.select((p) => p.name).minus(Employee).orderBy((p) => p.name);

describe('paging when the data breaks maxCount (lowering)', () => {
  test('a single-valued projection pages a sub-SELECT of subjects', () => {
    const sparql = sparqlOf(Person.select((p) => p.name).limit(2).offset(1));
    expect(sparql).toMatch(/\{\s*SELECT \?a0[\s\S]*GROUP BY \?a0[\s\S]*LIMIT 2 OFFSET 1\s*\}/);
    expect(sparql.trim()).not.toMatch(/LIMIT 2\s+OFFSET 1$/);
  });

  test('an order on a single-valued path breaks ties by the subject', () => {
    const sparql = sparqlOf(byName().limit(2));
    expect(sparql).toMatch(/\(MIN\(\?a0_name\) AS \?(\w+)\)[\s\S]*ORDER BY DESC\(BOUND\(\?\1\)\) ASC\(\?\1\) ASC\(\?a0\) LIMIT 2/);
  });

  test('the MINUS is applied inside the page, before its LIMIT', () => {
    const sparql = sparqlOf(byName().limit(2));
    const page = sparql.slice(sparql.indexOf('SELECT ?a0'), sparql.indexOf('LIMIT 2'));
    expect(page).toContain('MINUS {');
  });

  test('a single-valued traversal pages by subject', () => {
    const sparql = sparqlOf(Person.select((p) => p.bestFriend.name).limit(2));
    expect(sparql).toMatch(/SELECT \?a0[\s\S]*LIMIT 2\s*\}/);
  });

  test('.one() on a single-valued path pages by subject', () => {
    const sparql = sparqlOf(Person.select((p) => p.name).one());
    expect(sparql).toMatch(/SELECT \?a0[\s\S]*LIMIT 1\s*\}/);
  });

  test('an offset without an order pages in subject order', () => {
    const sparql = sparqlOf(Person.select((p) => p.name).limit(2).offset(2));
    expect(sparql).toMatch(/ORDER BY ASC\(\?a0\) LIMIT 2 OFFSET 2\s*\}/);
  });
});

beforeAll(async () => {
  if (!fusekiLive) return;
  await createTestDataset();
  await clearAllData();
  await loadTestData(DATA);
}, 30000);

afterAll(async () => {
  if (fusekiLive) await clearAllData();
});

describeFuseki('paging when the data breaks maxCount', () => {
  test('a subject with two values of a maxCount-1 path counts once', async () => {
    expect(ids(await run(byName().limit(3)))).toEqual(['a1', 'a2', 'a3']);
  });

  test('pages of one neither repeat nor skip a subject, ties and missing values included', async () => {
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) seen.push(...ids(await run(byName().limit(1).offset(i))));
    expect(seen).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
  });

  test('pages of three cover every subject once', async () => {
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) seen.push(...ids(await run(byName().limit(3).offset(i * 3))));
    expect(seen).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
  });

  test('.one() is one subject', async () => {
    const row = (await run(byName().one())) as ResultRow;
    expect(row.id).toBe(`${ENT}a1`);
  });

  test('without an order, offset pages neither repeat nor skip a subject', async () => {
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) seen.push(...ids(await run(Person.select((p) => p.name).minus(Employee).limit(2).offset(i * 2))));
    expect([...seen].sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
  });
});
