/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reading what a relation property points at.
 *
 * SHACL says it two ways, and they mean different things:
 *
 * - `sh:node S` (`valueShape`) names the SHAPE a value conforms to — and so the shape to
 *   view, edit or create it through.
 * - `sh:class C` (`class`) names the CLASS a value is an instance of. It says what the value
 *   *is*, not which shape describes it; several shapes may target the same class, or none.
 *
 * These helpers keep the two apart instead of folding one into the other. A `class`-only
 * relation is resolved to a shape here, at read time, and the answer is never written back
 * into the shape: a derived `sh:node` would then be indistinguishable from an authored one.
 *
 * Every helper works on a property in data or wire form, and takes an optional set of
 * shapes to resolve against — a project's catalog — in place of the registry, which also
 * holds compiled framework shapes for the same classes.
 */

import {shacl} from '../ontologies/shacl.js';
import {getShapesForTargetClass, getTargetClassId} from '../utils/ShapeClass.js';
import type {NodeShapeData, PropertyShapeData} from './nodeShapeData.js';
import type {NodeShapeWire} from './nodeShapeWire.js';

/** The fields of a property shape these helpers read; data and wire form both satisfy it. */
export type RelationPropertyLike = Pick<PropertyShapeData, 'valueShape' | 'class' | 'nodeKind'>;

/** Shapes to resolve against in place of the registry. Iterated more than once — pass an array. */
export type ShapeCandidates = Iterable<NodeShapeData | NodeShapeWire>;

/** How a relation property resolved to the shape its values are viewed through. */
export interface RelationShapeResolution {
  /** The shape to use, when there is one. */
  shapeId?: string;
  /** Every shape that qualified, in preference order; `shapeId` is the first. */
  candidates: string[];
  /** `node`: declared by `sh:node`. `class`: matched on `sh:class`. `none`: no shape found. */
  source: 'node' | 'class' | 'none';
}

const NODE_KINDS = new Set<string>([shacl.IRI.id, shacl.BlankNode.id, shacl.BlankNodeOrIRI.id]);

/** True when the property's values are nodes (IRIs or blank nodes) rather than literals. */
export function isRelation(p: RelationPropertyLike): boolean {
  if (p.valueShape || p.class) return true;
  return !!p.nodeKind?.id && NODE_KINDS.has(p.nodeKind.id);
}

/**
 * The class a relation's values are instances of: the declared `sh:class`, else the
 * targetClass of its `sh:node` shape. `undefined` when neither says.
 */
export function rangeClassOf(
  p: RelationPropertyLike,
  shapes?: ShapeCandidates,
): string | undefined {
  if (p.class?.id) return p.class.id;
  if (!p.valueShape?.id) return undefined;
  return getTargetClassId(p.valueShape, shapes);
}

/**
 * Ambiguities already warned about, keyed by class and candidate set, so a list of many rows
 * warns once and not once per row — while a different set of shapes competing for the same
 * class (another project's catalog, or the registry next to a catalog) still gets its own.
 */
const warnedAmbiguities = new Set<string>();

/**
 * The shape a relation's values are viewed, picked and created through.
 *
 * A declared `sh:node` wins outright: the relation uses exactly that shape. Otherwise the
 * shapes targeting the property's `sh:class` are candidates — the least specific ones (a
 * shape that extends another candidate is left out, so a relation to `Person` creates a
 * `Person`, never an `Employee extends Person`), sorted by id — and the first is used. More
 * than one root is a real ambiguity the data does not settle, so it warns — once per class
 * and candidate set — naming every candidate and the one chosen. No candidate (or no
 * `sh:class` either) resolves to `none`: the value can still be shown as a reference,
 * but there is no shape to open or create it through.
 */
export function resolveRelationShape(
  p: RelationPropertyLike,
  shapes?: ShapeCandidates,
): RelationShapeResolution {
  if (p.valueShape?.id) {
    return {shapeId: p.valueShape.id, candidates: [p.valueShape.id], source: 'node'};
  }
  const classIri = p.class?.id;
  if (classIri) {
    const matches = shapes
      ? getShapesForTargetClass(classIri, shapes)
      : getShapesForTargetClass(classIri);
    const candidates = matches.map((shape) => shape.id);
    if (candidates.length) {
      const warnKey = `${classIri}|${candidates.join(' ')}`;
      if (candidates.length > 1 && !warnedAmbiguities.has(warnKey)) {
        warnedAmbiguities.add(warnKey);
        console.warn(
          `[linked] ${candidates.length} shapes target class '${classIri}': ` +
            `${candidates.join(', ')}. Using '${candidates[0]}' for relations declared ` +
            `with sh:class only. Declare sh:node on the property to choose explicitly.`,
        );
      }
      return {shapeId: candidates[0], candidates, source: 'class'};
    }
  }
  return {candidates: [], source: 'none'};
}
