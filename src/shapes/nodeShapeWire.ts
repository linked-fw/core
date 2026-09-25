/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * JSON-safe transport form of the shape metamodel.
 *
 * `NodeShapeData` is the one shape metamodel (see `nodeShapeData.ts`). It is
 * *almost* JSON-safe already — `PathExpr` is a plain discriminated union, and every
 * constraint field holds a primitive or a `{id}` reference. Exactly two things stop
 * it crossing a wire:
 *
 *   1. `PropertyShapeData.parentNodeShape` is a back-reference to the owning node
 *      shape, so the object graph is circular and `JSON.stringify` throws.
 *   2. `PropertyShapeData.pattern` is a live `RegExp`, which serializes to `{}`.
 *
 * So the wire form is defined *by subtraction* from the metamodel rather than as a
 * parallel type: drop the back-reference, carry the pattern as its source string,
 * change nothing else. Every field added to `PropertyShapeData` is therefore carried
 * automatically — the single biggest maintenance failure of the `ShapeDetails` type
 * this replaces was that it enumerated a subset by hand and silently fell behind.
 *
 * `fromWire` restores the back-reference and recompiles the pattern, so
 * `fromWire(toWire(shape))` is structurally equal to `shape`.
 */

import type {NodeShapeData, PropertyShapeData} from './nodeShapeData.js';

/** `PropertyShapeData` minus the circular parent link, with `pattern` as a string. */
export type PropertyShapeWire = Omit<
  PropertyShapeData,
  'pattern' | 'parentNodeShape'
> & {
  /** `sh:pattern` as its SOURCE string — never a live RegExp. */
  pattern?: string;
  /** RegExp flags, so a case-insensitive pattern survives the round trip. */
  patternFlags?: string;
};

/** `NodeShapeData` whose property shapes are in wire form. */
export type NodeShapeWire = Omit<NodeShapeData, 'propertyShapes'> & {
  propertyShapes: PropertyShapeWire[];
};

/**
 * True when the value is already in wire form — a structural guess, not a fact.
 *
 * The two forms differ only by `parentNodeShape` and by `pattern` being a RegExp
 * rather than a string, so a shape carrying neither satisfies both types. An empty
 * `propertyShapes` array is the extreme case: `[].every()` is vacuously true, so
 * every propertyless shape reads as wire.
 *
 * This is safe **because the conversions are idempotent**, not because the guess is
 * reliable. `fromWire` preserves an already-compiled pattern and re-attaching a
 * parent link is a no-op, and `toWire` tolerates a pattern that is already a source
 * string. So misclassifying a shape in either direction costs nothing.
 *
 * That property is load-bearing: keep it if you change either converter. Before it
 * held, `fromWire` on an already-converted shape dropped every RegExp pattern.
 */
export function isNodeShapeWire(
  shape: NodeShapeData | NodeShapeWire,
): shape is NodeShapeWire {
  return (shape.propertyShapes ?? []).every(
    (prop) =>
      !(prop as PropertyShapeData).parentNodeShape &&
      !((prop as PropertyShapeData).pattern instanceof RegExp),
  );
}

/** Metamodel → wire. Drops the parent back-reference, stringifies the pattern. */
export function toWire(shape: NodeShapeData): NodeShapeWire {
  return {
    ...shape,
    propertyShapes: (shape.propertyShapes ?? []).map(propertyToWire),
  };
}

/** Wire → metamodel. Restores the parent back-reference, recompiles the pattern. */
export function fromWire(wire: NodeShapeWire): NodeShapeData {
  const shape: NodeShapeData = {
    ...wire,
    propertyShapes: [],
  };
  shape.propertyShapes = (wire.propertyShapes ?? []).map((prop) =>
    propertyFromWire(prop, shape),
  );
  return shape;
}

function propertyToWire(prop: PropertyShapeData): PropertyShapeWire {
  // Destructure the two problem fields out; everything else is carried verbatim,
  // which is what keeps this from falling behind the metamodel.
  const {pattern, parentNodeShape: _drop, ...rest} = prop;
  const wire = rest as PropertyShapeWire;
  if (pattern instanceof RegExp) {
    wire.pattern = pattern.source;
    if (pattern.flags) wire.patternFlags = pattern.flags;
  } else if (typeof pattern === 'string') {
    // Tolerate a pattern that is already a source string (a wire object handed
    // back in). Not a supported input type, but silently dropping it would be worse.
    wire.pattern = pattern;
  }
  return wire;
}

function propertyFromWire(
  wire: PropertyShapeWire,
  parent: NodeShapeData,
): PropertyShapeData {
  const {pattern, patternFlags, ...rest} = wire;
  const prop = rest as PropertyShapeData;
  if (typeof pattern === 'string') {
    prop.pattern = new RegExp(pattern, patternFlags ?? '');
  } else if ((pattern as unknown) instanceof RegExp) {
    // The cast is the point: `pattern` is declared `string` on the wire type, and
    // this branch exists precisely for the input that does not honour that.
    // Already in metamodel form. `pattern` was destructured out above, so without
    // this branch it is silently DROPPED -- converting a shape that was already
    // converted would quietly discard every `sh:pattern` constraint, and the shape
    // would then validate values it should reject.
    //
    // Keeping it makes this function idempotent: fromWire(fromWire(x)) equals
    // fromWire(x) for any input. That matters because the only thing deciding
    // whether to call it is `isNodeShapeWire`, a structural guess -- see the note
    // on that function.
    prop.pattern = pattern as unknown as RegExp;
  }
  prop.parentNodeShape = parent;
  return prop;
}
