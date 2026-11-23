/**
 * The object form of select: a key names a top-level field of the object it is written in (the
 * root row, or a sub-select's member row), holding the expression's yield. Intermediate hops never
 * appear in the row; a keyed sub-select or preload holds its member rows; the subject as a field
 * is `{id}`. A nested plain object and the key `id` are refused.
 *
 * Sections: the result map lowering writes (IR); the rows, mapped from recorded store answers
 * (`fixtures/object-form-rows.bindings.json`) and, live, from a store; the build-time refusals.
 */
import {beforeAll, afterAll, describe, expect, test} from '@jest/globals';
import {readFileSync} from 'fs';
import {Person} from '../test-helpers/query-fixtures';
import {Expr} from '../expressions/Expr';
import {lower} from '../queries/lower';
import {QueryBuilder} from '../queries/QueryBuilder';
import {FieldSet} from '../queries/FieldSet';
import {selectToSparql} from '../sparql/irToAlgebra';
import {mapSparqlSelectResult, type SparqlJsonResults} from '../sparql/resultMapping';
import type {IRResultMapEntry, IRSelectQuery} from '../queries/IntermediateRepresentation';
import type {SelectError} from '../queries/SelectQuery';
import {
  nameCard,
  normalizeRows,
  objectFormCases,
  objectFormData,
  objectFormRows,
  type ObjectFormCase,
} from '../test-helpers/object-form-fixtures';
import {createTestDataset, loadTestData, executeSparqlQuery, clearAllData} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import '../ontologies/rdf';
import '../ontologies/xsd';

/** Lowers a select (tracing its callbacks), as running it would. */
const build = (factory: () => unknown) => lower(factory() as any);

const entries = (factory: () => unknown): IRResultMapEntry[] =>
  (lower(factory() as any) as IRSelectQuery).resultMap!;

/** The projected expression an entry reads. */
const expressionOf = (ir: IRSelectQuery, entry: IRResultMapEntry) =>
  ir.projection.find((p) => p.alias === entry.alias)?.expression;

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T | undefined => undefined;
type Row<K extends ObjectFormCase> = Awaited<ReturnType<(typeof objectFormCases)[K]>> extends readonly (infer R)[]
  ? R
  : Awaited<ReturnType<(typeof objectFormCases)[K]>>;
type Node = {id: string};

describe('object form: the row types equal the rows (compile-time)', () => {
  test('a key on a path holds its yield; plural through a multi-valued hop', () => {
    assertType<Equals<Row<'n'>['n'], string>>();
    assertType<Equals<Row<'bb'>['bb'], Node>>();
    assertType<Equals<Row<'names'>['names'], string[]>>();
    assertType<Equals<Row<'fbf'>['fbf'], string[]>>();
    assertType<Equals<Row<'fb'>['fb'], Node[]>>();
    assertType<Equals<Row<'w'>['w'], Node[]>>();
    assertType<Equals<Row<'wName'>['w'], string[]>>();
    assertType<Equals<Row<'person'>['person'], Node>>();
    assertType<Equals<keyof Row<'nAndB'>, 'n' | 'b' | 'id'>>();
    assertType<Equals<Row<'allAndCarls'>['moaHobby'], string[]>>();
  });

  test('a keyed sub-select or preload holds the member row(s)', () => {
    type X = Row<'xFriends'>['x'];
    assertType<Equals<X[number]['bf'], Node>>();
    assertType<Equals<X[number]['n'] | X[number]['id'], string>>();
    assertType<Equals<Row<'xBestFriend'>['x']['n'], string>>();
    assertType<Equals<Row<'xFriendsArray'>['x'][number]['name'], string>>();
    assertType<Equals<Row<'pre'>['pre'], {name: string; id: string}>>();
    assertType<Equals<Row<'preFriends'>['pre'], {name: string; id: string}[]>>();
    assertType<Equals<Row<'subSize'>['x'][number]['c'], number>>();
    assertType<Equals<Row<'subExpr'>['x'][number]['e'], boolean>>();
    assertType<Equals<Row<'deepSub'>['x'][number]['y']['n'], string>>();
  });

  test('.one() and .for(id)', () => {
    assertType<Equals<Row<'one'>['n'], string>>();
    assertType<Equals<Row<'forP1'>['names'], string[]>>();
  });

  test('the array form of preloadFor carries the component fields', () => {
    const q = () => Person.select((p) => p.bestFriend.preloadFor(nameCard));
    type R = Awaited<ReturnType<typeof q>>[number];
    assertType<Equals<R['bestFriend']['name'], string>>();
  });

  test('grouped: a key is one value, a node its id', () => {
    const q = () => Person.select((p) => ({fn: p.friends.name, f: p.friends, person: p, n: Expr.count()})).groupBy('fn', 'f', 'person');
    type R = Awaited<ReturnType<typeof q>>[number];
    assertType<Equals<R['fn'], string>>();
    assertType<Equals<R['f'], Node>>();
    assertType<Equals<R['person'], Node>>();
    assertType<Equals<R['n'], number>>();
  });

  test('a nested plain object, an array value and the key id give an error row type', () => {
    const nested = () => Person.select((p) => ({info: {friend: p.bestFriend}}));
    const array = () => Person.select((p) => ({both: [p.name, p.hobby]}));
    const id = () => Person.select((p) => ({id: p.name}));
    const inner = () => Person.select((p) => p.friends.select((f) => ({info: {n: f.name}})));
    type RowOf<F extends () => unknown> = Awaited<ReturnType<F>> extends readonly (infer R)[] ? R : never;
    assertType<Equals<RowOf<typeof nested>, SelectError<'the value of key "info" is a plain object or an array: map each key to a path, sub-select, preload or expression'>>>();
    assertType<Equals<RowOf<typeof array>['__error'], 'the value of key "both" is a plain object or an array: map each key to a path, sub-select, preload or expression'>>();
    assertType<Equals<RowOf<typeof id>['__error'], '"id" cannot be a key of the object form: every row already holds its id under `id`'>>();
    // Reading a field of such a row does not compile.
    assertType<Equals<'info' extends keyof RowOf<typeof nested> ? true : false, false>>();
    assertType<Equals<'info' extends keyof RowOf<typeof inner>['friends'][number] ? true : false, false>>();
  });

  test('callbacks that compiled before still compile (no constraint on select)', () => {
    const fUnknown = (p: any): unknown => p.name;
    const fObject = (p: any): object => ({n: p.name});
    interface Named {
      n: unknown;
    }
    const fNamed = (p: any): Named => ({n: p.name});
    function wrap<R>(fn: (p: any) => R) {
      return Person.select(fn);
    }
    function wrapSub<R>(fn: (f: any) => R) {
      return Person.select((p) => p.friends.select(fn));
    }
    const built = [
      () => Person.select(fUnknown),
      () => Person.select(fObject),
      () => Person.select(fNamed),
      () => QueryBuilder.from(Person).select(fUnknown),
      () => wrap((p) => ({n: p.name})),
      () => wrapSub((f) => ({n: f.name})),
      () => Person.select((p) => p.friends.select(fUnknown)),
    ];
    expect(built.map((f) => typeof f)).toEqual(Array(7).fill('function'));
    // Still typed through: a wrapper keeps its row type.
    type Wrapped = Awaited<ReturnType<typeof wrap<{n: string}>>>;
    assertType<Equals<Wrapped extends unknown[] ? true : false, true>>();
  });
});

describe('object form: the result map (IR)', () => {
  test('a key on a deeper path is a keyed field of the root row', () => {
    const ir = lower(objectFormCases.n() as any) as IRSelectQuery;
    expect(ir.resultMap).toEqual([{key: 'n', alias: expect.any(String), container: 'a0', keyed: true}]);
    expect(expressionOf(ir, ir.resultMap![0])).toMatchObject({kind: 'property_expr', sourceAlias: 'a1'});
  });

  test('two keys over one relation stay two fields; no field for the relation', () => {
    expect(entries(objectFormCases.nAndB).map((e) => [e.key, e.container, e.keyed])).toEqual([
      ['n', 'a0', true],
      ['b', 'a0', true],
    ]);
  });

  test('a keyed sub-select holds its member rows; its fields are fields of those rows', () => {
    const map = entries(objectFormCases.xFriends);
    expect(map[0]).toEqual({key: 'x', alias: 'a1', container: 'a0', keyed: true, members: true});
    expect(map.slice(1).map((e) => [e.key, e.container, e.keyed])).toEqual([
      ['bf', 'a1', true],
      ['n', 'a1', true],
    ]);
  });

  test('an unkeyed field inside a keyed sub-select sits in its member row', () => {
    const map = entries(objectFormCases.xFriendsArray);
    expect(map[0]).toMatchObject({key: 'x', alias: 'a1', members: true});
    expect(map[1]).toEqual({key: expect.stringMatching(/name$/), alias: expect.any(String), container: 'a1'});
  });

  test('a preload under a key holds the component rows', () => {
    const map = entries(objectFormCases.pre);
    expect(map[0]).toEqual({key: 'pre', alias: 'a1', container: 'a0', keyed: true, members: true});
    expect(map[1]).toMatchObject({key: 'name', container: 'a1', keyed: true});
  });

  test('size() and an expression inside a sub-select are per member', () => {
    expect(entries(objectFormCases.subSize)[1]).toMatchObject({key: 'c', container: 'a1', keyed: true});
    expect(entries(() => Person.select((p) => ({x: p.friends.select((f) => ({e: f.name.equals('Moa')}))})))[1]).toMatchObject({key: 'e', container: 'a1', keyed: true});
    // In the array form too: the count is computed per friend.
    const arrayForm = entries(() => Person.select((p) => p.friends.select((f) => f.friends.size())));
    expect(arrayForm).toEqual([{key: 'friends', alias: expect.any(String), container: 'a1'}]);
  });

  test('a filtered relation under a key holds its filtered members', () => {
    const ir = lower(objectFormCases.w() as any) as IRSelectQuery;
    expect(ir.resultMap).toEqual([{key: 'w', alias: expect.any(String), container: 'a0', keyed: true}]);
    expect(expressionOf(ir, ir.resultMap![0])).toEqual({kind: 'alias_expr', alias: 'a1'});
  });

  test('keys are honoured per entry: a preload beside keyed fields', () => {
    const map = entries(objectFormCases.preloadBeside);
    expect(map.map((e) => e.key)).toEqual(['n', 'name']);
    expect(map[0]).toMatchObject({container: 'a0', keyed: true});
    // The preload has no key: it nests under its relation, its component's key in its member row.
    expect(map[1]).toMatchObject({container: 'a1', keyed: true});
    expect(map.some((e) => e.members)).toBe(false);
  });

  test('the array form carries none of the new fields', () => {
    const factory = () =>
      Person.select((p) => [p.bestFriend.name, p.friends.select((f) => [f.name, f.bestFriend]), p.pets.size()]);
    for (const entry of entries(factory)) {
      expect(Object.keys(entry).sort()).toEqual(['alias', 'key']);
    }
  });

  test('DSL-JSON "as" names the key', () => {
    const json = {
      shape: Person.shape.id,
      fields: [{bestFriend: {as: 'b'}}, {'bestFriend.name': {as: 'n'}}, 'hobby'],
    };
    const map = entries(() => QueryBuilder.fromJSON({...json, v: '1.11', op: 'select'} as any));
    expect(map.map((e) => [e.key, e.keyed])).toEqual([
      ['b', true],
      ['n', true],
      [expect.stringMatching(/hobby$/), undefined],
    ]);
  });
});

/** The store answers recorded for each case: the SPARQL they answer and the result set. */
const recorded: Record<string, {sparql: string; results: SparqlJsonResults}> = JSON.parse(
  readFileSync(new URL('./fixtures/object-form-rows.bindings.json', import.meta.url), 'utf8'),
);

const caseNames = Object.keys(objectFormCases) as ObjectFormCase[];

describe('object form: the rows (recorded store answers)', () => {
  test('every case has a recorded answer', () => {
    expect(Object.keys(recorded).sort()).toEqual([...caseNames].sort());
  });

  test.each(caseNames)('%s', (name) => {
    const ir = lower(objectFormCases[name]() as any) as IRSelectQuery;
    // The recording answers this very SPARQL; when lowering changes it, re-record it.
    expect(selectToSparql(ir)).toBe(recorded[name].sparql);
    const rows = mapSparqlSelectResult(recorded[name].results, ir);
    expect(normalizeRows(rows)).toEqual(normalizeRows(objectFormRows[name]));
  });

  test.each(caseNames)('%s round-trips through DSL-JSON', (name) => {
    const query = objectFormCases[name]() as any;
    const back = QueryBuilder.fromJSON(JSON.parse(JSON.stringify(query.toJSON())));
    expect(selectToSparql(lower(back as any) as IRSelectQuery)).toBe(recorded[name].sparql);
  });
});

beforeAll(async () => {
  if (!fusekiLive) return;
  await createTestDataset();
  await clearAllData();
  await loadTestData(objectFormData);
}, 30000);

afterAll(async () => {
  if (fusekiLive) await clearAllData();
});

describeFuseki('object form rows', () => {
  test.each(caseNames)('%s', async (name) => {
    const ir = lower(objectFormCases[name]() as any) as IRSelectQuery;
    const rows = mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir);
    expect(normalizeRows(rows)).toEqual(normalizeRows(objectFormRows[name]));
  });
});

describe('object form: refused at build time', () => {
  test('a nested plain object, naming the key', () => {
    expect(() => build(() => Person.select((p) => ({info: {friend: p.bestFriend}}) as any))).toThrow(
      /value of key "info" is a plain object/,
    );
    expect(() =>
      build(() => Person.select((p) => p.friends.select((f) => ({info: {n: f.name}}) as any))),
    ).toThrow(/value of key "info" is a plain object/);
  });

  test('an array as a value', () => {
    expect(() => build(() => Person.select((p) => ({both: [p.name, p.hobby]}) as any))).toThrow(
      /value of key "both" is an array/,
    );
  });

  test('null as a value (top level), naming the key', () => {
    expect(() => build(() => Person.select((p) => ({n: p.name, z: null}) as any))).toThrow(/value of key "z" is null/);
  });

  test('a preload of a relation also selected under a key', () => {
    expect(() =>
      build(() => Person.select((p) => ({x: p.friends.select((f) => ({n: f.name}))})).preload('friends', nameCard)),
    ).toThrow(/"friends" is selected under the key "x" and, apart from it, nested under its own name/);
    // Nested under the key itself it is one row: allowed.
    expect(() =>
      build(() => Person.select((p) => ({x: p.friends.select((f) => f.bestFriend.select((b) => b.name))}))),
    ).not.toThrow();
  });

  test('a key colliding with a preload names both readings', () => {
    expect(() => build(() => Person.select((p) => ({friends: p.friends.name})).preload('friends', nameCard)))
      .toThrow('(friends: friends.name and friends.select(name: name))');
  });

  test('the key id', () => {
    expect(() => build(() => Person.select((p) => ({id: p.name}) as any))).toThrow(/"id" cannot be a key/);
    expect(() => build(() => Person.select((p) => p.friends.select((f) => ({id: f.name}) as any)))).toThrow(
      /"id" cannot be a key/,
    );
  });

  test('the key id and two names for one key in DSL-JSON', () => {
    expect(() => FieldSet.fromJSON({shape: Person.shape.id, fields: [{name: {customKey: 'id'}}]})).toThrow(
      /"id" cannot be a key/,
    );
    expect(() => FieldSet.fromJSON({shape: Person.shape.id, fields: [{name: {as: 'id'}}]})).toThrow(
      /"id" cannot be a key/,
    );
    expect(() =>
      FieldSet.fromJSON({shape: Person.shape.id, fields: [{name: {as: 'a', customKey: 'b'}}]}),
    ).toThrow(/names its key twice/);
  });
});
