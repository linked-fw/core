/**
 * Sort and leaf path edges: a sort on a computed expression, a filter on a sort path, a
 * multi-valued leaf straight under a multi-valued traversal (`p.friends.nickNames`), and a
 * quantifier inside a quantifier (`p.friends.some(f => f.$type().equals(C))`). Sorting follows
 * the rules of `select-order-missing-last.test.ts`: missing values last in both directions, MIN
 * ascending / MAX descending per subject when paging, ties broken by the subject IRI.
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, tmpEntityBase, personClass, propBase} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {Expr} from '../expressions/Expr';
import {fromJSON} from '../queries/fromJSON';
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
const node = (
  id: string,
  o: {person?: boolean; name: string; hobby?: string; friends?: string[]; nicks?: string[]},
) =>
  [
    ...(o.person ? [`<${ENT}${id}> <${RDF_TYPE}> <${personClass.id}> .`] : []),
    `<${ENT}${id}> <${PROP}name> "${o.name}" .`,
    ...(o.hobby ? [`<${ENT}${id}> <${PROP}hobby> "${o.hobby}" .`] : []),
    ...(o.friends ?? []).map((f) => `<${ENT}${id}> <${PROP}hasFriend> <${ENT}${f}> .`),
    ...(o.nicks ?? []).map((n) => `<${ENT}${id}> <${PROP}nickName> "${n}" .`),
  ].join('\n');

// Persons: Anna (hobby Chess, friends Carl and Dirk), Carl (hobby Archery, friend Anna, nick
// names K, L), Dirk (friend Bob, nick names X, Y). Bob (nick names C, D) is not a person.
const DATA = [
  node('anna', {person: true, name: 'Anna', hobby: 'Chess', friends: ['carl', 'dirk'], nicks: ['N']}),
  node('carl', {person: true, name: 'Carl', hobby: 'Archery', friends: ['anna'], nicks: ['K', 'L']}),
  node('dirk', {person: true, name: 'Dirk', friends: ['bob'], nicks: ['X', 'Y']}),
  node('bob', {name: 'Bob', nicks: ['C', 'D']}),
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const roundTrip = (q: {toJSON(): unknown}) => fromJSON(JSON.parse(JSON.stringify(q.toJSON())) as never);
const run = async (q: unknown) => {
  const ir = irOf(q);
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir);
};
const ids = (rows: unknown) => (rows as ResultRow[]).map((r) => String(r.id).replace(ENT, ''));
const PERSON = {id: personClass.id};

// --- 1. A computed sort key ---------------------------------------------------------------

const byHobbyLength = (d: 'ASC' | 'DESC') => Person.select((p) => p.name).orderBy((p) => p.hobby.strlen(), d);

describe('orderBy on a computed expression (lowering, wire)', () => {
  test('sorts by the expression, bound first', () => {
    const sparql = sparqlOf(byHobbyLength('ASC'));
    expect(sparql).toMatch(/BIND\(STRLEN\(\?a0_hobby\) AS \?(\w+)\)[\s\S]*ORDER BY DESC\(BOUND\(\?\1\)\) ASC\(\?\1\)$/);
  });

  test('paged: MIN ascending, MAX descending of the expression per subject', () => {
    const sparql = sparqlOf(
      Person.select((p) => [p.name, p.nickNames]).orderBy((p) => p.hobby.strlen(), 'DESC').limit(2),
    );
    expect(sparql).toMatch(/\(MAX\(STRLEN\(\?a0_hobby\)\) AS \?page_order_0\)/);
  });

  test('an expression with an aggregate is refused, as an aggregate is', () => {
    expect(() => sparqlOf(Person.select((p) => p.name).orderBy((p) => p.hobby.strlen().plus(Expr.count())))).toThrow(
      /cannot sort by an aggregate/,
    );
  });

  test('round-trips through DSL-JSON', () => {
    const q = Person.select((p) => p.name).orderBy((p) => [p.name, p.hobby.strlen()], 'DESC');
    const json = q.toJSON() as {sortBy: unknown[]};
    expect(json.sortBy[1]).toEqual({value: ['STRLEN', {'@path': 'hobby'}], direction: 'DESC'});
    expect(sparqlOf(roundTrip(q))).toBe(sparqlOf(q));
  });
});

// --- 2. A filter on a sort path -----------------------------------------------------------

const byAnnasHobby = (d: 'ASC' | 'DESC') =>
  Person.select((p) => p.name)
    .orderBy((p) => p.friends.where((f) => f.name.equals('Anna')).hobby, d)
    .limit(3);

describe('a filter on a sort path (lowering, wire)', () => {
  test('the filter is in the sort key\'s OPTIONAL block', () => {
    const sparql = sparqlOf(byAnnasHobby('ASC'));
    expect(sparql).toMatch(/OPTIONAL \{[^}]*hasFriend[\s\S]*FILTER\([^)]*"Anna"/);
  });

  test('a sort path does not share the traversal of a filtered projection', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.friends.where((f) => f.name.equals('Anna')).name).orderBy((p) => p.friends.hobby),
    );
    // Two traversals of hasFriend: the projection's (filtered) and the sort key's.
    expect(sparql.match(/hasFriend> \?a\d+ \./g)).toHaveLength(2);
  });

  test('a filter on a later segment is refused: it would make the hops before it required', () => {
    expect(() =>
      sparqlOf(Person.select((p) => p.name).orderBy((p) => p.friends.friends.where((f) => f.name.equals('A')).hobby)),
    ).toThrow(/first segment only/);
  });

  test('a wire filter on another segment than the first is refused, not dropped', () => {
    for (const whereIndex of [1, 7, -1]) {
      const json = {
        ...(byAnnasHobby('ASC').toJSON() as object),
        sortBy: [{'friends.hobby': {direction: 'ASC', where: {name: 'Anna'}, whereIndex}}],
      };
      expect(() => sparqlOf(fromJSON(json as never))).toThrow(/first segment only/);
    }
  });

  test('filters on two segments of one sort path are refused (by where(), as everywhere)', () => {
    expect(() =>
      sparqlOf(
        Person.select((p) => p.name).orderBy(
          (p) => p.friends.where((f) => f.name.equals('A')).friends.where((g) => g.name.equals('B')).hobby,
        ),
      ),
    ).toThrow(/cannot call where\(\) from within a where\(\)/);
  });

  test('round-trips through DSL-JSON', () => {
    const q = byAnnasHobby('DESC');
    const json = q.toJSON() as {sortBy: unknown[]};
    expect(json.sortBy[0]).toEqual({
      'friends.hobby': {direction: 'DESC', where: {name: 'Anna'}, whereIndex: 0},
    });
    expect(sparqlOf(roundTrip(q))).toBe(sparqlOf(q));
  });
});

// --- 3. A multi-valued leaf under a multi-valued traversal --------------------------------

describe('p.friends.nickNames (lowering)', () => {
  test('is the same select as p.friends.select(f => f.nickNames)', () => {
    expect(sparqlOf(Person.select((p) => p.friends.nickNames))).toBe(
      sparqlOf(Person.select((p) => p.friends.select((f) => f.nickNames))),
    );
  });
});

// --- 5. A quantifier inside a quantifier --------------------------------------------------

const friendIsPerson = () => Person.select((p) => p.name).where((p) => p.friends.some((f) => f.$type().equals(PERSON)));

describe('a quantifier inside a quantifier (lowering, wire)', () => {
  test('lowers to an EXISTS inside an EXISTS', () => {
    expect(sparqlOf(friendIsPerson())).toMatch(/FILTER\(EXISTS \{[^}]*hasFriend> \?a1 \.\s*FILTER\(EXISTS \{\s*\?a1 rdf:type \?a2/);
  });

  test('every() with an inner quantifier lowers', () => {
    expect(() =>
      sparqlOf(Person.select((p) => p.name).where((p) => p.friends.every((f) => f.$type().equals(PERSON)))),
    ).not.toThrow();
  });

  test('every() over a chained inner quantifier negates the whole chain', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.name).where((p) =>
        p.friends.every((f) => f.$type().equals(PERSON).and(f.name.equals('Anna'))),
      ),
    );
    // NOT EXISTS(friend, NOT(type is Person AND name = Anna)) = NOT EXISTS(friend, no type is
    // Person OR name != Anna).
    expect(sparql).toMatch(/FILTER\(!\(EXISTS \{[\s\S]*FILTER\(!\(EXISTS \{[\s\S]*\|\|[\s\S]*!\(\?a1_name = "Anna"\)/);
  });

  test('a quantifier\'s condition reads back against the member shape', () => {
    const q = Person.select((p) => p.name).where((p) => p.pets.some((pt) => pt.bestFriend.equals({id: `${ENT}rex`})));
    expect(sparqlOf(roundTrip(q))).toBe(sparqlOf(q));
  });

  test('round-trips through DSL-JSON (some, none, every, chained)', () => {
    const qs = [
      friendIsPerson(),
      Person.select((p) => p.name).where((p) => p.friends.none((f) => f.$type().equals(PERSON))),
      Person.select((p) => p.name).where((p) => p.friends.every((f) => f.$type().equals(PERSON))),
      Person.select((p) => p.name).where((p) =>
        p.friends.some((f) => f.$type().equals(PERSON).and(f.name.equals('Carl'))),
      ),
      Person.select((p) => p.name).where((p) => p.friends.some((f) => f.friends.some((g) => g.name.equals('Anna')))),
      Person.select((p) => p.name).where((p) =>
        p.friends.every((f) => f.$type().equals(PERSON).and(f.name.equals('Anna'))),
      ),
    ];
    for (const q of qs) expect(sparqlOf(roundTrip(q))).toBe(sparqlOf(q));
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

describeFuseki('sort and leaf path edges', () => {
  test('computed sort key: ASC Anna (5), Carl (7), Dirk; DESC Carl, Anna, Dirk', async () => {
    expect(ids(await run(byHobbyLength('ASC')))).toEqual(['anna', 'carl', 'dirk']);
    expect(ids(await run(byHobbyLength('DESC')))).toEqual(['carl', 'anna', 'dirk']);
  });

  test('computed sort key, paged', async () => {
    const q = (d: 'ASC' | 'DESC', offset: number) =>
      Person.select((p) => [p.name, p.nickNames]).orderBy((p) => p.hobby.strlen(), d).limit(2).offset(offset);
    expect([...ids(await run(q('ASC', 0))), ...ids(await run(q('ASC', 2)))]).toEqual(['anna', 'carl', 'dirk']);
    expect([...ids(await run(q('DESC', 0))), ...ids(await run(q('DESC', 2)))]).toEqual(['carl', 'anna', 'dirk']);
  });

  test('filtered sort path: only Carl has a friend Anna; the others are kept, last', async () => {
    expect(ids(await run(byAnnasHobby('ASC')))).toEqual(['carl', 'anna', 'dirk']);
    expect(ids(await run(byAnnasHobby('DESC')))).toEqual(['carl', 'anna', 'dirk']);
  });

  test('paged, a subject with a friend with a hobby and one without sorts by the hobby', async () => {
    // Friends' hobbies: Anna → Archery (Carl) and none (Dirk), Carl → Chess, Dirk → none.
    const q = (d: 'ASC' | 'DESC') => Person.select((p) => p.name).orderBy((p) => p.friends.hobby, d).limit(3);
    expect(ids(await run(q('ASC')))).toEqual(['anna', 'carl', 'dirk']);
    expect(ids(await run(q('DESC')))).toEqual(['carl', 'anna', 'dirk']);
  });

  test('unfiltered sort path next to a filtered projection sorts by every friend', async () => {
    // Friends' hobbies: Anna → Archery (Carl), Carl → Chess (Anna), Dirk → none.
    const q = Person.select((p) => p.friends.where((f) => f.name.equals('Anna')).name)
      .orderBy((p) => p.friends.hobby)
      .limit(3);
    const rows = (await run(q)) as ResultRow[];
    expect(ids(rows)).toEqual(['anna', 'carl', 'dirk']);
    expect(ids(rows.find((r) => String(r.id).endsWith('carl'))!.friends)).toEqual(['anna']);
  });

  test('p.friends.nickNames keeps every friend and every nick name', async () => {
    const row = (await run(Person.select((p) => p.friends.nickNames).for({id: `${ENT}anna`}))) as ResultRow;
    const friends = (row.friends as ResultRow[]).map((f) => [ids([f])[0], [...(f.nickNames as string[])].sort()]);
    expect(friends.sort()).toEqual([['carl', ['K', 'L']], ['dirk', ['X', 'Y']]]);
  });

  test('some friend is a Person: Anna, Carl; no friend is: Dirk', async () => {
    expect(ids(await run(friendIsPerson())).sort()).toEqual(['anna', 'carl']);
    const none = Person.select((p) => p.name).where((p) => p.friends.none((f) => f.$type().equals(PERSON)));
    expect(ids(await run(none))).toEqual(['dirk']);
    const every = Person.select((p) => p.name).where((p) => p.friends.every((f) => f.$type().equals(PERSON)));
    expect(ids(await run(every)).sort()).toEqual(['anna', 'carl']);
  });

  test('every friend is a Person named Anna: Carl only', async () => {
    const q = Person.select((p) => p.name).where((p) =>
      p.friends.every((f) => f.$type().equals(PERSON).and(f.name.equals('Anna'))),
    );
    expect(ids(await run(q))).toEqual(['carl']);
    expect(ids(await run(roundTrip(q)))).toEqual(['carl']);
  });

  test('an inner quantifier chained with a condition, and two levels of some', async () => {
    const carl = Person.select((p) => p.name).where((p) =>
      p.friends.some((f) => f.$type().equals(PERSON).and(f.name.equals('Carl'))),
    );
    expect(ids(await run(carl))).toEqual(['anna']);
    const friendOfAnna = Person.select((p) => p.name).where((p) =>
      p.friends.some((f) => f.friends.some((g) => g.name.equals('Anna'))),
    );
    expect(ids(await run(friendOfAnna))).toEqual(['anna']);
  });
});
