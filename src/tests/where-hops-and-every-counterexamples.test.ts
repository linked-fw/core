/**
 * Plan 006 decisions 26 and 27, and a filtered relation's computed sub-select field (report 122's
 * review fixes).
 *
 * - Decision 26: a hop under a bare `isNotDefined()` / `defaultTo()` stays required (the path's
 *   relations must exist, only the leaf may be missing), in a select, a count, a delete or update
 *   where and inside a quantifier. Only an `||` branch the others do not need makes a hop optional.
 * - Decision 27: under `every`, a member that lacks a hop the predicate reads is a counterexample,
 *   unless the predicate holds anyway (another `||` branch). `some` and `none` are unchanged.
 * - A sub-select of a filtered relation whose field is computed keeps the filter.
 */
import {describe, expect, test, beforeAll, afterAll, beforeEach} from '@jest/globals';
import {Person, tmpEntityBase, personClass, propBase} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {captureQuery} from '../test-helpers/query-capture-store';
import {selectToSparql, countToSparql, deleteWhereToSparql, updateWhereToSparql} from '../sparql/irToAlgebra';
import {mapSparqlSelectResult} from '../sparql/resultMapping';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import type {IRSelectQuery, ResultRow} from '../queries/IntermediateRepresentation';
import {
  createTestDataset,
  loadTestData,
  executeSparqlQuery,
  executeSparqlUpdate,
  clearAllData,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import '../ontologies/rdf';

const ENT = tmpEntityBase;
const PROP = propBase;
const PT = personClass.id;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const node = (id: string, o: {name?: string; hobby?: string; bestFriend?: string; friends?: string[]}) =>
  [
    `<${ENT}${id}> <${RDF_TYPE}> <${PT}> .`,
    ...(o.name ? [`<${ENT}${id}> <${PROP}name> "${o.name}" .`] : []),
    ...(o.hobby ? [`<${ENT}${id}> <${PROP}hobby> "${o.hobby}" .`] : []),
    ...(o.bestFriend ? [`<${ENT}${id}> <${PROP}bestFriend> <${ENT}${o.bestFriend}> .`] : []),
    ...(o.friends ?? []).map((f) => `<${ENT}${id}> <${PROP}hasFriend> <${ENT}${f}> .`),
  ].join('\n');

// bob's friends: carl (Carl, Chess, best friend erik), ann (Anna, Golf, no best friend), carl2
// (Carl, no best friend). erik (best friend nameless, who has no name) and zed are friends of carl;
// nameless's best friend is erik. Only erik has a best friend without a name.
const DATA = [
  node('bob', {name: 'Bob', friends: ['carl', 'ann', 'carl2']}),
  node('carl', {name: 'Carl', hobby: 'Chess', bestFriend: 'erik', friends: ['ann']}),
  node('ann', {name: 'Anna', hobby: 'Golf'}),
  node('carl2', {name: 'Carl'}),
  node('erik', {name: 'Erik', bestFriend: 'nameless', friends: ['carl']}),
  node('nameless', {bestFriend: 'erik'}),
  node('zed', {name: 'Zed', friends: ['carl']}),
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const idOf = (r: ResultRow) => String(r.id).replace(ENT, '');
const ids = async (q: unknown): Promise<string[]> => {
  const ir = irOf(q);
  const rows = mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir) as ResultRow[];
  return rows.map(idOf).sort();
};

const bestFriendWithoutName = () => Person.select().where((p) => p.bestFriend.name.isNotDefined());
const bestFriendNameDefaulted = () =>
  Person.select().where((p) => p.bestFriend.name.defaultTo('none').equals('none'));
const friendWithNamelessBestFriend = () =>
  Person.select().where((p) => p.friends.some((f) => f.bestFriend.name.isNotDefined()));
const everyFriendsBestFriendIsErik = () =>
  Person.select().where((p) => p.friends.every((f) => f.bestFriend.name.equals('Erik')));
const everyFriendsBestFriendIsErikOrGolfer = () =>
  Person.select().where((p) => p.friends.every((f) => f.bestFriend.name.equals('Erik').or(f.hobby.equals('Golf'))));
const everyCarlsBestFriendIsErik = () =>
  Person.select().where((p) =>
    p.friends.where((f) => f.name.equals('Carl')).every((f) => f.bestFriend.name.equals('Erik')),
  );
const noFriendsBestFriendIsErik = () =>
  Person.select().where((p) => p.friends.none((f) => f.bestFriend.name.equals('Erik')));
const chessFriendsShout = () =>
  Person.select((p) => p.friends.where((f) => f.hobby.equals('Chess')).select((f) => ({x: f.name.concat('!')})));
const deleteBestFriendWithoutName = () =>
  DeleteBuilder.from(Person).where((p: any) => p.bestFriend.name.isNotDefined());
const updateBestFriendWithoutName = () =>
  (Person as any).update({hobby: 'Jog'}).where((p: any) => p.bestFriend.name.isNotDefined());

describe('a hop under isNotDefined() (decision 26)', () => {
  test('stays required in a select; the leaf is OPTIONAL', () => {
    const sparql = sparqlOf(bestFriendWithoutName());
    expect(sparql).toMatch(/^ {2}\?a0 <[^>]*bestFriend> \?a1 \.$/m);
    expect(sparql).toMatch(/OPTIONAL \{\n {4}\?a1 <[^>]*name> \?a1_name \.\n {2}\}\n {2}FILTER\(!\(BOUND\(\?a1_name\)\)\)/);
  });

  test('in a count', async () => {
    const ir = await captureQuery(() => bestFriendWithoutName().count());
    expect(countToSparql(ir as never)).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT (COUNT(DISTINCT ?a0) AS ?count)
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}bestFriend> ?a1 .
  OPTIONAL {
    ?a1 <${PROP}name> ?a1_name .
  }
  FILTER(!(BOUND(?a1_name)))
}`);
  });

  test('under defaultTo()', () => {
    expect(sparqlOf(bestFriendNameDefaulted())).toMatch(/^ {2}\?a0 <[^>]*bestFriend> \?a1 \.$/m);
  });

  test('inside a quantifier', () => {
    expect(sparqlOf(friendWithNamelessBestFriend())).toMatch(/\?a0 <[^>]*hasFriend> \?a1 \.\n {4}\?a1 <[^>]*bestFriend> \?a2 \./);
  });

  test('the relation itself under isNotDefined() may be missing', () => {
    expect(sparqlOf(Person.select().where((p) => p.bestFriend.isNotDefined()))).toContain('OPTIONAL');
  });

  test('a hop one || branch does not need is OPTIONAL; one both branches need is required', () => {
    expect(sparqlOf(Person.select().where((p) => p.name.equals('x').or(p.bestFriend.name.isNotDefined())))).toMatch(
      /OPTIONAL \{\n {4}\?a0 <[^>]*bestFriend> \?a1 \./,
    );
    expect(
      sparqlOf(Person.select().where((p) => p.bestFriend.name.equals('Erik').or(p.bestFriend.bestFriend.name.equals('Erik')))),
    ).toMatch(/^ {2}\?a0 <[^>]*bestFriend> \?a1 \.$/m);
  });
});

describe('every with a hop (decision 27)', () => {
  test('a member without the hop is a counterexample unless the predicate holds', () => {
    expect(sparqlOf(everyFriendsBestFriendIsErik())).toContain(
      'FILTER(!(?a2_name = "Erik") || !(BOUND(?a2)) && !(COALESCE(?a2_name = "Erik", "false"^^xsd:boolean)))',
    );
  });

  test('a filtered every guards the predicate, not the filter', () => {
    expect(sparqlOf(everyCarlsBestFriendIsErik())).toContain('FILTER(?a1_name = "Carl" && (!(?a2_name = "Erik") || !(BOUND(?a2))');
  });

  test('none, some and every over the member\'s own properties are unchanged', () => {
    expect(sparqlOf(noFriendsBestFriendIsErik())).not.toContain('BOUND');
    expect(sparqlOf(Person.select().where((p) => p.friends.some((f) => f.bestFriend.name.equals('Erik'))))).not.toContain('BOUND');
    expect(sparqlOf(Person.select().where((p) => p.friends.every((f) => f.hobby.equals('Chess'))))).not.toContain('BOUND');
  });
});

describe('a computed field of a filtered relation\'s sub-select', () => {
  test('keeps the filter', () => {
    expect(sparqlOf(chessFriendsShout())).toContain('FILTER(?a1_hobby = "Chess")');
    expect(
      sparqlOf(Person.select((p) => p.friends.where((f) => f.hobby.equals('Chess')).select((f) => ({x: f.name.concat('!'), n: f.name})))),
    ).toContain('FILTER(?a1_hobby = "Chess")');
  });
});

const people = async (): Promise<string[]> => {
  const res = await executeSparqlQuery(
    `SELECT ?s ?h WHERE { ?s a <${PT}> OPTIONAL { ?s <${PROP}hobby> ?h } } ORDER BY ?s`,
  );
  return res.results.bindings.map((b: any) => b.s.value.replace(ENT, '') + (b.h ? `=${b.h.value}` : ''));
};

beforeAll(async () => {
  if (fusekiLive) await createTestDataset();
}, 30000);

beforeEach(async () => {
  if (!fusekiLive) return;
  await clearAllData();
  await loadTestData(DATA);
});

afterAll(async () => {
  if (fusekiLive) await clearAllData();
});

describeFuseki('hops under isNotDefined(), every with a hop, a filtered sub-select field', () => {
  test('select, defaultTo, count: only erik (his best friend has no name)', async () => {
    expect(await ids(bestFriendWithoutName())).toEqual(['erik']);
    expect(await ids(bestFriendNameDefaulted())).toEqual(['erik']);
    const ir = await captureQuery(() => bestFriendWithoutName().count());
    const res = await executeSparqlQuery(countToSparql(ir as never));
    expect(Number(res.results.bindings[0].count.value)).toBe(1);
  });

  test('a quantifier: no one has a friend whose best friend lacks a name', async () => {
    expect(await ids(friendWithNamelessBestFriend())).toEqual([]);
  });

  test('delete and update where: erik only', async () => {
    await executeSparqlUpdate(deleteWhereToSparql((await captureQuery(deleteBestFriendWithoutName)) as never));
    expect(await people()).toEqual(['ann=Golf', 'bob', 'carl=Chess', 'carl2', 'nameless', 'zed']);
    await clearAllData();
    await loadTestData(DATA);
    await executeSparqlUpdate(updateWhereToSparql((await captureQuery(updateBestFriendWithoutName)) as never));
    expect(await people()).toEqual(['ann=Golf', 'bob', 'carl=Chess', 'carl2', 'erik=Jog', 'nameless', 'zed']);
  });

  test('every: bob (ann, carl2 have no best friend) and carl (ann) fail', async () => {
    expect(await ids(everyFriendsBestFriendIsErik())).toEqual(['ann', 'carl2', 'erik', 'nameless', 'zed']);
  });

  test('every with ||: ann plays golf, so carl passes; carl2 still fails bob', async () => {
    expect(await ids(everyFriendsBestFriendIsErikOrGolfer())).toEqual(['ann', 'carl', 'carl2', 'erik', 'nameless', 'zed']);
  });

  test('a filtered every: bob\'s carl2 has no best friend', async () => {
    expect(await ids(everyCarlsBestFriendIsErik())).toEqual(['ann', 'carl', 'carl2', 'erik', 'nameless', 'zed']);
  });

  test('none is unchanged', async () => {
    expect(await ids(noFriendsBestFriendIsErik())).toEqual(['ann', 'carl', 'carl2', 'nameless']);
  });

  test('a computed field of a filtered sub-select reads only the filtered members', async () => {
    const ir = irOf(chessFriendsShout());
    const rows = mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir) as ResultRow[];
    // carl's only friend (ann) plays golf: no value. (Where the value lands is plan 006 step S8.)
    const values = Object.fromEntries(rows.map((r) => [idOf(r), JSON.stringify(r).includes('Anna!')]));
    expect(values.carl).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('Anna!');
  });
});
