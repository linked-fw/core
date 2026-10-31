/**
 * Grouped selects: `select((s) => ({…keys, …aggregates})).where(…).groupBy('key', …)`, with
 * `having`, `orderBy`, `limit`, `offset` over the result fields, and the aggregates
 * `Expr.count()`, `.countDistinct()`, `.min()`, `.max()` (and `.size()`).
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, tmpEntityBase, personClass, propBase} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
import {selectToSparql} from '../sparql/irToAlgebra';
import {mapSparqlSelectResult} from '../sparql/resultMapping';
import type {IRSelectQuery, ResultRow} from '../queries/IntermediateRepresentation';
import {createTestDataset, loadTestData, executeSparqlQuery, clearAllData} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import {Expr} from '../expressions/Expr';
import {GroupedSelectBuilder, type GroupByError} from '../queries/GroupedSelectBuilder';
import {SelectBuilder} from '../queries/QueryBuilder';
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import type {IDataset} from '../interfaces/IDataset';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {LinkedStorage} from '../utils/LinkedStorage';
import '../ontologies/rdf';
import '../ontologies/xsd';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T | undefined => undefined;

const ENT = tmpEntityBase;
const PROP = propBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DT = 'http://www.w3.org/2001/XMLSchema#dateTime';
const DATA = `
<${ENT}p1> <${RDF_TYPE}> <${personClass.id}> .
<${ENT}p1> <${PROP}hobby> "Reading" .
<${ENT}p1> <${PROP}bestFriend> <${ENT}p2> .
<${ENT}p1> <${PROP}birthDate> "1990-01-01T00:00:00Z"^^<${XSD_DT}> .
<${ENT}p1> <${PROP}hasFriend> <${ENT}p2> .
<${ENT}p1> <${PROP}hasFriend> <${ENT}p3> .
<${ENT}p1> <${PROP}nickName> "A" .
<${ENT}p1> <${PROP}nickName> "B" .
<${ENT}p2> <${RDF_TYPE}> <${personClass.id}> .
<${ENT}p2> <${PROP}hobby> "Reading" .
<${ENT}p2> <${PROP}bestFriend> <${ENT}p3> .
<${ENT}p2> <${PROP}birthDate> "1995-01-01T00:00:00Z"^^<${XSD_DT}> .
<${ENT}p2> <${PROP}hasFriend> <${ENT}p3> .
<${ENT}p3> <${RDF_TYPE}> <${personClass.id}> .
<${ENT}p3> <${PROP}hobby> "Chess" .
<${ENT}p3> <${PROP}birthDate> "2000-01-01T00:00:00Z"^^<${XSD_DT}> .
<${ENT}p4> <${RDF_TYPE}> <${personClass.id}> .
<${ENT}p4> <${PROP}bestFriend> <${ENT}p3> .
<${ENT}p4> <${PROP}birthDate> "2005-01-01T00:00:00Z"^^<${XSD_DT}> .
`.trim();

const queries = {
  countPerHobby: () => Person.select((p) => ({hobby: p.hobby, n: Expr.count()})).groupBy('hobby'),
  countHaving: () =>
    Person.select((p) => ({hobby: p.hobby, n: Expr.count()}))
      .groupBy('hobby')
      .having('n', (n) => n.gt(1)),
  latestPerFriend: () =>
    Person.select((p) => ({friend: p.bestFriend, last: p.birthDate.max()}))
      .groupBy('friend')
      .orderBy('last', 'DESC'),
  nestedKey: () =>
    Person.select((p) => ({friendHobby: p.bestFriend.hobby, n: Expr.count()})).groupBy('friendHobby'),
  pluralKey: () => Person.select((p) => ({nick: p.nickNames, n: Expr.count()})).groupBy('nick'),
  sizeInGroup: () => Person.select((p) => ({hobby: p.hobby, friends: p.friends.size()})).groupBy('hobby'),
  distinctHobbies: () =>
    Person.select((p) => ({friend: p.bestFriend, hobbies: p.hobby.countDistinct()})).groupBy('friend'),
  filteredMembers: () =>
    Person.select((p) => ({hobby: p.hobby, first: p.birthDate.min()}))
      .where((p) => p.hobby.isDefined())
      .groupBy('hobby')
      .orderBy('hobby'),
  twoKeys: () =>
    Person.select((p) => ({hobby: p.hobby, friend: p.bestFriend, n: Expr.count()})).groupBy('hobby', 'friend'),
  perNode: () =>
    Person.select((p) => ({person: p, n: p.friends.size()}))
      .groupBy('person')
      .orderBy('n', 'DESC')
      .limit(2),
  minPerRow: () => Person.select((p) => ({first: p.nickNames.min()})),
};

describe('grouped select types (compile-time)', () => {
  test('a row holds the keys and the aggregates, and no id', () => {
    type Row = Awaited<ReturnType<typeof queries.countPerHobby>>[number];
    assertType<Equals<Row, {hobby: string; n: number}>>();
    type Latest = Awaited<ReturnType<typeof queries.latestPerFriend>>[number];
    assertType<Equals<Latest['last'], Date>>();
    assertType<Equals<Latest['friend'], {id: string}>>();
  });

  test('a key over a multi-valued path is one of its values', () => {
    type Row = Awaited<ReturnType<typeof queries.pluralKey>>[number];
    assertType<Equals<Row['nick'], string>>();
  });

  test('size(), countDistinct() and min() are numbers / the value type', () => {
    type Sizes = Awaited<ReturnType<typeof queries.sizeInGroup>>[number];
    assertType<Equals<Sizes['friends'], number>>();
    type Distinct = Awaited<ReturnType<typeof queries.distinctHobbies>>[number];
    assertType<Equals<Distinct['hobbies'], number>>();
    type PerRow = Awaited<ReturnType<typeof queries.minPerRow>>[number];
    assertType<Equals<PerRow['first'], string>>();
  });

  test('a field that is neither key nor aggregate is a type error', () => {
    const missing = () =>
      Person.select((p) => ({hobby: p.hobby, name: p.name, n: Expr.count()})).groupBy('hobby');
    type Missing = ReturnType<typeof missing>;
    assertType<Equals<Missing, GroupByError<'every field that is not an aggregate must be a group key; missing: name'>>>();
    const aggregateKey = () => Person.select((p) => ({hobby: p.hobby, n: Expr.count()})).groupBy('hobby', 'n');
    assertType<ReturnType<typeof aggregateKey> extends GroupByError<string> ? true : false>();
  });

  test('groupBy is refused after .for(id) and on the array form', () => {
    const single = () => Person.select((p) => ({hobby: p.hobby})).for({id: `${ENT}p1`}).groupBy('hobby');
    assertType<ReturnType<typeof single> extends GroupByError<string> ? true : false>();
  });

  test('the grouped builder has no where, for or one', () => {
    type G = ReturnType<typeof queries.countPerHobby>;
    assertType<Equals<'where' extends keyof G ? true : false, false>>();
    assertType<Equals<'for' extends keyof G ? true : false, false>>();
    assertType<Equals<'one' extends keyof G ? true : false, false>>();
  });
});

const sparqlOf = async (factory: () => unknown) =>
  selectToSparql((await captureQuery(factory as () => any)) as IRSelectQuery);

describe('grouped select SPARQL (unit)', () => {
  test('count per key: GROUP BY the key, no root, members counted distinct', async () => {
    const sparql = await sparqlOf(queries.countPerHobby);
    expect(sparql).toMatch(/SELECT \?a0_hobby \(COUNT\(DISTINCT \?a0\) AS \?\w+\)/);
    expect(sparql).toMatch(/GROUP BY \?a0_hobby\s*$/);
    expect(sparql).not.toContain('DISTINCT ?a0_hobby');
  });

  test('having lowers to HAVING over the aggregate', async () => {
    expect(await sparqlOf(queries.countHaving)).toMatch(/HAVING\(COUNT\(DISTINCT \?a0\) > "1"\^\^xsd:integer\)/);
  });

  test('max per group, ordered by the aggregate', async () => {
    const sparql = await sparqlOf(queries.latestPerFriend);
    expect(sparql).toMatch(/\(MAX\(\?a0_birthDate\) AS \?\w+\)/);
    expect(sparql).toContain('GROUP BY ?a0_bestFriend');
    expect(sparql).toContain('ORDER BY DESC(MAX(?a0_birthDate))');
  });

  test('a nested path key groups by the traversed value only', async () => {
    const sparql = await sparqlOf(queries.nestedKey);
    expect(sparql).toMatch(/GROUP BY \?a1_hobby\s*$/);
    expect(sparql).not.toMatch(/SELECT[^\n]*\?a1 /);
  });

  test('the IR carries groupBy and requires', async () => {
    const ir = (await captureQuery(queries.latestPerFriend as () => any)) as IRSelectQuery;
    expect(ir.groupBy).toHaveLength(1);
    expect(ir.requires).toEqual(['groupBy', 'max']);
    const plain = (await captureQuery(() => Person.select((p) => p.name) as any)) as IRSelectQuery;
    expect(plain.requires).toBeUndefined();
    expect(plain.groupBy).toBeUndefined();
  });

  test('result mapping: keys and aggregates, a node key as {id}, an unbound key as null', async () => {
    const ir = (await captureQuery(queries.latestPerFriend as () => any)) as IRSelectQuery;
    const lastAlias = ir.resultMap!.find((e) => e.key === 'last')!.alias;
    const rows = mapSparqlSelectResult(
      {
        head: {vars: ['a0_bestFriend', lastAlias]},
        results: {
          bindings: [
            {a0_bestFriend: {type: 'uri', value: `${ENT}p3`}, [lastAlias]: {type: 'literal', value: '2005-01-01T00:00:00Z', datatype: XSD_DT}},
            {[lastAlias]: {type: 'literal', value: '2000-01-01T00:00:00Z', datatype: XSD_DT}},
          ],
        },
      },
      ir,
    );
    expect(rows).toEqual([
      {friend: {id: `${ENT}p3`}, last: new Date('2005-01-01T00:00:00Z')},
      {friend: null, last: new Date('2000-01-01T00:00:00Z')},
    ]);
  });
});

describe('groupBy refusals (runtime)', () => {
  test('a field that is neither key nor aggregate', () => {
    expect(() =>
      (Person.select((p) => ({hobby: p.hobby, name: p.name, n: Expr.count()})) as any).groupBy('hobby'),
    ).toThrow(/the field "name" is neither a group key nor an aggregate/);
  });

  test('the array form', () => {
    expect(() => (Person.select((p) => [p.hobby, Expr.count()]) as any).groupBy('hobby')).toThrow(
      /needs the object form of select/,
    );
  });

  test('an orderBy on the members', () => {
    expect(() =>
      (Person.select((p) => ({hobby: p.hobby, n: Expr.count()})).orderBy((p) => p.name) as any).groupBy('hobby'),
    ).toThrow(/already sorts its members/);
  });

  test('after .for(id) or .one()', () => {
    expect(() => (Person.select((p) => ({hobby: p.hobby})).one() as any).groupBy('hobby')).toThrow(
      /cannot follow .for\(id\) or .one\(\)/,
    );
  });

  test('a nested select field', () => {
    expect(() =>
      (Person.select((p) => ({hobby: p.hobby, friends: p.friends.select((f) => [f.name])})) as any).groupBy('hobby'),
    ).toThrow(/is a nested select/);
  });

  test('orderBy and having over a name that is not a field', () => {
    const grouped = queries.countPerHobby() as any;
    expect(() => grouped.orderBy('nope')).toThrow(/"nope" is not a field of the select/);
    expect(() => grouped.having('nope', (x: any) => x.gt(1))).toThrow(/"nope" is not a field of the select/);
  });

  test('an ungrouped orderBy over an aggregate', async () => {
    await expect(Person.select((p) => p.name).orderBy((p) => p.friends.size() as any)).rejects.toThrow(
      /cannot sort by an aggregate/,
    );
  });
});

describe('grouped select on the wire', () => {
  test('toJSON carries op, requires and the grouping', () => {
    const json = queries.countHaving().toJSON();
    expect(json.op).toBe('select');
    expect(json.requires).toEqual(['groupBy']);
    expect(json.groupBy).toEqual(['hobby']);
    expect(json.having).toBeDefined();
    expect(queries.latestPerFriend().toJSON().groupOrderBy).toEqual([{field: 'last', direction: 'DESC'}]);
  });

  test('a select with min/max carries op and requires; a plain select does not', () => {
    const json = queries.minPerRow().toJSON();
    expect(json.op).toBe('select');
    expect(json.requires).toEqual(['min']);
    const plain = Person.select((p) => p.name).toJSON();
    expect(plain.op).toBeUndefined();
    expect(plain.requires).toBeUndefined();
  });

  test('round trip: fromJSON rebuilds the grouped select, lowering to the same SPARQL', () => {
    for (const factory of [queries.countHaving, queries.latestPerFriend, queries.nestedKey, queries.perNode]) {
      const original = factory();
      const rebuilt = fromJSON(JSON.parse(JSON.stringify(original.toJSON())) as never);
      expect(rebuilt).toBeInstanceOf(GroupedSelectBuilder);
      expect(selectToSparql(lower(rebuilt as never) as IRSelectQuery)).toBe(
        selectToSparql(lower(original as never) as IRSelectQuery),
      );
    }
  });

  test('a received envelope with a stray field is refused', () => {
    const json = {...queries.countPerHobby().toJSON(), groupBy: ['hobby', 'n']};
    expect(() => SelectBuilder.fromJSON(json as never)).toThrow(/aggregate and cannot be a group key/);
  });
});

describe('stores that do not declare the features', () => {
  const legacy: IDataset = {
    selectQuery: async () => [],
    createQuery: async () => ({}) as never,
    updateQuery: async () => ({}) as never,
    deleteQuery: async () => ({deleted: [], count: 0}),
    graphQuery: async () => ({}) as never,
  };

  test('a grouped select is refused before it is sent', async () => {
    let sent = false;
    const store = {...legacy, selectQuery: async () => ((sent = true), [])};
    await expect(queries.countPerHobby().exec(store)).rejects.toThrow(/uses 'groupBy', which the dataset/);
    expect(sent).toBe(false);
  });

  test('a select with max is refused; a plain select is not', async () => {
    await expect(queries.minPerRow().exec(legacy)).rejects.toThrow(/uses 'min'/);
    await expect(Person.select((p) => p.name).exec(legacy)).resolves.toEqual([]);
  });

  test('a store that declares them is sent the query', async () => {
    const store = {...legacy, supports: ['groupBy' as const, 'min' as const, 'max' as const]};
    await expect(queries.countPerHobby().exec(store)).resolves.toEqual([]);
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
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir) as ResultRow[];
}

/** Rows sorted by a key's value (a node by its id), the null group last. */
const byKey = (rows: ResultRow[], key: string) => {
  const sortKey = (row: ResultRow) => {
    const value = (row as Record<string, any>)[key];
    return value === null ? '\uffff' : String(value?.id ?? value);
  };
  return [...rows].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
};

describeFuseki('grouped selects', () => {
  test('count per key, with a null group for members without it', async () => {
    expect(byKey(await runLive(queries.countPerHobby), 'hobby')).toEqual([
      {hobby: 'Chess', n: 1},
      {hobby: 'Reading', n: 2},
      {hobby: null, n: 1},
    ]);
  });

  test('having keeps the groups the condition holds for', async () => {
    expect(await runLive(queries.countHaving)).toEqual([{hobby: 'Reading', n: 2}]);
  });

  test('max per group, sorted by it', async () => {
    expect(await runLive(queries.latestPerFriend)).toEqual([
      {friend: {id: `${ENT}p3`}, last: new Date('2005-01-01T00:00:00Z')},
      {friend: null, last: new Date('2000-01-01T00:00:00Z')},
      {friend: {id: `${ENT}p2`}, last: new Date('1990-01-01T00:00:00Z')},
    ]);
  });

  test('a nested path key', async () => {
    expect(byKey(await runLive(queries.nestedKey), 'friendHobby')).toEqual([
      {friendHobby: 'Chess', n: 2},
      {friendHobby: 'Reading', n: 1},
      {friendHobby: null, n: 1},
    ]);
  });

  test('a multi-valued key: each value its own group', async () => {
    expect(byKey(await runLive(queries.pluralKey), 'nick')).toEqual([
      {nick: 'A', n: 1},
      {nick: 'B', n: 1},
      {nick: null, n: 3},
    ]);
  });

  test('size() and countDistinct() over a group count distinct values', async () => {
    expect(byKey(await runLive(queries.sizeInGroup), 'hobby')).toEqual([
      {hobby: 'Chess', friends: 0},
      {hobby: 'Reading', friends: 2},
      {hobby: null, friends: 0},
    ]);
    expect(byKey(await runLive(queries.distinctHobbies), 'friend')).toEqual([
      {friend: {id: `${ENT}p2`}, hobbies: 1},
      {friend: {id: `${ENT}p3`}, hobbies: 1},
      {friend: null, hobbies: 1},
    ]);
  });

  test('where filters the members before grouping; min per group', async () => {
    expect(await runLive(queries.filteredMembers)).toEqual([
      {hobby: 'Chess', first: new Date('2000-01-01T00:00:00Z')},
      {hobby: 'Reading', first: new Date('1990-01-01T00:00:00Z')},
    ]);
  });

  test('two keys', async () => {
    const rows = await runLive(queries.twoKeys);
    expect(rows).toHaveLength(4);
    expect(rows).toContainEqual({hobby: 'Reading', friend: {id: `${ENT}p2`}, n: 1});
    expect(rows).toContainEqual({hobby: null, friend: {id: `${ENT}p3`}, n: 1});
  });

  test('the root as a key, sorted by an aggregate, limited', async () => {
    expect(await runLive(queries.perNode)).toEqual([
      {person: {id: `${ENT}p1`}, n: 2},
      {person: {id: `${ENT}p2`}, n: 1},
    ]);
  });

  test('an ungrouped select: min per row', async () => {
    const rows = await runLive(queries.minPerRow);
    expect(rows.find((r) => r.id === `${ENT}p1`)).toEqual({id: `${ENT}p1`, first: 'A'});
  });
});

/** A SPARQL store on the test dataset: the full path, lowering and mapping included. */
class LiveStore extends SparqlDataset {
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    return executeSparqlQuery(sparql);
  }
  protected async executeSparqlUpdate(): Promise<void> {
    throw new Error('read-only');
  }
}

describeFuseki('grouped selects through a store', () => {
  test('exec on a SparqlDataset', async () => {
    expect(await queries.countHaving().exec(new LiveStore())).toEqual([{hobby: 'Reading', n: 2}]);
  });

  test('through LinkedStorage, which checks the routed dataset', async () => {
    LinkedStorage.setDefaultDataset(new LiveStore());
    expect(await queries.latestPerFriend().limit(1)).toEqual([
      {friend: {id: `${ENT}p3`}, last: new Date('2005-01-01T00:00:00Z')},
    ]);
    const legacy = {
      selectQuery: async () => [],
      createQuery: async () => ({}) as never,
      updateQuery: async () => ({}) as never,
      deleteQuery: async () => ({deleted: [], count: 0}),
      graphQuery: async () => ({}) as never,
    };
    LinkedStorage.setDefaultDataset(legacy);
    await expect(queries.countPerHobby()).rejects.toThrow(/uses 'groupBy', which the dataset it was sent to/);
  });
});
