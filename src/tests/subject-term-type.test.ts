/**
 * A node's term type in a query: `isIri()` and `isBlank()` on the root subject and on a relation,
 * in `where` and `minus`. On a paged select the filter applies inside the page of subjects,
 * before its LIMIT.
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, tmpEntityBase, personClass, propBase} from '../test-helpers/query-fixtures';
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

// Two IRI persons and two blank-node persons; i1's best friend is a blank node, i2's an IRI.
const DATA = [
  `<${ENT}i1> <${RDF_TYPE}> <${personClass.id}> .`,
  `<${ENT}i1> <${PROP}name> "Ann" .`,
  `<${ENT}i1> <${PROP}bestFriend> _:b1 .`,
  `<${ENT}i2> <${RDF_TYPE}> <${personClass.id}> .`,
  `<${ENT}i2> <${PROP}name> "Dan" .`,
  `<${ENT}i2> <${PROP}bestFriend> <${ENT}i1> .`,
  `_:b1 <${RDF_TYPE}> <${personClass.id}> .`,
  `_:b1 <${PROP}name> "Bea" .`,
  `_:b2 <${RDF_TYPE}> <${personClass.id}> .`,
  `_:b2 <${PROP}name> "Cid" .`,
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const run = async (q: unknown) => {
  const ir = irOf(q);
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir);
};
const names = (rows: unknown) => (rows as ResultRow[]).map((r) => r.name);

describe('term type of a node (lowering)', () => {
  test('where isIri() on the root filters the subject', () => {
    const sparql = sparqlOf(Person.select((p) => p.name).where((p) => p.isIri()));
    expect(sparql).toMatch(/FILTER\(isIRI\(\?a0\)\)/);
  });

  test('where isBlank() on the root filters the subject', () => {
    const sparql = sparqlOf(Person.select((p) => p.name).where((p) => p.isBlank()));
    expect(sparql).toMatch(/FILTER\(isBlank\(\?a0\)\)/);
  });

  test('on a paged select the filter is inside the page, before its LIMIT', () => {
    const sparql = sparqlOf(Person.select((p) => p.name).where((p) => p.isIri()).orderBy((p) => p.name).limit(2));
    const page = sparql.slice(sparql.indexOf('SELECT ?a0'), sparql.indexOf('LIMIT 2'));
    expect(page).toMatch(/FILTER\(isIRI\(\?a0\)\)/);
  });

  test('a relation has them too', () => {
    const sparql = sparqlOf(Person.select((p) => p.name).where((p) => p.bestFriend.isBlank()));
    expect(sparql).toMatch(/FILTER\(isBlank\(\?a0_bestFriend\)\)/);
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

describeFuseki('term type of a node', () => {
  test('where isIri() keeps the IRI subjects', async () => {
    expect(names(await run(Person.select((p) => p.name).where((p) => p.isIri()).orderBy((p) => p.name)))).toEqual(['Ann', 'Dan']);
  });

  test('where isBlank() keeps the blank-node subjects', async () => {
    expect(names(await run(Person.select((p) => p.name).where((p) => p.isBlank()).orderBy((p) => p.name)))).toEqual(['Bea', 'Cid']);
  });

  test('minus isBlank() leaves out the blank-node subjects', async () => {
    expect(names(await run(Person.select((p) => p.name).minus((p) => p.isBlank()).orderBy((p) => p.name)))).toEqual(['Ann', 'Dan']);
  });

  test('a page of IRI subjects holds as many as asked', async () => {
    expect(names(await run(Person.select((p) => p.name).where((p) => p.isIri()).orderBy((p) => p.name).limit(2)))).toEqual(['Ann', 'Dan']);
    expect(names(await run(Person.select((p) => p.name).minus((p) => p.isBlank()).orderBy((p) => p.name).limit(1).offset(1)))).toEqual(['Dan']);
  });

  test('a relation: best friend is a blank node', async () => {
    expect(names(await run(Person.select((p) => p.name).where((p) => p.bestFriend.isBlank())))).toEqual(['Ann']);
  });
});
