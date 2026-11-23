/**
 * Backlog 108: an inline filter that reads the outer subject compares with the outer node, never
 * with its own member; where the outer node is not bound around the filter's block the query is
 * refused. A filtered `size()` counts only the members its filter keeps and keeps every instance
 * (the hops above it stay optional, the count is 0).
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, tmpEntityBase, personClass, propBase} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {captureQuery} from '../test-helpers/query-capture-store';
import {fromJSON} from '../queries/fromJSON';
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

// anna → best friend Bob, whose friends are Carl (Chess), a second "Anna" (ann) and a second
// "Bob" (bobby, whose best friend is bob).
// dirk (no name) → best friend Bob. carl → best friend Erik, whose only friend is Dirk.
// bob, erik, ann → no best friend.
const DATA = [
  node('anna', {name: 'Anna', bestFriend: 'bob'}),
  node('bob', {name: 'Bob', friends: ['carl', 'ann', 'bobby']}),
  node('carl', {name: 'Carl', hobby: 'Chess', bestFriend: 'erik', friends: ['anna']}),
  node('dirk', {bestFriend: 'bob'}),
  node('erik', {name: 'Erik', friends: ['dirk']}),
  node('ann', {name: 'Anna'}),
  node('bobby', {name: 'Bob', bestFriend: 'bob'}),
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const jsonOf = (q: {toJSON(): unknown}) => JSON.parse(JSON.stringify(q.toJSON())) as Record<string, unknown>;
const roundTrip = (q: {toJSON(): unknown}) => fromJSON(jsonOf(q) as never);
const run = async (q: unknown) => {
  const ir = irOf(q);
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir) as ResultRow[];
};
const idOf = (r: ResultRow) => String(r.id).replace(ENT, '');

// The best friend's friends named like the person.
const namesakes = () => Person.select((p) => p.bestFriend.friends.where((f) => f.name.equals(p.name)).name);
// …or playing chess: a person without a name still gets the chess players.
const namesakesOrChess = () =>
  Person.select((p) => p.bestFriend.friends.where((f) => f.name.equals(p.name).or(f.hobby.equals('Chess'))).name);
// How many of the best friend's friends are called Carl.
const carlCount = () => Person.select((p) => ({carls: p.bestFriend.friends.where((f) => f.name.equals('Carl')).size()}));

describe('an inline filter reading the outer subject', () => {
  test('reads the outer node, with a variable of its own bound beside the block', () => {
    const sparql = sparqlOf(namesakes());
    expect(sparql).toContain('FILTER(?a2_name = ?a0_name)');
    expect(sparql).not.toMatch(/FILTER\(\?(\w+) = \?\1\)/);
  });

  test('a projected outer value keeps its own variable and OPTIONAL', () => {
    const sparql = sparqlOf(Person.select((p) => [p.name, p.friends.where((f) => f.name.equals(p.name)).name]));
    expect(sparql).toContain('FILTER(?a1_name = ?a0_name_2)');
    // The projection's binding is a top-level OPTIONAL, not one inside the filtered block.
    expect(sparql).toMatch(/\n  OPTIONAL \{\n    \?a0 <[^>]*name> \?a0_name \.\n  \}\n\}$/);
  });

  test('reads a hop above the filtered relation (p.bestFriend.name)', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.bestFriend.friends.where((f) => f.name.equals(p.bestFriend.name)).name),
    );
    expect(sparql).toContain('FILTER(?a2_name = ?a1_name)');
  });

  test('a sub-select reads its own member (f.name in p.friends.select((f) => …))', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.friends.select((f) => f.friends.where((g) => g.name.equals(f.name)).name)),
    );
    expect(sparql).toContain('FILTER(?a2_name = ?a1_name)');
  });

  test('in a sort key, paged: the page sub-SELECT binds the outer value too', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.name).orderBy((p) => p.friends.where((f) => f.name.equals(p.name)).hobby).limit(10),
    );
    expect(sparql.match(/FILTER\(\?a1_name = \?a0_name_2\)/g)).toHaveLength(2);
    expect(sparql.match(/\?a0 <[^>]*name> \?a0_name_2 \./g)).toHaveLength(2);
  });

  test('a path that is not a hop above the filtered relation is refused', () => {
    expect(() => irOf(Person.select((p) => p.friends.where((f) => f.name.equals(p.bestFriend.name)).name)))
      .toThrow(/not a hop above the filtered relation/);
    // `p.friends` is the filtered relation itself: never compared with the member.
    expect(() => irOf(Person.select((p) => p.friends.where((f) => f.name.equals(p.friends.name)).name)))
      .toThrow(/not a hop above the filtered relation/);
  });

  test('a node more than one hop above the filtered relation is refused (not bound in its block)', () => {
    expect(() => sparqlOf(
      Person.select((p) => p.bestFriend.bestFriend.friends.where((f) => f.name.equals(p.name)).name),
    )).toThrow(/more than one hop above the relation it filters/);
  });

  test('a quantifier inside the filter reads only its own member', () => {
    expect(() => irOf(Person.select((p) => p.friends.where((f) => f.friends.some((g) => g.name.equals(p.name))).name)))
      .toThrow(/not a quantifier inside it/);
    expect(() => irOf(Person.select((p) => p.friends.where((f) => f.friends.some((g) => g.name.equals(f.name))).name)))
      .toThrow(/a quantifier \(some\/every\/none\) inside an inline filter can read only its own member/);
  });

  test('an aggregate over the outer subject inside the filter is refused', () => {
    expect(() => irOf(Person.select((p) => p.friends.where((f) => p.friends.size().equals(2)).name)))
      .toThrow(/only over its own member's paths/);
  });

  test('has no DSL-JSON form yet: toJSON refuses it', () => {
    expect(() => namesakes().toJSON()).toThrow(/no DSL-JSON form yet/);
  });

  test('a failing query still names its own error, not the serialization one', async () => {
    await expect(
      captureQuery(() => Person.select((p) => p.friends.where((f) => f.name.equals(p.bestFriend.name)).name).exec()),
    ).rejects.toThrow(/not a hop above the filtered relation[\s\S]*not serializable/);
  });

  test('a filter on the member alone is unchanged', () => {
    expect(sparqlOf(Person.select((p) => p.friends.where((f) => f.name.equals('Moa')).name)))
      .toContain('FILTER(?a1_name = "Moa")');
  });
});

describe('a filtered size()', () => {
  test('counts the members the filter keeps; the hops above it are OPTIONAL', () => {
    const sparql = sparqlOf(carlCount());
    expect(sparql).toContain('(COUNT(DISTINCT ?a2) AS ?a1_agg)');
    expect(sparql).toContain('FILTER(?a2_name = "Carl")');
    expect(sparql).not.toMatch(/WHERE \{\s*\?a0 rdf:type <[^>]+> \.\s*\?a0 <[^>]*bestFriend>/);
    expect(sparql).toMatch(/GROUP BY \?a0$/);
  });

  test('a filter on a hop above the counted relation filters that hop', () => {
    const sparql = sparqlOf(Person.select((p) => p.friends.where((f) => f.name.equals('Bob')).friends.size()));
    expect(sparql).toContain('(COUNT(DISTINCT ?a1_friends) AS ?a1_agg)');
    expect(sparql).toContain('FILTER(?a1_name = "Bob")');
  });

  test('with an outer reference', () => {
    const sparql = sparqlOf(Person.select((p) => p.bestFriend.friends.where((f) => f.name.equals(p.name)).size()));
    expect(sparql).toContain('FILTER(?a2_name = ?a0_name)');
    expect(sparql).toContain('(COUNT(DISTINCT ?a2) AS ?a1_agg)');
  });

  test('compared in a where, it is refused (it would count every member)', () => {
    expect(() => irOf(Person.select((p) => p.name).where((p) => p.friends.where((f) => f.name.equals('Carl')).size().equals(1))))
      .toThrow(/can be selected, not compared/);
  });

  test('an unfiltered size keeps the hops above it OPTIONAL too', () => {
    const sparql = sparqlOf(Person.select((p) => p.bestFriend.friends.size()));
    expect(sparql).toMatch(/OPTIONAL \{\s*\?a0 <[^>]*bestFriend> \?a1 \./);
    expect(sparql).toMatch(/GROUP BY \?a0$/);
  });

  test('round-trips through DSL-JSON', () => {
    const q = carlCount();
    expect(jsonOf(q).fields).toEqual([
      {'bestFriend.friends': {customKey: 'carls', aggregation: 'count', where: {name: 'Carl'}, whereIndex: 1}},
    ]);
    expect(sparqlOf(roundTrip(q))).toBe(sparqlOf(q));
  });
});

const isCarl = (f: {name: {equals(v: string): unknown}}) => f.name.equals('Carl');
const friendsAndCarls = () => Person.select((p) => ({n: p.friends.size(), c: p.friends.where(isCarl as never).size()}));
const carlsAndAnnas = () =>
  Person.select((p) => ({
    carls: p.friends.where(isCarl as never).size(),
    annas: p.friends.where((f) => f.name.equals('Anna')).size(),
  }));
// A component whose filter reads its own subject, preloaded on the best friend.
const namesakeCard = {query: Person.select((c) => ({fr: c.friends.where((f) => f.name.equals(c.name)).name}))};
const preloaded = () => Person.select((p) => p.bestFriend.preloadFor(namesakeCard as never));
const carlsOfAnnaFriends = () =>
  Person.select((p) => ({c: p.friends.where(isCarl as never).size()})).where((p) => p.friends.name.equals('Anna'));
const friendsWithMeAsBest = () => Person.select((p) => p.friends.where((f) => f.bestFriend.equals(p)).name);

describe('filtered traversals of their own (review fixes)', () => {
  test('a plain and a filtered size of one relation read different traversals', () => {
    const sparql = sparqlOf(friendsAndCarls());
    expect(sparql).toContain('(COUNT(DISTINCT ?a0_friends) AS ?a1_agg) (COUNT(DISTINCT ?a1) AS ?a2)');
  });

  test('two filtered sizes keep their own filters', () => {
    const sparql = sparqlOf(carlsAndAnnas());
    expect(sparql).toContain('FILTER(?a1_name = "Carl")');
    expect(sparql).toContain('FILTER(?a2_name = "Anna")');
  });

  test('equal filters still share one traversal', () => {
    const sparql = sparqlOf(Person.select((p) => [p.friends.where(isCarl as never).name, p.friends.where(isCarl as never).hobby]));
    expect(sparql.match(/hasFriend>/g)).toHaveLength(1);
  });

  test('a top-level where on the same relation gets its own traversal', () => {
    const sparql = sparqlOf(carlsOfAnnaFriends());
    expect(sparql).toMatch(/\?a0 <[^>]*hasFriend> \?a2 \.\n  \?a2 <[^>]*name> \?a2_name \./);
    expect(sparql).toContain('FILTER(?a1_name = "Carl")');
  });

  test('a preloaded component reads its own subject, not the host root (preloadFor and preload())', () => {
    expect(sparqlOf(preloaded())).toContain('FILTER(?a2_name = ?a1_name)');
    expect(sparqlOf(Person.select((p) => p.name).preload('bestFriend' as never, namesakeCard as never)))
      .toContain('FILTER(?a2_name = ?a1_name)');
  });

  test('a member compared with the outer subject', () => {
    expect(sparqlOf(friendsWithMeAsBest())).toContain('FILTER(?a1_bestFriend = ?a0)');
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

describeFuseki('inline filter outer references and filtered size', () => {
  test('namesakes: Anna gets ann; every person is kept', async () => {
    const rows = await run(namesakes());
    expect(rows.map(idOf).sort()).toEqual(['ann', 'anna', 'bob', 'bobby', 'carl', 'dirk', 'erik']);
    const anna = rows.find((r) => idOf(r) === 'anna')!;
    expect(((anna.bestFriend as ResultRow).friends as ResultRow[]).map(idOf)).toEqual(['ann']);
    const dirk = rows.find((r) => idOf(r) === 'dirk')!;
    expect(((dirk.bestFriend as ResultRow).friends as ResultRow[] | undefined) ?? []).toEqual([]);
  });

  test('or: a person without a name still gets the chess players', async () => {
    const rows = await run(namesakesOrChess());
    const friendsOf = (id: string) =>
      (((rows.find((r) => idOf(r) === id)!.bestFriend as ResultRow).friends as ResultRow[] | undefined) ?? []).map(idOf).sort();
    expect(friendsOf('anna')).toEqual(['ann', 'carl']);
    expect(friendsOf('dirk')).toEqual(['carl']);
  });

  test('a plain and a filtered size of one relation: bob 3 friends, 1 Carl', async () => {
    const rows = await run(friendsAndCarls());
    const counts = Object.fromEntries(rows.map((r) => [idOf(r), [Number(r.n), Number(r.c)]]));
    expect(counts.bob).toEqual([3, 1]);
    expect(counts.carl).toEqual([1, 0]);
  });

  test('two filtered sizes: bob 1 Carl and 1 Anna, carl 0 and 1', async () => {
    const rows = await run(carlsAndAnnas());
    const counts = Object.fromEntries(rows.map((r) => [idOf(r), [Number(r.carls), Number(r.annas)]]));
    expect(counts.bob).toEqual([1, 1]);
    expect(counts.carl).toEqual([0, 1]);
  });

  test('a preloaded component: the best friend\'s friends named like the best friend', async () => {
    const rows = await run(preloaded());
    const fr = (id: string) =>
      ((((rows.find((r) => idOf(r) === id)!.bestFriend as ResultRow | undefined)?.friends as ResultRow[] | undefined) ?? [])).map(idOf);
    expect(fr('anna')).toEqual(['bobby']);
    expect(fr('carl')).toEqual([]);
  });

  test('a where on the counted relation: bob 1, carl 0', async () => {
    const rows = await run(carlsOfAnnaFriends());
    expect(Object.fromEntries(rows.map((r) => [idOf(r), Number(r.c)]))).toEqual({bob: 1, carl: 0});
  });

  test('a member compared with the outer subject: bob gets bobby', async () => {
    const rows = await run(friendsWithMeAsBest());
    expect(((rows.find((r) => idOf(r) === 'bob')!.friends as ResultRow[]) ?? []).map(idOf)).toEqual(['bobby']);
  });

  test('filtered size: 1 for anna, dirk and bobby (best friend bob), 0 for everyone else (kept)', async () => {
    const rows = await run(carlCount());
    const counts = Object.fromEntries(rows.map((r) => [idOf(r), Number(r.carls)]));
    expect(counts).toEqual({anna: 1, dirk: 1, bobby: 1, bob: 0, carl: 0, erik: 0, ann: 0});
  });
});
