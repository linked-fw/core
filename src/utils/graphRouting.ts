/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Graph routing: which named graph of a dataset holds the instances of a shape.
 *
 * Storage rules pick the graph, per app, the way they pick the dataset (`LinkedStorage`): a route
 * maps a shape IRI to one graph of one dataset, so ordinary code never names a graph. Routes live
 * in the app's code: `LinkedStorage.setDatasetForShapes(dataset, shapes, {graph})`, or
 * {@link setShapeGraphs} directly (a composite dataset registers them on the store it forwards
 * to). A shape without a route, and without a routed super-shape, lives in the default graph, as
 * before routing existed.
 *
 * A route states intent; the graph IRI lives under the store's data root (`DATA_ROOT`, see
 * {@link dataRootOf}), joined whenever the routing is read, so a root the store learns later is
 * the one used:
 *
 * - `'own'` → `{DATA_ROOT}/graph/{package slug}/{shape name}`. The package is the one the shape
 *   class was registered by (`linkedPackage(name)`), slugged by `packageNameToSlug` (npm scope
 *   dropped, every run of other characters than ASCII letters and digits → `-`, leading and
 *   trailing `-` trimmed, lower-cased: `@acme/news-site` → `news-site`). The shape name is the
 *   shape IRI's last path segment, case kept (`@linkedShape({name})`, else the class name:
 *   `Article`). So `Article` of `@acme/news-site` → `{DATA_ROOT}/graph/news-site/Article`.
 * - `dataGraph('slug')` → `{DATA_ROOT}/graph/{slug}`.
 * - An absolute graph IRI, as given (advanced use).
 *
 * A route never names a graph the store manages itself: a portable name, the graph registry, a
 * package's ontology or shape graph (`…/pkg/{slug}/graph/…`), the app's shape graph
 * (`{DATA_ROOT}/graph/shapes`) or an imported graph (`{DATA_ROOT}/graph/import/…`). Such a route
 * is refused with `GraphQueryError('graph-name-read-only')`, naming the shape and the graph: when
 * it is set, or, for a full IRI under the data root, when the routing is read. The managed kinds
 * are the top segment of a `dataGraph()` slug; an `'own'` route's top segment is its package slug,
 * so a package slugged `import` or `shapes` has its own graphs (refused only where one would be
 * named exactly like an imported graph, `graph/import/{lower-case slug}`).
 *
 * - **A shape's graph** (where its instances are written): its own route, else its nearest routed
 *   super-shape's, else the default graph.
 * - **Its read set**: its graph plus the graph of every registered sub-shape, because a select of a
 *   shape returns the instances of its sub-shapes too, plus the read set of every shape that owns
 *   it or one of its sub-shapes (a `contains` property whose value shape is it, a super-shape or
 *   a sub-shape of it), because an owned node is written into its owner's graph.
 *
 * The default graph appears in a set as `graphs.default`. The table lives on the shared global and
 * is keyed by the dataset object and the shape IRI (never a class object): a module can evaluate
 * twice in a process, and a shape's IRI is the identity every copy agrees on.
 */
import type {IDataset} from '../interfaces/IDataset.js';
import {
  DATA_GRAPH_SLUG,
  graphs,
  isDataGraphRoute,
  OWN_GRAPH,
  PORTABLE_GRAPH_NAMES,
  type GraphRoute,
} from '../ontologies/graphs.js';
import {GraphQueryError} from '../queries/graphQuery.js';
import {defaultReadGraphsOf} from '../queries/readGraphs.js';
import {
  getActiveShapeCatalog,
  getAllNodeShapes,
  getRegisteredShapeClass,
  getRegistryVersion,
  getSubShapes,
  getSuperShapes,
} from './ShapeClass.js';
import {getPropertyShapes} from '../shapes/nodeShapeData.js';
import {packageNameToSlug} from '../shapes/SHACL.js';

const routingGlobal: any = typeof globalThis !== 'undefined' ? globalThis : ({} as any);

/**
 * One stored route: an absolute graph IRI, or a path under the data root (`graph/…`) that
 * {@link graphRoutingFor} joins with the dataset's root.
 */
type StoredRoute = {iri: string} | {underRoot: string; form: string};

/** Dataset → (shape IRI → route). */
const routes: WeakMap<object, Map<string, StoredRoute>> = (routingGlobal.__linkedGraphRoutes ??=
  new WeakMap<object, Map<string, StoredRoute>>());

/** Absolute IRI with a scheme and none of the characters that end an IRIREF. */
const IRI_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]*$/;

function checkShape(shape: string): void {
  if (typeof shape !== 'string' || !IRI_PATTERN.test(shape)) {
    throw new Error(`A graph route needs a shape IRI; got ${JSON.stringify(shape)}.`);
  }
}

/**
 * Paths under a data root that name graphs a store manages itself, which a route never names: the
 * app's shape graph (`graph/shapes`, written by the shape sync) and imported graphs
 * (`graph/import/…`).
 */
const MANAGED_UNDER_ROOT = /^graph\/(?:shapes|import\/.+)$/;

/** A package's ontology or shape graph (`…/pkg/{slug}/graph/…`; core's portable names are refused before). */
const PACKAGE_GRAPH = /\/pkg\/[^/]+\/graph\//;

/** A route to a graph the store manages itself is refused, naming the shape and the graph. */
function refuseManaged(shape: string, graph: string, what: string): never {
  throw new GraphQueryError(
    'graph-name-read-only',
    `The graph route of <${shape}> names <${graph}>, ${what}, which only its own sync writes; ` +
      `route the shape to a data graph ('own', dataGraph('slug')) or leave it in the default graph.`,
    graph,
  );
}

function checkGraphIri(shape: string, graph: string): void {
  if (typeof graph !== 'string' || !IRI_PATTERN.test(graph)) {
    throw new Error(
      `The graph route of <${shape}> must be 'own', dataGraph('slug') or an absolute graph IRI; ` +
        `got ${JSON.stringify(graph)}.`,
    );
  }
  if (PORTABLE_GRAPH_NAMES.has(graph) && graph !== graphs.default) {
    throw new GraphQueryError(
      'graph-name-read-only',
      `<${graph}> is a portable graph name a store resolves at read time; a route names the one ` +
        `graph a shape's instances are written to (route <${shape}> to a graph IRI, or leave it ` +
        `out for the default graph).`,
      graph,
    );
  }
  if (graph !== graphs.default && PACKAGE_GRAPH.test(graph)) {
    refuseManaged(shape, graph, "a package's ontology or shape graph");
  }
}

/**
 * The name of an imported graph, `graph/import/{slug}`: one lower-case slug segment, the form the
 * graphs an import writes are named in.
 */
const IMPORT_GRAPH_PATH = /^graph\/import\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Refuse the `'own'` path of a shape that names a managed graph. An `'own'` path is
 * `graph/{package slug}/{shape name}`, so its top segment is a package slug, not a managed kind: a
 * package slugged `import` or `shapes` routes to its own graphs. Only a path that is also the name
 * of an imported graph (`graph/import/{slug}`: package `import`, a shape named in lower case) is
 * refused; shape names are case-kept class names (`Article`), which no import slug is.
 */
function checkOwnPath(shape: string, path: string, graph: string): void {
  if (IMPORT_GRAPH_PATH.test(path)) {
    refuseManaged(shape, graph, 'an imported graph');
  }
}

/** Refuse a path under the data root that names a managed graph ({@link MANAGED_UNDER_ROOT}). */
function checkUnderRoot(shape: string, path: string, graph: string): void {
  if (MANAGED_UNDER_ROOT.test(path)) {
    refuseManaged(shape, graph, path === 'graph/shapes' ? "the app's shape graph" : 'an imported graph');
  }
}

/** The last path segment of a shape IRI (after the last `/` or `#`). */
function shapeLocalName(shape: string): string {
  return shape.slice(Math.max(shape.lastIndexOf('/'), shape.lastIndexOf('#')) + 1);
}

/**
 * The path under the data root of a shape's own graph: `graph/{package slug}/{shape name}`
 * (module comment). Refused for a shape no package registered.
 */
export function ownGraphPath(shape: string): string {
  const packageName = (getRegisteredShapeClass(shape) as {packageName?: string} | undefined)
    ?.packageName;
  const slug = packageName ? packageNameToSlug(packageName) : '';
  const name = shapeLocalName(shape);
  if (!slug || !name) {
    throw new Error(
      `The graph route 'own' of <${shape}> needs a shape class registered by a package ` +
        `(linkedPackage(name).linkedShape); route it with dataGraph('slug') or a graph IRI instead.`,
    );
  }
  return `graph/${slug}/${name}`;
}

/**
 * Refuse a route for a shape that declares a default read set (`static defaultReadGraphs`: the
 * ontology term and shape shapes): its reads go to that set, so instances written to a routed
 * graph would never be read back. One that opts out (`graphs.default`) may be routed.
 */
function checkNoDefaultReadSet(shape: string): void {
  const declared = defaultReadGraphsOf(shape);
  if (!declared || (declared.length === 1 && declared[0] === graphs.default)) return;
  throw new GraphQueryError(
    'graph-name-read-only',
    `<${shape}> reads ${declared.map((g) => `<${g}>`).join(', ')} by default (its defaultReadGraphs), ` +
      `which its own sync writes; a graph route for it would write where its reads never look. ` +
      `Leave it unrouted, or read and write a graph of its own with .from() and .into().`,
    declared[0],
  );
}

/** A route as stored: `undefined` for the default graph (no route). */
function storedRoute(shape: string, route: GraphRoute): StoredRoute | undefined {
  checkShape(shape);
  if (route !== graphs.default) checkNoDefaultReadSet(shape);
  if (route === OWN_GRAPH) {
    const path = ownGraphPath(shape);
    checkOwnPath(shape, path, `{DATA_ROOT}/${path}`);
    return {underRoot: path, form: `'own'`};
  }
  if (isDataGraphRoute(route)) {
    // Re-checked: a route may arrive as plain data rather than from dataGraph().
    const {dataGraph: slug} = route;
    if (typeof slug !== 'string' || !DATA_GRAPH_SLUG.test(slug)) {
      throw new Error(`The graph route of <${shape}> has an invalid dataGraph slug ${JSON.stringify(slug)}.`);
    }
    checkUnderRoot(shape, `graph/${slug}`, `{DATA_ROOT}/graph/${slug}`);
    return {underRoot: `graph/${slug}`, form: `dataGraph('${slug}')`};
  }
  checkGraphIri(shape, route as string);
  return route === graphs.default ? undefined : {iri: route as string};
}

/**
 * The data root graph routes of `dataset` resolve under: the dataset's own (`IDataset.dataRoot()`;
 * a `SparqlDataset` returns its `SparqlOptions.dataRoot`, the root it mints ids under), else the
 * process's `DATA_ROOT`; trimmed, without trailing slashes. `undefined` when neither is set.
 */
export function dataRootOf(dataset: IDataset | object | undefined): string | undefined {
  const own =
    dataset && typeof (dataset as IDataset).dataRoot === 'function'
      ? (dataset as IDataset).dataRoot!()
      : undefined;
  const env = typeof process !== 'undefined' ? process.env?.DATA_ROOT : undefined;
  const root = (own || env || '').trim().replace(/\/+$/, '');
  return root || undefined;
}

/**
 * Route shapes of `dataset` to graphs: `{<shape IRI>: 'own' | dataGraph('slug') | <graph IRI>}`.
 * Adds to (and overrides) the dataset's existing routes. A route to `graphs.default` removes the
 * shape's route. Every route is checked before any is recorded.
 */
export function setShapeGraphs(
  dataset: IDataset | object,
  shapeGraphs: Record<string, GraphRoute>,
): void {
  const entries = Object.entries(shapeGraphs ?? {}).map(
    ([shape, route]) => [shape, storedRoute(shape, route)] as const,
  );
  let table = routes.get(dataset);
  if (!table) {
    table = new Map();
    routes.set(dataset, table);
  }
  for (const [shape, stored] of entries) {
    if (stored) table.set(shape, stored);
    else table.delete(shape);
  }
  bumpRoutesVersion();
}

/**
 * Every route change moves this version, which every cached routing is keyed on. It lives on the
 * shared global with the routes themselves: a second copy of this module writes the same table.
 * (A copy of core older than the routing cache writes the table without moving it.)
 */
function bumpRoutesVersion(): void {
  routingGlobal.__linkedGraphRoutesVersion = (routingGlobal.__linkedGraphRoutesVersion ?? 0) + 1;
}

/** The graph IRI of one stored route of `dataset`. */
function resolveStored(
  shape: string,
  stored: StoredRoute,
  root: () => string | undefined,
): string {
  if ('iri' in stored) {
    // A full IRI under the data root may name a managed graph there; checked once the root is known.
    const base = root();
    if (base && stored.iri.startsWith(`${base}/`)) {
      checkUnderRoot(shape, stored.iri.slice(base.length + 1), stored.iri);
    }
    return stored.iri;
  }
  const base = root();
  if (!base) {
    throw new Error(
      `The graph route ${stored.form} of <${shape}> resolves under the store's data root, and ` +
        `this store has none: give it one (SparqlOptions.dataRoot) or set DATA_ROOT.`,
    );
  }
  const graph = `${base}/${stored.underRoot}`;
  checkGraphIri(shape, graph);
  return graph;
}

/** The resolved routes of `dataset` (shape IRI → graph IRI), resolved with its data root. */
function resolvedTable(dataset: IDataset | object): Map<string, string> | undefined {
  const table = routes.get(dataset);
  if (!table || table.size === 0) return undefined;
  let cachedRoot: string | undefined | null = null;
  const root = () => (cachedRoot === null ? (cachedRoot = dataRootOf(dataset)) : cachedRoot);
  const out = new Map<string, string>();
  for (const [shape, stored] of table) out.set(shape, resolveStored(shape, stored, root));
  return out;
}

/**
 * The routes of `dataset` (shape IRI → graph IRI, `'own'` and `dataGraph()` resolved under its
 * data root), a copy; empty when it has none. Throws when a route needs a root the dataset lacks.
 */
export function getShapeGraphs(dataset: IDataset | object): Record<string, string> {
  return Object.fromEntries(resolvedTable(dataset) ?? []);
}

/** Drop the graph route of `shape` in `dataset`. */
export function unsetShapeGraph(shape: string, dataset: IDataset | object): void {
  if (routes.get(dataset)?.delete(shape)) bumpRoutesVersion();
}

/** The graph routing of one dataset, as the SPARQL compiler and the live-query matcher read it. */
export interface ShapeGraphRouting {
  /** The graph a shape's instances are written to (`graphs.default` when unrouted). */
  graphForShape(shapeId: string): string;
  /**
   * The graphs a read of the shape covers: its graph and every registered sub-shape's, without
   * duplicates, sorted (`graphs.default` first when present), so the query text is stable. The
   * array is frozen: the routing keeps it and hands the same one to every later caller.
   */
  readGraphsForShape(shapeId: string): string[];
  /** Every graph the routing names, and the default graph: where a node of unknown shape may be. */
  allGraphs(): string[];
}

/** What a routing object was built from: it is reused while all of them are unchanged. */
type CachedRouting = {
  routesVersion: number;
  registryVersion: number;
  root: string | undefined;
  routing: ShapeGraphRouting;
};

/** Dataset → its routing, rebuilt whole on the next use once an input moved (see graphRoutingFor). */
const routingCache = new WeakMap<object, CachedRouting>();

/**
 * The routing of `dataset`, or `undefined` when it has no routes (its reads and writes are then
 * exactly what they were before routing: everything in the default graph). Routes stated as
 * `'own'` or `dataGraph()` are resolved here, under the dataset's data root ({@link dataRootOf});
 * a route that needs a root the dataset lacks throws.
 *
 * The routing object is kept per dataset and returned again until one of its inputs moves; it is
 * then rebuilt whole on its next use (ownership crosses shapes, so no part of it is patched):
 *
 * - a route is set or unset ({@link setShapeGraphs}, {@link unsetShapeGraph}; any dataset's),
 * - a shape is registered or re-registered (the registry version, `getRegistryVersion()`),
 * - the dataset's data root ({@link dataRootOf}, read on every call, so a root the store learns
 *   later is the one used).
 *
 * A shape changed in place (its `NodeShapeData` edited without registering it again) is not seen:
 * change a shape, then re-register it. A routing that throws is not kept. What the routing derives
 * from the registry (owners, read sets, referring shapes) is kept per shape catalog, so a read
 * inside `withShapeCatalog` never sees the global registry's sets, nor the reverse.
 */
export function graphRoutingFor(dataset: IDataset | object | undefined): ShapeGraphRouting | undefined {
  if (!dataset) return undefined;
  const stored = routes.get(dataset);
  if (!stored || stored.size === 0) return undefined;
  const routesVersion: number = routingGlobal.__linkedGraphRoutesVersion ?? 0;
  const registryVersion = getRegistryVersion();
  const root = dataRootOf(dataset);
  const cached = routingCache.get(dataset);
  if (
    cached &&
    cached.routesVersion === routesVersion &&
    cached.registryVersion === registryVersion &&
    cached.root === root
  ) {
    return cached.routing;
  }
  const routing = buildRouting(resolvedTable(dataset)!);
  routingCache.set(dataset, {routesVersion, registryVersion, root, routing});
  return routing;
}

/** What a routing derives from the registry, for one catalog (or the global registry). */
type RegistryMemo = {
  /** Value shape → the shapes that own it (declare a `contains` property with it). */
  owners?: Map<string, Set<string>>;
  /** Value shape → the shapes that declare any property with it (storedInGraph shapes left out). */
  referrers?: Map<string, string[]>;
  readSets: Map<string, string[]>;
  referringGraphs: Map<string, string[]>;
};

/** The routing's own answer to {@link referringGraphsForShape}, memoized with its read sets. */
const REFERRING_GRAPHS = Symbol('referringGraphs');
type BuiltRouting = ShapeGraphRouting & {[REFERRING_GRAPHS](shapeId: string): string[]};

function buildRouting(table: Map<string, string>): BuiltRouting {
  const globalMemo: RegistryMemo = {readSets: new Map(), referringGraphs: new Map()};
  const catalogMemos = new WeakMap<object, RegistryMemo>();
  // Read when a method runs, not when the routing is built: a routing obtained outside a catalog
  // scope is used inside one when an IR captured in that catalog is compiled.
  const memo = (): RegistryMemo => {
    const catalog = getActiveShapeCatalog();
    if (catalog === undefined) return globalMemo;
    let forCatalog = catalogMemos.get(catalog);
    if (!forCatalog) catalogMemos.set(catalog, (forCatalog = {readSets: new Map(), referringGraphs: new Map()}));
    return forCatalog;
  };
  const graphForShape = (shapeId: string): string => {
    const own = table.get(shapeId);
    if (own) return own;
    for (const parent of getSuperShapes(shapeId)) {
      const inherited = table.get(parent.id);
      if (inherited) return inherited;
    }
    return graphs.default;
  };
  // The shapes that own instances of a shape: those declaring a `contains` property whose value
  // shape is the shape, one of its super-shapes or one of its sub-shapes (a select of the shape
  // returns its sub-shapes' instances too, so the owners of a sub-shape, an album that contains a
  // panorama read as a photo, hold nodes this shape reads).
  const ownersOf = (shapeId: string, m: RegistryMemo): string[] => {
    const owners = (m.owners ??= ownerIndex());
    const out = new Set<string>();
    for (const target of withRelatedShapes(shapeId)) {
      for (const owner of owners.get(target) ?? []) out.add(owner);
    }
    return [...out];
  };
  // A shape's read set: the graphs of every shape reachable from it through ownersOf (itself
  // included, `contains` cycles too), each contributing its own graph and its sub-shapes' graphs.
  // One traversal with a set of reached shapes, so each shape is expanded once; a reached shape
  // whose read set is already known contributes that set instead (it holds everything reachable
  // from it). Every set computed is complete, so every one is kept, frozen: the same array is
  // handed to every later caller.
  const readGraphsForShape = (shapeId: string): string[] => {
    const m = memo();
    const cached = m.readSets.get(shapeId);
    if (cached) return cached;
    const set = new Set<string>();
    const reached = new Set<string>([shapeId]);
    const pending = [shapeId];
    while (pending.length) {
      const current = pending.pop()!;
      const known = m.readSets.get(current);
      if (known) {
        for (const graph of known) set.add(graph);
        continue;
      }
      set.add(graphForShape(current));
      for (const sub of getSubShapes(current)) set.add(graphForShape(sub.id));
      for (const owner of ownersOf(current, m)) {
        if (reached.has(owner)) continue;
        reached.add(owner);
        pending.push(owner);
      }
    }
    const sortedSet = Object.freeze(sortGraphSet(set)) as string[];
    m.readSets.set(shapeId, sortedSet);
    return sortedSet;
  };
  const referringGraphs = (shapeId: string): string[] => {
    const m = memo();
    const cached = m.referringGraphs.get(shapeId);
    if (cached) return cached;
    const referrers = (m.referrers ??= referrerIndex());
    const out = Object.freeze(referringGraphsVia(referrers, readGraphsForShape, shapeId)) as string[];
    m.referringGraphs.set(shapeId, out);
    return out;
  };
  return {
    graphForShape,
    readGraphsForShape,
    allGraphs(): string[] {
      return sortGraphSet([graphs.default, ...table.values()]);
    },
    [REFERRING_GRAPHS]: referringGraphs,
  };
}

/** The shape, its super-shapes and its sub-shapes. */
function withRelatedShapes(shapeId: string): string[] {
  return [shapeId, ...getSuperShapes(shapeId).map((s) => s.id), ...getSubShapes(shapeId).map((s) => s.id)];
}

/** Value shape → the shapes declaring a `contains` property with it (own properties). */
function ownerIndex(): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const shape of getAllNodeShapes().values()) {
    for (const ps of getPropertyShapes(shape)) {
      const valueShape = ps.contains ? ps.valueShape?.id : undefined;
      if (!valueShape) continue;
      let owners = index.get(valueShape);
      if (!owners) index.set(valueShape, (owners = new Set()));
      owners.add(shape.id);
    }
  }
  return index;
}

/**
 * Value shape → the shapes declaring any property with it (own properties), leaving out shapes
 * whose class stores its instances in a graph of its own (`storedInGraph`, the graph registry's
 * records): mutations never write those graphs.
 */
function referrerIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const shape of getAllNodeShapes().values()) {
    const storedIn = (getRegisteredShapeClass(shape.id) as {storedInGraph?: unknown} | undefined)?.storedInGraph;
    if (typeof storedIn === 'string' && storedIn) continue;
    const valueShapes = new Set<string>();
    for (const ps of getPropertyShapes(shape)) {
      if (ps.valueShape?.id !== undefined) valueShapes.add(ps.valueShape.id);
    }
    for (const valueShape of valueShapes) {
      let referrers = index.get(valueShape);
      if (!referrers) index.set(valueShape, (referrers = []));
      referrers.push(shape.id);
    }
  }
  return index;
}

/** The read sets of the shapes `referrers` lists for the shape, a super- or a sub-shape of it. */
function referringGraphsVia(
  referrers: Map<string, string[]>,
  readGraphsForShape: (shapeId: string) => string[],
  shapeId: string,
): string[] {
  const shapes = new Set<string>();
  for (const target of withRelatedShapes(shapeId)) {
    for (const shape of referrers.get(target) ?? []) shapes.add(shape);
  }
  const out = new Set<string>();
  for (const shape of shapes) for (const graph of readGraphsForShape(shape)) out.add(graph);
  return sortGraphSet(out);
}

/** A graph set in its stable order: `graphs.default` first, then the named graphs sorted. */
export function sortGraphSet(set: Iterable<string>): string[] {
  const all = [...new Set(set)];
  const named = all.filter((g) => g !== graphs.default).sort();
  return all.includes(graphs.default) ? [graphs.default, ...named] : named;
}

/**
 * The graphs that may hold a link to a node of `shapeId` under `routing`: the read set of every
 * shape that declares a property whose value shape is the shape, one of its super-shapes or one
 * of its sub-shapes (a sub-shape of such a shape is in its read set), in the stable order of
 * {@link sortGraphSet}. A delete by id removes the links to its subject there. Shapes whose class
 * stores its instances in a graph of its own (`storedInGraph`, the graph registry's records) are
 * left out: mutations never write those graphs.
 */
export function referringGraphsForShape(routing: ShapeGraphRouting, shapeId: string): string[] {
  const own = (routing as Partial<BuiltRouting>)[REFERRING_GRAPHS];
  if (own) return own(shapeId);
  // A routing from elsewhere (a store that overrides its graphRouting()): nothing kept.
  return referringGraphsVia(referrerIndex(), (id) => routing.readGraphsForShape(id), shapeId);
}
