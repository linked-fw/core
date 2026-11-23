/**
 * Select result types and runtime agree:
 * - a multi-valued literal (`string[]`, no maxCount) is typed as an array field of the row;
 * - the expression methods of a path (`isDefined()`, `strlen()`, …) are in its type, and run;
 * - a relation projected bare next to a where that traverses it returns its `{id}`;
 * - a relation field in the object form of select is a node reference (`{id}` / `{id}[]`), as in
 *   the array form, while a sub-select keeps the object of its selected fields.
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

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T | undefined => undefined;

const ENT = tmpEntityBase;
const PROP = propBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DATA = `
<${ENT}p1> <${RDF_TYPE}> <${personClass.id}> .
<${ENT}p1> <${PROP}name> "Semmy" .
<${ENT}p1> <${PROP}hobby> "Reading" .
<${ENT}p1> <${PROP}nickName> "Sem1" .
<${ENT}p1> <${PROP}nickName> "Sem" .
<${ENT}p1> <${PROP}bestFriend> <${ENT}p2> .
<${ENT}p1> <${PROP}hasFriend> <${ENT}p2> .
<${ENT}p1> <${PROP}hasFriend> <${ENT}p3> .
<${ENT}p2> <${RDF_TYPE}> <${personClass.id}> .
<${ENT}p2> <${PROP}name> "Moa" .
<${ENT}p2> <${PROP}bestFriend> <${ENT}p3> .
<${ENT}p3> <${RDF_TYPE}> <${personClass.id}> .
<${ENT}p3> <${PROP}name> "Jinx" .
`.trim();

const queries = {
  nickNames: () => Person.select((p) => [p.name, p.nickNames]),
  nickNamesKeyed: () => Person.select((p) => ({nicks: p.nickNames})),
  hobbyDefined: () => Person.select((p) => [p.name]).where((p) => p.hobby.isDefined()),
  hobbyNotDefined: () => Person.select((p) => [p.name]).where((p) => p.hobby.isNotDefined()),
  nameLanguage: () => Person.select((p) => [p.name]).where((p) => p.name.lang().equals('en')),
  nameLength: () => Person.select((p) => [p.name]).where((p) => p.name.strlen().gt(3)),
  bestFriendDefined: () => Person.select((p) => [p.name]).where((p) => p.bestFriend.isDefined()),
  bestFriendNotDefined: () => Person.select((p) => [p.name]).where((p) => p.bestFriend.isNotDefined()),
  bareRelationWithWhere: () =>
    Person.select((p) => [p.name, p.bestFriend]).where((p) => p.bestFriend.name.equals('Jinx')),
  keyedRelations: () => Person.select((p) => ({friend: p.bestFriend, all: p.friends, name: p.name})),
  keyedRelationOne: () => Person.select((p) => ({friend: p.bestFriend})).one(),
  keyedRelationsFor: () =>
    Person.select((p) => ({friend: p.bestFriend, all: p.friends})).for({id: `${ENT}p1`}),
  keyedRelationInSubSelect: () =>
    Person.select((p) => p.friends.select((f) => ({friend: f.bestFriend, name: f.name}))),
  keyedSubSelect: () =>
    Person.select((p) => ({info: p.bestFriend.select((bf) => ({friend: bf.bestFriend, name: bf.name}))})),
};

describe('select result types (compile-time)', () => {
  test('a multi-valued literal is an array field of the row', () => {
    type Row = Awaited<ReturnType<typeof queries.nickNames>>[number];
    assertType<Equals<Row['nickNames'], string[]>>();
    assertType<Equals<Row['name'], string>>();
    type Keyed = Awaited<ReturnType<typeof queries.nickNamesKeyed>>[number];
    assertType<Equals<Keyed['nicks'], string[]>>();
  });

  test('a bare relation is a node reference', () => {
    type Row = Awaited<ReturnType<typeof queries.bareRelationWithWhere>>[number];
    assertType<Equals<Row['bestFriend'], {id: string}>>();
  });

  test('a relation field in the object form is a node reference', () => {
    type Row = Awaited<ReturnType<typeof queries.keyedRelations>>[number];
    assertType<Equals<Row['friend'], {id: string}>>();
    assertType<Equals<Row['all'], {id: string}[]>>();
    assertType<Equals<Row['name'], string>>();
    // the row holds the friend's id only, not the shape's fields
    assertType<Equals<'name' extends keyof Row['friend'] ? true : false, false>>();
  });

  test('.one() and .for(id) keep the node reference', () => {
    type One = Awaited<ReturnType<typeof queries.keyedRelationOne>>;
    assertType<Equals<One['friend'], {id: string}>>();
    type For = Awaited<ReturnType<typeof queries.keyedRelationsFor>>;
    assertType<Equals<For['friend'], {id: string}>>();
    assertType<Equals<For['all'], {id: string}[]>>();
  });

  test('a relation field in the object of a sub-select is a node reference', () => {
    type Row = Awaited<ReturnType<typeof queries.keyedRelationInSubSelect>>[number];
    type Friend = Row['friends'][number];
    assertType<Equals<Friend['friend'], {id: string}>>();
    assertType<Equals<Friend['name'], string>>();
  });

  test('a sub-select keeps the object of its selected fields', () => {
    type Row = Awaited<ReturnType<typeof queries.keyedSubSelect>>[number];
    type Info = Row['info']['bestFriend'];
    assertType<Equals<Info['name'], string>>();
    assertType<Equals<Info['friend'], {id: string}>>();
  });
});

describe('expression methods on a path (unit)', () => {
  const sparqlOf = async (factory: () => unknown) =>
    selectToSparql((await captureQuery(factory as () => any)) as IRSelectQuery);

  test('isDefined / isNotDefined on a literal render BOUND', async () => {
    expect(await sparqlOf(queries.hobbyDefined)).toContain('FILTER(BOUND(?a0_hobby))');
    expect(await sparqlOf(queries.hobbyNotDefined)).toContain('FILTER(!(BOUND(?a0_hobby)))');
  });

  test('isDefined / isNotDefined on a relation render BOUND', async () => {
    expect(await sparqlOf(queries.bestFriendDefined)).toContain('FILTER(BOUND(?a0_bestFriend))');
    expect(await sparqlOf(queries.bestFriendNotDefined)).toContain('FILTER(!(BOUND(?a0_bestFriend)))');
  });

  test('RDF introspection methods are typed on a path', async () => {
    expect(await sparqlOf(queries.nameLanguage)).toContain('LANG(?a0_name)');
  });

  test('string methods chain', async () => {
    expect(await sparqlOf(queries.nameLength)).toContain('FILTER(STRLEN(?a0_name) > "3"^^xsd:integer)');
  });
});

describe('a bare relation next to a where that traverses it (unit)', () => {
  test('is read from the traversal variable', async () => {
    const ir = (await captureQuery(queries.bareRelationWithWhere)) as IRSelectQuery;
    const sparql = selectToSparql(ir);
    expect(sparql).toMatch(/SELECT DISTINCT \?a0 \?a0_name \?a1\b/);
    const rows = mapSparqlSelectResult(
      {
        head: {vars: ['a0', 'a0_name', 'a1']},
        results: {
          bindings: [
            {
              a0: {type: 'uri', value: `${ENT}p2`},
              a0_name: {type: 'literal', value: 'Moa'},
              a1: {type: 'uri', value: `${ENT}p3`},
            },
          ],
        },
      },
      ir,
    );
    expect(rows).toEqual([{id: `${ENT}p2`, name: 'Moa', bestFriend: {id: `${ENT}p3`}}]);
  });
});

describe('a relation field in the object form (unit)', () => {
  test('holds the node reference, one per value', async () => {
    const ir = (await captureQuery(queries.keyedRelations)) as IRSelectQuery;
    const sparql = selectToSparql(ir);
    expect(sparql).toMatch(/SELECT DISTINCT \?a0 \?a0_bestFriend \?a0_friends \?a0_name\b/);
    const binding = (friend: string) => ({
      a0: {type: 'uri' as const, value: `${ENT}p1`},
      a0_bestFriend: {type: 'uri' as const, value: `${ENT}p2`},
      a0_friends: {type: 'uri' as const, value: `${ENT}${friend}`},
      a0_name: {type: 'literal' as const, value: 'Semmy'},
    });
    const rows = mapSparqlSelectResult(
      {
        head: {vars: ['a0', 'a0_bestFriend', 'a0_friends', 'a0_name']},
        results: {bindings: [binding('p2'), binding('p3')]},
      },
      ir,
    ) as ResultRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].friend).toEqual({id: `${ENT}p2`});
    expect(rows[0].all).toEqual(expect.arrayContaining([{id: `${ENT}p2`}, {id: `${ENT}p3`}]));
    expect((rows[0].all as unknown[]).length).toBe(2);
    expect(rows[0].name).toBe('Semmy');
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

async function runLive(factory: () => unknown): Promise<ResultRow[]> {
  const ir = (await captureQuery(factory as () => any)) as IRSelectQuery;
  const rows = mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir);
  return (rows as ResultRow[]).slice().sort((a, b) => a.id.localeCompare(b.id));
}

describeFuseki('select result typing', () => {
  test('a multi-valued literal returns every value', async () => {
    const rows = await runLive(queries.nickNames);
    expect(rows.find((r) => r.id === `${ENT}p1`)?.nickNames).toEqual(expect.arrayContaining(['Sem1', 'Sem']));
    expect(rows.find((r) => r.id === `${ENT}p2`)?.nickNames).toEqual([]);
  });

  test('isDefined / isNotDefined filter on a literal', async () => {
    expect((await runLive(queries.hobbyDefined)).map((r) => r.name)).toEqual(['Semmy']);
    expect((await runLive(queries.hobbyNotDefined)).map((r) => r.name)).toEqual(['Moa', 'Jinx']);
  });

  test('isDefined / isNotDefined filter on a relation', async () => {
    expect((await runLive(queries.bestFriendDefined)).map((r) => r.name)).toEqual(['Semmy', 'Moa']);
    expect((await runLive(queries.bestFriendNotDefined)).map((r) => r.name)).toEqual(['Jinx']);
  });

  test('a bare relation next to a where that traverses it returns its id', async () => {
    expect(await runLive(queries.bareRelationWithWhere)).toEqual([
      {id: `${ENT}p2`, name: 'Moa', bestFriend: {id: `${ENT}p3`}},
    ]);
  });

  test('a relation field in the object form returns node references', async () => {
    const rows = await runLive(queries.keyedRelations);
    const p1 = rows.find((r) => r.id === `${ENT}p1`);
    expect(p1?.friend).toEqual({id: `${ENT}p2`});
    expect(p1?.all).toEqual(expect.arrayContaining([{id: `${ENT}p2`}, {id: `${ENT}p3`}]));
    expect((p1?.all as unknown[]).length).toBe(2);
    expect(rows.find((r) => r.id === `${ENT}p3`)?.all).toEqual([]);
  });

  test('a relation field in the object of a sub-select returns a node reference', async () => {
    const rows = await runLive(queries.keyedRelationInSubSelect);
    const friends = rows.find((r) => r.id === `${ENT}p1`)?.friends as ResultRow[];
    expect(friends.find((f) => f.id === `${ENT}p2`)).toEqual({id: `${ENT}p2`, name: 'Moa', friend: {id: `${ENT}p3`}});
  });
});
