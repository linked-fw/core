/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {getAllShapeClasses, getShapeClass} from '../utils/ShapeClass.js';
import {NodeShape} from './SHACL.js';
import {
  getUniquePropertyShapes,
  type NodeShapeData,
  type PropertyShapeData,
} from './nodeShapeData.js';
import {Shape} from './Shape.js';
import {DeleteBuilder} from '../queries/DeleteBuilder.js';
import type {IDataset} from '../interfaces/IDataset.js';
import {rdfList} from './List.js';
import {serializePathToNodeData} from './serializePathToNodeData.js';

/**
 * The npm scope of framework shapes (NodeShape/PropertyShape/List/PathNode/Shape) that
 * describe the meta-model itself and must never be synced as user data.
 */
const FRAMEWORK_PACKAGE = '@_linked/core';

/**
 * Build the create-pipeline data object for a single PropertyShape (flattened under shapeIri).
 *
 * @internal Exported for tests only — not part of the public API.
 */
export function buildPropertyShapeData(ps: PropertyShapeData, shapeIri: string): Record<string, unknown> {
  const psIri = `${shapeIri}/${ps.label}`;
  const d: Record<string, unknown> = {
    __id: psIri,
    path: serializePathToNodeData(ps.path, psIri),
  };
  // `rdfs:label` — the DSL label, i.e. the accessor name the property is reached
  // by in code (`person.memberships`). It is NOT `sh:name`, written below, which
  // is a human-readable display string.
  //
  // Without this the label is only ever implied by `psIri`, and a reader has to
  // re-derive one from the path's local part. That works right up until the two
  // differ — `@_linked/org` declares `memberships` on the path `org:hasMembership`
  // — at which point the catalog reports `hasMembership`, the query proxy indexes
  // the shape with it, and the class (which only knows `memberships`) throws.
  // Readers already prefer a stored label and fall back to the path, so writing it
  // is the whole fix; old catalogs keep working via that fallback.
  if (ps.label) d.label = ps.label;
  if (ps.nodeKind) d.nodeKind = ps.nodeKind;
  if (ps.datatype) d.datatype = ps.datatype;
  if (typeof ps.minCount === 'number') d.minCount = ps.minCount;
  if (typeof ps.maxCount === 'number') d.maxCount = ps.maxCount;
  if (ps.name) d.name = ps.name;
  if (ps.description) d.description = ps.description;
  if (typeof ps.order === 'number') d.order = ps.order;
  if (ps.group) d.group = ps.group;
  if (typeof ps.displayRank === 'number') d.displayRank = ps.displayRank;
  if (ps.displayHidden !== undefined) d.displayHidden = ps.displayHidden;
  if (ps.class) d.class = ps.class;
  if (ps.in) d.in = rdfList(ps.in, {base: `${psIri}/in`});
  if (ps.equalsConstraint) d.equalsConstraint = ps.equalsConstraint;
  if (ps.disjoint) d.disjoint = ps.disjoint;
  if (ps.lessThan) d.lessThan = ps.lessThan;
  if (ps.lessThanOrEquals) d.lessThanOrEquals = ps.lessThanOrEquals;
  if (ps.minInclusive !== undefined) d.minInclusive = ps.minInclusive;
  if (ps.maxInclusive !== undefined) d.maxInclusive = ps.maxInclusive;
  if (ps.minExclusive !== undefined) d.minExclusive = ps.minExclusive;
  if (ps.maxExclusive !== undefined) d.maxExclusive = ps.maxExclusive;
  if (typeof ps.minLength === 'number') d.minLength = ps.minLength;
  if (typeof ps.maxLength === 'number') d.maxLength = ps.maxLength;
  // sh:pattern is serialized as its regex source string.
  if (ps.pattern) d.pattern = ps.pattern.source;
  if (ps.hasValueConstraint !== undefined) d.hasValue = ps.hasValueConstraint;
  if (ps.valueShape) d.valueShape = ps.valueShape;
  if (ps.contains) d.contains = true;
  return d;
}

/** Build the create-pipeline data object for a NodeShape and its (flattened) property shapes. */
function buildNodeShapeData(nodeShape: NodeShapeData, shapeIri: string): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (nodeShape.targetClass) d.targetClass = nodeShape.targetClass;
  if (nodeShape.description) d.description = nodeShape.description;
  if (nodeShape.extends) d.extends = nodeShape.extends;
  if (nodeShape.dependent) d.dependent = true;
  if (nodeShape.closed !== undefined) d.closed = nodeShape.closed;
  if (nodeShape.ignoredProperties && nodeShape.ignoredProperties.length) {
    d.ignoredProperties = nodeShape.ignoredProperties;
  }
  // Flatten: emit own + inherited property shapes (deduped by label) under this shape.
  d.properties = getUniquePropertyShapes(nodeShape).map((ps) =>
    buildPropertyShapeData(ps, shapeIri),
  );
  return d;
}

/**
 * The per-shape `delete → create` thunk shared by `syncShapes()` and `syncShape()`. The delete
 * cascade-cleans the shape's old property-shape / list / path subtrees; the create rebuilds them.
 *
 * `ds` (optional) targets an explicit dataset — both the delete and the create run against it
 * instead of the global router. Omitted → today's global behavior.
 */
function buildSyncThunk(nodeShape: NodeShapeData, iri: string, ds?: IDataset): () => Promise<void> {
  return () => {
    // Build the data fresh on each invocation: the create pipeline mutates the node-data
    // (it strips nested `shape` keys), so a shared object can't be re-used across runs.
    const data = buildNodeShapeData(nodeShape, iri);
    return (DeleteBuilder.from(NodeShape, {id: iri}).exec(ds) as Promise<unknown>)
      .then(() =>
        (NodeShape.create(data as never).withId(iri) as unknown as {
          exec: (target?: IDataset) => Promise<unknown>;
        }).exec(ds),
      )
      .then(() => undefined);
  };
}

/** Options controlling how {@link syncShapes} treats store shapes that are not in code. */
export interface SyncShapesOptions {
  /**
   * How to treat NodeShapes present in the store but not in the current process's code:
   * - `'all'` (default) — prune every store-only shape as an orphan. Correct for a
   *   **single-writer** dataset (CN's own storage sync, tests), where "not in code" ⇒ deleted.
   * - `'ownedNamespaces'` — prune a store-only shape ONLY if its IRI falls within a namespace
   *   this process actually writes (the package-namespace of one of its code-registered shapes,
   *   i.e. the IRI prefix up to the last `/` or `#`). This is the **multi-writer** rule (arch-04:
   *   one app-data dataset, several writers): an app booting `syncShapesOnBoot` must not delete
   *   shapes another writer (e.g. CN's `enableCapability`) materialized into the same dataset in a
   *   package the app never registers. Renames/removals WITHIN the app's own package still prune.
   * - `'none'` — never prune; purely additive (delete→recreate the code shapes, touch nothing else).
   */
  orphanScope?: 'all' | 'ownedNamespaces' | 'none';
}

/** The owning namespace of a shape IRI — everything up to and including the last `/` or `#`. */
function shapeNamespace(iri: string): string {
  const cut = Math.max(iri.lastIndexOf('/'), iri.lastIndexOf('#'));
  return cut >= 0 ? iri.slice(0, cut + 1) : iri;
}

/**
 * Plan an idempotent sync of all code-registered (non-framework) NodeShapes into the store as
 * SHACL data — the forward (code → graph) materialization of arch-05 "code is canonical".
 *
 * Returns built-but-unexecuted thunks; the caller controls execution and batching:
 * ```ts
 * await Promise.all((await syncShapes()).map((run) => run()));
 * ```
 * Each in-code shape's thunk runs `delete → create` in order (the delete cascade-cleans the old
 * property shapes / list / path subtrees via the containment cascade, the create rebuilds them).
 * Shapes present in the store but no longer in code are deleted as orphans (their owned subtree
 * cascades too) — subject to `options.orphanScope`. Reads existing shape IRIs for orphan detection.
 *
 * `ds` (optional) targets an explicit dataset instead of the global router. It is a **plan-time**
 * parameter: it feeds both the orphan-detection read (so orphans are computed against the same
 * store they'll be pruned from) and every delete/create thunk. Omitted → today's global behavior;
 * the returned thunks stay nullary either way.
 *
 * `options.orphanScope` (default `'all'`) scopes the orphan sweep — see {@link SyncShapesOptions}.
 * Multi-writer datasets (an app materializing on boot next to CN's capability shapes) MUST pass
 * `'ownedNamespaces'` so the sweep never clobbers another writer's shapes.
 */
export async function syncShapes(
  ds?: IDataset,
  options?: SyncShapesOptions,
): Promise<Array<() => Promise<void>>> {
  const orphanScope = options?.orphanScope ?? 'all';
  // 1. Enumerate code-registered user shapes (exclude framework/meta shapes).
  const userShapes: Array<{iri: string; nodeShape: NodeShapeData}> = [];
  for (const [iri, shapeClass] of getAllShapeClasses()) {
    if (!shapeClass?.shape) continue;
    const pkg = (shapeClass as {packageName?: string}).packageName;
    // Skip framework/meta shapes: the core package, and the base `Shape` which is registered
    // directly (no applyLinkedShape) and therefore carries no packageName.
    if (!pkg || pkg === FRAMEWORK_PACKAGE) continue;
    userShapes.push({iri, nodeShape: shapeClass.shape});
  }
  const localShapeIris = new Set(userShapes.map((s) => s.iri));
  // Namespaces this process actually writes — the ownership scope for `'ownedNamespaces'` pruning.
  const ownedNamespaces = new Set(userShapes.map((s) => shapeNamespace(s.iri)));

  const thunks: Array<() => Promise<void>> = [];

  // 2. Per in-code shape: delete (cascade) then recreate.
  for (const {iri, nodeShape} of userShapes) {
    thunks.push(buildSyncThunk(nodeShape, iri, ds));
  }

  // 3. Orphan sweep (unless disabled). Identity-read existing NodeShape IRIs (ids only). Must hit
  //    the same `ds` the thunks target, or orphans get computed against the wrong store.
  if (orphanScope !== 'none') {
    const existingRows = (await (NodeShape as unknown as {
      select: () => {exec: (target?: IDataset) => Promise<Array<{id: string}>>};
    }).select().exec(ds)) as Array<{id: string}>;

    // Orphan shapes (in store, not in code) → delete (cascade cleans their owned subtree). In
    // `'ownedNamespaces'` mode, only shapes within a namespace this process writes are eligible —
    // other writers' shapes (different package namespace) are left untouched.
    for (const {id: iri} of existingRows) {
      if (localShapeIris.has(iri)) continue;
      if (orphanScope === 'ownedNamespaces' && !ownedNamespaces.has(shapeNamespace(iri))) {
        continue;
      }
      thunks.push(() =>
        (DeleteBuilder.from(NodeShape, {id: iri}).exec(ds) as Promise<unknown>).then(
          () => undefined,
        ),
      );
    }
  }

  return thunks;
}

/**
 * Plan an idempotent sync of ONE code-registered NodeShape into the store as SHACL data.
 *
 * Scoped counterpart to {@link syncShapes}: materializes a single shape (delete → recreate, so the
 * delete cascade-cleans the old property-shape / list / path subtrees and the create rebuilds them)
 * and does NOT run the store-wide orphan sweep — other shapes in the store are untouched.
 *
 * @param target a shape class (e.g. `Person`) or its NodeShape IRI string. An IRI is resolved to
 *   its registered class via `getShapeClass`; the shape must be code-registered.
 * @param ds optional explicit dataset to materialize into (a store or a router) — both the delete
 *   and the create run against it instead of the global router. Omitted → global behavior.
 * @returns a single unexecuted thunk (consistent with {@link syncShapes}), so callers can batch
 *   several together — e.g. a shape plus its referenced object-property shapes:
 *   `await Promise.all([syncShape(Person), syncShape(Address)].map((run) => run()))`.
 * @throws if `target` is a framework/meta shape, is not registered, or has no `.shape`.
 */
export function syncShape(target: typeof Shape | string, ds?: IDataset): () => Promise<void> {
  // Normalize target → its registered shape class.
  const cls =
    typeof target === 'string' ? getShapeClass(target) : (target as typeof Shape);
  if (typeof target === 'string' && !cls) {
    throw new Error(`syncShape: no registered shape for IRI ${target}`);
  }
  const nodeShape = cls?.shape;
  if (!nodeShape) {
    throw new Error(
      typeof target === 'string'
        ? `syncShape: no registered shape for IRI ${target}`
        : `syncShape: shape class has no static .shape`,
    );
  }
  const iri = nodeShape.id;

  // Never materialize a framework/meta shape as user data — same invariant syncShapes() enforces
  // by skipping (the base Shape carries no packageName).
  const pkg = (cls as {packageName?: string}).packageName;
  if (!pkg || pkg === FRAMEWORK_PACKAGE) {
    throw new Error(`syncShape: refusing to sync framework/meta shape ${iri}`);
  }

  return buildSyncThunk(nodeShape, iri, ds);
}
