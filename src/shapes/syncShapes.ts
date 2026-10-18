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
import {buildSingleOwnerConstraints} from './singleOwnerConstraint.js';
import {QueryBuilder} from '../queries/QueryBuilder.js';
import {sha256Hex} from '../utils/sha256.js';
import {builtInShapeIris} from '../utils/ShapeCatalog.js';

/**
 * The npm scope of core's shapes. Only its six built-ins (`builtInShapeIris`) are synced; any
 * other shape declared with core's own `linkedShape` (core's test fixtures) is not.
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
    path: serializePathToNodeData(ps.path),
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
  // The single-owner constraints of the shape's own `contains` properties, owned through
  // `core:generatedShape` and written nested in the same create with their fixed IRIs.
  const generated = buildSingleOwnerConstraints(nodeShape, shapeIri);
  if (generated.length > 0) {
    d.generatedShapes = generated.map(({iri, data}) => ({__id: iri, ...data}));
  }
  return d;
}

/**
 * Version of the {@link shapeSyncHash} input. Bump it whenever core changes the SHACL it writes
 * for a shape (a serialization change that the create data itself does not show), so every stored
 * shape is rewritten once by the next sync. Without a bump, stores keep the old triples: their
 * stored hashes still match, so the sync skips them.
 *
 * Enforced by `shape-sync-output-equivalence.test.ts`: its golden SHACL output is recorded in
 * `SHAPE_HASH_LEDGER` with the version it was generated for, and regenerating the golden without
 * bumping this constant fails that test. To change the output: bump this by one, update the
 * golden, and append `{version, goldenDigest}` to the ledger (never edit an existing entry).
 *
 * @internal Exported for tests only — not part of the public API.
 */
export const SHAPE_HASH_VERSION = 1;

/**
 * A canonical string for create-pipeline data: equal for equal data, independent of object key
 * order and of the order of array values.
 *
 * Arrays are sorted because in create data an array is always a multi-valued property (a set of
 * RDF values: `properties`, `generatedShapes`, `targetObjectsOf`, …). Ordered `rdf:List`s
 * (`sh:in`, sequence and alternative paths, `sh:or`) are nested `first`/`rest` objects, so their
 * order is kept by the structure. A shape class value (`shape: List`) is written as its NodeShape
 * IRI. Values without ids (blank nodes once written) are compared by structure, so no blank-node
 * label is ever part of the input.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return `n:${Object.is(value, -0) ? '0' : String(value)}`;
    case 'boolean':
      return `b:${value}`;
    case 'bigint':
      return `i:${value.toString()}`;
    case 'function': {
      const shapeId = (value as {shape?: {id?: string}}).shape?.id;
      return `c:${JSON.stringify(shapeId ?? (value as {name?: string}).name ?? '')}`;
    }
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).sort().join(',')}]`;
  }
  if (value instanceof Date) return `d:${value.toISOString()}`;
  if (value instanceof RegExp) return `r:${JSON.stringify(value.source)}/${value.flags}`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(',')}}`;
}

/**
 * The content hash shape sync stores on a NodeShape as `core:shapeHash`: SHA-256 (hex) of the
 * canonical form of the shape IRI and the exact create data the sync writes for it — the
 * NodeShape, its flattened own + inherited property shapes, their `sh:in` lists and paths, and
 * the generated single-owner shapes it owns (whose owner classes come from the registered
 * sub-shapes, so registering a new sub-shape changes the hash of the declaring shape).
 *
 * Deterministic across processes, runtimes and Node versions: no blank-node labels, no object key
 * order, no array order (see {@link canonicalize}).
 *
 * @internal Exported for tests only — not part of the public API.
 */
export function shapeSyncHash(data: Record<string, unknown>, shapeIri: string): string {
  return sha256Hex(`linked-shape-sync/${SHAPE_HASH_VERSION}\n${canonicalize({iri: shapeIri, data})}`);
}

/** The create data and its content hash for one shape, as the sync writes it. */
function buildSyncData(
  nodeShape: NodeShapeData,
  iri: string,
): {data: Record<string, unknown>; hash: string} {
  const data = buildNodeShapeData(nodeShape, iri);
  return {data, hash: shapeSyncHash(data, iri)};
}

/**
 * The stored `core:shapeHash` of each of `iris` that exists as a NodeShape, in one select. A shape
 * that is absent, or stored without a hash (written before hashes existed), is missing from the
 * map. `ds` targets an explicit dataset, as for the writes.
 */
async function readStoredHashes(iris: string[], ds?: IDataset): Promise<Map<string, string>> {
  const stored = new Map<string, string>();
  if (iris.length === 0) return stored;
  const rows = (await (QueryBuilder.from(NodeShape).select(['shapeHash']).forAll(iris) as unknown as {
    exec: (target?: IDataset) => Promise<Array<{id: string; shapeHash?: unknown}> | null>;
  }).exec(ds)) ?? [];
  for (const row of rows) {
    if (row && typeof row.shapeHash === 'string') stored.set(row.id, row.shapeHash);
  }
  return stored;
}

/**
 * The per-shape `delete → create` thunk shared by `syncShapes()` and `syncShape()`: exactly two
 * requests. The delete cascade-cleans the shape's old property-shape / list / path subtrees; the
 * create rebuilds them, and stores the content hash (`core:shapeHash`) of what it wrote on the
 * NodeShape so a later sync can skip the shape while it is unchanged.
 *
 * The single-owner constraints generated from the shape's own `contains` properties
 * (`${iri}/${label}.singleOwner`, see `singleOwnerConstraint.ts`) are owned by the shape through
 * `core:generatedShape` (a `contains` property with value shape NodeShape). The delete removes
 * them and their property shapes through the owned walk, and their blank path and qualified-shape
 * nodes through the blank-node cascade; the create writes the current ones nested, in the same request
 * as the shape. A removed or renamed accessor therefore loses its constraint on the next sync,
 * and a NodeShape the shape does not own is never touched.
 *
 * `ds` (optional) targets an explicit dataset — both requests run against it instead of the
 * global router. Omitted → today's global behavior.
 */
function buildSyncThunk(nodeShape: NodeShapeData, iri: string, ds?: IDataset): () => Promise<void> {
  // `writeShape` builds the data fresh on each invocation, so every run writes from the current
  // shape metadata, and the hash stored with it always describes what was written.
  return () => writeShape(nodeShape, iri, ds);
}

/** Delete (cascade) then create one shape, storing the hash of the written data. */
async function writeShape(nodeShape: NodeShapeData, iri: string, ds?: IDataset): Promise<void> {
  const {data, hash} = buildSyncData(nodeShape, iri);
  await DeleteBuilder.from(NodeShape, {id: iri}).exec(ds);
  await (NodeShape.create({...data, shapeHash: hash} as never).withId(iri) as unknown as {
    exec: (target?: IDataset) => Promise<unknown>;
  }).exec(ds);
}

/** The generated single-owner shape IRIs a code shape writes. */
function generatedIrisOf(nodeShape: NodeShapeData, iri: string): string[] {
  return buildSingleOwnerConstraints(nodeShape, iri).map((c) => c.iri);
}

/** Throw when a registered shape IRI equals one of a shape's generated single-owner IRIs. */
function assertNoGeneratedIriCollision(
  nodeShape: NodeShapeData,
  iri: string,
  isRegistered: (iri: string) => boolean,
): void {
  for (const generated of generatedIrisOf(nodeShape, iri)) {
    if (isRegistered(generated)) {
      throw new Error(`Shape IRI ${generated} collides with a generated single-owner shape`);
    }
  }
}

/** Options controlling how {@link syncShapes} treats store shapes that are not in code. */
export interface SyncShapesOptions {
  /**
   * How to treat NodeShapes present in the store but not in the current process's code:
   * - `'none'` (default) — never prune; purely additive (delete→recreate the code shapes, touch
   *   nothing else). The only mode that is safe when the process has loaded a *subset* of the
   *   shapes in the dataset, or when the dataset has more than one writer.
   * - `'all'` — prune every store-only shape as an orphan. Only correct when this process has
   *   loaded **every** shape the dataset should hold and is its **only** writer; "not registered
   *   here" is then taken to mean "deleted from code".
   * - `'ownedNamespaces'` — prune a store-only shape ONLY if its IRI falls within a namespace
   *   this process actually writes (the package-namespace of one of its code-registered shapes,
   *   i.e. the IRI prefix up to the last `/` or `#`). Protects other writers' packages (arch-04:
   *   one app-data dataset, several writers), but NOT the rest of a package the process only
   *   partially loaded — the namespace is the whole package, so a deep import of one shape file
   *   still claims all of it.
   *
   * `'all'` and `'ownedNamespaces'` are destructive and must be requested explicitly.
   */
  orphanScope?: 'all' | 'ownedNamespaces' | 'none';
  /**
   * Rewrite every code shape, even one whose stored `core:shapeHash` matches. Default `false`:
   * a shape is rewritten only when its hash differs or is missing. Use it to repair a shape
   * whose stored subtree was edited or partly deleted outside shape sync (the hash describes
   * what sync last wrote, not what is in the store now).
   */
  force?: boolean;
}

/** Options for {@link syncShape}. */
export interface SyncShapeOptions {
  /** Rewrite the shape even when its stored `core:shapeHash` matches. See {@link SyncShapesOptions.force}. */
  force?: boolean;
}

/** The owning namespace of a shape IRI — everything up to and including the last `/` or `#`. */
function shapeNamespace(iri: string): string {
  const cut = Math.max(iri.lastIndexOf('/'), iri.lastIndexOf('#'));
  return cut >= 0 ? iri.slice(0, cut + 1) : iri;
}

/**
 * Plan an idempotent sync of all code-registered NodeShapes into the store as SHACL data — the
 * forward (code → graph) materialization of arch-05 "code is canonical". Core's six built-in
 * shapes are included, like any package's; other shapes in the core package are not.
 *
 * Returns built-but-unexecuted thunks; the caller controls execution and batching:
 * ```ts
 * await Promise.all((await syncShapes()).map((run) => run()));
 * ```
 * Each in-code shape's thunk runs `delete → create` in order (the delete cascade-cleans the old
 * property shapes / list / path subtrees via the containment cascade, the create rebuilds them).
 *
 * **Unchanged shapes are skipped.** The create stores a content hash of everything it writes for
 * the shape on the NodeShape (`core:shapeHash`, see {@link shapeSyncHash}). The plan reads the
 * stored hashes of all code shapes in one select and builds a thunk only for a shape whose hash
 * is missing (never synced, or synced before hashes existed) or differs. Syncing an unchanged
 * app therefore returns no write thunks, and the length of the plan is the number of shapes
 * actually written plus the pruned orphans. The hash records what sync last wrote, not what the
 * store holds now: a subtree edited or partly deleted by another writer while the NodeShape and
 * its hash survive is not detected. `options.force` rewrites every code shape.
 *
 * **Shapes in the store but not registered in this process are left alone by default**
 * (`orphanScope: 'none'`). The registry only holds what this process happened to import, and
 * that is routinely a subset of what the dataset holds: shapes are deep-importable one file at a
 * time, and an app-data dataset also holds shapes other writers materialized (CN's
 * `bindShape` / `enableCapability`). "Not registered here" therefore does not mean "deleted from
 * code". Measured against a dataset holding the 36 `@_linked/schema` shapes: a process that
 * imported only `@_linked/schema/shapes/Thing` (11 shapes registered) deleted the other 25 under
 * both `'all'` and `'ownedNamespaces'`, and a process that imported no shapes deleted all 36.
 *
 * Pruning is opt-in via `options.orphanScope` (see {@link SyncShapesOptions}): pass `'all'` only
 * from a process that has loaded every shape the dataset should hold and is its sole writer, and
 * `'ownedNamespaces'` only when it has loaded every shape of each package it registers. Pruned
 * orphans are deleted with their owned subtree. Pruning reads the existing shape IRIs first;
 * with `'none'` no read is made.
 *
 * `ds` (optional) targets an explicit dataset instead of the global router. It is a **plan-time**
 * parameter: it feeds the stored-hash read and the orphan-detection read (so both are computed
 * against the same store they'll be written to) and every delete/create thunk. Omitted → the global router;
 * the returned thunks stay nullary either way.
 *
 * It enumerates the globally registered classes, so it must run outside any `withShapeCatalog`
 * scope: inside one it would see only core's built-ins, which it skips.
 */
export async function syncShapes(
  ds?: IDataset,
  options?: SyncShapesOptions,
): Promise<Array<() => Promise<void>>> {
  const orphanScope = options?.orphanScope ?? 'none';
  // 1. Enumerate code-registered shapes: every package's, and core's six built-ins (`Shape`,
  //    `NodeShape`, `PropertyShape`, `List`, `PathNode`, `PathList`), so a dataset is a complete
  //    shape catalog on its own. Other core-package shapes and classes with no package are skipped.
  const builtIns = new Set(builtInShapeIris());
  const userShapes: Array<{iri: string; nodeShape: NodeShapeData}> = [];
  for (const [iri, shapeClass] of getAllShapeClasses()) {
    if (!shapeClass?.shape) continue;
    const pkg = (shapeClass as {packageName?: string}).packageName;
    if (!builtIns.has(iri) && (!pkg || pkg === FRAMEWORK_PACKAGE)) continue;
    userShapes.push({iri, nodeShape: shapeClass.shape});
  }
  const localShapeIris = new Set(userShapes.map((s) => s.iri));
  for (const {iri, nodeShape} of userShapes) {
    assertNoGeneratedIriCollision(nodeShape, iri, (id) => localShapeIris.has(id));
  }
  // The generated single-owner shapes of in-code shapes are written by the same thunks, so they
  // are never orphans. Derived in memory from the same function that builds them; a stale
  // generated shape (removed accessor or shape) is not protected and goes with its owner's
  // delete, through the `core:generatedShape` cascade.
  for (const {iri, nodeShape} of userShapes) {
    for (const generated of generatedIrisOf(nodeShape, iri)) localShapeIris.add(generated);
  }
  // Namespaces this process actually writes — the ownership scope for `'ownedNamespaces'` pruning.
  const ownedNamespaces = new Set(userShapes.map((s) => shapeNamespace(s.iri)));

  const thunks: Array<() => Promise<void>> = [];

  // 2. Per in-code shape whose stored content hash is missing or differs: delete (cascade) then
  //    recreate. An unchanged shape gets no thunk, so syncing an unchanged app writes nothing.
  //    The stored hashes are read in one select, against the same `ds` the thunks target.
  const storedHashes = options?.force
    ? new Map<string, string>()
    : await readStoredHashes(userShapes.map((s) => s.iri), ds);
  for (const {iri, nodeShape} of userShapes) {
    if (!options?.force && storedHashes.get(iri) === buildSyncData(nodeShape, iri).hash) continue;
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
 * @param options `force: true` rewrites the shape even when its stored hash matches.
 * @returns a single unexecuted thunk (consistent with {@link syncShapes}), so callers can batch
 *   several together — e.g. a shape plus its referenced object-property shapes:
 *   `await Promise.all([syncShape(Person), syncShape(Address)].map((run) => run()))`.
 *   Unless `force` is set, the thunk first reads the shape's stored `core:shapeHash` and writes
 *   nothing when it equals the hash of what it would write (see {@link syncShapes}).
 * @throws if `target` is a framework/meta shape, is not registered, or has no `.shape`.
 */
export function syncShape(
  target: typeof Shape | string,
  ds?: IDataset,
  options?: SyncShapeOptions,
): () => Promise<void> {
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

  assertNoGeneratedIriCollision(nodeShape, iri, (id) => !!getShapeClass(id));
  if (options?.force) return buildSyncThunk(nodeShape, iri, ds);
  return async () => {
    const stored = await readStoredHashes([iri], ds);
    if (stored.get(iri) === buildSyncData(nodeShape, iri).hash) return;
    await writeShape(nodeShape, iri, ds);
  };
}
