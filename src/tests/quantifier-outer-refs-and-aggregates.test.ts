/**
 * Report 118 (backlog 079, backlog 111 items 1–2).
 *
 * - An aggregate inside a condition SPARQL tests per member (a quantifier's EXISTS, an inline
 *   filter's OPTIONAL block, a MINUS block) is refused at lowering: a FILTER cannot hold one.
 * - A quantifier (`some`/`every`/`none`) whose callback reads the outer subject (`p.name`) or an
 *   enclosing quantifier's member (`f.name`) reads that node, never its own member: inside its
 *   EXISTS, into a variable of its own. In a top-level where and inside an inline filter.
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, tmpEntityBase, personClass, propBase} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {selectToSparql, askToSparql, deleteWhereToSparql, updateWhereToSparql} from '../sparql/irToAlgebra';
import {mapSparqlSelectResult} from '../sparql/resultMapping';
import {captureQuery} from '../test-helpers/query-capture-store';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import type {
  IRAskQuery,
  IRDeleteWhereMutation,
  IRSelectQuery,
  IRUpdateWhereMutation,
  ResultRow,
} from '../queries/IntermediateRepresentation';
import {createTestDataset, loadTestData, executeSparqlQuery, clearAllData} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import '../ontologies/rdf';

const ENT = tmpEntityBase;
const PROP = propBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const node = (id: string, o: {name?: string; bestFriend?: string; friends?: string[]}) =>
  [
    `<${ENT}${id}> <${RDF_TYPE}> <${personClass.id}> .`,
    ...(o.name ? [`<${ENT}${id}> <${PROP}name> "${o.name}" .`] : []),
    ...(o.bestFriend ? [`<${ENT}${id}> <${PROP}bestFriend> <${ENT}${o.bestFriend}> .`] : []),
    ...(o.friends ?? []).map((f) => `<${ENT}${id}> <${PROP}hasFriend> <${ENT}${f}> .`),
  ].join('\n');

// anna has a namesake friend (ann), bob too (bob2); carl's friend dave has a friend named Carl,
// who is also dave's best friend; dirk has no name; eve's friend fay has a friend named Eve and
// eve as best friend; gus is eve's friend; hal's friend jo is also a friend of hal's best friend.
const DATA = [
  node('anna', {name: 'Anna', friends: ['ann', 'bob']}),
  node('ann', {name: 'Anna'}),
  node('bob', {name: 'Bob', friends: ['bob2']}),
  node('bob2', {name: 'Bob'}),
  node('carl', {name: 'Carl', friends: ['anna', 'dave']}),
  node('dave', {name: 'Dave', bestFriend: 'carl2', friends: ['carl2']}),
  node('carl2', {name: 'Carl', bestFriend: 'carl'}),
  node('dirk', {friends: ['anna']}),
  node('erik', {name: 'Erik'}),
  node('eve', {name: 'Eve', friends: ['fay']}),
  node('fay', {name: 'Fay', bestFriend: 'eve', friends: ['eve2']}),
  node('eve2', {name: 'Eve'}),
  node('gus', {name: 'Gus', friends: ['eve']}),
  node('hal', {name: 'Hal', bestFriend: 'ida', friends: ['jo']}),
  node('ida', {name: 'Ida', friends: ['jo']}),
  node('jo', {name: 'Jo'}),
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const run = async (q: unknown) => {
  const ir = irOf(q);
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir) as ResultRow[];
};
const idOf = (r: ResultRow) => String(r.id).replace(ENT, '');
const idsOf = async (q: unknown) => (await run(q)).map(idOf).sort();
/** A FILTER comparing a variable with itself: the bug of backlog 111. */
const SELF_COMPARISON = /FILTER\(!?\(?\?(\w+) = \?\1\)/;

const someNamesake = () => Person.select().where((p) => p.friends.some((f) => f.name.equals(p.name)));
const everyNamesake = () => Person.select().where((p) => p.friends.every((f) => f.name.equals(p.name)));
const noneNamesake = () => Person.select().where((p) => p.friends.none((f) => f.name.equals(p.name)));
const friendOfFriendNamesake = () =>
  Person.select().where((p) => p.friends.some((f) => f.friends.some((g) => g.name.equals(p.name))));
const friendWithNamesakeFriend = () =>
  Person.select().where((p) => p.friends.some((f) => f.friends.some((g) => g.name.equals(f.name))));
const friendAlsoBestFriendsFriend = () =>
  Person.select().where((p) => p.friends.some((f) => p.bestFriend.friends.some((x) => x.equals(f as never))));
const friendsWithFriendNamedLikeMe = () =>
  Person.select((p) => p.friends.where((f) => f.friends.some((g) => g.name.equals(p.name))));
const friendsWithoutNamesakeFriend = () =>
  Person.select((p) => p.friends.where((f) => f.friends.none((g) => g.name.equals(f.name))));

const AGGREGATE_REFUSAL = /An aggregate \(size, min, max, …\) inside a quantifier \(some\/every\/none\) is not supported[\s\S]*`\.where\(\(p\) => p\.friends\.size\(\)\.equals\(1\)\)`/;

describe('an aggregate inside a per-member condition is refused (backlog 079)', () => {
  test('a quantifier: named error, pointing at the top-level form', () => {
    expect(() => irOf(Person.select().where((p) => p.friends.some((f) => f.friends.size().equals(1)))))
      .toThrow(AGGREGATE_REFUSAL);
  });

  test('every and none, an aggregate inside a conjunction, min/max, a nested quantifier', () => {
    const queries = [
      () => Person.select().where((p) => p.friends.every((f) => f.friends.size().gt(1))),
      () => Person.select().where((p) => p.friends.none((f) => f.friends.size().equals(0))),
      () => Person.select().where((p) => p.friends.some((f) => f.name.equals('x').and(f.friends.size().equals(1)))),
      () => Person.select().where((p) => p.friends.some((f) => f.friends.name.min().equals('a'))),
      () => Person.select().where((p) => p.friends.some((f) => f.friends.some((g) => g.friends.size().equals(1)))),
      () => Person.select().where((p) => p.friends.some((f) => f.friends.some((g) => g.name.equals('x')).and(f.friends.size().equals(1)))),
    ];
    for (const q of queries) expect(() => irOf(q())).toThrow(AGGREGATE_REFUSAL);
  });

  test('an ask and a mutation where refuse it too (same lowering)', async () => {
    await expect(captureQuery(() => Person.select().where((p) => p.friends.some((f) => f.friends.size().equals(1))).exists()))
      .rejects.toThrow(AGGREGATE_REFUSAL);
    expect(() => lower(DeleteBuilder.from(Person).where((p: any) => p.friends.some((f: any) => f.friends.size().equals(1))) as never))
      .toThrow(AGGREGATE_REFUSAL);
  });

  test('an inline filter and a minus() refuse it, naming themselves', () => {
    expect(() => irOf(Person.select((p) => p.friends.where((f) => f.friends.size().equals(1)).name)))
      .toThrow(/An aggregate \(size, min, max, …\) inside an inline filter \(`\.where\(\)` on a relation\) is not supported/);
    expect(() => irOf(Person.select().minus((p) => p.friends.size().equals(1))))
      .toThrow(/An aggregate \(size, min, max, …\) inside minus\(\) is not supported/);
  });

  test('an aggregate over the outer subject inside a quantifier is refused while tracing', () => {
    expect(() => irOf(Person.select().where((p) => p.friends.some(() => p.friends.size().equals(1)))))
      .toThrow(/over the outer subject's paths inside an inline filter or a quantifier/);
  });

  test('a top-level aggregate is unchanged: GROUP BY/HAVING, also chained beside a quantifier', () => {
    expect(sparqlOf(Person.select().where((p) => p.friends.size().equals(1))))
      .toContain('HAVING(COUNT(DISTINCT ?a0_friends) = "1"^^xsd:integer)');
    const chained = sparqlOf(
      Person.select().where((p) => p.friends.some((f) => f.name.equals('x')).and(p.friends.size().equals(1))),
    );
    expect(chained).toContain('GROUP BY ?a0');
    expect(chained).toMatch(/HAVING\(EXISTS \{[\s\S]*\} && COUNT\(DISTINCT \?a0_friends\) = "1"\^\^xsd:integer\)/);
  });
});

describe('a quantifier reading the outer subject (backlog 111 items 1–2)', () => {
  test('some: compares with the outer subject\'s value, read inside the EXISTS', () => {
    const sparql = sparqlOf(someNamesake());
    expect(sparql).toContain(`?a0 <${PROP}name> ?a0_name .`);
    expect(sparql).toContain('FILTER(?a1_name = ?a0_name)');
    expect(sparql).not.toMatch(SELF_COMPARISON);
  });

  test('every and none (NOT EXISTS)', () => {
    const every = sparqlOf(everyNamesake());
    expect(every).toMatch(/FILTER\(!\(EXISTS \{[\s\S]*FILTER\(!\(\?a1_name = \?a0_name\)\)/);
    const none = sparqlOf(noneNamesake());
    expect(none).toMatch(/FILTER\(!\(EXISTS \{[\s\S]*FILTER\(\?a1_name = \?a0_name\)/);
    expect(every).not.toMatch(SELF_COMPARISON);
    expect(none).not.toMatch(SELF_COMPARISON);
  });

  test('nested quantifiers: the outer subject, and the enclosing member', () => {
    const outer = sparqlOf(friendOfFriendNamesake());
    expect(outer).toContain(`?a0 <${PROP}name> ?a0_name .`);
    expect(outer).toContain('FILTER(?a2_name = ?a0_name)');
    const enclosing = sparqlOf(friendWithNamesakeFriend());
    expect(enclosing).toContain(`?a1 <${PROP}name> ?a1_name .`);
    expect(enclosing).toContain('FILTER(?a2_name = ?a1_name)');
  });

  test('a quantifier on the outer subject\'s relation, inside another one, starts at the subject', () => {
    const sparql = sparqlOf(friendAlsoBestFriendsFriend());
    expect(sparql).toMatch(/FILTER\(EXISTS \{\n      \?a0 <[^>]*bestFriend> \?a2 \.\n      \?a2 <[^>]*hasFriend> \?a3 \.\n      FILTER\(\?a3 = \?a1\)/);
    // An enclosing member's relation: `f.bestFriend.friends` inside `g`'s callback.
    expect(sparqlOf(Person.select().where((p) =>
      p.friends.some((f) => f.friends.some((g) => f.bestFriend.friends.some((h) => h.equals(g as never)))))))
      .toContain(`?a1 <${PROP}bestFriend> ?a3 .`);
    // Inside an inline filter: the outer subject's relation, read where its block binds it.
    expect(sparqlOf(Person.select((p) => p.friends.where((f) => p.friends.some((g) => g.bestFriend.equals(f as never))).name)))
      .toMatch(/FILTER\(EXISTS \{\n\s+\?a0 <[^>]*hasFriend> \?a2 \.[\s\S]*FILTER\(\?a2_bestFriend = \?a1\)/);
    expect(() => friendAlsoBestFriendsFriend().toJSON()).toThrow(/no DSL-JSON form yet/);
  });

  test('a condition chained inside a quantifier reads the outer subject too', () => {
    expect(sparqlOf(Person.select().where((p) =>
      p.friends.some((f) => f.friends.some((g) => g.name.equals('x')).and(f.name.equals(p.name))))))
      .toMatch(/\} && \?a1_name = \?a0_name\)/);
  });

  test('a path below the outer subject is traversed inside the EXISTS, from the subject', () => {
    const hop = sparqlOf(Person.select().where((p) => p.friends.some((f) => f.name.equals(p.bestFriend.name))));
    expect(hop).toContain(`?a0 <${PROP}bestFriend> ?a2 .`);
    expect(hop).toContain('FILTER(?a1_name = ?a2_name)');
    // `p.friends.name` is any friend's name: a traversal of its own, never the member.
    const relation = sparqlOf(Person.select().where((p) => p.friends.some((f) => f.name.equals(p.friends.name))));
    expect(relation).toContain(`?a0 <${PROP}hasFriend> ?a2 .`);
    expect(relation).toContain('FILTER(?a1_name = ?a2_name)');
  });

  test('a projected or sorted outer value keeps its own variable and top-level binding', () => {
    const sorted = sparqlOf(someNamesake().orderBy((p) => p.name));
    expect(sorted).toMatch(/\n  OPTIONAL \{\n    \?a0 <[^>]*name> \?a0_name \.\n  \}\n  FILTER\(EXISTS/);
    expect(sorted).toContain('FILTER(?a1_name = ?a0_name_2)');
    expect(sorted).toContain('ORDER BY DESC(BOUND(?a0_name)) ASC(?a0_name)');
  });

  test('inside an inline filter: the outer subject and the filter\'s member', () => {
    const outer = sparqlOf(friendsWithFriendNamedLikeMe());
    expect(outer).toMatch(/OPTIONAL \{\n    \?a0 <[^>]*hasFriend> \?a1 \.\n    FILTER\(EXISTS \{/);
    expect(outer).toContain('FILTER(?a2_name = ?a0_name)');
    const member = sparqlOf(friendsWithoutNamesakeFriend());
    expect(member).toContain('FILTER(!(EXISTS {');
    expect(member).toContain('FILTER(?a2_name = ?a1_name)');
  });

  test('inside a nested inline filter: the hop its block binds; a node further up is refused', () => {
    expect(sparqlOf(
      Person.select((p) => p.bestFriend.friends.where((f) => f.friends.some((g) => g.name.equals(p.name))).name),
    )).toContain('FILTER(?a3_name = ?a0_name)');
    expect(() => sparqlOf(
      Person.select((p) => p.bestFriend.bestFriend.friends.where((f) => f.friends.some((g) => g.name.equals(p.name))).name),
    )).toThrow(/more than one hop above the relation it filters/);
  });

  test('in a preloaded component, the component\'s subject (where the host preloads it)', () => {
    const component = (fn: (c: any) => unknown) => ({query: Person.select((c) => ({fr: fn(c)}))}) as never;
    expect(sparqlOf(Person.select((p) => p.bestFriend.preloadFor(component((c) =>
      c.friends.where((f: any) => f.friends.some((g: any) => g.name.equals(c.name))).name)))))
      .toContain('FILTER(?a3_name = ?a1_name)');
    expect(sparqlOf(Person.select((p) => p.bestFriend.preloadFor(component((c) =>
      c.friends.where((f: any) => c.friends.some((g: any) => g.bestFriend.equals(f))).name)))))
      .toMatch(/FILTER\(EXISTS \{\n\s+\?a1 <[^>]*hasFriend> \?a3 \.[\s\S]*FILTER\(\?a3_bestFriend = \?a2\)/);
  });

  test('a mutation where and an ask read the outer subject too', async () => {
    const del = deleteWhereToSparql(
      lower(DeleteBuilder.from(Person).where((p: any) => p.friends.some((f: any) => f.name.equals(p.name)))) as IRDeleteWhereMutation,
    );
    expect(del).toContain('FILTER(?a1_name = ?a0_name)');
    const upd = updateWhereToSparql(
      lower(UpdateBuilder.from(Person).set({hobby: 'x'}).where((p: any) => p.friends.none((f: any) => f.name.equals(p.name)))) as IRUpdateWhereMutation,
    );
    expect(upd).toContain('FILTER(?a1_name = ?a0_name)');
    expect(upd).not.toMatch(SELF_COMPARISON);
    const ask = askToSparql(await captureQuery(() => someNamesake().exists()) as IRAskQuery);
    expect(ask).toContain('FILTER(?a1_name = ?a0_name)');
  });

  test('a node of the query compared with a member: the outer subject, an enclosing member, a hop', () => {
    expect(sparqlOf(Person.select().where((p) => p.friends.some((f) => f.bestFriend.equals(p as never)))))
      .toContain('FILTER(?a1_bestFriend = ?a0)');
    expect(sparqlOf(Person.select().where((p) => p.friends.some((f) => f.friends.some((g) => g.equals(f as never))))))
      .toContain('FILTER(?a2 = ?a1)');
    // `p.friends.equals(x)` is `some((m) => m.equals(x))`: x is read from the subject.
    const hop = sparqlOf(Person.select().where((p) => p.friends.equals(p.bestFriend as never)));
    expect(hop).toContain(`?a0 <${PROP}bestFriend> ?a0_bestFriend .`);
    expect(hop).toContain('FILTER(?a1 = ?a0_bestFriend)');
    // Outside a quantifier too (it threw a circular-structure error before).
    expect(sparqlOf(Person.select().where((p) => p.bestFriend.equals(p as never))))
      .toContain('FILTER(?a0_bestFriend = ?a0)');
  });

  test('has no DSL-JSON form yet: toJSON refuses it', () => {
    expect(() => someNamesake().toJSON()).toThrow(/a quantifier that reads the outer subject[\s\S]*no DSL-JSON form yet/);
    expect(() => friendWithNamesakeFriend().toJSON()).toThrow(/no DSL-JSON form yet/);
  });

  test('a quantifier on its own member is unchanged', () => {
    expect(sparqlOf(Person.select().where((p) => p.friends.some((f) => f.name.equals('Moa')))))
      .toContain('FILTER(?a1_name = "Moa")');
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

describeFuseki('quantifiers reading the outer subject', () => {
  test('some / every / none', async () => {
    expect(await idsOf(someNamesake())).toEqual(['anna', 'bob']);
    // Vacuously true without friends; dirk has no name, so no friend contradicts it.
    expect(await idsOf(everyNamesake())).toEqual(['ann', 'bob', 'bob2', 'carl2', 'dirk', 'erik', 'eve2', 'jo']);
    expect(await idsOf(noneNamesake()))
      .toEqual(['ann', 'bob2', 'carl', 'carl2', 'dave', 'dirk', 'erik', 'eve', 'eve2', 'fay', 'gus', 'hal', 'ida', 'jo']);
  });

  test('a path below the outer subject', async () => {
    expect(await idsOf(Person.select().where((p) => p.friends.some((f) => f.name.equals(p.bestFriend.name)))))
      .toEqual(['dave', 'fay']);
  });

  test('a node compared with a member', async () => {
    expect(await idsOf(Person.select().where((p) => p.friends.equals(p.bestFriend as never)))).toEqual(['dave']);
    expect(await idsOf(Person.select().where((p) => p.friends.some((f) => f.bestFriend.equals(p as never))))).toEqual(['eve']);
  });

  test('nested quantifiers', async () => {
    expect(await idsOf(friendOfFriendNamesake())).toEqual(['carl', 'eve']);
    expect(await idsOf(friendAlsoBestFriendsFriend())).toEqual(['hal']);
    expect(await idsOf(friendWithNamesakeFriend())).toEqual(['anna', 'carl', 'dirk']);
  });

  test('inside an inline filter: every person kept', async () => {
    const friendsOf = (rows: ResultRow[]) => Object.fromEntries(
      rows.map((r) => [idOf(r), ((r.friends as ResultRow[] | undefined) ?? []).map(idOf).sort()]),
    );
    const outer = friendsOf(await run(friendsWithFriendNamedLikeMe()));
    expect(Object.keys(outer)).toHaveLength(16);
    expect(Object.entries(outer).filter(([, f]) => f.length > 0).sort()).toEqual([['carl', ['dave']], ['eve', ['fay']]]);
    const member = friendsOf(await run(friendsWithoutNamesakeFriend()));
    expect(member).toMatchObject({anna: ['ann'], bob: ['bob2'], carl: ['dave'], dirk: [], gus: ['eve'], hal: ['jo']});
  });
});
