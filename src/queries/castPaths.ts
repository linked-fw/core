/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Cast-aware DSL-JSON paths: a `.as(Shape)` narrowing rides inline as an `as(<ShapeLabel>)` path
 * segment (`pets.as(Dog).guardDogLevel`, documentation/dsl-json.md "Paths"). Used by fields,
 * conditions and sort keys alike.
 */
import type {NodeShapeData, PropertyShapeData} from '../shapes/SHACL.js';
import {findPropertyShapeById, getQueryPropertyShape} from '../shapes/nodeShapeData.js';
import {PropertyPath, walkPropertyPath} from './PropertyPath.js';
import {getActiveShapeCatalog, getAllNodeShapes, getAllShapeClasses, getNodeShape, getShapeClass} from '../utils/ShapeClass.js';

const CAST_SEGMENT = /^as\((.+)\)$/;

function shapeById(id: string): NodeShapeData | undefined {
  return getShapeClass(id)?.shape ?? getNodeShape(id);
}

export function labelOfId(id: string): string {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

/** The label a cast to `shape` is written with. */
export function castLabelOf(shape: NodeShapeData): string {
  return shape.label ?? labelOfId(shape.id);
}

/** The shape a cast label names. An unknown label is refused, never read as the current shape. */
export function shapeByCastLabel(label: string, path: string): NodeShapeData {
  // Inside a catalog every shape is data (core's built-ins aside), so scan its shapes;
  // the global registry keeps scanning authored classes.
  const matches = (shape?: NodeShapeData): shape is NodeShapeData =>
    !!shape && (shape.label === label || labelOfId(shape.id) === label);
  if (getActiveShapeCatalog() !== undefined) {
    for (const shape of getAllNodeShapes().values()) if (matches(shape)) return shape;
  } else {
    for (const cls of getAllShapeClasses().values()) {
      const shape = (cls as unknown as {shape?: NodeShapeData}).shape;
      if (matches(shape)) return shape;
    }
  }
  throw new Error(`Unknown shape '${label}' in the cast as(${label}) of path '${path}'.`);
}

/**
 * Render a segment chain as a dotted label path, inserting `as(<ShapeLabel>)` wherever a segment
 * is not resolvable by label from the natural (walked) shape — i.e. a `.as(Shape)` narrowing
 * happened before it.
 */
export function pathToStringWithCasts(rootShape: NodeShapeData, segments: readonly PropertyShapeData[]): string {
  const parts: string[] = [];
  let current: NodeShapeData | undefined = rootShape;
  for (const seg of segments) {
    const label = labelOfId(seg.id);
    const natural = current ? getQueryPropertyShape(current, label) : undefined;
    if (!natural || natural.id !== seg.id) {
      // A cast narrowed the context to the segment's owner shape.
      const ownerId = seg.id.slice(0, seg.id.lastIndexOf('/'));
      const owner = shapeById(ownerId);
      parts.push(`as(${owner ? castLabelOf(owner) : labelOfId(ownerId)})`);
      current = owner ?? current;
    }
    parts.push(label);
    const vs = seg.valueShape;
    current = vs ? shapeById(vs.id) ?? current : current;
  }
  return parts.join('.');
}

/** {@link pathToStringWithCasts} over property-shape IRIs (a condition's path refs). */
export function segmentIdsToStringWithCasts(rootShape: NodeShapeData, segmentIds: readonly string[]): string {
  const segments = segmentIds.map((id) => findPropertyShapeById(id));
  if (segments.some((s) => !s)) return segmentIds.map(labelOfId).join('.');
  return pathToStringWithCasts(rootShape, segments as PropertyShapeData[]);
}

/** Inverse of {@link pathToStringWithCasts}: resolve a dotted path with `as(X)` casts. */
export function walkPathWithCasts(rootShape: NodeShapeData, path: string): PropertyPath {
  if (!path.includes('as(')) return walkPropertyPath(rootShape, path);
  const segments: PropertyShapeData[] = [];
  let current: NodeShapeData | undefined = rootShape;
  for (const token of path.split('.')) {
    const cast = CAST_SEGMENT.exec(token);
    if (cast) {
      current = shapeByCastLabel(cast[1], path);
      continue;
    }
    const ps = current ? getQueryPropertyShape(current, token) : undefined;
    if (!ps) {
      throw new Error(
        `Property '${token}' not found on shape '${current?.label || current?.id}' while resolving path '${path}'`,
      );
    }
    segments.push(ps);
    const vs = ps.valueShape;
    current = vs ? shapeById(vs.id) ?? current : current;
  }
  return new PropertyPath(rootShape, segments);
}

/**
 * A relation path that may end in a cast (`pets.as(Dog)`, a quantifier's key): the relation, and
 * the cast shape when there is one.
 */
export function walkRelationWithCast(
  rootShape: NodeShapeData,
  path: string,
): {relation: PropertyPath; cast?: NodeShapeData} {
  const tokens = path.split('.');
  const last = CAST_SEGMENT.exec(tokens[tokens.length - 1] ?? '');
  if (!last) return {relation: walkPathWithCasts(rootShape, path)};
  const relation = walkPathWithCasts(rootShape, tokens.slice(0, -1).join('.'));
  return {relation, cast: shapeByCastLabel(last[1], path)};
}
