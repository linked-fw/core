/**
 * The metamodel⇄wire conversions must be idempotent.
 *
 * Nothing decides which form a shape is in except `isNodeShapeWire`, and that is a
 * structural guess: the two types differ only by `parentNodeShape` and by `pattern`
 * being a RegExp rather than a source string, so a shape carrying neither satisfies
 * both. A shape with no property shapes is the extreme case — `[].every()` is
 * vacuously true, so every propertyless shape reads as wire.
 *
 * The guess is therefore allowed to be wrong, and the conversions have to survive
 * being applied to a form they were not meant for. These tests pin that.
 */
import {describe, expect, test} from '@jest/globals';
import {fromWire, toWire, isNodeShapeWire} from '../shapes/nodeShapeWire';
import type {NodeShapeData} from '../shapes/nodeShapeData';

const shapeWithPattern = (): NodeShapeData => {
  const shape = {
    id: 'https://example.org/shape/Thing',
    label: 'Thing',
    propertyShapes: [] as any[],
  } as NodeShapeData;
  shape.propertyShapes = [
    {
      id: 'https://example.org/shape/Thing/code',
      label: 'code',
      path: {id: 'https://example.org/code'},
      pattern: /^[A-Z]{3}$/i,
      parentNodeShape: shape,
    } as any,
  ];
  return shape;
};

describe('metamodel ⇄ wire conversions are idempotent', () => {
  test('fromWire on an already-converted shape keeps its compiled pattern', () => {
    const metamodel = shapeWithPattern();

    // The misclassification this guards against: handing a metamodel shape to
    // `fromWire`. Before it was idempotent, `pattern` was destructured out and only
    // restored when it was a string — so a RegExp was silently DROPPED, and the
    // shape then validated values it should have rejected.
    const again = fromWire(metamodel as any);

    const pattern = again.propertyShapes[0].pattern;
    expect(pattern).toBeInstanceOf(RegExp);
    expect((pattern as RegExp).source).toBe('^[A-Z]{3}$');
    expect((pattern as RegExp).flags).toBe('i');
  });

  test('a full round trip preserves the pattern and its flags', () => {
    const wire = toWire(shapeWithPattern());
    expect(wire.propertyShapes[0].pattern).toBe('^[A-Z]{3}$');
    expect(wire.propertyShapes[0].patternFlags).toBe('i');

    const back = fromWire(wire);
    expect(back.propertyShapes[0].pattern).toEqual(/^[A-Z]{3}$/i);
    expect(back.propertyShapes[0].parentNodeShape).toBe(back);
  });

  test('toWire on an already-wire shape keeps the source string', () => {
    const twice = toWire(toWire(shapeWithPattern()) as any);
    expect(twice.propertyShapes[0].pattern).toBe('^[A-Z]{3}$');
  });

  test('a shape with no property shapes reads as wire — the ambiguity, pinned', () => {
    // Not a defect to fix: it is why the conversions must tolerate either input.
    const empty = {id: 'https://example.org/shape/Empty', propertyShapes: []} as NodeShapeData;
    expect(isNodeShapeWire(empty)).toBe(true);
    expect(fromWire(empty as any).propertyShapes).toEqual([]);
  });
});
