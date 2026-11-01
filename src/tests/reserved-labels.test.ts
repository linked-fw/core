/**
 * Reserved property labels. A `$`-prefixed label is refused at registration: `$` names are facts
 * about the node in queries (`$type()`), and no RDF label starts with one in practice. Every other
 * reserved name (the DSL-JSON combinators `and`/`or`/`not`, the query proxies' own members) only
 * warns, so a shape that uses one keeps loading.
 */
import {describe, expect, jest, test} from '@jest/globals';
import {registerPropertyShape} from '../shapes/SHACL';
import {resetReservedPropertyLabelWarnings} from '../queries/reservedQueryNames';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';
import {createNodeShapeData, createPropertyShapeData} from '../shapes/nodeShapeData';
import {SelectBuilder} from '../queries/QueryBuilder';
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';
import {xsd} from '../ontologies/xsd';

const stub = (label: string) => [{label: 'Widget', id: 'urn:Widget'} as any, {label} as any] as const;

describe('reserved property labels', () => {
  for (const label of ['$type', '$graph', '$anything']) {
    test(`registering a property named '${label}' throws`, () => {
      expect(() => registerPropertyShape(...stub(label))).toThrow(/is reserved/);
    });
  }

  for (const label of ['and', 'or', 'not', 'size']) {
    test(`registering a property named '${label}' warns and does not throw the reserved error`, () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      resetReservedPropertyLabelWarnings();
      try {
        expect(() => registerPropertyShape(...stub(label))).not.toThrow(/reserved/);
        expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain(`Widget.${label}`);
      } finally {
        warn.mockRestore();
      }
    });
  }

  test('a non-reserved label passes the reserved-label guard', () => {
    // `name` is not reserved, so it proceeds past the guard (and then fails on
    // the bare stub for an unrelated reason — never the reserved error).
    expect(() => registerPropertyShape(...stub('name'))).not.toThrow(/reserved/);
  });
});

describe('a property labelled after a DSL-JSON combinator', () => {
  const GATE = 'https://example.org/reserved/shape/Gate';
  test('a condition on it is written as an S-expr and reads back the same', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const shape = createNodeShapeData(GATE);
      shape.label = 'Gate';
      shape.targetClass = {id: 'https://example.org/reserved/vocab#Gate'};
      const prop = createPropertyShapeData();
      Object.assign(prop, {
        id: `${GATE}/and`,
        label: 'and',
        path: {id: 'https://example.org/reserved/and'},
        datatype: xsd.string,
        maxCount: 1,
        parentNodeShape: shape,
      });
      shape.propertyShapes = [prop];
      registerRuntimeShape(shape);
    } finally {
      warn.mockRestore();
    }
    const q = SelectBuilder.from(GATE)
      .select((g: any) => [g.and])
      .where((g: any) => g.and.equals('x'));
    const json = q.toJSON() as {where: unknown};
    expect(json.where).toEqual(['=', {'@path': 'and'}, 'x']);
    const sparql = (b: unknown) => selectToSparql(lower(b as never) as never);
    expect(sparql(fromJSON(JSON.parse(JSON.stringify(json)) as never))).toBe(sparql(q));
  });
});
