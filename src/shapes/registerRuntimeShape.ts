/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Register a shape that exists only as data.
 *
 * This is the return leg of the round trip. `@linkedShape` is class → metadata and
 * `syncShapes` is metadata → RDF; this is RDF → metadata, so a shape authored in a
 * project and read back from its materialized SHACL resolves in queries exactly like a
 * compiled one.
 *
 * It takes metadata — `NodeShapeData`, or its wire form — rather than a bespoke DTO. The
 * previous implementation of this idea lived outside core and rebuilt the shape field by
 * field from a projection, which meant it silently dropped `extends` (so a child shape
 * lost every inherited property), the value constraints, and any property whose label was
 * absent. Taking the metamodel removes that whole class of loss: there is nothing to
 * re-derive.
 *
 * No class is synthesized here. Consumers that need a constructor — the query builders —
 * get one on demand from `getOrCreateShapeAdapter`, so `getShapeClass` keeps reporting
 * only the shapes that have a real authored class.
 */

import {
  assertNoActiveCatalog,
  getShapeClass,
  getSuperShapes,
  registerNodeShape,
} from '../utils/ShapeClass.js';
import {warnDataOnlyOverrides} from './tightenOnly.js';
import {warnOnReservedPropertyLabel} from '../queries/reservedQueryNames.js';
import type {NodeShapeData} from './nodeShapeData.js';
import {fromWire, isNodeShapeWire, type NodeShapeWire} from './nodeShapeWire.js';
import {assertSafeShapePaths} from '../paths/propertyPathSafety.js';

/**
 * Register one shape's metadata under its IRI.
 *
 * Idempotent by replacement: registering the same IRI again replaces the metadata, which
 * is what a shape edited in a builder needs. A shape that already has a compiled class is
 * left alone — an authored class is always the better answer, and shadowing it would make
 * behaviour depend on import order.
 *
 * @returns true when the shape was registered, false when a compiled class already owns
 * the IRI.
 */
export function registerRuntimeShape(
  shape: NodeShapeData | NodeShapeWire,
): boolean {
  assertNoActiveCatalog();
  if (!shape?.id) return false;
  if (getShapeClass(shape.id)) return false;
  // `fromWire` checks the paths of a wire shape; shape data is checked here.
  const isWire = isNodeShapeWire(shape);
  const data = isWire ? fromWire(shape) : (shape as NodeShapeData);
  if (!isWire) assertSafeShapePaths(data);
  // A data-only shape never passes through registerPropertyShape, so the collision
  // check has to happen here too — otherwise a shape authored in a builder is the one
  // kind of shape that gets no warning until the field tracer fails.
  for (const ps of data.propertyShapes ?? []) {
    warnOnReservedPropertyLabel(ps.label, data.label, data.id);
  }
  registerNodeShape(data);
  // Tighten-only for a shape that exists only as data: every case is a warning, because the
  // data comes from a store at runtime and must never stop a running app. Compared against the
  // registered parents (`registerRuntimeShapes` registers parents first).
  if (data.extends?.id) {
    warnDataOnlyOverrides(data, getSuperShapes(data));
  }
  return true;
}

/**
 * Register a whole catalog, parents before children.
 *
 * Order matters: inheritance is resolved by looking `extends` up in the registry, so a
 * child registered before its parent would resolve an empty chain until the parent
 * arrived. Callers should not have to know that, so this sorts by depth first.
 */
export function registerRuntimeShapes(
  shapes: Record<string, NodeShapeData | NodeShapeWire> | (NodeShapeData | NodeShapeWire)[],
): number {
  assertNoActiveCatalog();
  const list = Array.isArray(shapes) ? shapes : Object.values(shapes);
  const byId = new Map(list.map((s) => [s.id, s]));

  const depth = (shape: NodeShapeData | NodeShapeWire): number => {
    let d = 0;
    const seen = new Set<string>([shape.id]);
    let current = shape;
    while (current?.extends?.id && !seen.has(current.extends.id)) {
      seen.add(current.extends.id);
      const parent = byId.get(current.extends.id);
      if (!parent) break; // parent outside this batch — already registered, or absent
      current = parent;
      d++;
    }
    return d;
  };

  let registered = 0;
  for (const shape of [...list].sort((a, b) => depth(a) - depth(b))) {
    if (registerRuntimeShape(shape)) registered++;
  }
  return registered;
}
