/**
 * Report 118, review fixes: a member cast with `.as(Shape)` inside a quantifier's or an inline
 * filter's callback (`p.friends.some((f) => f.as(Employee).department.equals('x'))`) is still that
 * callback's member, never the outer subject. A traced root the scopes do not know is refused,
 * never read from the query root.
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {
  Person,
  Employee,
  tmpEntityBase,
  personClass,
  employeeClass,
  propBase,
} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';
import {mapSparqlSelectResult} from '../sparql/resultMapping';
import {traceScopeOf, withTraceScope} from '../queries/traceScopes';
import type {IRSelectQuery, ResultRow} from '../queries/IntermediateRepresentation';
import {createTestDataset, loadTestData, executeSparqlQuery, clearAllData} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import '../ontologies/rdf';

const ENT = tmpEntityBase;
const PROP = propBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const node = (id: string, o: {employee?: boolean; department?: string; bestFriend?: string; friends?: string[]}) =>
  [
    `<${ENT}${id}> <${RDF_TYPE}> <${personClass.id}> .`,
    ...(o.employee ? [`<${ENT}${id}> <${RDF_TYPE}> <${employeeClass.id}> .`] : []),
    ...(o.department ? [`<${ENT}${id}> <${PROP}employeeDepartment> "${o.department}" .`] : []),
    ...(o.bestFriend ? [`<${ENT}${id}> <${PROP}bestFriend> <${ENT}${o.bestFriend}> .`] : []),
    ...(o.friends ?? []).map((f) => `<${ENT}${id}> <${PROP}hasFriend> <${ENT}${f}> .`),
  ].join('\n');

// e1 works in x, e2 in y. p2 itself has a department x (what the outer subject would
// answer), its only friend is e2. p3 has both as friends and e2 as best friend; p4's friend is p1.
const DATA = [
  node('e1', {employee: true, department: 'x'}),
  node('e2', {employee: true, department: 'y'}),
  node('p1', {friends: ['e1']}),
  node('p2', {department: 'x', friends: ['e2']}),
  node('p3', {bestFriend: 'e2', friends: ['e1', 'e2']}),
  node('p4', {friends: ['p1']}),
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const run = async (q: unknown) => {
  const ir = irOf(q);
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir) as ResultRow[];
};
const idOf = (r: ResultRow) => String(r.id).replace(ENT, '');
const idsOf = async (q: unknown) => (await run(q)).map(idOf).sort();

const someInX = () => Person.select().where((p) => p.friends.some((f) => f.as(Employee).department.equals('x')));
const everyInX = () => Person.select().where((p) => p.friends.every((f) => f.as(Employee).department.equals('x')));
const friendOfSomeoneInX = () =>
  Person.select().where((p) => p.friends.some((f) => f.friends.some((g) => g.as(Employee).department.equals('x'))));
const friendIsBestFriend = () =>
  Person.select().where((p) => p.friends.some((f) => f.as(Employee).equals(p.bestFriend as never)));
const friendsInX = () => Person.select((p) => p.friends.where((f) => f.as(Employee).department.equals('x')));

describe('a member cast inside a callback is that callback\'s member', () => {
  test('some and every read the member\'s department', () => {
    expect(sparqlOf(someInX())).toContain(`?a1 <${PROP}employeeDepartment> ?a1_department .`);
    expect(sparqlOf(someInX())).toContain('FILTER(?a1_department = "x")');
    expect(sparqlOf(everyInX())).toContain('FILTER(!(?a1_department = "x"))');
    expect(sparqlOf(everyInX())).not.toContain('?a0_department');
  });

  test('a nested quantifier, a node comparison, a quantifier on the cast member\'s relation', () => {
    expect(sparqlOf(friendOfSomeoneInX())).toContain(`?a2 <${PROP}employeeDepartment> ?a2_department .`);
    expect(sparqlOf(friendIsBestFriend())).toContain('FILTER(?a1 = ?a0_bestFriend)');
    expect(sparqlOf(Person.select().where((p) =>
      p.friends.some((f) => f.as(Employee).friends.some((g) => g.name.equals('x'))))))
      .toContain(`?a1 <${PROP}hasFriend> ?a2 .`);
    expect(sparqlOf(Person.select().where((p) =>
      p.friends.some((f) => f.as(Employee).$type().equals({id: 'urn:x'} as never)))))
      .toContain('?a1 rdf:type ?a2 .');
  });

  test('an inline filter reads the member (it read the outer subject before)', () => {
    const sparql = sparqlOf(friendsInX());
    expect(sparql).toContain(`?a1 <${PROP}employeeDepartment> ?a1_department .`);
    expect(sparql).toContain('FILTER(?a1_department = "x")');
    expect(sparql).not.toContain('?a0_department');
  });

  test('a cast of the outer subject is the outer subject', () => {
    expect(sparqlOf(Person.select().where((p) => p.friends.some((f) => f.name.equals(p.as(Employee).department)))))
      .toContain('FILTER(?a1_name = ?a0_department)');
  });

  test('round-trips through DSL-JSON as a member path', () => {
    expect(JSON.parse(JSON.stringify(someInX().toJSON())).where)
      .toEqual({'friends.some': {'as(Employee).department': 'x'}});
  });

  test('a root the scopes do not know is not taken for the query root', () => {
    const scope = {};
    expect(withTraceScope(scope, () => traceScopeOf({}))).toEqual({kind: 'unscoped'});
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

describeFuseki('a member cast inside a callback', () => {
  test('some / every / nested / node comparison', async () => {
    expect(await idsOf(someInX())).toEqual(['p1', 'p3']);
    // Vacuously true without friends (e1, e2), and for p4, whose friend p1 has no department.
    expect(await idsOf(everyInX())).toEqual(['e1', 'e2', 'p1', 'p4']);
    expect(await idsOf(friendOfSomeoneInX())).toEqual(['p4']);
    expect(await idsOf(friendIsBestFriend())).toEqual(['p3']);
  });

  test('inline filter: the friends in x, every person kept', async () => {
    const rows = await run(friendsInX());
    const friends = Object.fromEntries(
      rows.map((r) => [idOf(r), ((r.friends as ResultRow[] | undefined) ?? []).map(idOf).sort()]),
    );
    expect(friends).toEqual({e1: [], e2: [], p1: ['e1'], p2: [], p3: ['e1'], p4: []});
  });
});
