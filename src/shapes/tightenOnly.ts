/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Tighten-only: a property a sub-shape redeclares (same label as an inherited one) may only
 * narrow what the inherited property allows. An instance of the sub-shape is an instance of the
 * super-shape, so a value the override admits must be one the base admits.
 *
 * This module holds the comparison. Its callers decide what a widening costs:
 * `registerPropertyShape` throws for the three original cases (minCount, maxCount, nodeKind) and
 * warns for the others; a shape that exists only as data is warned for every case (it is
 * registered from store data at runtime, which must never stop a running app); the shape check
 * (`checkShapeHierarchy`) reports them as `override-not-tightened` and adds the class
 * comparison, which needs the class hierarchy.
 *
 * @internal
 */

import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {shacl} from '../ontologies/shacl.js';
import {getAllNodeShapes, isSubShapeOf} from '../utils/ShapeClass.js';
import {canonicalPathKey} from '../paths/pathExprToSparql.js';
import {getPropertyShapes, type NodeShapeData, type PropertyShapeData} from './nodeShapeData.js';

/** The constraint an override widened. */
export type OverrideField =
  | 'minCount'
  | 'maxCount'
  | 'nodeKind'
  | 'datatype'
  | 'valueShape'
  | 'contains'
  | 'path';

export interface OverrideWidening {
  field: OverrideField;
  reason: string;
}

const ATOMIC_NODE_KINDS = [shacl.BlankNode.id, shacl.IRI.id, shacl.Literal.id];

/** The atomic node kinds (BlankNode, IRI, Literal) a `sh:nodeKind` value admits. */
export const nodeKindToAtomics = (nodeKind?: NodeReferenceValue): Set<string> => {
  if (!nodeKind?.id) {
    return new Set();
  }
  switch (nodeKind.id) {
    case shacl.BlankNode.id:
    case shacl.IRI.id:
    case shacl.Literal.id:
      return new Set([nodeKind.id]);
    case shacl.BlankNodeOrIRI.id:
      return new Set([shacl.BlankNode.id, shacl.IRI.id]);
    case shacl.IRIOrLiteral.id:
      return new Set([shacl.IRI.id, shacl.Literal.id]);
    case shacl.BlankNodeOrLiteral.id:
      return new Set([shacl.BlankNode.id, shacl.Literal.id]);
    default:
      return new Set(ATOMIC_NODE_KINDS);
  }
};

const pathKey = (ps: PropertyShapeData): string | undefined => {
  if (!ps.path) return undefined;
  try {
    return canonicalPathKey(ps.path);
  } catch {
    return undefined;
  }
};

/**
 * A value shape the override names is narrower than the base's when it is the same shape or a
 * sub-shape of it. `undefined` when that cannot be decided yet: the override's value shape is not
 * registered (a `[package, name]` reference, or a class still being set up).
 */
export function valueShapeNarrows(
  base: NodeReferenceValue,
  override: NodeReferenceValue,
): boolean | undefined {
  if (base.id === override.id) return true;
  if (!getAllNodeShapes().has(override.id)) return undefined;
  return isSubShapeOf(override.id, base.id);
}

/**
 * Every way `override` widens `base`, in a fixed order. `fields` limits the comparison (all seven
 * by default). The class (`sh:class`) is not compared here: deciding whether one class is
 * narrower than another needs the class hierarchy, so the shape check compares it.
 */
export function overrideWidenings(
  base: PropertyShapeData,
  override: PropertyShapeData,
  fields?: ReadonlySet<OverrideField>,
): OverrideWidening[] {
  const out: OverrideWidening[] = [];
  const wants = (field: OverrideField) => !fields || fields.has(field);
  if (
    wants('minCount') &&
    typeof base.minCount === 'number' &&
    typeof override.minCount === 'number' &&
    override.minCount < base.minCount
  ) {
    out.push({
      field: 'minCount',
      reason: `minCount cannot be lowered (${base.minCount} -> ${override.minCount}).`,
    });
  }
  if (
    wants('maxCount') &&
    typeof base.maxCount === 'number' &&
    typeof override.maxCount === 'number' &&
    override.maxCount > base.maxCount
  ) {
    out.push({
      field: 'maxCount',
      reason: `maxCount cannot be increased (${base.maxCount} -> ${override.maxCount}).`,
    });
  }
  if (wants('nodeKind') && base.nodeKind && override.nodeKind) {
    const baseKinds = nodeKindToAtomics(base.nodeKind);
    const overrideKinds = nodeKindToAtomics(override.nodeKind);
    if ([...overrideKinds].some((kind) => !baseKinds.has(kind))) {
      out.push({
        field: 'nodeKind',
        reason: `nodeKind cannot be widened (${base.nodeKind.id} -> ${override.nodeKind.id}).`,
      });
    }
  }
  if (
    wants('datatype') &&
    base.datatype?.id &&
    override.datatype?.id &&
    base.datatype.id !== override.datatype.id
  ) {
    out.push({
      field: 'datatype',
      reason: `datatype cannot change (${base.datatype.id} -> ${override.datatype.id}).`,
    });
  }
  if (wants('valueShape') && base.valueShape?.id && override.valueShape?.id) {
    if (valueShapeNarrows(base.valueShape, override.valueShape) === false) {
      out.push({
        field: 'valueShape',
        reason:
          `value shape ${override.valueShape.id} is not ${base.valueShape.id} or a sub-shape of it.`,
      });
    }
  }
  if (wants('contains') && base.contains && !override.contains) {
    out.push({
      field: 'contains',
      reason: `contains cannot be dropped (the inherited property owns its values).`,
    });
  }
  if (wants('path')) {
    const baseKey = pathKey(base);
    const overrideKey = pathKey(override);
    if (baseKey && overrideKey && baseKey !== overrideKey) {
      out.push({
        field: 'path',
        reason: `path cannot change (${baseKey} -> ${overrideKey}).`,
      });
    }
  }
  return out;
}

/**
 * The inherited property shape `label` overrides on `shape`: the nearest ancestor's own property
 * shape of that label. `ancestors` is `getSuperShapes(shape)`, most specific first.
 */
export function nearestInherited(
  ancestors: NodeShapeData[],
  label: string,
): PropertyShapeData | undefined {
  for (const ancestor of ancestors) {
    const found = getPropertyShapes(ancestor).find((ps) => ps.label === label);
    if (found) return found;
  }
  return undefined;
}

/**
 * An inherited property, under another label, with the same path as `property`: the same
 * property declared twice under two names. `undefined` when there is none.
 */
export function inheritedSamePath(
  ancestors: NodeShapeData[],
  property: PropertyShapeData,
): PropertyShapeData | undefined {
  const key = pathKey(property);
  if (!key) return undefined;
  for (const ancestor of ancestors) {
    for (const ps of getPropertyShapes(ancestor)) {
      if (ps.label !== property.label && pathKey(ps) === key) return ps;
    }
  }
  return undefined;
}

const warned = new Set<string>();

/** The warning text of an override that widens its inherited property. */
export function overrideWarningText(shapeLabel: string, label: string, reason: string): string {
  return (
    `[linked] Override ${shapeLabel}.${label} widens the inherited property: ${reason} ` +
    `This becomes an error in the next major.`
  );
}

/** Warn once per shape, property label and field. */
export function warnOverrideOnce(
  shape: NodeShapeData,
  label: string,
  widening: OverrideWidening,
): void {
  const key = `${shape.id}\u0000${label}\u0000${widening.field}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(overrideWarningText(shape.label ?? shape.id, label, widening.reason));
}

/** The reason text of a new label whose path equals an inherited property's. */
export function samePathReason(other: PropertyShapeData): string {
  return (
    `the path ${pathKey(other) ?? '?'} is already declared as the inherited property ` +
    `'${other.label}'; redeclare it under that label.`
  );
}

/**
 * Compare every own property of a shape known only as data against the property it overrides,
 * all seven cases, and warn. Data-only shapes are registered from store data at runtime and are
 * never refused.
 */
export function warnDataOnlyOverrides(shape: NodeShapeData, ancestors: NodeShapeData[]): void {
  for (const property of getPropertyShapes(shape)) {
    const base = nearestInherited(ancestors, property.label);
    if (base) {
      for (const widening of overrideWidenings(base, property)) {
        warnOverrideOnce(shape, property.label, widening);
      }
      continue;
    }
    const other = inheritedSamePath(ancestors, property);
    if (other) {
      warnOverrideOnce(shape, property.label, {field: 'path', reason: samePathReason(other)});
    }
  }
}
