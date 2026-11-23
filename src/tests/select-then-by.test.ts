/**
 * Multi-key sorting: `.orderBy(fn, dir).thenBy(fn, dir)` appends one key per call, each with its
 * own direction. Each key keeps the single-key rules (missing values last, a multi-valued path
 * by its first value in that direction, the subject IRI as the last tie-break on a page). The
 * DSL-JSON `sortBy` array carries one direction per key and round-trips to the same SPARQL.
 */
import {describe, expect, test} from '@jest/globals';
import {Person, personClass, propBase} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';
import {SelectBuilder} from '../queries/QueryBuilder';
import {FieldSet} from '../queries/FieldSet';
import {fromJSON} from '../queries/fromJSON';
import {WIRE_VERSION} from '../queries/wireVersion';
import type {IRSelectQuery} from '../queries/IntermediateRepresentation';
import '../ontologies/rdf';
import '../ontologies/xsd';

const PT = personClass.id;
const PROP = propBase;

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const directionsOf = (q: unknown) => (irOf(q).orderBy ?? []).map((o) => o.direction);

describe('thenBy — builder', () => {
  test('appends one key per call, each with its own direction', () => {
    const q = Person.select((p) => [p.name, p.hobby])
      .orderBy((p) => p.hobby, 'DESC')
      .thenBy((p) => p.name)
      .thenBy((p) => p.birthDate, 'DESC');
    expect(directionsOf(q)).toEqual(['DESC', 'ASC', 'DESC']);
  });

  test('returns a new builder; the original keeps its sort', () => {
    const base = Person.select((p) => p.name).orderBy((p) => p.hobby, 'DESC');
    const extended = base.thenBy((p) => p.name);
    expect(extended).not.toBe(base);
    expect(directionsOf(base)).toEqual(['DESC']);
    expect(directionsOf(extended)).toEqual(['DESC', 'ASC']);
  });

  test('a later orderBy replaces the whole sort, thenBy keys included', () => {
    const q = Person.select((p) => p.name)
      .orderBy((p) => p.hobby, 'DESC')
      .thenBy((p) => p.name)
      .orderBy((p) => p.birthDate);
    expect(directionsOf(q)).toEqual(['ASC']);
    expect(sparqlOf(q)).toMatch(/ORDER BY DESC\(BOUND\(\?a0_birthDate\)\) ASC\(\?a0_birthDate\)$/);
  });

  test('the array form of orderBy keeps one direction, and thenBy extends it', () => {
    const q = Person.select((p) => p.name)
      .orderBy((p) => [p.hobby, p.name], 'DESC')
      .thenBy((p) => p.birthDate);
    expect(directionsOf(q)).toEqual(['DESC', 'DESC', 'ASC']);
  });

  test('thenBy without a preceding orderBy is refused', () => {
    expect(() => Person.select((p) => p.name).thenBy((p) => p.name)).toThrow(/call orderBy\(\) first/);
    expect(() => SelectBuilder.from(Person).thenBy((p) => p.name, 'DESC')).toThrow(/call orderBy\(\) first/);
  });

  test('a thenBy callback returns one key, not an array', () => {
    const q = Person.select((p) => p.name)
      .orderBy((p) => p.hobby)
      .thenBy((p) => [p.name, p.birthDate]);
    expect(() => irOf(q)).toThrow(/thenBy\(\) adds one sort key/);
  });

  test('a thenBy key holding an aggregate is refused, naming thenBy', () => {
    const q = Person.select((p) => p.name)
      .orderBy((p) => p.hobby)
      .thenBy((p) => p.friends.size());
    expect(() => irOf(q)).toThrow(/thenBy\(\) on a select .* cannot sort by an aggregate/);
  });

  test('a thenBy callback returning nothing usable is refused, naming thenBy', () => {
    const q = Person.select((p) => p.name)
      .orderBy((p) => p.hobby)
      .thenBy(() => 'name' as never);
    expect(() => irOf(q)).toThrow(/thenBy\(\): the callback must return a property path/);
  });

  test('a computed expression is a valid thenBy key', () => {
    const q = Person.select((p) => p.name)
      .orderBy((p) => p.hobby)
      .thenBy((p) => p.name.strlen(), 'DESC');
    expect(sparqlOf(q)).toMatch(
      /ORDER BY DESC\(BOUND\(\?a0_hobby\)\) ASC\(\?a0_hobby\) DESC\(BOUND\(\?order_1\)\) DESC\(\?order_1\)$/,
    );
  });

  test('groupBy after a thenBy sort is refused like after orderBy', () => {
    expect(() =>
      Person.select((p) => ({hobby: p.hobby}))
        .orderBy((p) => p.hobby)
        .thenBy((p) => p.name)
        .groupBy('hobby'),
    ).toThrow(/already sorts its members/);
  });

  test('count() and exists() drop the whole sort', () => {
    const q = Person.select((p) => p.name).orderBy((p) => p.hobby).thenBy((p) => p.name, 'DESC');
    const count = q.toCount().toJSON() as unknown as Record<string, unknown>;
    expect(count.sortBy).toBeUndefined();
  });

  test('.one() keeps both keys', () => {
    const q = Person.select((p) => p.name).orderBy((p) => p.hobby, 'DESC').thenBy((p) => p.name).one();
    expect(directionsOf(q)).toEqual(['DESC', 'ASC']);
    expect(irOf(q).limit).toBe(1);
  });

  test('works on a builder from a shape IRI and on a FieldSet select', () => {
    const byIri = SelectBuilder.from<Person>(Person.shape.id)
      .select(['name'])
      .orderBy((p) => p.hobby, 'DESC')
      .thenBy((p) => p.name);
    const byFieldSet = SelectBuilder.from(Person)
      .select(FieldSet.for(Person.shape, ['name']))
      .orderBy((p) => p.hobby, 'DESC')
      .thenBy((p) => p.name);
    const byCallback = Person.select((p) => [p.name]).orderBy((p) => p.hobby, 'DESC').thenBy((p) => p.name);
    expect(sparqlOf(byIri)).toBe(sparqlOf(byCallback));
    expect(sparqlOf(byFieldSet)).toBe(sparqlOf(byCallback));
  });
});

describe('thenBy — SPARQL golden', () => {
  test('mixed directions, unpaged: one bound-first key before each key', () => {
    const q = Person.select((p) => [p.name, p.hobby]).orderBy((p) => p.hobby, 'DESC').thenBy((p) => p.name);
    expect(sparqlOf(q)).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name ?a0_hobby
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  OPTIONAL {
    ?a0 <${PROP}hobby> ?a0_hobby .
  }
}
ORDER BY DESC(BOUND(?a0_hobby)) DESC(?a0_hobby) DESC(BOUND(?a0_name)) ASC(?a0_name)`);
  });

  test('two keys on a page: MAX for the descending key, MIN for the ascending one, then the subject', () => {
    const q = Person.select((p) => [p.name, p.nickNames])
      .orderBy((p) => p.hobby, 'DESC')
      .thenBy((p) => p.nickNames)
      .limit(2)
      .offset(1);
    expect(sparqlOf(q)).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name ?a0_nickNames
WHERE {
  {
    SELECT ?a0 (MAX(?a0_hobby) AS ?page_order_0) (MIN(?a0_nickNames) AS ?page_order_1) WHERE {
      ?a0 rdf:type <${PT}> .
      OPTIONAL {
        ?a0 <${PROP}nickName> ?a0_nickNames .
      }
      OPTIONAL {
        ?a0 <${PROP}hobby> ?a0_hobby .
      }
    } GROUP BY ?a0 ORDER BY DESC(BOUND(?page_order_0)) DESC(?page_order_0) DESC(BOUND(?page_order_1)) ASC(?page_order_1) ASC(?a0) LIMIT 2 OFFSET 1
  }
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  OPTIONAL {
    ?a0 <${PROP}nickName> ?a0_nickNames .
  }
  OPTIONAL {
    ?a0 <${PROP}hobby> ?a0_hobby .
  }
}
ORDER BY DESC(BOUND(?page_order_0)) DESC(?page_order_0) DESC(BOUND(?page_order_1)) ASC(?page_order_1) ASC(?a0) DESC(BOUND(?a0_hobby)) DESC(?a0_hobby) DESC(BOUND(?a0_nickNames)) ASC(?a0_nickNames)`);
  });
});

describe('thenBy — DSL-JSON', () => {
  const q = () =>
    Person.select((p) => [p.name, p.hobby])
      .orderBy((p) => p.hobby, 'DESC')
      .thenBy((p) => p.bestFriend.name)
      .thenBy((p) => p.name.strlen(), 'DESC')
      .limit(5);

  test('sortBy carries one direction per key, in precedence order', () => {
    const json = q().toJSON();
    expect(json.v).toBe(WIRE_VERSION);
    expect(json.sortBy).toEqual([
      {hobby: 'DESC'},
      {'bestFriend.name': 'ASC'},
      {value: expect.anything(), direction: 'DESC'},
    ]);
  });

  test('toJSON → fromJSON → identical SPARQL', () => {
    const json = q().toJSON();
    const restored = fromJSON(JSON.parse(JSON.stringify(json))) as SelectBuilder<Person>;
    expect(sparqlOf(restored)).toBe(sparqlOf(q()));
    expect(restored.toJSON()).toEqual(json);
  });

  test('an envelope from before the bump (one direction per key) still parses', () => {
    const json = {v: '1.7', shape: Person.shape.id, fields: ['name'], sortBy: [{hobby: 'desc'}, {name: 'ASC'}]};
    expect(directionsOf(fromJSON(json as never))).toEqual(['DESC', 'ASC']);
  });

  test('thenBy on a builder restored from JSON appends; orderBy replaces', () => {
    const restored = fromJSON({
      v: WIRE_VERSION,
      shape: Person.shape.id,
      fields: ['name'],
      sortBy: [{hobby: 'DESC'}],
    } as never) as SelectBuilder<Person>;
    expect(directionsOf(restored.thenBy((p) => p.name))).toEqual(['DESC', 'ASC']);
    expect(restored.orderBy((p) => p.name).toJSON().sortBy).toEqual([{name: 'ASC'}]);
  });
});
