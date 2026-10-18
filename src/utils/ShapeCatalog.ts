/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * A set of shapes a query resolves against without registering them.
 *
 * The global registry is process-wide and last-wins: two projects (or two branches of
 * one) that hold the same shape IRI with different properties cannot both be registered.
 * A `ShapeCatalog` is an immutable object holding one such set; `withShapeCatalog(catalog,
 * fn)` makes it the shapes every registry accessor reads while `fn` runs. Builders, field
 * sets and IRs capture the catalog they were made in and re-enter it wherever they are
 * picked up later, so a query built in a scope lowers, compiles and live-tracks against
 * that catalog after the scope has closed.
 *
 * The catalog is never serialized: DSL-JSON carries IRIs only, and each side of a wire
 * supplies its own catalog (`fromJSON(json, {catalog})`).
 *
 * See docs/architecture/runtime-instances.md.
 */

import type {Shape} from '../shapes/Shape.js';
import type {NodeShapeData} from '../shapes/nodeShapeData.js';
import {fromWire, isNodeShapeWire, type NodeShapeWire} from '../shapes/nodeShapeWire.js';
import {getNodeShapeUri} from '../shapes/SHACL.js';
import {warnOnReservedPropertyLabel} from '../queries/reservedQueryNames.js';
import {getRegisteredShapeClass} from './ShapeClass.js';
// Registers PathNode and PathList (PathNode imports PathList), two of the built-ins.
import '../shapes/PathNode.js';

export {
  withShapeCatalog,
  getActiveShapeCatalog,
  catalogOf,
  shapeCatalogKey,
} from './ShapeClass.js';

/**
 * Core's own shapes, which every catalog holds: from its data, else from core's code.
 *
 * `syncShapes` writes them into a dataset like any package's shapes. Data-only shapes depend
 * on them: a property shape's `type` points at `Shape`, and the shape metamodel itself
 * (`NodeShape`, `PropertyShape`, their `sh:in` lists and complex paths) is how a shape
 * sync reads and writes shapes.
 */
const BUILT_IN_NAMES = ['Shape', 'NodeShape', 'PropertyShape', 'List', 'PathNode', 'PathList'];

/** The IRIs of core's six built-in shapes, which every catalog holds. */
export function builtInShapeIris(): string[] {
  return BUILT_IN_NAMES.map((name) => getNodeShapeUri('@_linked/core', name));
}

export class ShapeCatalog {
  /** For log lines only, e.g. `"<projectId>#<branch>"`. */
  readonly name?: string;
  /**
   * Every shape the catalog holds, its own and core's built-ins, by IRI. Read by the
   * registry accessors. A plain field rather than a private one, so a catalog built by
   * one copy of core is readable by another.
   * @internal
   */
  readonly nodeShapes: ReadonlyMap<string, NodeShapeData>;
  /**
   * Core's built-in classes by IRI, for the built-ins the data lacked — the only classes a
   * catalog holds. @internal
   */
  readonly shapeClasses: ReadonlyMap<string, typeof Shape>;

  private constructor(
    nodeShapes: Map<string, NodeShapeData>,
    shapeClasses: Map<string, typeof Shape>,
    name?: string,
  ) {
    this.nodeShapes = nodeShapes;
    this.shapeClasses = shapeClasses;
    if (name !== undefined) this.name = name;
    Object.freeze(this);
  }

  /**
   * Build a catalog from shape metadata or its wire form. Wires are converted as
   * `registerRuntimeShape` converts them (`fromWire`, the reserved-label warning). Unlike the
   * global registry, a row for an IRI that has a compiled class elsewhere is kept: inside a
   * catalog the data is the authority.
   *
   * Core's six built-in shapes come from the data like any other shape (`syncShapes` writes
   * them). Only a built-in the data lacks — a dataset synced by an older core — is added from
   * core's code, with its class.
   */
  static from(
    shapes:
      | Iterable<NodeShapeData | NodeShapeWire>
      | Record<string, NodeShapeData | NodeShapeWire>,
    options?: {name?: string},
  ): ShapeCatalog {
    const list: Iterable<NodeShapeData | NodeShapeWire> =
      shapes && typeof (shapes as Iterable<unknown>)[Symbol.iterator] === 'function'
        ? (shapes as Iterable<NodeShapeData | NodeShapeWire>)
        : Object.values(shapes as Record<string, NodeShapeData | NodeShapeWire>);

    const nodeShapes = new Map<string, NodeShapeData>();
    const shapeClasses = new Map<string, typeof Shape>();
    for (const shape of list) {
      if (!shape?.id) continue;
      const data = isNodeShapeWire(shape) ? fromWire(shape) : (shape as NodeShapeData);
      for (const ps of data.propertyShapes ?? []) {
        warnOnReservedPropertyLabel(ps.label, data.label, data.id);
      }
      nodeShapes.set(data.id, data);
    }
    for (const iri of builtInShapeIris()) {
      if (nodeShapes.has(iri)) continue;
      const shapeClass = getRegisteredShapeClass(iri);
      if (!shapeClass?.shape) continue;
      shapeClasses.set(iri, shapeClass);
      nodeShapes.set(iri, shapeClass.shape);
    }
    return new ShapeCatalog(nodeShapes, shapeClasses, options?.name);
  }

  /** How many shapes the catalog holds, core's built-ins included. */
  get size(): number {
    return this.nodeShapes.size;
  }

  get(iri: string): NodeShapeData | undefined {
    return this.nodeShapes.get(iri);
  }

  has(iri: string): boolean {
    return this.nodeShapes.has(iri);
  }

  /** Every shape the catalog holds, core's built-ins included. */
  values(): IterableIterator<NodeShapeData> {
    return this.nodeShapes.values() as IterableIterator<NodeShapeData>;
  }
}
