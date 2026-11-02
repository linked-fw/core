/**
 * `.size()` counts a property's values per row, also when the select joins a second
 * multi-valued path. The two paths' triples are joined in one pattern, so each subject has
 * (friends × nickNames) rows; a plain `COUNT(?x)` counted those rows and multiplied each count
 * by the other path's size. A count now counts distinct values.
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, tmpEntityBase, personClass, propBase} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
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
// p1: two friends and three nick names; p2: one friend, no nick names.
const DATA = `
<${ENT}p1> <${RDF_TYPE}> <${personClass.id}> .
<${ENT}p1> <${PROP}hasFriend> <${ENT}p2> .
<${ENT}p1> <${PROP}hasFriend> <${ENT}p3> .
<${ENT}p1> <${PROP}nickName> "A" .
<${ENT}p1> <${PROP}nickName> "B" .
<${ENT}p1> <${PROP}nickName> "C" .
<${ENT}p2> <${RDF_TYPE}> <${personClass.id}> .
<${ENT}p2> <${PROP}hasFriend> <${ENT}p3> .
<${ENT}p3> <${RDF_TYPE}> <${personClass.id}> .
`.trim();

const twoSizes = () => Person.select((p) => ({friends: p.friends.size(), nicks: p.nickNames.size()}));

describe('size() next to another plural path (unit)', () => {
  test('lowers to COUNT(DISTINCT …) for each path', async () => {
    const sparql = selectToSparql((await captureQuery(twoSizes)) as IRSelectQuery);
    expect(sparql).toContain('COUNT(DISTINCT ?a0_friends)');
    expect(sparql).toContain('COUNT(DISTINCT ?a0_nickNames)');
  });

  test('a where comparison on size() counts distinct values too', async () => {
    const sparql = selectToSparql(
      (await captureQuery(() => Person.select((p) => p.name).where((p) => p.friends.size().gt(1)))) as IRSelectQuery,
    );
    expect(sparql).toMatch(/HAVING\(COUNT\(DISTINCT \?a0_friends\) > /);
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

describeFuseki('size() fan-out', () => {
  test('each count is its own path\'s value count', async () => {
    const ir = (await captureQuery(twoSizes)) as IRSelectQuery;
    const rows = mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir) as ResultRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(`${ENT}p1`)).toMatchObject({friends: 2, nicks: 3});
    expect(byId.get(`${ENT}p2`)).toMatchObject({friends: 1, nicks: 0});
    expect(byId.get(`${ENT}p3`)).toMatchObject({friends: 0, nicks: 0});
  });
});
