import {describe, expect, test} from '@jest/globals';
import type {PathExpr} from '../paths/PropertyPathExpr';
import {
  createNodeShapeData,
  createPropertyShapeData,
  type NodeShapeData,
} from '../shapes/nodeShapeData';
import {
  fromWire,
  isNodeShapeWire,
  toWire,
  type NodeShapeWire,
} from '../shapes/nodeShapeWire';

const ns = (local: string) => ({id: `https://example.org/${local}`});

/** Every PathExpr variant, so the round trip is proven not to flatten complex paths. */
const PATHS: {name: string; path: PathExpr}[] = [
  {name: 'string ref', path: 'https://example.org/name'},
  {name: 'node ref', path: ns('name')},
  {name: 'sequence', path: {seq: [ns('address'), ns('city')]}},
  {name: 'alternative', path: {alt: [ns('name'), ns('label')]}},
  {name: 'inverse', path: {inv: ns('parent')}},
  {name: 'zeroOrMore', path: {zeroOrMore: ns('child')}},
  {name: 'oneOrMore', path: {oneOrMore: ns('child')}},
  {name: 'zeroOrOne', path: {zeroOrOne: ns('nickname')}},
  {
    name: 'negated property set',
    path: {negatedPropertySet: [ns('secret'), {inv: ns('hidden')}]},
  },
  {
    name: 'nested sequence of alternatives',
    path: {seq: [{alt: [ns('a'), ns('b')]}, {inv: {zeroOrMore: ns('c')}}]},
  },
];

/** A shape exercising every field the metamodel carries. */
function richShape(): NodeShapeData {
  const shape = createNodeShapeData('https://example.org/shapes/Person');
  shape.label = 'Person';
  shape.description = 'A person';
  shape.targetClass = ns('Person');
  shape.extends = {id: 'https://example.org/shapes/Thing'};
  shape.dependent = true;
  shape.closed = true;
  shape.ignoredProperties = [ns('ignored')];

  const name = createPropertyShapeData();
  Object.assign(name, {
    id: 'https://example.org/shapes/Person/name',
    label: 'name',
    path: ns('name'),
    nodeKind: ns('Literal'),
    datatype: ns('string'),
    minCount: 1,
    maxCount: 1,
    name: 'Name',
    description: 'Full name',
    order: 3,
    group: {id: 'https://example.org/basics'},
    minLength: 2,
    maxLength: 64,
    pattern: /^[A-Z][a-z]+$/i,
    defaultValue: 'Anon',
    parentNodeShape: shape,
  });

  const age = createPropertyShapeData();
  Object.assign(age, {
    id: 'https://example.org/shapes/Person/age',
    label: 'age',
    path: {seq: [ns('profile'), ns('age')]} as PathExpr,
    datatype: ns('integer'),
    minInclusive: 0,
    maxInclusive: 130,
    minExclusive: -1,
    maxExclusive: 131,
    lessThan: ns('maxAge'),
    lessThanOrEquals: ns('limit'),
    equalsConstraint: ns('reportedAge'),
    disjoint: ns('shoeSize'),
    hasValueConstraint: 42,
    sortBy: ns('age') as PathExpr,
    parentNodeShape: shape,
  });

  const status = createPropertyShapeData();
  Object.assign(status, {
    id: 'https://example.org/shapes/Person/status',
    label: 'status',
    path: ns('status'),
    in: [ns('Active'), ns('Inactive'), 'pending', 3, true],
    parentNodeShape: shape,
  });

  const addresses = createPropertyShapeData();
  Object.assign(addresses, {
    id: 'https://example.org/shapes/Person/addresses',
    label: 'addresses',
    path: ns('address'),
    valueShape: {id: 'https://example.org/shapes/Address'},
    class: ns('Address'),
    contains: true,
    maxCount: 0,
    parentNodeShape: shape,
  });

  shape.propertyShapes = [name, age, status, addresses];
  return shape;
}

describe('nodeShapeWire — round trip', () => {
  test('toWire output is JSON-serializable (the parent back-reference is dropped)', () => {
    const shape = richShape();
    expect(() => JSON.stringify(shape)).toThrow(); // circular, as designed
    const wire = toWire(shape);
    expect(() => JSON.stringify(wire)).not.toThrow();
    for (const prop of wire.propertyShapes) {
      expect(prop).not.toHaveProperty('parentNodeShape');
    }
  });

  test('fromWire(toWire(shape)) restores the metamodel', () => {
    const shape = richShape();
    const restored = fromWire(toWire(shape));

    expect(restored.id).toBe(shape.id);
    expect(restored.label).toBe(shape.label);
    expect(restored.description).toBe(shape.description);
    expect(restored.targetClass).toEqual(shape.targetClass);
    expect(restored.extends).toEqual(shape.extends);
    expect(restored.dependent).toBe(true);
    expect(restored.closed).toBe(true);
    expect(restored.ignoredProperties).toEqual(shape.ignoredProperties);
    expect(restored.propertyShapes).toHaveLength(shape.propertyShapes.length);
  });

  test('survives an actual JSON hop, not just an in-memory copy', () => {
    const shape = richShape();
    const restored = fromWire(
      JSON.parse(JSON.stringify(toWire(shape))) as NodeShapeWire,
    );
    const original = shape.propertyShapes[1];
    const hopped = restored.propertyShapes[1];
    expect(hopped.path).toEqual(original.path);
    expect(hopped.minInclusive).toBe(0);
    expect(hopped.maxInclusive).toBe(130);
    expect(hopped.minExclusive).toBe(-1);
    expect(hopped.maxExclusive).toBe(131);
    expect(hopped.hasValueConstraint).toBe(42);
    expect(hopped.equalsConstraint).toEqual(original.equalsConstraint);
    expect(hopped.disjoint).toEqual(original.disjoint);
    expect(hopped.lessThan).toEqual(original.lessThan);
    expect(hopped.lessThanOrEquals).toEqual(original.lessThanOrEquals);
    expect(hopped.sortBy).toEqual(original.sortBy);
  });

  test('the parent back-reference is restored and points at the new shape', () => {
    const restored = fromWire(toWire(richShape()));
    for (const prop of restored.propertyShapes) {
      expect(prop.parentNodeShape).toBe(restored);
    }
  });

  test('pattern round-trips as source + flags, not as {}', () => {
    const shape = richShape();
    const wire = toWire(shape);
    expect(wire.propertyShapes[0].pattern).toBe('^[A-Z][a-z]+$');
    expect(wire.propertyShapes[0].patternFlags).toBe('i');

    const restored = fromWire(JSON.parse(JSON.stringify(wire)) as NodeShapeWire);
    const pattern = restored.propertyShapes[0].pattern;
    expect(pattern).toBeInstanceOf(RegExp);
    expect(pattern!.source).toBe('^[A-Z][a-z]+$');
    expect(pattern!.flags).toBe('i');
    expect(pattern!.test('Alice')).toBe(true);
  });

  test('sh:in keeps mixed node refs and literals', () => {
    const restored = fromWire(
      JSON.parse(JSON.stringify(toWire(richShape()))) as NodeShapeWire,
    );
    expect(restored.propertyShapes[2].in).toEqual([
      ns('Active'),
      ns('Inactive'),
      'pending',
      3,
      true,
    ]);
  });

  test('containment and value-shape references survive', () => {
    const restored = fromWire(toWire(richShape()));
    const addresses = restored.propertyShapes[3];
    expect(addresses.contains).toBe(true);
    expect(addresses.valueShape).toEqual({
      id: 'https://example.org/shapes/Address',
    });
    expect(addresses.class).toEqual(ns('Address'));
    // maxCount 0 must survive — it is falsy, so a truthiness-guarded copy loses it.
    expect(addresses.maxCount).toBe(0);
  });

  test.each(PATHS)('path variant survives a JSON hop: $name', ({path}) => {
    const shape = createNodeShapeData('https://example.org/shapes/PathTest');
    const prop = createPropertyShapeData();
    Object.assign(prop, {
      id: 'https://example.org/shapes/PathTest/p',
      label: 'p',
      path,
      parentNodeShape: shape,
    });
    shape.propertyShapes = [prop];

    const restored = fromWire(
      JSON.parse(JSON.stringify(toWire(shape))) as NodeShapeWire,
    );
    expect(restored.propertyShapes[0].path).toEqual(path);
  });

  test('a shape with no properties round-trips', () => {
    const shape = createNodeShapeData('https://example.org/shapes/Empty');
    const restored = fromWire(toWire(shape));
    expect(restored.id).toBe(shape.id);
    expect(restored.propertyShapes).toEqual([]);
  });

  test('isNodeShapeWire distinguishes the two forms', () => {
    expect(isNodeShapeWire(richShape())).toBe(false);
    expect(isNodeShapeWire(toWire(richShape()))).toBe(true);
  });

  test('toWire does not mutate its input', () => {
    const shape = richShape();
    toWire(shape);
    expect(shape.propertyShapes[0].parentNodeShape).toBe(shape);
    expect(shape.propertyShapes[0].pattern).toBeInstanceOf(RegExp);
  });
});
