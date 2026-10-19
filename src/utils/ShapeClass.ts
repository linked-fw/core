import {type Shape, type ShapeConstructor} from '../shapes/Shape.js';
// Namespace import, read at CALL time rather than captured at module-evaluation time.
// `getOrCreateShapeAdapter` subclasses `Shape` at runtime, and under some import orders this
// module finishes evaluating before `Shape.js` does — a named import captured then is
// permanently `undefined`, and the subclass fails with "Class extends value undefined".
import * as ShapeModule from '../shapes/Shape.js';
import {
  getPropertyShape,
  type NodeShapeData,
  type PropertyShapeData,
} from '../shapes/nodeShapeData.js';
import type {NodeShapeWire} from '../shapes/nodeShapeWire.js';
import type {ICoreIterable} from '../interfaces/ICoreIterable.js';
import type {NodeReferenceValue} from './NodeReference.js';
import type {ShapeCatalog} from './ShapeCatalog.js';
import {RegistryCache} from './registryCache.js';
import {sharedState} from './sharedState.js';
import {isLinkedInstance} from './linkedError.js';

export {RegistryCache};

const resolveTargetClassId = (
  targetClass?: NodeReferenceValue | null,
): string | null => {
  if (!targetClass) return null;
  return targetClass.id ?? null;
};

/**
 * The shape registries live on `globalThis`, not in module scope.
 *
 * A module can evaluate more than once in one process, and in a built app it does: an
 * app's backend is assembled from two graphs, one loaded by the bundler from `src/` and
 * one resolved by Node to `lib/esm/`. A module-scope `Map` then exists twice — shapes
 * register into one copy and every lookup reads the other, which finds nothing.
 *
 * The symptom never mentions module identity. It is `Invalid property key: projectSlug.
 * The shape Project does not have a registered property with this name` for a property
 * that is declared correctly two files away, because validation ran on the copy the
 * decorators never reached. See docs/reports/043-module-identity-in-the-backend.md.
 *
 * Sharing the state makes duplication harmless rather than merely absent: the graphs
 * still hold two copies of this module, but only one registry. `LinkedStorage` already
 * keeps its instance counter here; this keeps the data itself.
 */
const shapeRegistryGlobal: any =
  typeof globalThis !== 'undefined' ? globalThis : ({} as any);

/**
 * Counts DISTINCT physical copies of this module, not evaluations of it.
 *
 * The difference matters. A bare `count++` here is incremented by Vite's HMR every time
 * the module is re-evaluated in the same process, against the same `globalThis` — so a
 * developer who edits a file a few times sees a count of 4 and goes hunting a
 * dual-resolution problem that does not exist. Recording a token per copy and counting
 * the tokens survives re-evaluation: HMR replaces the module, and its token with it.
 */
const copyToken: object = {};
const copies: Set<object> = (shapeRegistryGlobal.__linkedShapeRegistryCopies ??= new Set());
copies.add(copyToken);

/**
 * More than one copy of this module means shapes register into one registry and are
 * looked up in another, and the resulting failures never mention module identity — they
 * say a declared property is not declared, or that a pinned shape has no pin.
 *
 * Reported rather than thrown. A throw from a library module at import time breaks
 * tooling that legitimately loads a module twice, and the shared state above means a
 * second copy is survivable: it is a correctness hazard for anything holding a class
 * reference, not an immediate failure. So this says so, once, as loudly as a log can.
 */
if (copies.size > 1) {
  console.error(
    `[linked] ${copies.size} copies of @_linked/core's shape registry have loaded in ` +
      `this process. They share one registry, so lookups still resolve — but each copy ` +
      `has its own \`Shape\` base class, so \`instanceof\` comparisons across them are ` +
      `false and adapters built by one copy do not satisfy the other. This is a module ` +
      `resolution problem: part of the app is reaching this package by a path that ` +
      `resolves to its source and part by one that resolves to its build output.`,
  );
}

/**
 * One shared container, created by whichever copy evaluates first.
 *
 * `registryVersion` belongs here too: every derived cache in this module is keyed on it,
 * so a version that is not shared would let one copy's writes leave another copy's caches
 * looking valid. The caches themselves stay per-copy — they are rebuilt whenever the
 * shared version moves past them.
 */
const registryState: {
  nodeShapeToShapeClass: Map<string, typeof Shape>;
  nodeShapeRegistry: Map<string, NodeShapeData>;
  shapeAdapters: Map<string, typeof Shape>;
  registryVersion: number;
  /**
   * The catalog `withShapeCatalog` made current, or undefined for the global registry.
   * Shared like the rest, so a scope opened by one copy of this module is seen by another.
   */
  activeCatalog: ShapeCatalog | undefined;
} = (shapeRegistryGlobal.__linkedShapeRegistry ??= {
  nodeShapeToShapeClass: new Map(),
  nodeShapeRegistry: new Map(),
  shapeAdapters: new Map(),
  registryVersion: 0,
  activeCatalog: undefined,
});
// A container created by an older copy has no slot yet; give it one so every read below
// sees the same object layout.
if (!('activeCatalog' in (registryState as object))) registryState.activeCatalog = undefined;

/** How many distinct copies of this module are loaded. One is expected. */
export function getShapeRegistryInstanceCount(): number {
  return copies.size;
}

// ---------------------------------------------------------------------------
// The active shape catalog
// ---------------------------------------------------------------------------

/**
 * Run `fn` with `catalog` as the shapes every registry accessor reads; `undefined` means
 * the global registry (explicitly — it does not inherit an outer catalog).
 *
 * Synchronous on purpose: it works the same in the browser and in Node, with no
 * AsyncLocalStorage. Scopes nest, the previous catalog is restored in `finally`, and fn's
 * value is returned unchanged. A promise returned by fn is not awaited, so its
 * continuation runs outside the scope. That is why builders and IRs capture their catalog
 * and every place that picks one up later re-enters it (see docs/architecture/runtime-instances.md).
 */
export function withShapeCatalog<T>(catalog: ShapeCatalog | undefined, fn: () => T): T {
  const previous = registryState.activeCatalog;
  if (previous === catalog) return fn();
  registryState.activeCatalog = catalog;
  try {
    const result = fn();
    if (result instanceof Promise) warnPromiseInScope();
    return result;
  } finally {
    registryState.activeCatalog = previous;
  }
}

/**
 * Run `fn` with no catalog active, without the promise warning: for core's own calls into a
 * dataset, whose asynchronous continuation is meant to run outside any catalog. @internal
 */
export function outsideShapeCatalog<T>(fn: () => T): T {
  const previous = registryState.activeCatalog;
  if (previous === undefined) return fn();
  registryState.activeCatalog = undefined;
  try {
    return fn();
  } finally {
    registryState.activeCatalog = previous;
  }
}

let warnedPromiseInScope = false;

/**
 * A scope ends when `fn` returns, so the continuation of a promise `fn` returns runs outside
 * it. Said once, outside production. A builder (a thenable, not a Promise) is the intended
 * return value: it captured the catalog and re-enters it.
 */
function warnPromiseInScope(): void {
  if (warnedPromiseInScope) return;
  const env = (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env;
  if (env?.NODE_ENV === 'production') return;
  warnedPromiseInScope = true;
  console.warn(
    '[linked] withShapeCatalog(catalog, fn): fn returned a promise. The scope ended when fn ' +
      'returned, so code after its first await runs outside the catalog. Build the query inside ' +
      'the scope and await it outside — a builder keeps its catalog.',
  );
}

/** The catalog of the current `withShapeCatalog` scope, or undefined for the global registry. */
export function getActiveShapeCatalog(): ShapeCatalog | undefined {
  return registryState.activeCatalog;
}

/**
 * The catalog a builder, a FieldSet or an IR captured — undefined means the global registry.
 * Reads the object's `catalog` field, which builders keep as a getter and IRs as a
 * non-enumerable property, so neither appears in `toJSON` or a JSON round trip.
 */
export function catalogOf(queryOrIr: object | null | undefined): ShapeCatalog | undefined {
  return (queryOrIr as {catalog?: ShapeCatalog} | null | undefined)?.catalog;
}

/**
 * Record `catalog` on an IR object as a non-enumerable `catalog` field, so the code that
 * compiles it later (often after an `await`) re-enters the catalog it was lowered in.
 * Nothing is written for the global registry: an IR without the field compiles globally.
 * @internal
 */
export function attachCatalog<T extends object>(
  ir: T,
  catalog: ShapeCatalog | undefined = registryState.activeCatalog,
): T {
  if (catalog !== undefined) {
    Object.defineProperty(ir, 'catalog', {
      value: catalog,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return ir;
}

/**
 * Process-unique ids for catalogs, for live-query template keys. On `globalThis`, like the
 * registry, so two copies of core give one catalog the same id.
 */
const keyState: {keys: WeakMap<object, number>; next: number} =
  (shapeRegistryGlobal.__linkedShapeCatalogKeys ??= {keys: new WeakMap(), next: 1});

/** 0 for the global registry, else a process-unique id for the catalog. */
export function shapeCatalogKey(catalog: ShapeCatalog | undefined): number {
  if (catalog === undefined) return 0;
  let key = keyState.keys.get(catalog);
  if (key === undefined) {
    key = keyState.next++;
    keyState.keys.set(catalog, key);
  }
  return key;
}

/** The catalog of an adapter class a catalog built, keyed on the class. */
const adapterCatalogs = sharedState(
  '@_linked/core',
  'ShapeClass.adapterCatalogs',
  () => new WeakMap<Function, ShapeCatalog>(),
);

/**
 * The catalog a builder made from `shape` captures.
 *
 * Inside a scope: the active catalog when the root is an IRI (`shape` undefined) or a
 * shape the catalog holds; otherwise none. A class the active catalog does not hold is
 * authored code (CN's own shapes, built by CN code while a project scope is active) and
 * must lower against the global registry. Outside a scope: the catalog that built the
 * adapter class, if it is one, else none.
 * @internal
 */
export function captureCatalog(
  shape?: {shape?: {id?: string}} | Function | null,
): ShapeCatalog | undefined {
  const active = registryState.activeCatalog;
  if (shape === undefined || shape === null) return active;
  if (active !== undefined) {
    const id = (shape as {shape?: {id?: string}}).shape?.id;
    if (id && active.has(id)) return active;
  }
  return typeof shape === 'function' ? adapterCatalogs.get(shape) : undefined;
}

/**
 * Throw when a registry write is attempted inside a catalog scope. A catalog is
 * immutable, and a write meant for it would land in the global registry instead.
 * @internal
 */
export function assertNoActiveCatalog(): void {
  if (registryState.activeCatalog !== undefined) {
    throw new Error(
      'Cannot register shapes while a ShapeCatalog is active. Register outside ' +
        'withShapeCatalog, or build a new catalog with ShapeCatalog.from().',
    );
  }
}

/** What a catalog holds, as the accessors below read it. Plain fields: any copy can read them. */
type CatalogContents = {
  readonly nodeShapes: ReadonlyMap<string, NodeShapeData>;
  readonly shapeClasses: ReadonlyMap<string, typeof Shape>;
};

function contentsOf(catalog: ShapeCatalog): CatalogContents {
  return catalog as unknown as CatalogContents;
}

const subShapesCache = new RegistryCache<string, (typeof Shape)[]>();
const mostSpecificSubShapesCache = new RegistryCache<string, (typeof Shape)[]>();
const nodeShapeToShapeClass = registryState.nodeShapeToShapeClass;
const warnedDuplicateBases = new Set<string>();

/**
 * The PRIMARY shape registry: node-shape IRI → its metadata.
 *
 * Every shape is here — those declared by a `@linkedShape` class and those known only
 * as data (a project-authored shape read from the graph). `nodeShapeToShapeClass` above
 * is the SECONDARY registry, holding only the shapes that have a TypeScript class, and
 * exists for the few callers that genuinely need a class (a `ShapeProvider` lookup, a
 * typed accessor). Query lowering, predicate resolution and containment all read
 * metadata, so they use this map and work identically for both kinds of shape.
 */
const nodeShapeRegistry = registryState.nodeShapeRegistry;

/**
 * The shapes the accessors read: the active catalog's (its shapes plus core's built-ins),
 * else the global registry. One shared read and a null check on the global path.
 */
function activeNodeShapes(): ReadonlyMap<string, NodeShapeData> {
  const catalog = registryState.activeCatalog;
  return catalog === undefined ? nodeShapeRegistry : contentsOf(catalog).nodeShapes;
}

/** The authored classes the accessors read: the catalog's built-ins, else every registered class. */
function activeShapeClasses(): ReadonlyMap<string, typeof Shape> {
  const catalog = registryState.activeCatalog;
  return catalog === undefined ? nodeShapeToShapeClass : contentsOf(catalog).shapeClasses;
}

/**
 * The current registration version — a monotonic counter, bumped on every write.
 *
 * Every derived cache in this module, and in `irToAlgebra`, is keyed on it. It replaces
 * two earlier invalidation strategies that were both unsound: a `setTimeout(…, 0)` cache
 * clear (which missed anything registered later in the same session) and comparing the
 * registry SIZE (which silently reuses a stale cache when a registration and a removal
 * coincide, or when a shape is re-registered in place).
 *
 * It lives on the shared state, not in module scope: a cache keyed on a per-copy version
 * would look valid after another copy had written.
 */
export function getRegistryVersion(): number {
  return registryState.registryVersion;
}

/** Reverse index parentIri → direct child IRIs, rebuilt when the registry changes. */
const childIndex = new RegistryCache<string, string[]>((index) => {
  activeNodeShapes().forEach((shape, id) => {
    const parent = shape.extends?.id;
    if (!parent) return;
    const siblings = index.get(parent);
    if (siblings) siblings.push(id);
    else index.set(parent, [id]);
  });
});

function getChildIndex(): Map<string, string[]> {
  return childIndex.get();
}

// Every derived cache is a RegistryCache keyed on this version, so bumping it is the
// whole invalidation.
function invalidateRegistryCaches() {
  registryState.registryVersion++;
}

/** Drop the adapter for a shape whose metadata was replaced. */
function invalidateShapeAdapter(id: string) {
  shapeAdapters.delete(id);
}

/**
 * Register a shape known only as data — no TypeScript class is created.
 *
 * This is the return leg of the round trip: `@linkedShape` is class → metadata,
 * `syncShapes` is metadata → RDF, and this is RDF → metadata. Idempotent: re-registering
 * the same IRI replaces the metadata (a shape edited in the builder), which is why cache
 * invalidation cannot be keyed on registry size.
 */
export function registerNodeShape(nodeShape: NodeShapeData): void {
  assertNoActiveCatalog();
  if (!nodeShape?.id) return;
  nodeShapeRegistry.set(nodeShape.id, nodeShape);
  invalidateShapeAdapter(nodeShape.id);
  invalidateRegistryCaches();
}

/** The metadata for a node-shape IRI, whether or not it has a TypeScript class. */
export function getNodeShape(
  nodeShape: NodeReferenceValue | {id: string} | string,
): NodeShapeData | undefined {
  const id = typeof nodeShape === 'string' ? nodeShape : nodeShape?.id;
  if (!id) return undefined;
  return activeNodeShapes().get(id);
}

/**
 * Every registered shape's metadata, keyed by node-shape IRI. Inside a catalog scope:
 * exactly the catalog's shapes plus core's built-ins.
 */
export function getAllNodeShapes(): ReadonlyMap<string, NodeShapeData> {
  return activeNodeShapes();
}

/**
 * Lazily-built constructors for shapes that exist only as data.
 *
 * The builder entry points (`QueryBuilder`, `CreateBuilder`, `UpdateBuilder`,
 * `DeleteBuilder` via `resolveShape`) take a `ShapeConstructor` and instantiate result
 * proxies from it, so they need *a* class. Rather than have every caller hand-roll one —
 * which is what `create-now-js`'s `registerRuntimeShape` used to do, losing `extends` and
 * every value constraint on the way — core derives one on demand from the registered
 * metadata and caches it.
 *
 * These adapters are deliberately NOT in `nodeShapeToShapeClass`: `getShapeClass` keeps
 * telling the truth about which shapes have a real, authored class. An adapter carries
 * the metadata verbatim, so nothing is lost, and inheritance is read from
 * `nodeShape.extends` (not from the adapter's prototype, which is always `Shape`).
 */
const shapeAdapters = registryState.shapeAdapters;

/**
 * A constructor for a shape known only as data, created on first use.
 *
 * Returns undefined when the IRI is not registered at all. Prefer `getShapeClass` when
 * you specifically need an authored class; use this when you need *something*
 * constructor-shaped to drive the query builders.
 */
/**
 * Adapters built inside a catalog: one map per catalog, keyed by IRI. Shared with
 * `adapterCatalogs` above, so an adapter one copy of core built keeps its catalog in another.
 */
const catalogAdapters = sharedState(
  '@_linked/core',
  'ShapeClass.catalogAdapters',
  () => new WeakMap<object, Map<string, typeof Shape>>(),
);

export function getOrCreateShapeAdapter(
  nodeShape: NodeShapeData | string,
): typeof Shape | undefined {
  const catalog = registryState.activeCatalog;
  const shapes = catalog === undefined ? nodeShapeRegistry : contentsOf(catalog).nodeShapes;
  const data = typeof nodeShape === 'string' ? shapes.get(nodeShape) : nodeShape;
  if (!data?.id) return undefined;

  const authored = (
    catalog === undefined ? nodeShapeToShapeClass : contentsOf(catalog).shapeClasses
  ).get(data.id);
  if (authored) return authored;

  let adapters: Map<string, typeof Shape> | undefined = shapeAdapters;
  if (catalog !== undefined) {
    adapters = catalogAdapters.get(catalog);
    if (!adapters) catalogAdapters.set(catalog, (adapters = new Map()));
  }
  const cached = adapters.get(data.id);
  // Re-registering a shape replaces its metadata, so an adapter built from the old
  // object must not be reused.
  if (cached && cached.shape === data) return cached;

  class RuntimeShape extends ShapeModule.Shape {
    static shape = data as NodeShapeData;
    static targetClass = (data as NodeShapeData).targetClass ?? null;
  }
  Object.defineProperty(RuntimeShape, 'name', {
    value: (data as NodeShapeData).label || 'RuntimeShape',
  });
  adapters.set(data.id, RuntimeShape);
  if (catalog !== undefined) adapterCatalogs.set(RuntimeShape, catalog);
  return RuntimeShape;
}

/** Anything that can identify a shape: its metadata, its class, or its IRI. */
export type ShapeLike = NodeShapeData | typeof Shape | Function | string;

/** Resolve a ShapeLike to node-shape metadata, or undefined if it isn't a shape. */
function toNodeShapeData(shape: ShapeLike): NodeShapeData | undefined {
  if (!shape) return undefined;
  const shapes = activeNodeShapes();
  if (typeof shape === 'string') return shapes.get(shape);
  const asData = shape as NodeShapeData;
  // NodeShapeData is a plain object with an id; a Shape class is a function.
  if (typeof shape === 'object' && typeof asData.id === 'string') {
    return shapes.get(asData.id) ?? asData;
  }
  const asClass = shape as typeof Shape;
  const shapeData = asClass?.shape;
  if (shapeData?.id) return shapes.get(shapeData.id) ?? shapeData;
  return undefined;
}

const warnedUnresolvedExtends = new Set<string>();

/**
 * Every shape the given shape extends, most specific first.
 *
 * THE canonical inheritance walk — `getPropertyShapes(shape, true)` delegates to it, so
 * there is exactly one answer to "what does this shape extend". Two earlier walks
 * disagreed (one over the prototype chain, one over `extends`) and that divergence, not
 * either strategy, was the bug: `selectAll` listed labels from one and resolved them
 * through the other, so an inherited property became unresolvable and the query proxy
 * threw.
 *
 * Strategy is chosen by what is available:
 *
 * - **A class-backed shape walks its prototype chain.** This is authoritative and
 *   includes the framework `Shape` root, whose own property shapes (`label`, `type`) are
 *   genuinely inherited. `applyLinkedShape` deliberately does NOT record `extends` for
 *   that root — it is not a domain shape and must not appear as an `extends` triple in
 *   materialized SHACL — so the data alone cannot see it.
 * - **A shape known only as data walks `extends` through the registry.** This is what
 *   makes inheritance work for a project-authored shape with no class, which the
 *   prototype chain cannot express.
 *
 * `extends` is a REFERENCE, so a parent that was never registered ends the walk. The
 * prototype chain has no such failure mode, so it warns once per shape rather than
 * throwing — this runs on read paths.
 */
export function getSuperShapes(shape: ShapeLike): NodeShapeData[] {
  const start = toNodeShapeData(shape);
  const chain: NodeShapeData[] = [];
  if (!start) return chain;

  // Class-backed: the prototype chain is the authority.
  const shapes = activeNodeShapes();
  const startClass = activeShapeClasses().get(start.id);
  if (startClass) {
    let current: typeof Shape | undefined = startClass;
    while (current) {
      const parent = Object.getPrototypeOf(current) as typeof Shape | undefined;
      if (!parent?.shape) break;
      chain.push(parent.shape);
      if ((parent as unknown) === (ShapeModule.Shape as unknown)) break;
      current = parent;
    }
    return chain;
  }

  const seen = new Set<string>([start.id]);
  let current: NodeShapeData | undefined = start;
  while (current?.extends?.id) {
    const parentId = current.extends.id;
    if (seen.has(parentId)) break; // cycle guard — malformed data must not hang a read
    seen.add(parentId);
    const parent = shapes.get(parentId);
    if (!parent) {
      if (!warnedUnresolvedExtends.has(current.id)) {
        warnedUnresolvedExtends.add(current.id);
        console.warn(
          `[linked] Shape '${current.id}' extends '${parentId}', which is not registered. ` +
            `Inherited properties from it are unavailable. Register the parent shape first ` +
            `(import its module, or register its metadata before the child).`,
        );
      }
      break;
    }
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** Every shape that extends the given shape, transitively. Most specific last. */
export function getSubShapes(shape: ShapeLike): NodeShapeData[] {
  const start = toNodeShapeData(shape);
  if (!start) return [];
  const index = getChildIndex();
  const shapes = activeNodeShapes();
  const out: NodeShapeData[] = [];
  const seen = new Set<string>([start.id]);
  const queue = [start.id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const childId of index.get(current) ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const child = shapes.get(childId);
      if (child) {
        out.push(child);
        queue.push(childId);
      }
    }
  }
  return out;
}

/** True when `a` extends `b` (strictly — a shape is not a sub-shape of itself). */
export function isSubShapeOf(a: ShapeLike, b: ShapeLike): boolean {
  const target = toNodeShapeData(b);
  if (!target) return false;
  return getSuperShapes(a).some((superShape) => superShape.id === target.id);
}

/**
 * The fields of a shape the targetClass lookups read. Both `NodeShapeData` and its wire
 * form satisfy it, so a caller holding a shape catalog never has to convert it first.
 */
type ShapeHeader = Pick<NodeShapeData, 'id' | 'targetClass' | 'extends'>;

/**
 * Every shape `shape` extends, most specific first — resolving each parent in `local`
 * before the registry.
 *
 * `local` is a caller's own set of shapes (a project's catalog), which may hold shapes the
 * registry has never seen, or newer versions of ones it has. The catalog is the authority
 * for what it holds; once the chain leaves it, the registry knows the rest.
 */
function superShapesWithin(
  shape: ShapeHeader,
  local?: ReadonlyMap<string, ShapeHeader>,
): ShapeHeader[] {
  if (!local) return getSuperShapes(shape as NodeShapeData);
  const chain: ShapeHeader[] = [];
  const seen = new Set<string>([shape.id]);
  let current: ShapeHeader = shape;
  while (current.extends?.id) {
    const parentId = current.extends.id;
    if (seen.has(parentId)) break; // cycle guard — malformed data must not hang a read
    seen.add(parentId);
    const parent = local.get(parentId);
    if (!parent) {
      const registered = activeNodeShapes().get(parentId);
      if (registered) chain.push(registered, ...getSuperShapes(registered));
      break;
    }
    chain.push(parent);
    current = parent;
  }
  return chain;
}

function indexShapes<S extends ShapeHeader>(shapes: Iterable<S>): Map<string, S> {
  const index = new Map<string, S>();
  for (const shape of shapes) if (shape?.id) index.set(shape.id, shape);
  return index;
}

function targetClassIdWithin(
  shape: ShapeLike | NodeShapeWire | {id: string},
  local?: ReadonlyMap<string, ShapeHeader>,
): string | undefined {
  if (!shape) return undefined;
  if (typeof shape === 'function') {
    // A class's static targetClass is inherited through the prototype chain for free.
    const asClass = shape as typeof Shape;
    if (asClass.targetClass?.id) return asClass.targetClass.id;
    if (!asClass.shape?.id) return undefined;
    shape = asClass.shape;
  }
  const id = typeof shape === 'string' ? shape : shape.id;
  if (!id) return undefined;
  const given = typeof shape === 'string' ? undefined : (shape as ShapeHeader);
  const shapes = activeNodeShapes();
  const own =
    given?.targetClass?.id ??
    local?.get(id)?.targetClass?.id ??
    getShapeClass(id)?.targetClass?.id ??
    shapes.get(id)?.targetClass?.id;
  if (own) return own;
  // A data-only shape's targetClass is not inherited for free, so walk `extends`.
  const start = local?.get(id) ?? (given?.extends ? given : shapes.get(id) ?? given);
  if (!start) return undefined;
  return superShapesWithin(start, local).find((s) => s.targetClass?.id)?.targetClass?.id;
}

/**
 * The class a shape's instances are typed with: its own `targetClass`, else the first one
 * found through what it extends. `undefined` when there is none anywhere in the chain.
 *
 * Accepts a shape IRI, a `{id}` reference, a shape's metadata (data or wire form) or a shape
 * class. Pass `shapes` to resolve the shape — and what it extends — in that set before the
 * registry; a project's catalog may hold shapes the registry does not.
 */
export function getTargetClassId(
  shape: ShapeLike | NodeShapeWire | {id: string},
  shapes?: Iterable<NodeShapeData | NodeShapeWire>,
): string | undefined {
  return targetClassIdWithin(shape, shapes ? indexShapes(shapes) : undefined);
}

/**
 * The least specific candidates (the roots), by id. A candidate that extends another
 * candidate (directly or further up) is dropped: a relation to `Person` with `Person` and
 * `Employee extends Person` both targeting it means `Person` — a relation never upgrades
 * itself to a sub-shape; declare `sh:node` to ask for one. What remains are unrelated roots
 * the data does not choose between; they sort by id alone — never by depth or by
 * registration or catalog order — so the choice is stable and visibly arbitrary. If that
 * would drop every candidate (an `extends` cycle), all of them are kept, by id.
 */
function leastSpecific<S extends ShapeHeader>(
  candidates: S[],
  local?: ReadonlyMap<string, ShapeHeader>,
): S[] {
  const ids = new Set(candidates.map((c) => c.id));
  const byId = (a: S, b: S) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const roots = candidates.filter(
    (candidate) => !superShapesWithin(candidate, local).some((parent) => ids.has(parent.id)),
  );
  // An `extends` cycle makes each member extend another, so the filter can leave nothing.
  // Malformed data must not turn a relation into "no shape" silently: keep every candidate
  // instead, by id, and let the caller's ambiguity handling (warn) apply.
  return (roots.length ? roots : [...candidates]).sort(byId);
}

/** targetClass IRI → registered shapes targeting it, ordered. Rebuilt when the registry changes. */
const targetClassIndex = new RegistryCache<string, NodeShapeData[]>((index) => {
  activeNodeShapes().forEach((shape) => {
    const classId = targetClassIdWithin(shape);
    if (!classId) return;
    const shapes = index.get(classId);
    if (shapes) shapes.push(shape);
    else index.set(classId, [shape]);
  });
  index.forEach((shapes, classId) => index.set(classId, leastSpecific(shapes)));
});

function getTargetClassIndex(): Map<string, NodeShapeData[]> {
  return targetClassIndex.get();
}

/**
 * The least specific shapes whose effective targetClass (own, or inherited through
 * `extends`) is exactly `classIri`, sorted by id. A matching shape that extends another
 * match is left out, so one entry means the class has one root shape and more than one
 * means unrelated roots compete for it. Sub-shapes are never chosen for a class alone.
 *
 * With no `shapes`, the candidates are the registered shapes. Pass `shapes` to choose among
 * that set only — the registry also holds compiled framework shapes, and a project's
 * `schema:Person` relation should resolve to the project's shape, not to one a framework
 * package happens to register for the same class. Inheritance is still resolved through
 * the registry when a candidate extends a shape outside the set.
 */
export function getShapesForTargetClass(classIri: string): NodeShapeData[];
export function getShapesForTargetClass<S extends NodeShapeData | NodeShapeWire>(
  classIri: string,
  shapes: Iterable<S>,
): S[];
export function getShapesForTargetClass(
  classIri: string,
  shapes?: Iterable<NodeShapeData | NodeShapeWire>,
): (NodeShapeData | NodeShapeWire)[] {
  if (!classIri) return [];
  if (!shapes) return [...(getTargetClassIndex().get(classIri) ?? [])];
  const local = indexShapes(shapes);
  const candidates = [...local.values()].filter(
    (shape) => targetClassIdWithin(shape, local) === classIri,
  );
  return leastSpecific(candidates, local);
}

export function addNodeShapeToShapeClass(
  nodeShape: NodeShapeData,
  shapeClass: typeof Shape,
) {
  assertNoActiveCatalog();
  if (!nodeShape?.id) {
    return;
  }
  // Dev guardrail for IDENTITY duplication. Shape URIs embed `constructor.name`
  // (getNodeShapeUri). If a bundler emits >1 copy of a framework package, the copies
  // are renamed `Person`→`Person2`/`3`, so a mangled URI registers alongside the clean
  // one — the exact failure that silently breaks cross-runtime shape lookup (`Person3`
  // on the FE ≠ `Person` on the backend). Warn ONCE per base so a build-config
  // regression (e.g. a dropped `optimizeDeps.exclude`) surfaces loudly instead of
  // no-op'ing a query at forward time.
  //
  // This used to be dev-only, on the reasoning that production is minified and
  // the check would false-fire. It does not: full minification renames a class
  // to something like `za`, so `base === id` and nothing fires. What DOES fire
  // is the case worth catching — a bundler appending a digit to disambiguate
  // `BackendAPIStore` from the ontology term of the same name, which is exactly
  // the collision that breaks shape lookup, and it only happens in a production
  // build. Suppressing the warning there hid it from the one place it occurs.
  {
    const id = nodeShape.id;
    const base = id.replace(/\d+$/, '');
    const existing = nodeShapeToShapeClass.get(base);
    if (base !== id && existing && !warnedDuplicateBases.has(base)) {
      // A real duplicate is the SAME logical shape (same targetClass) registered under
      // a mangled name; a legit digit-suffixed sibling (e.g. `OAuth2` vs `OAuth`)
      // targets a different class. Warn only when they match (or targetClass is absent).
      const newTarget = (shapeClass as any).targetClass?.id;
      const existingTarget = (existing as any).targetClass?.id;
      if (!newTarget || !existingTarget || newTarget === existingTarget) {
        warnedDuplicateBases.add(base);
        console.warn(
          `[linked] Shape identity duplication: '${id}' registered alongside '${base}'. ` +
            `A bundler emitted >1 copy of this package — cross-runtime shape lookup will ` +
            `break. Check the cli vite-config single-instance levers (optimizeDeps.exclude ` +
            `/ ssr.noExternal).`,
        );
      }
    }
  }
  nodeShapeToShapeClass.set(nodeShape.id, shapeClass);
  // The class-backed shape goes into the primary registry too, so metadata consumers
  // see one map regardless of how a shape was declared. This also bumps the version,
  // which invalidates every derived cache immediately rather than on a next-tick timer.
  registerNodeShape(nodeShape);
}

/**
 * The constructor for a shape IRI — an authored class if there is one, otherwise one
 * derived from the registered metadata.
 *
 * This is what the query layer wants in every case, and `getShapeClass` alone is not:
 * it answers `undefined` for a shape that exists only as data, which is every shape
 * authored in a project. Five call sites used to spell this fallback out by hand, in
 * four different ways.
 *
 * `getShapeClass` is NOT consulted first. `getOrCreateShapeAdapter` already returns the
 * authored class when one exists, and a class-backed shape is always mirrored into the
 * primary registry, so the adapter path cannot miss a shape `getShapeClass` would find.
 */
export function resolveShapeConstructor(
  nodeShape: NodeReferenceValue | {id: string} | string,
): ShapeConstructor | undefined {
  const id = typeof nodeShape === 'string' ? nodeShape : nodeShape?.id;
  if (!id) return undefined;
  // SAFETY: both paths yield a concrete subclass of Shape with a static .shape —
  // i.e. a ShapeConstructor. Same cast getShapeClass documents.
  return getOrCreateShapeAdapter(id) as unknown as ShapeConstructor | undefined;
}

/**
 * The constructor the query layer resolves an IRI to. In the global registry it is
 * `getShapeClass` (authored classes only, as always). Inside a catalog, where every shape
 * but core's built-ins is data, it is the catalog's constructor for any shape it holds.
 * @internal
 */
export function getQueryShapeClass(
  nodeShape: NodeReferenceValue | {id: string} | string,
): ShapeConstructor | undefined {
  return registryState.activeCatalog === undefined
    ? getShapeClass(nodeShape)
    : resolveShapeConstructor(nodeShape);
}

export function getShapeClass(
  nodeShape: NodeReferenceValue | {id: string} | string,
): ShapeConstructor | undefined {
  const id = typeof nodeShape === 'string' ? nodeShape : nodeShape?.id;
  if (!id) {
    return undefined;
  }
  // SAFETY: The map stores `typeof Shape` (abstract), but registered shapes are always
  // concrete subclasses with a constructor and static .shape — i.e. ShapeConstructor.
  return activeShapeClasses().get(id) as unknown as ShapeConstructor | undefined;
}

/** The class registered globally for an IRI, whatever catalog is active. @internal */
export function getRegisteredShapeClass(id: string): typeof Shape | undefined {
  return nodeShapeToShapeClass.get(id);
}

/**
 * Returns all registered shape classes (keyed by NodeShape URI). Inside a catalog scope:
 * core's built-in classes only — a catalog holds no other class.
 */
export function getAllShapeClasses(): Map<string, typeof Shape> {
  return activeShapeClasses() as Map<string, typeof Shape>;
}

/**
 * Returns all the sub shapes of the given shape
 * That is all the shapes that extend this shape
 * @param shape
 */

export function getSubShapesClasses(
  shape: typeof Shape | (typeof Shape)[],
  _internalKey?: string,
): (typeof Shape)[] {
  let key = _internalKey || getKey(shape);
  const cache = subShapesCache.get();
  if (!cache.has(key)) {
    //apply the hasSuperclass function to the shape
    let filterFunction = applyFnToShapeOrArray(shape, hasSubClass);
    //filter and then sort the results based on their inheritance (most specific classes first, so we use hasSuperClass for the sorting)
    cache.set(
      key,
      filterShapeClasses(filterFunction).sort((a, b) => {
        return hasSubClass(a, b) ? 1 : -1;
      }),
    );
  }
  //return a copy of the array to prevent it from being modified
  return [...cache.get(key)!];
}

/**
 * Returns all the superclasses of the given shape
 * That is all the shapes that it extends.
 * Results are sorted from most specific to least specific
 * @param shape
 */
export function getSuperShapesClasses(
  shape: typeof Shape | (typeof Shape)[],
): (typeof Shape)[] {
  //apply the hasSuperclass function to the shape
  let filterFunction = applyFnToShapeOrArray(shape, hasSuperClass);
  //filter and then sort the results based on their inheritance
  return filterShapeClasses(filterFunction).sort((a, b) => {
    return hasSubClass(a, b) ? 1 : -1;
  });
}

export function getPropertyShapeByLabel(
  shapeClass: typeof Shape,
  label: string,
): PropertyShapeData | undefined {
  if (!shapeClass.shape) return undefined;
  return getPropertyShape(shapeClass.shape, label, true);
}

/**
 * True when `a` extends `b`.
 *
 * Inheritance is read from `nodeShape.extends` (data), not from the JS prototype chain.
 * `applyLinkedShape` derives `extends` FROM the prototype chain, so for a class-backed
 * shape the two agree — but only the data form also works for a shape that has no
 * class, which is the whole point. The prototype comparison is kept as a fallback for
 * classes that are not registered as shapes at all (an abstract intermediate class).
 */
export function hasSuperClass(a: ShapeLike, b: ShapeLike) {
  if (!a || !b) return false;
  const aData = toNodeShapeData(a);
  const bData = toNodeShapeData(b);
  if (aData && bData) return isSubShapeOf(aData, bData);
  return typeof a === 'function' && typeof b === 'function'
    ? isLinkedInstance((a as Function).prototype, b as Function)
    : false;
}

/** True when `b` extends `a` — the mirror of {@link hasSuperClass}. */
export function hasSubClass(a: ShapeLike, b: ShapeLike) {
  return hasSuperClass(b, a);
}

function applyFnToShapeOrArray(shape, filterFn) {
  if (Array.isArray(shape)) {
    return (shapeClass) => {
      //returns true if one of the given shapes extends the shapeClass passed as argument
      return (shape as Function[]).some((s) => filterFn(s, shapeClass));
    };
  } else {
    //first argument will be the given shape class, second argument will be each stored shape class in the map
    //will filter down where the given shape extends the stored shape
    return filterFn.bind(null, shape);
  }
}

function filterShapeClasses(filterFn) {
  let result = [];
  activeShapeClasses().forEach((shapeClass) => {
    if (filterFn(shapeClass)) {
      result.push(shapeClass);
    }
  });
  return result;
}

export function getLeastSpecificShapeClasses(shapes: ICoreIterable<Shape>) {
  let shapeClasses = shapes.map((shape) =>
    getQueryShapeClass(shape.nodeShape.id),
  );
  return filterShapesToLeastSpecific(shapeClasses);
}

export function getMostSpecificSubShapes(
  shape: typeof Shape | (typeof Shape)[],
): (typeof Shape)[] {
  if (!Array.isArray(shape)) {
    shape = [shape];
  }
  //get the subshapes of the given shapes
  let key = shape.map((s) => s.name).join(',');
  const cache = mostSpecificSubShapesCache.get();
  if (!cache.has(key)) {
    //get the subshapes of the given shapes
    let subShapes: (typeof Shape)[] = getSubShapesClasses(shape, key);
    //filter them down to the most specific ones (that are not extended by any other shape)
    cache.set(key, filterShapesToMostSpecific(subShapes));
  }
  return cache.get(key)!;
}

/**
 * Filters out all shapes that are extended by any other shape in the given set/array
 * @param subShapes
 */
function filterShapesToMostSpecific(subShapes) {
  return subShapes.filter((subShape) => {
    return !subShapes.some((otherSubShape) => {
      return isLinkedInstance(otherSubShape.prototype, subShape);
    });
  });
}

/**
 * Filters out all shapes that extend any other shape in the given set/array
 * @param shapeClasses
 */
function filterShapesToLeastSpecific(shapeClasses) {
  return shapeClasses.filter((shapeClass) => {
    return !shapeClasses.some((otherShapeClass) => {
      return (
        otherShapeClass !== shapeClass &&
        isLinkedInstance(shapeClass.prototype, otherShapeClass)
      );
    });
  });
}

function getKey(shape: typeof Shape | (typeof Shape)[]) {
  return Array.isArray(shape)
    ? shape.map((s) => getShapeKey(s)).join(',')
    : getShapeKey(shape);
}

function getShapeKey(shape: typeof Shape) {
  //return a unique string for each shape
  return (
    resolveTargetClassId(shape.targetClass) ||
    shape.name + shape.prototype.constructor.toString().substring(0, 80)
  );
}
