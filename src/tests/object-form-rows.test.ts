/**
 * The object form of select: a key names a top-level field of the object it is written in (the
 * root row, or a sub-select's member row), holding the expression's yield. Intermediate hops never
 * appear in the row; a keyed sub-select or preload holds its member rows; the subject as a field
 * is `{id}`. A nested plain object and the key `id` are refused.
 *
 * Sections: the result map lowering writes (IR), the build-time refusals.
 */
import {describe, expect, test} from '@jest/globals';
import {Person} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {QueryBuilder} from '../queries/QueryBuilder';
import {FieldSet} from '../queries/FieldSet';
import type {IRResultMapEntry, IRSelectQuery} from '../queries/IntermediateRepresentation';
import '../ontologies/rdf';
import '../ontologies/xsd';

const card = {query: Person.select((p) => ({name: p.name}))};
const isMoa = (f: any) => f.name.equals('Moa');

/** The S8 cases, by name: each select as a user writes it. */
export const objectFormCases = {
  n: () => Person.select((p) => ({n: p.bestFriend.name})),
  bb: () => Person.select((p) => ({bb: p.bestFriend.bestFriend})),
  names: () => Person.select((p) => ({names: p.friends.name})),
  fbf: () => Person.select((p) => ({fbf: p.friends.bestFriend.name})),
  xFriends: () => Person.select((p) => ({x: p.friends.select((f) => ({bf: f.bestFriend, n: f.name}))})),
  xFriendsArray: () => Person.select((p) => ({x: p.friends.select((f) => f.name)})),
  xBestFriend: () => Person.select((p) => ({x: p.bestFriend.select((b) => ({n: b.name}))})),
  w: () => Person.select((p) => ({w: p.friends.where(isMoa)})),
  wName: () => Person.select((p) => ({w: p.friends.where(isMoa).name})),
  pre: () => Person.select((p) => ({pre: p.bestFriend.preloadFor(card)})),
  person: () => Person.select((p) => ({person: p})),
  nAndB: () => Person.select((p) => ({n: p.bestFriend.name, b: p.bestFriend})),
  subSize: () => Person.select((p) => ({x: p.friends.select((f) => ({c: f.friends.size()}))})),
  subExpr: () => Person.select((p) => ({x: p.friends.select((f) => ({e: f.name.equals('Moa')}))})),
  preloadBeside: () => Person.select((p) => ({n: p.hobby})).preload('bestFriend', card),
};

/** Lowers a select (tracing its callbacks), as running it would. */
const build = (factory: () => unknown) => lower(factory() as any);

const entries = (factory: () => unknown): IRResultMapEntry[] =>
  (lower(factory() as any) as IRSelectQuery).resultMap!;

/** The projected expression an entry reads. */
const expressionOf = (ir: IRSelectQuery, entry: IRResultMapEntry) =>
  ir.projection.find((p) => p.alias === entry.alias)?.expression;

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
    expect(entries(objectFormCases.subExpr)[1]).toMatchObject({key: 'e', container: 'a1', keyed: true});
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
