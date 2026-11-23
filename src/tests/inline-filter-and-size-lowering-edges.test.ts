/**
 * Backlog 112 (and the computed-field case beside it): lowering edges that gave silent wrong
 * answers.
 *
 * - A where on a relation a paged sub-select reads gets a traversal of its own: it tests the
 *   subject, and its triple no longer binds the paged variable outside the page.
 * - A traversal an inline filter reads below its member (`f.bestFriend.name`) is the filter's own,
 *   inside its OPTIONAL block, never a required triple of the top-level pattern.
 * - Inside a quantifier's EXISTS, what only one `||` branch reads (a property, a traversal, an
 *   outer read) is OPTIONAL, as in a top-level where; a top-level where keeps a traversal only one
 *   branch reads OPTIONAL too.
 * - A quantifier on a filtered relation (`p.friends.where(F).some(P)`) tests `F and P`; an inline
 *   filter on a path read as a value (compared, computed, min/max, a hop above a quantifier) is
 *   refused, never dropped.
 * - A computed field (`p.bestFriend.name.concat('!')`) keeps the hops it reads OPTIONAL.
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

const ENT = tmpEntityBase;
const PROP = propBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const node = (id: string, o: {name?: string; hobby?: string; bestFriend?: string; friends?: string[]}) =>
  [
    `<${ENT}${id}> <${RDF_TYPE}> <${personClass.id}> .`,
    ...(o.name ? [`<${ENT}${id}> <${PROP}name> "${o.name}" .`] : []),
    ...(o.hobby ? [`<${ENT}${id}> <${PROP}hobby> "${o.hobby}" .`] : []),
    ...(o.bestFriend ? [`<${ENT}${id}> <${PROP}bestFriend> <${ENT}${o.bestFriend}> .`] : []),
    ...(o.friends ?? []).map((f) => `<${ENT}${id}> <${PROP}hasFriend> <${ENT}${f}> .`),
  ].join('\n');

// bob's friends: carl (Carl, Chess, best friend erik), ann (Anna, Golf) and noname (no name,
// Chess, best friend carl). anna's friends: bob, carl. erik (best friend ann): dirk, ann.
// noname's friends: carl, ann. zed's friends: noname and carl2 (Carl, no hobby). ann, dirk, carl2:
// no friends.
const DATA = [
  node('bob', {name: 'Bob', friends: ['carl', 'ann', 'noname']}),
  node('carl', {name: 'Carl', hobby: 'Chess', bestFriend: 'erik', friends: ['ann']}),
  node('ann', {name: 'Anna', hobby: 'Golf'}),
  node('noname', {hobby: 'Chess', bestFriend: 'carl', friends: ['carl', 'ann']}),
  node('anna', {name: 'Anna', friends: ['bob', 'carl']}),
  node('erik', {name: 'Erik', bestFriend: 'ann', friends: ['dirk', 'ann']}),
  node('dirk', {}),
  node('zed', {name: 'Zed', friends: ['noname', 'carl2']}),
  node('carl2', {name: 'Carl'}),
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const run = async (q: unknown): Promise<ResultRow[]> => {
  const ir = irOf(q);
  const rows = mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir) as ResultRow | ResultRow[];
  return Array.isArray(rows) ? rows : [rows];
};
const idOf = (r: ResultRow) => String(r.id).replace(ENT, '');
const ids = async (q: unknown) => (await run(q)).map(idOf).sort();
const friendIdsBy = (rows: ResultRow[]) =>
  Object.fromEntries(rows.map((r) => [idOf(r), ((r.friends as ResultRow[] | undefined) ?? []).map(idOf).sort()]));

const carl = (f: any) => f.name.equals('Carl');
const chess = (f: any) => f.hobby.equals('Chess');

// A where on the relation a paged sub-select reads.
const pagedFriendsOfChessPlayersFriend = () =>
  Person.select((p) => p.friends.select((f) => f.name).limit(1))
    .where((p) => p.friends.hobby.equals('Chess'))
    .for({id: `${ENT}bob`});
// An inline filter that traverses below its member.
const friendsWithBestFriendErik = () =>
  Person.select((p) => p.friends.where((f) => f.bestFriend.name.equals('Erik')).name);
const friendsWithBestFriendErikOrGolf = () =>
  Person.select((p) => p.friends.where((f) => f.bestFriend.name.equals('Erik').or(f.hobby.equals('Golf'))).name);
const friendsWithAnAnnaFriendCount = () =>
  Person.select((p) => ({n: p.friends.where((f) => f.friends.name.equals('Anna')).size()}));
// `||` inside a quantifier.
const someNamedXOrChess = () =>
  Person.select().where((p) => p.friends.some((f) => f.name.equals('x').or(chess(f))));
const someNamelessFriend = () => Person.select().where((p) => p.friends.some((f) => f.name.isNotDefined()));
const someBestFriendErikOrGolf = () =>
  Person.select().where((p) => p.friends.some((f) => f.bestFriend.name.equals('Erik').or(f.hobby.equals('Golf'))));
const someNamesakeOrChess = () =>
  Person.select().where((p) => p.friends.some((f) => f.name.equals(p.name).or(chess(f))));
// A quantifier on a filtered relation.
const someChessPlayerIsCarl = () => Person.select().where((p) => p.friends.where(chess).some(carl));
const noChessPlayerIsCarl = () => Person.select().where((p) => p.friends.where(chess).none(carl));
// A computed field through a hop; a top-level `||` through a hop.
const bestFriendShout = () => Person.select((p) => ({e: p.bestFriend.name.concat('!')}));
const bobOrGolfBestFriend = () =>
  Person.select().where((p) => p.name.equals('Bob').or(p.bestFriend.hobby.equals('Golf')));

describe('a where on a paged relation', () => {
  test('reads a traversal of its own, required beside the page', () => {
    const sparql = sparqlOf(pagedFriendsOfChessPlayersFriend());
    expect(sparql).toMatch(/\?a0 <[^>]*hasFriend> \?a2 \.\n {2}\?a2 <[^>]*hobby> \?a2_hobby \./);
    expect(sparql).toContain('FILTER(?a2_hobby = "Chess")');
    // The page's variable is bound inside its sub-SELECT only.
    expect(sparql).not.toMatch(/\?a1 <[^>]*hobby>/);
  });

  test('a sort key on a paged relation gets its own traversal too', () => {
    const ir = irOf(
      Person.select((p) => p.friends.select((f) => f.name).limit(1)).orderBy((p) => p.friends.name).for({id: `${ENT}bob`}),
    );
    const traversals = ir.patterns.filter((p) => p.kind === 'traverse');
    expect(traversals).toHaveLength(2);
  });
});

describe("an inline filter's own traversals", () => {
  test('stay inside its block, OPTIONAL, with the properties read on them', () => {
    const sparql = sparqlOf(friendsWithBestFriendErik());
    expect(sparql).toMatch(
      /OPTIONAL \{\n {4}\?a0 <[^>]*hasFriend> \?a1 \.\n {4}OPTIONAL \{\n {6}\?a1 <[^>]*bestFriend> \?a2 \.\n {6}OPTIONAL \{\n {8}\?a2 <[^>]*name> \?a2_name \./,
    );
    // Not a required triple of the top-level pattern, and not projected.
    expect(sparql).not.toMatch(/^ {2}\?a1 <[^>]*bestFriend>/m);
    expect(sparql).toMatch(/^SELECT DISTINCT \?a0 \?a1_name \?a1$/m);
  });

  test('are never shared with a projection of the same path', () => {
    const ir = irOf(Person.select((p) => p.friends.where((f) => f.bestFriend.name.equals('Erik')).bestFriend.name));
    const bestFriendHops = ir.patterns.filter((p) => p.kind === 'traverse' && p.property.endsWith('/bestFriend'));
    expect(bestFriendHops).toHaveLength(2);
  });

  test('an equal filter on two fields is lowered once (no orphan traversals)', () => {
    const ir = irOf(
      Person.select((p) => [
        p.friends.where((f) => f.bestFriend.name.equals('Erik')).name,
        p.friends.where((f) => f.bestFriend.name.equals('Erik')).hobby,
      ]),
    );
    expect(ir.patterns.filter((p) => p.kind === 'traverse')).toHaveLength(2);
  });

  test('a filtered size counts with them, grouped by the subject only', () => {
    const sparql = sparqlOf(friendsWithAnAnnaFriendCount());
    expect(sparql).toContain('COUNT(DISTINCT ?a1)');
    expect(sparql).toMatch(/GROUP BY \?a0$/m);
  });
});

describe('|| inside a quantifier', () => {
  test('a property only one branch reads is OPTIONAL inside the EXISTS', () => {
    const sparql = sparqlOf(someNamedXOrChess());
    expect(sparql).toMatch(/OPTIONAL \{\n {6}\?a1 <[^>]*name> \?a1_name \.\n {4}\}/);
    expect(sparql).toMatch(/OPTIONAL \{\n {6}\?a1 <[^>]*hobby> \?a1_hobby \.\n {4}\}/);
  });

  test('a traversal only one branch reads is an OPTIONAL subtree; the member path stays required', () => {
    const sparql = sparqlOf(someBestFriendErikOrGolf());
    expect(sparql).toMatch(/EXISTS \{\n {4}\?a0 <[^>]*hasFriend> \?a1 \./);
    expect(sparql).toMatch(/OPTIONAL \{\n {6}\?a1 <[^>]*bestFriend> \?a2 \.\n {6}OPTIONAL \{\n {8}\?a2 <[^>]*name> \?a2_name \./);
  });

  test('a conjunction keeps every read required', () => {
    const sparql = sparqlOf(
      Person.select().where((p) => p.friends.some((f) => f.bestFriend.name.equals('Erik').and(f.hobby.equals('Chess')))),
    );
    expect(sparql).not.toContain('OPTIONAL');
  });

  test('an outer read only one branch reads is OPTIONAL', () => {
    expect(sparqlOf(someNamesakeOrChess())).toMatch(/OPTIONAL \{\n {6}\?a0 <[^>]*name> \?a0_name \.\n {4}\}/);
  });

  test('isNotDefined() reads its property OPTIONAL', () => {
    expect(sparqlOf(someNamelessFriend())).toMatch(/OPTIONAL \{\n {6}\?a1 <[^>]*name> \?a1_name \.\n {4}\}\n {4}FILTER\(!\(BOUND/);
  });

  test('a top-level where keeps a traversal only one branch reads OPTIONAL', () => {
    const sparql = sparqlOf(bobOrGolfBestFriend());
    expect(sparql).toMatch(/OPTIONAL \{\n {4}\?a0 <[^>]*bestFriend> \?a1 \./);
    expect(sparql).not.toMatch(/^ {2}\?a0 <[^>]*bestFriend>/m);
  });
});

describe('an inline filter on a quantified relation or a path read as a value', () => {
  test('a quantifier on a filtered relation tests the filter and the predicate together', () => {
    expect(sparqlOf(someChessPlayerIsCarl())).toContain('FILTER(?a1_hobby = "Chess" && ?a1_name = "Carl")');
    expect(sparqlOf(noChessPlayerIsCarl())).toMatch(/FILTER\(!\(EXISTS \{[\s\S]*FILTER\(\?a1_hobby = "Chess" && \?a1_name = "Carl"\)/);
    expect(sparqlOf(Person.select().where((p) => p.friends.where(chess).every(carl)))).toContain(
      'FILTER(?a1_hobby = "Chess" && !(?a1_name = "Carl"))',
    );
  });

  test('a filter that is itself a quantifier', () => {
    const sparql = sparqlOf(
      Person.select().where((p) => p.friends.where((f) => f.friends.some((g) => g.name.equals('Anna'))).some(chess)),
    );
    expect(sparql).toMatch(/FILTER\(EXISTS \{[\s\S]*\?a2_name = "Anna"[\s\S]*\} && \?a1_hobby = "Chess"\)/);
  });

  const refusal = /An inline filter \(`\.where\(\)` on a relation\) on a path .* is not supported: the filter would be dropped/;

  test('a filtered path in a where is refused', () => {
    expect(() => irOf(Person.select().where((p) => p.friends.where(carl).hobby.equals('Chess')))).toThrow(refusal);
  });

  test('inside a quantifier, also reading the outer subject', () => {
    expect(() =>
      irOf(Person.select().where((p) => p.friends.some((f) => f.friends.where(carl).hobby.equals('Chess')))),
    ).toThrow(refusal);
    expect(() =>
      irOf(Person.select().where((p) =>
        p.friends.some((f) => f.friends.where((g) => g.name.equals(p.name)).name.equals('x')),
      )),
    ).toThrow(refusal);
  });

  test('a filter on a hop above a quantified relation', () => {
    expect(() =>
      irOf(Person.select().where((p) => p.friends.where(carl).friends.some((g) => g.name.equals('Anna')))),
    ).toThrow(/leading to a quantifier/);
  });

  test('a computed field, a computed sort key, min/max over a filtered path are refused', () => {
    expect(() => irOf(Person.select((p) => ({e: p.friends.where(carl).name.equals('Carl')})))).toThrow(refusal);
    expect(() => irOf(Person.select((p) => p.name).orderBy((p) => p.friends.where(carl).name.equals('Carl')))).toThrow(refusal);
    expect(() => irOf(Person.select((p) => ({m: p.friends.where(carl).name.max()})))).toThrow(/aggregated with min\(\) or max\(\)/);
  });

  test('an unfiltered where and a selected filtered path are unchanged', () => {
    expect(sparqlOf(Person.select().where((p) => p.friends.hobby.equals('Chess')))).toContain('FILTER(?a1_hobby = "Chess")');
    expect(sparqlOf(Person.select((p) => p.friends.where(carl).hobby))).toContain('FILTER(?a1_name = "Carl")');
  });
});

describe('a computed field through a hop', () => {
  test('keeps the hop OPTIONAL', () => {
    const sparql = sparqlOf(bestFriendShout());
    expect(sparql).toContain('(CONCAT(?a1_name, "!") AS ?a1_expr)');
    expect(sparql).toMatch(/OPTIONAL \{\n {4}\?a0 <[^>]*bestFriend> \?a1 \./);
  });

  test('a where that requires the hop keeps it required', () => {
    const sparql = sparqlOf(bestFriendShout().where((p) => p.bestFriend.name.equals('Erik')));
    expect(sparql).toMatch(/^ {2}\?a0 <[^>]*bestFriend> \?a1 \.$/m);
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

describeFuseki('inline filter and size lowering edges', () => {
  test("a where on a paged relation: bob qualifies, his page is his first friend", async () => {
    const rows = await run(pagedFriendsOfChessPlayersFriend());
    expect(friendIdsBy(rows)).toEqual({bob: ['ann']});
  });

  test("an inline filter's own traversal: friends whose best friend is Erik", async () => {
    expect(friendIdsBy(await run(friendsWithBestFriendErik()))).toEqual({
      ann: [], anna: ['carl'], bob: ['carl'], carl: [], carl2: [], dirk: [], erik: [], noname: ['carl'], zed: [],
    });
  });

  test('… or who play golf: a friend without a best friend still matches the other branch', async () => {
    expect(friendIdsBy(await run(friendsWithBestFriendErikOrGolf()))).toEqual({
      ann: [], anna: ['carl'], bob: ['ann', 'carl'], carl: ['ann'], carl2: [], dirk: [], erik: ['ann'], noname: ['ann', 'carl'],
      zed: [],
    });
  });

  test('a filtered size through the filter\'s own traversal', async () => {
    const rows = await run(friendsWithAnAnnaFriendCount());
    expect(Object.fromEntries(rows.map((r) => [idOf(r), r.n]))).toEqual({
      ann: 0, anna: 2, bob: 2, carl: 0, carl2: 0, dirk: 0, erik: 0, noname: 1, zed: 1,
    });
  });

  test('|| in a quantifier: zed matches through his unnamed chess-playing friend', async () => {
    expect(await ids(someNamedXOrChess())).toEqual(['anna', 'bob', 'noname', 'zed']);
  });

  test('isNotDefined() in a quantifier', async () => {
    expect(await ids(someNamelessFriend())).toEqual(['bob', 'erik', 'zed']);
  });

  test('|| with a traversal in a quantifier', async () => {
    expect(await ids(someBestFriendErikOrGolf())).toEqual(['anna', 'bob', 'carl', 'erik', 'noname']);
  });

  test('|| with an outer read in a quantifier: zed (no namesake) through chess', async () => {
    expect(await ids(someNamesakeOrChess())).toEqual(['anna', 'bob', 'noname', 'zed']);
  });

  test('a quantifier on a filtered relation: zed\'s Carl plays no chess', async () => {
    expect(await ids(someChessPlayerIsCarl())).toEqual(['anna', 'bob', 'noname']);
    expect(await ids(noChessPlayerIsCarl())).toEqual(['ann', 'carl', 'carl2', 'dirk', 'erik', 'zed']);
  });

  test('a computed field keeps every person', async () => {
    const rows = await run(bestFriendShout());
    expect(Object.fromEntries(rows.map((r) => [idOf(r), r.e]))).toEqual({
      ann: null, anna: null, bob: null, carl: 'Erik!', carl2: null, dirk: null, erik: 'Anna!', noname: 'Carl!', zed: null,
    });
  });

  test('a top-level ||: bob has no best friend and is kept by his name', async () => {
    expect(await ids(bobOrGolfBestFriend())).toEqual(['bob', 'erik']);
  });
});
