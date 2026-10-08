/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {NodeReferenceValue} from '../utils/NodeReference.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';
import {getAllNodeShapes, getRegistryVersion, getSuperShapes} from '../utils/ShapeClass.js';

/**
 * Plain-object SHACL metadata — the QResult-like shape of a `sh:PropertyShape`.
 *
 * Shapes are metadata, not data: a shape class's `.shape` and its property shapes
 * are plain objects (no class instance, no methods). Operations that used to be
 * instance methods now live as free functions in this module.
 */
export interface PropertyShapeData {
  id: string;
  label: string;
  path: PathExpr;
  nodeKind?: NodeReferenceValue;
  datatype?: NodeReferenceValue;
  minCount?: number;
  maxCount?: number;
  name?: string;
  description?: string;
  order?: number;
  group?: string;
  /**
   * `core:displayRank` — a single linear importance rank, lower = more
   * important. Truncated display contexts ("the top 3 properties") derive from it.
   * Distinct from `order`, which is arrangement rather than importance.
   */
  displayRank?: number;
  /** `core:displayHidden` — omit from generic rendering. */
  displayHidden?: boolean;
  class?: NodeReferenceValue;
  in?: (NodeReferenceValue | string | number | boolean)[];
  equalsConstraint?: NodeReferenceValue;
  disjoint?: NodeReferenceValue;
  lessThan?: NodeReferenceValue;
  lessThanOrEquals?: NodeReferenceValue;
  /** Value-range constraints (sh:minInclusive / sh:maxInclusive / sh:minExclusive / sh:maxExclusive). */
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number | string;
  maxExclusive?: number;
  /** String-length constraints (sh:minLength / sh:maxLength). */
  minLength?: number;
  maxLength?: number;
  /** Regex constraint (sh:pattern); serialized as its source string. */
  pattern?: RegExp;
  hasValueConstraint?: NodeReferenceValue | string | number | boolean;
  defaultValue?: unknown;
  sortBy?: PathExpr;
  valueShape?: NodeReferenceValue;
  /** Composition marker: the value(s) of this property are owned by the subject. */
  contains?: boolean;
  parentNodeShape?: NodeShapeData;
}

/**
 * Plain-object SHACL metadata — the QResult-like shape of a `sh:NodeShape`.
 */
export interface NodeShapeData {
  id: string;
  label?: string;
  description?: string;
  targetClass?: NodeReferenceValue;
  extends?: NodeReferenceValue;
  /** Composition marker: instances are dependent (cascade-deletable via `contains`). */
  dependent?: boolean;
  /** sh:closed — target nodes with undeclared properties are invalid. */
  closed?: boolean;
  /** sh:ignoredProperties — extra properties permitted when the shape is closed. */
  ignoredProperties?: NodeReferenceValue[];
  propertyShapes: PropertyShapeData[];
}

/**
 * Result object produced by `propertyShapeToResult()` (SHACL projection).
 * @deprecated No production callers remain (the `NodeShape.properties` getter and
 * `PropertyShape.getResult()` were removed with the plain-object conversion). Read
 * the plain `PropertyShapeData` fields directly. Scheduled for removal.
 */
export interface PropertyShapeResult {
  id: string;
  label: string;
  path: PathExpr;
  nodeKind?: NodeReferenceValue;
  datatype?: NodeReferenceValue;
  minCount?: number;
  maxCount?: number;
  name?: string;
  description?: string;
  order?: number;
  group?: string;
  class?: NodeReferenceValue;
  in?: (NodeReferenceValue | string | number | boolean)[];
  equals?: NodeReferenceValue;
  disjoint?: NodeReferenceValue;
  lessThan?: NodeReferenceValue;
  lessThanOrEquals?: NodeReferenceValue;
  hasValue?: NodeReferenceValue | string | number | boolean;
  defaultValue?: unknown;
  sortBy?: PathExpr;
  valueShape?: NodeReferenceValue;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/** Create an empty NodeShape metadata object for the given shape IRI. */
export function createNodeShapeData(id: string): NodeShapeData {
  return {id, propertyShapes: []};
}

/** Create a blank PropertyShape metadata object (fields filled in by the caller). */
export function createPropertyShapeData(): PropertyShapeData {
  return {id: '', label: '', path: null as unknown as PathExpr};
}

// ---------------------------------------------------------------------------
// Free functions (formerly NodeShape/PropertyShape instance methods)
// ---------------------------------------------------------------------------

/** One-time warning keys for shapes whose `propertyShapes` is missing/invalid. */
const warnedMissingPropertyShapes = new Set<string>();

/**
 * Read a node shape's own property shapes, tolerating a missing/invalid array.
 *
 * A non-array `propertyShapes` almost always means a duplicate `@_linked/core`
 * install or a non-normalized static shape on a superclass; warn once per shape id
 * (diagnostic parity with the former `NodeShape.listPropertyShapesSafe`) and treat
 * it as empty.
 */
function ownPropertyShapes(nodeShape: NodeShapeData): PropertyShapeData[] {
  const own = (nodeShape as {propertyShapes?: PropertyShapeData[]}).propertyShapes;
  if (Array.isArray(own)) {
    return own;
  }
  const id = (nodeShape as {id?: string}).id ?? '';
  if (!warnedMissingPropertyShapes.has(id)) {
    warnedMissingPropertyShapes.add(id);
    console.warn(
      `[@_linked/core] static shape ${id ? `'${id}'` : '(unknown id)'} has missing ` +
        `or invalid propertyShapes. Treating as []. Often caused by duplicate ` +
        `@_linked/core installs or a non-normalized static shape on a superclass.`,
    );
  }
  return [];
}

/**
 * Property shapes declared on this NodeShape. With `includeSuperClasses`, walks the
 * inheritance chain via `getSuperShapes` and concatenates each ancestor's own property
 * shapes — the prototype chain for a class-backed shape, `extends` for one known only
 * as data.
 */
export function getPropertyShapes(
  nodeShape: NodeShapeData,
  includeSuperClasses: boolean = false,
): PropertyShapeData[] {
  if (!includeSuperClasses) {
    return [...ownPropertyShapes(nodeShape)];
  }
  // One inheritance walk, shared with getSuperShapes: the prototype chain for a
  // class-backed shape (which includes the framework `Shape` root and its `label` /
  // `type` properties), or `extends` through the registry for a shape that exists only
  // as data. Previously this walked the prototype chain directly and returned ONLY own
  // properties when no class existed — so a project-authored shape silently lost
  // everything it inherited.
  const res: PropertyShapeData[] = [...ownPropertyShapes(nodeShape)];
  for (const superShape of getSuperShapes(nodeShape)) {
    res.push(...ownPropertyShapes(superShape));
  }
  return res;
}

// ---------------------------------------------------------------------------
// Property-shape lookup by id
// ---------------------------------------------------------------------------

// The registry scan behind predicate, datatype and dependency resolution, cached on
// successful lookups only and invalidated by the registry version.
const propertyShapeCache = new Map<string, PropertyShapeData>();
let propertyShapeCacheVersion = -1;

/**
 * Find the property shape declared under a property-shape IRI, across every
 * registered node shape.
 *
 * Scans the METAMODEL registry, which holds every shape — authored or data-only.
 * Scanning the class registry meant a data-only property was never found, and the
 * caller then fell through to emitting the PROPERTY SHAPE's IRI as the SPARQL
 * predicate: a silently wrong query that matched nothing, with no error.
 *
 * Cache keyed on the registration version rather than the registry SIZE. Size does not
 * change when a shape is re-registered in place, which is exactly what happens when a
 * shape is edited and its metadata replaced. Only successful resolutions are cached — a
 * not-found is never stored, so a property resolved before its shape registers can
 * still resolve correctly afterwards.
 */
export function findPropertyShapeById(propertyId: string): PropertyShapeData | undefined {
  const version = getRegistryVersion();
  if (version !== propertyShapeCacheVersion) {
    propertyShapeCache.clear();
    propertyShapeCacheVersion = version;
  }
  const cached = propertyShapeCache.get(propertyId);
  if (cached) return cached;

  for (const nodeShape of getAllNodeShapes().values()) {
    const propertyShape = getPropertyShapes(nodeShape, true).find(
      (prop: {id?: string}) => prop.id === propertyId,
    );
    if (propertyShape) {
      propertyShapeCache.set(propertyId, propertyShape);
      return propertyShape;
    }
  }
  return undefined;
}

/** Property shapes across the inheritance chain, deduped by label (most specific wins). */
export function getUniquePropertyShapes(
  nodeShape: NodeShapeData,
): PropertyShapeData[] {
  const unique: PropertyShapeData[] = [];
  const seen = new Set<string>();
  for (const ps of getPropertyShapes(nodeShape, true)) {
    if (!seen.has(ps.label)) {
      seen.add(ps.label);
      unique.push(ps);
    }
  }
  return unique;
}

/**
 * Find a property shape by label. With `checkSubShapes` (default true), ascends the
 * inheritance chain if the label isn't found locally.
 *
 * Shares `getSuperShapes` with {@link getPropertyShapes}, so the singular and plural
 * lookups can never disagree about what a shape inherits — and so a shape registered
 * from data resolves inherited properties through `extends` rather than stopping at its
 * own. This is what `getPropertyShapeByLabel` delegates to (PR #211), so closing the gap
 * here closes it for the query proxies too. See docs/backlog/040.
 */
export function getPropertyShape(
  nodeShape: NodeShapeData,
  label: string,
  checkSubShapes: boolean = true,
): PropertyShapeData | undefined {
  const own = ownPropertyShapes(nodeShape).find((ps) => ps.label === label);
  if (own || !checkSubShapes) return own;
  for (const superShape of getSuperShapes(nodeShape)) {
    const inherited = ownPropertyShapes(superShape).find(
      (ps) => ps.label === label,
    );
    if (inherited) return inherited;
  }
  return undefined;
}

/** Two node shapes are equal when they share the same IRI. */
export function nodeShapeEquals(a: NodeShapeData, b?: NodeShapeData): boolean {
  return !!b && a?.id === b.id;
}

/** Append a property shape to a node shape, wiring the back-reference. */
export function addPropertyShape(
  nodeShape: NodeShapeData,
  propertyShape: PropertyShapeData,
): void {
  propertyShape.parentNodeShape = nodeShape;
  if (!Array.isArray(nodeShape.propertyShapes)) {
    nodeShape.propertyShapes = [];
  }
  nodeShape.propertyShapes.push(propertyShape);
}

/** Shallow-clone a property shape (used by property override / disallow). */
export function clonePropertyShape(
  propertyShape: PropertyShapeData,
): PropertyShapeData {
  return {...propertyShape};
}

/**
 * Project a property shape to its SHACL result object.
 * @deprecated No production callers remain. Read the plain `PropertyShapeData`
 * fields directly (note this projection renames `equalsConstraint`→`equals`,
 * `hasValueConstraint`→`hasValue`, and serializes `pattern` to its source string).
 * Scheduled for removal.
 */
export function propertyShapeToResult(ps: PropertyShapeData): PropertyShapeResult {
  const result: Record<string, unknown> & {id: string; label: string; path: PathExpr} = {
    id: ps.id,
    label: ps.label,
    path: ps.path,
  };
  if (ps.nodeKind) result.nodeKind = ps.nodeKind;
  if (ps.datatype) result.datatype = ps.datatype;
  if (typeof ps.minCount === 'number') result.minCount = ps.minCount;
  if (typeof ps.maxCount === 'number') result.maxCount = ps.maxCount;
  if (ps.name) result.name = ps.name;
  if (ps.description) result.description = ps.description;
  if (typeof ps.order === 'number') result.order = ps.order;
  if (ps.group) result.group = ps.group;
  if (ps.class) result.class = ps.class;
  if (ps.in) result.in = ps.in;
  if (ps.equalsConstraint) result.equals = ps.equalsConstraint;
  if (ps.disjoint) result.disjoint = ps.disjoint;
  if (ps.lessThan) result.lessThan = ps.lessThan;
  if (ps.lessThanOrEquals) result.lessThanOrEquals = ps.lessThanOrEquals;
  if (ps.minInclusive !== undefined) result.minInclusive = ps.minInclusive;
  if (ps.maxInclusive !== undefined) result.maxInclusive = ps.maxInclusive;
  if (ps.minExclusive !== undefined) result.minExclusive = ps.minExclusive;
  if (ps.maxExclusive !== undefined) result.maxExclusive = ps.maxExclusive;
  if (typeof ps.minLength === 'number') result.minLength = ps.minLength;
  if (typeof ps.maxLength === 'number') result.maxLength = ps.maxLength;
  if (ps.pattern) result.pattern = ps.pattern.source;
  if (ps.hasValueConstraint !== undefined) result.hasValue = ps.hasValueConstraint;
  if (ps.defaultValue !== undefined) result.defaultValue = ps.defaultValue;
  if (ps.sortBy) result.sortBy = ps.sortBy;
  if (ps.valueShape) result.valueShape = ps.valueShape;
  return result as PropertyShapeResult;
}
