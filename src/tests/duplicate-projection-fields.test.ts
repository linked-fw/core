/**
 * A field selected twice. An exact duplicate (same key, same path, filters and sub-selection) is
 * one field: one SPARQL variable, one key in the row. The same key selected in two different
 * ways is refused when the query is lowered, naming the key, never at result mapping. Fields
 * that only share a relation (`[p.bestFriend.name, p.bestFriend.hobby]`) still nest together.
 */
import {describe, expect, test} from '@jest/globals';
import {Person} from '../test-helpers/query-fixtures';
import {QueryBuilder} from '../queries/QueryBuilder';
import {FieldSet} from '../queries/FieldSet';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';
import {mapSparqlSelectResult, type SparqlJsonResults} from '../sparql/resultMapping';
import type {IRSelectQuery} from '../queries/IntermediateRepresentation';
import '../ontologies/rdf';
import '../ontologies/xsd';

const P = 'https://linked.cm/shape/core/Person';
const componentLike = {query: Person.select((p) => ({name: p.name}))};

const irOf = (query: unknown): IRSelectQuery => lower(query as never) as IRSelectQuery;
const selectLine = (ir: IRSelectQuery): string =>
  selectToSparql(ir).split('\n').find((line) => line.startsWith('SELECT'))!;

const uri = (value: string) => ({type: 'uri' as const, value});
const lit = (value: string) => ({type: 'literal' as const, value});
const rows = (ir: IRSelectQuery, bindings: Record<string, {type: 'uri' | 'literal'; value: string}>[]) =>
  mapSparqlSelectResult({head: {vars: []}, results: {bindings}} as unknown as SparqlJsonResults, ir);

/** The refusal for a key selected in two different ways, pointing at the object form. */
const refusalFor = (key: string) =>
  new RegExp(`result key "${key.replace(/\./g, '\\.')}" is selected twice with different paths or sub-selections.*object form`);
/** The refusal when the two read one relation with different paginations. */
const paginationRefusalFor = (key: string) =>
  new RegExp(`result key "${key.replace(/\./g, '\\.')}" is selected twice.*cannot yet read a relation with two different paginations`);
/** The refusal when keys of the object form would not keep two reads of a relation apart. */
const keyedRefusalFor = (key: string) =>
  new RegExp(`result key "${key.replace(/\./g, '\\.')}" is selected twice.*keys of the object form nest under the relation`);

describe('exact duplicates are one field', () => {
  test('[p.name, p.name] projects ?a0_name once and maps to {id, name}', () => {
    const ir = irOf(Person.select((p) => [p.name, p.name]));
    expect(ir.resultMap).toEqual([{key: `${P}/name`, alias: 'a1'}]);
    expect(selectLine(ir)).toBe('SELECT DISTINCT ?a0 ?a0_name');
    expect(rows(ir, [{a0: uri('p1'), a0_name: lit('Semmy')}])).toEqual([{id: 'p1', name: 'Semmy'}]);
  });

  test('a duplicate inside a sub-select: p.friends.select((f) => [f.name, f.name])', () => {
    const ir = irOf(Person.select((p) => p.friends.select((f) => [f.name, f.name])));
    expect(ir.resultMap).toHaveLength(1);
    expect(selectLine(ir)).toBe('SELECT DISTINCT ?a0 ?a1_name ?a1');
    expect(rows(ir, [{a0: uri('p1'), a1: uri('p2'), a1_name: lit('Moa')}])).toEqual([
      {id: 'p1', friends: [{id: 'p2', name: 'Moa'}]},
    ]);
  });

  test('a duplicate across paths and sub-selects: [p.friends.name, p.friends.select((f) => f.name)]', () => {
    const ir = irOf(Person.select((p) => [p.friends.name, p.friends.select((f) => f.name)]));
    expect(ir.resultMap).toHaveLength(1);
    expect(selectLine(ir)).toBe('SELECT DISTINCT ?a0 ?a1_name ?a1');
  });

  test('two identical sub-selects in the object form inside: ({x: f.name}) twice', () => {
    const ir = irOf(Person.select((p) => [
      p.friends.select((f) => ({x: f.name})),
      p.friends.select((f) => ({x: f.name})),
    ]));
    expect(ir.resultMap).toEqual([{key: 'x', alias: 'a1'}]);
  });

  test('the same inline filter written twice is one field', () => {
    const ir = irOf(Person.select((p) => [
      p.friends.where((f) => f.name.equals('Moa')),
      p.friends.where((f) => f.name.equals('Moa')),
    ]));
    expect(ir.resultMap).toHaveLength(1);
    expect(selectLine(ir)).toBe('SELECT DISTINCT ?a0 ?a1');
  });

  test('the same quantifier filter written twice is one field', () => {
    const ir = irOf(Person.select((p) => [
      p.friends.where((f) => f.friends.some((g) => g.name.equals('Moa'))),
      p.friends.where((f) => f.friends.some((g) => g.name.equals('Moa'))),
    ]));
    expect(ir.resultMap).toHaveLength(1);
  });

  test('[p.friends.size(), p.friends.size()] counts once', () => {
    const ir = irOf(Person.select((p) => [p.friends.size(), p.friends.size()]));
    expect(ir.projection).toHaveLength(1);
    expect(selectToSparql(ir)).toContain('SELECT ?a0 (COUNT(DISTINCT ?a0_friends) AS ?a1)\n');
  });

  test('a field and the same field from a preloadFor component', () => {
    const ir = irOf(Person.select((p) => [p.bestFriend.name, p.bestFriend.preloadFor(componentLike)]));
    expect(ir.resultMap).toHaveLength(1);
    expect(selectLine(ir)).toBe('SELECT DISTINCT ?a0 ?a1_name ?a1');
  });

  test('a FieldSet with a label twice', () => {
    const ir = irOf(QueryBuilder.from(Person).select(FieldSet.for(Person.shape, ['name', 'name'])));
    expect(selectLine(ir)).toBe('SELECT DISTINCT ?a0 ?a0_name');
  });

  test("a dynamic label select select(['name', 'name']), and its DSL-JSON round trip", () => {
    const builder = QueryBuilder.from(Person).select(['name', 'name']);
    expect(selectLine(irOf(builder))).toBe('SELECT DISTINCT ?a0 ?a0_name');
    const restored = QueryBuilder.fromJSON(JSON.parse(JSON.stringify(builder.toJSON())));
    expect(selectLine(irOf(restored))).toBe('SELECT DISTINCT ?a0 ?a0_name');
  });
});

describe('fields that are not duplicates', () => {
  test('a filtered relation and a field read through the same filter nest together', () => {
    const ir = irOf(Person.select((p) => [
      p.friends.where((f) => f.name.equals('Moa')),
      p.friends.where((f) => f.name.equals('Moa')).hobby,
    ]));
    expect(ir.resultMap).toHaveLength(2);
  });

  test('the object form keeps two keys on the same path', () => {
    const ir = irOf(Person.select((p) => ({a: p.name, b: p.name})));
    expect(ir.resultMap.map((e) => e.key)).toEqual(['a', 'b']);
    expect(selectLine(ir)).toBe('SELECT DISTINCT ?a0 ?a0_name');
    expect(rows(ir, [{a0: uri('p1'), a0_name: lit('Semmy')}])).toEqual([{id: 'p1', a: 'Semmy', b: 'Semmy'}]);
  });

  test('fields that share a relation nest together', () => {
    const ir = irOf(Person.select((p) => [p.friends.select((f) => f.name), p.friends.select((f) => f.hobby)]));
    expect(ir.resultMap).toHaveLength(2);
    expect(rows(ir, [{a0: uri('p1'), a1: uri('p2'), a1_name: lit('Moa'), a1_hobby: lit('Jogging')}])).toEqual([
      {id: 'p1', friends: [{id: 'p2', name: 'Moa', hobby: 'Jogging'}]},
    ]);
  });

  test('the same key at different depths: [p.name, p.bestFriend.name]', () => {
    const ir = irOf(Person.select((p) => [p.name, p.bestFriend.name]));
    expect(ir.resultMap).toHaveLength(2);
  });
});

describe('one key selected in two different ways is refused at lowering', () => {
  test('[p.friends, p.friends.select((f) => f.name)]', () => {
    expect(() => irOf(Person.select((p) => [p.friends, p.friends.select((f) => f.name)]))).toThrow(
      refusalFor('friends'),
    );
  });

  test('[p.bestFriend, p.bestFriend.preloadFor(c)]', () => {
    expect(() => irOf(Person.select((p) => [p.bestFriend, p.bestFriend.preloadFor(componentLike)]))).toThrow(
      refusalFor('bestFriend'),
    );
  });

  test('two different filters on one relation', () => {
    expect(() => irOf(Person.select((p) => [
      p.friends.where((f) => f.name.equals('Moa')),
      p.friends.where((f) => f.name.equals('Jinx')),
    ]))).toThrow(refusalFor('friends'));
  });

  test('a filtered and an unfiltered leaf under one key', () => {
    expect(() => irOf(Person.select((p) => [p.friends.name, p.friends.where((f) => f.hobby.equals('x')).name])))
      .toThrow(refusalFor('friends.name'));
  });

  test('a filtered and an unfiltered read of one relation under different leaves', () => {
    expect(() => irOf(Person.select((p) => [
      p.friends.name,
      p.friends.where((f) => f.name.equals('Carl')).hobby,
    ]))).toThrow(refusalFor('friends'));
  });

  test('…and its object form, whose keys nest under the relation today', () => {
    expect(() => irOf(Person.select((p) => ({
      all: p.friends.name,
      carls: p.friends.where((f) => f.name.equals('Carl')).hobby,
    })))).toThrow(keyedRefusalFor('friends'));
  });

  test('two filters on one relation in the object form, whose keys the row drops today', () => {
    expect(() => irOf(Person.select((p) => ({
      a: p.friends.where((f) => f.name.equals('Carl')),
      b: p.friends.where((f) => f.name.equals('Moa')),
    })))).toThrow(keyedRefusalFor('friends'));
  });

  test('two sub-selects of one relation, one paginated', () => {
    expect(() => irOf(Person.select((p) => [
      p.friends.select((f) => f.name).limit(1),
      p.friends.select((f) => f.hobby),
    ]).for({id: 'p1'}))).toThrow(paginationRefusalFor('friends'));
  });

  test('a size() and the relation itself: [p.friends.size(), p.friends]', () => {
    expect(() => irOf(Person.select((p) => [p.friends.size(), p.friends]))).toThrow(refusalFor('friends'));
  });

  test('inside a sub-select: one key, two values', () => {
    expect(() => irOf(Person.select((p) => [
      p.friends.select((f) => ({x: f.name})),
      p.friends.select((f) => ({x: f.hobby})),
    ]))).toThrow(/result key "friends\.x" is selected twice.*give each a key of its own/);
  });

  test('inside a sub-select: a relation and a field nested under it', () => {
    expect(() => irOf(Person.select((p) => p.friends.select((f) => [f.bestFriend, f.bestFriend.name]))))
      .toThrow(refusalFor('friends.bestFriend'));
  });

  test('the same sub-select with and without inner pagination', () => {
    expect(() => irOf(Person.select((p) => [
      p.friends.select((f) => f.name).limit(1),
      p.friends.select((f) => f.name),
    ]).for({id: 'p1'}))).toThrow(paginationRefusalFor('friends.name'));
  });

  test('the refusal names both fields as written', () => {
    expect(() => irOf(Person.select((p) => [p.friends, p.friends.where((f) => f.name.equals('Moa'))])))
      .toThrow('(friends and friends.where(…))');
  });

  test('a single-valued relation and its size() point at the object form, not at filters', () => {
    expect(() => irOf(Person.select((p) => [p.bestFriend.friends.size(), p.bestFriend.friends])))
      .toThrow(refusalFor('bestFriend.friends'));
  });
});

describe('result mapping keeps its duplicate-key assertion', () => {
  test('a hand-built IR with two root fields under one key still throws while mapping', () => {
    const ir = irOf(Person.select((p) => [p.name, p.hobby]));
    const broken: IRSelectQuery = {...ir, resultMap: ir.resultMap.map((e) => ({...e, key: `${P}/name`}))};
    expect(() => rows(broken, [{a0: uri('p1')}])).toThrow('Duplicate result key "name"');
  });
});
