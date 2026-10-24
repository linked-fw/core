/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The shape graph sync: each package's shapes in its own named graph,
 * `{package IRI}/graph/shapes`, recorded in the graph registry as a `ShapesGraph` (never a
 * hierarchy source), and the app's generated single-owner shapes in the app's own shape graph.
 *
 * A graph's body is the package's `shapes.ttl` (built by `linked build`, or generated here with
 * `packageShapesTurtle`, the same bytes). Skipped by a content hash (`linked-shape-graph/1\n` +
 * the Turtle), compared with the record's `core:contentHash`: an unchanged package writes
 * nothing; a changed or new one is replaced whole in one graph query. The sync never patches.
 *
 * The shapes an earlier sync wrote into the default graph (`NodeShape`s with a `core:shapeHash`)
 * are removed once their package's graph holds them. A store without graph queries
 * (`unsupported-query-kind`) gets that default-graph sync instead (`syncShapes`).
 *
 * That is the `'package'` mode, the default. The store's `shapeGraph` target
 * (`utils/graphTargets.ts`) chooses the others: a shared graph IRI holds every package's shapes
 * (and the app's generated ones) in one `ShapesGraph`, rebuilt whole on any change
 * ({@link sharedShapeGraphHash}); `'default'` runs `syncShapes` into the default graph. Data
 * another mode left is reported in one warning, never moved.
 *
 * Runs at app boot and through the app's control route, after the ontology sync. Server only.
 *
 * @module @_linked/core/shapes/syncShapeGraphs
 */
import type {IDataset} from '../interfaces/IDataset.js';
import type {GraphContent} from '../queries/IntermediateRepresentation.js';
import {DeleteBuilder} from '../queries/DeleteBuilder.js';
import {isGraphQueryError} from '../queries/graphQuery.js';
import {assertNoActiveCatalog} from '../utils/ShapeClass.js';
import {sha256Hex} from '../utils/sha256.js';
import {ShapesGraph} from './NamedGraph.js';
import {NodeShape} from './SHACL.js';
import {readStoredHashes, syncShapes} from './syncShapes.js';
import {
  packageShapes,
  packageShapesTurtle,
  packagesWithShapes,
  singleOwnerShapesTurtle,
} from './shapesToTurtle.js';
import {graphTargetsOf, isSharedGraphTarget, type GraphTarget} from '../utils/graphTargets.js';

/** What the shape graph hash covers before the Turtle; a new prefix re-syncs every dataset once. */
export const SHAPE_GRAPH_HASH_PREFIX = 'linked-shape-graph/1\n';

/** The content hash of a shape graph: SHA-256 (hex) of {@link SHAPE_GRAPH_HASH_PREFIX} + the Turtle. */
export function shapeGraphHash(turtle: string): string {
  return sha256Hex(SHAPE_GRAPH_HASH_PREFIX + turtle);
}

/** The `dcterms:source` of a package's shape graph: the file `linked build` writes. */
const SHAPES_SOURCE = 'data/shapes.ttl';

/** A package's shape graph IRI (arch-02: `{baseUri}pkg/{slug}/graph/shapes`). */
const PACKAGE_SHAPES_GRAPH = /\/pkg\/[^/]+\/graph\/shapes$/;

export interface SyncShapeGraphsOptions {
  /** Replace every graph, even when its stored hash matches. */
  force?: boolean;
  /** Only these packages (npm names). The app graph is written whenever `appShapes` is given. */
  packages?: string[];
  /**
   * The bytes of a package's `shapes.ttl` (its `lib/esm/data/shapes.ttl`), or `undefined` to
   * generate them from the registered shapes (`packageShapesTurtle`, the same bytes for the same
   * core). A server reads the installed file here.
   */
  turtleFor?: (packageName: string) => string | undefined | Promise<string | undefined>;
  /**
   * The app's own shape graph, `{DATA_ROOT}/graph/shapes`, for the single-owner shapes core
   * generates from `contains` properties (they depend on what the app registers). `package`
   * is recorded on its record. Without it those shapes are not written.
   */
  appShapes?: {graph: string; package?: string};
  /**
   * `'all'` (without `packages`): drop the shape graph of every package that is no longer
   * registered (the app graph excepted). Default `'none'`.
   */
  orphanScope?: 'none' | 'all';
}

export interface SyncShapeGraphsResult {
  /** Packages whose shape graph was written. */
  written: string[];
  /** Packages whose shape graph was unchanged. */
  skipped: string[];
  /** Packages no longer registered whose shape graph was dropped (`orphanScope: 'all'`). */
  pruned: string[];
  /** Shapes an earlier sync had written into the default graph, removed now. */
  cleaned: number;
  /** The app graph: written, unchanged, or dropped (nothing to hold). Absent without `appShapes`. */
  appGraph?: 'written' | 'skipped' | 'dropped';
  /**
   * Set when the shapes went into the default graph (`syncShapes`): under `shapeGraph: 'default'`,
   * or because the store has no graph queries. How many of its writes ran.
   */
  defaultGraph?: number;
  /** Where the run wrote: the store's `shapeGraph` target (`'package'`, `'default'` or an IRI). */
  target?: GraphTarget;
  /** Set when a store without graph queries got the default-graph sync instead of `target`. */
  fallback?: true;
}

type ShapesRecord = {package?: string; contentHash?: string; packageHashes: string[]};

/** What a shared shape graph's hash covers before its parts; a new prefix rebuilds it once. */
export const SHARED_SHAPE_GRAPH_HASH_PREFIX = 'linked-shape-graph-shared/1\n';

/**
 * The content hash of a shared shape graph: SHA-256 (hex) of
 * {@link SHARED_SHAPE_GRAPH_HASH_PREFIX} + one `"{package} {hash}"` line per package (sorted by
 * name, each hash the package's {@link shapeGraphHash}), then, when the app's generated shapes are
 * part of it, an empty line and their {@link shapeGraphHash}.
 */
export function sharedShapeGraphHash(parts: Array<{name: string; hash: string}>, appHash?: string): string {
  return sha256Hex(
    SHARED_SHAPE_GRAPH_HASH_PREFIX + packageHashLines(parts).join('\n') + (appHash ? `\n\n${appHash}` : ''),
  );
}

const packageHashLines = (parts: Array<{name: string; hash: string}>): string[] =>
  [...parts].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => `${p.name} ${p.hash}`);

const turtle = (text: string): GraphContent => ({mediaType: 'text/turtle', text});

/**
 * Sync the shapes of every registered package (or of `options.packages`) into `ds` (default:
 * the global router), one shape graph per package; see the module doc.
 *
 * Per package: skipped when its record's hash matches (no write at all, so an unforked branch
 * stays unforked); otherwise its graph is created or replaced whole in one graph query. Then the
 * package's shapes an earlier sync wrote into the default graph are deleted there (one read finds
 * them; a store already cleaned costs that read only). The app graph follows the same rule.
 */
export async function syncShapeGraphs(
  ds?: IDataset,
  options: SyncShapeGraphsOptions = {},
): Promise<SyncShapeGraphsResult> {
  assertNoActiveCatalog();
  const target = graphTargetsOf(ds).shapeGraph;
  if (target === 'default') return syncDefaultMode(ds, options);
  // A dataset class built against an older core has no graph queries.
  if (ds && typeof (ds as Partial<IDataset>).graphQuery !== 'function') {
    return {...(await syncDefaultGraph(ds, options)), target, fallback: true};
  }
  const run = {wroteGraph: false};
  try {
    return isSharedGraphTarget(target)
      ? await syncSharedGraph(run, ds, options, target)
      : {...(await syncGraphs(run, ds, options)), target: 'package'};
  } catch (error) {
    // A store either runs graph queries or refuses the first one, before anything was written.
    if (!run.wroteGraph && isGraphQueryError(error, 'unsupported-query-kind')) {
      return {...(await syncDefaultGraph(ds, options)), target, fallback: true};
    }
    throw error;
  }
}

/** The default-graph sync (`syncShapes`): the `'default'` mode, and stores without graph queries. */
async function syncDefaultGraph(ds: IDataset | undefined, options: SyncShapeGraphsOptions): Promise<SyncShapeGraphsResult> {
  const thunks = await syncShapes(ds, options.force ? {force: true} : undefined);
  for (const run of thunks) await run();
  return {written: [], skipped: [], pruned: [], cleaned: 0, defaultGraph: thunks.length};
}

/** Every `ShapesGraph` record of `ds`, by graph, in one read. */
async function readShapesRecords(ds?: IDataset): Promise<Map<string, ShapesRecord>> {
  const rows =
    ((await ShapesGraph.select((r) => [r.package, r.contentHash, r.packageHashes]).exec(ds)) as Array<{
      id: string;
      package?: unknown;
      contentHash?: unknown;
      packageHashes?: unknown;
    }> | null) ?? [];
  const records = new Map<string, ShapesRecord>();
  for (const row of rows) {
    if (!row?.id) continue;
    const hashes = Array.isArray(row.packageHashes)
      ? row.packageHashes
      : row.packageHashes === undefined || row.packageHashes === null
        ? []
        : [row.packageHashes];
    records.set(row.id, {
      package: typeof row.package === 'string' ? row.package : undefined,
      contentHash: typeof row.contentHash === 'string' ? row.contentHash : undefined,
      packageHashes: hashes.filter((h): h is string => typeof h === 'string').sort(),
    });
  }
  return records;
}

/**
 * Log one warning naming the data of another `shapeGraph` mode the run found. The sync never
 * moves it: changing the mode means clearing first (see "Ontology and shape graphs" in the README).
 */
function warnOtherModes(mode: GraphTarget, found: {packageGraphs?: string[]; sharedGraphs?: string[]; appGraph?: string; defaultGraphShapes?: number}): void {
  const parts: string[] = [];
  if (found.packageGraphs?.length) {
    parts.push(`package shape graphs (the 'package' mode): ${found.packageGraphs.map((g) => `<${g}>`).join(', ')}`);
  }
  if (found.appGraph) parts.push(`the app's shape graph <${found.appGraph}> (the 'package' mode)`);
  if (found.sharedGraphs?.length) {
    parts.push(`shared shape graphs: ${found.sharedGraphs.map((g) => `<${g}>`).join(', ')}`);
  }
  if (found.defaultGraphShapes) {
    parts.push(`${found.defaultGraphShapes} registered shape(s) in the default graph (the 'default' mode)`);
  }
  if (!parts.length) return;
  const where = mode === 'package' ? "'package'" : mode === 'default' ? "'default'" : `<${mode}>`;
  console.warn(
    `[syncShapeGraphs] shapeGraph is ${where}, but the dataset also holds ${parts.join('; ')}. ` +
      'The sync leaves it as it is and never copies it: clear it to switch modes (see "Ontology ' +
      'and shape graphs" in @_linked/core\'s README).',
  );
}

/** The package shape graphs among `records` (a package's own graph), sorted. */
const packageGraphsOf = (records: Map<string, ShapesRecord>): string[] =>
  [...records]
    .filter(([graph, record]) => PACKAGE_SHAPES_GRAPH.test(graph) && !record.packageHashes.length)
    .map(([graph]) => graph)
    .sort();

/** An app's own shape graph among `records` (neither a package's nor a shared one), if any. */
const appGraphOf = (records: Map<string, ShapesRecord>): string | undefined =>
  [...records].find(([graph, record]) => !PACKAGE_SHAPES_GRAPH.test(graph) && !record.packageHashes.length)?.[0];

/** The shared shape graphs among `records` (those listing package hashes), sorted. */
const sharedGraphsOf = (records: Map<string, ShapesRecord>, except?: string): string[] =>
  [...records]
    .filter(([graph, record]) => graph !== except && record.packageHashes.length > 0)
    .map(([graph]) => graph)
    .sort();

/**
 * The `'default'` mode: every shape in the default graph through `syncShapes` (each shape
 * replaced on its own hash, keeping the links other shapes hold to it). Other modes' graphs are
 * reported, never moved.
 */
async function syncDefaultMode(ds: IDataset | undefined, options: SyncShapeGraphsOptions): Promise<SyncShapeGraphsResult> {
  try {
    const records = await readShapesRecords(ds);
    warnOtherModes('default', {
      packageGraphs: packageGraphsOf(records),
      sharedGraphs: sharedGraphsOf(records),
      appGraph: appGraphOf(records),
    });
  } catch {
    // A store without a graph registry holds no other mode's graphs.
  }
  return {...(await syncDefaultGraph(ds, options)), target: 'default'};
}

/**
 * The shared mode (`shapeGraph` is an IRI): the shapes of every package of the run, and the app's
 * generated shapes when `appShapes` is given, in the one `ShapesGraph` at `graph`, rebuilt whole in
 * one graph query when the combined hash ({@link sharedShapeGraphHash}) differs from the record's.
 * The record lists every package's hash (`packageHashes`) and file (`sources`). Other modes' data
 * is reported, never moved (the default-graph cleanup of the package mode does not run).
 */
async function syncSharedGraph(
  run: {wroteGraph: boolean},
  ds: IDataset | undefined,
  options: SyncShapeGraphsOptions,
  graph: string,
): Promise<SyncShapeGraphsResult> {
  const records = await readShapesRecords(ds);
  const registered = packagesWithShapes();
  const only = options.packages ? new Set(options.packages) : undefined;
  const texts: Array<{name: string; text: string}> = [];
  for (const name of registered) {
    if (only && !only.has(name)) continue;
    const text = (await options.turtleFor?.(name)) ?? packageShapesTurtle(name);
    if (text !== undefined) texts.push({name, text});
  }
  texts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const appText = options.appShapes
    ? singleOwnerShapesTurtle(registered.flatMap((name) => packageShapes(name)))
    : undefined;

  const stale = await readStoredHashes(registered.flatMap((name) => packageShapes(name).map((shape) => shape.id)), ds);
  warnOtherModes(graph, {
    packageGraphs: packageGraphsOf(records),
    sharedGraphs: sharedGraphsOf(records, graph),
    appGraph: appGraphOf(records),
    defaultGraphShapes: stale.size,
  });

  const parts = texts.map(({name, text}) => ({name, hash: shapeGraphHash(text)}));
  const hash = sharedShapeGraphHash(parts, appText === undefined ? undefined : shapeGraphHash(appText));
  const record = records.get(graph);
  const names = texts.map((t) => t.name);
  const appStatus = (status: 'written' | 'skipped') =>
    options.appShapes ? {appGraph: appText === undefined ? ('skipped' as const) : status} : {};
  if (!options.force && record?.contentHash === hash) {
    return {written: [], skipped: names, pruned: [], cleaned: 0, ...appStatus('skipped'), target: graph};
  }
  const content = turtle([...texts.map((t) => t.text), ...(appText === undefined ? [] : [appText])].join('\n'));
  const fields = {
    sources: names.map((name) => `${name}/${SHAPES_SOURCE}`),
    packageHashes: packageHashLines(parts),
  };
  const replace = () => ShapesGraph.update(graph).set(fields).replaceContent(content, {contentHash: hash}).exec(ds);
  const create = () =>
    ShapesGraph.create({id: graph, ...fields} as unknown as {id: string; package: string})
      .withContent(content, {contentHash: hash})
      .exec(ds);
  if (record) {
    await replace();
  } else {
    try {
      await create();
    } catch (error) {
      if (!isGraphQueryError(error, 'graph-exists')) throw error;
      try {
        await replace();
      } catch (inner) {
        if (!isGraphQueryError(inner, 'graph-not-registered')) throw inner;
        await ShapesGraph.delete(graph).exec(ds);
        await create();
      }
    }
  }
  run.wroteGraph = true;
  const pruned = [...new Set((record?.packageHashes ?? []).map((line) => line.split(' ')[0]))].filter(
    (name) => name && !names.includes(name),
  );
  return {written: names, skipped: [], pruned: pruned.sort(), cleaned: 0, ...appStatus('written'), target: graph};
}

async function syncGraphs(
  run: {wroteGraph: boolean},
  ds: IDataset | undefined,
  options: SyncShapeGraphsOptions,
): Promise<SyncShapeGraphsResult> {
  const result: SyncShapeGraphsResult = {written: [], skipped: [], pruned: [], cleaned: 0};
  const records = await readShapesRecords(ds);
  warnOtherModes('package', {sharedGraphs: sharedGraphsOf(records)});

  /** Create or replace `graph` with `text` unless its record's hash matches. */
  const write = async (
    graph: string,
    text: string,
    record: {package?: string; sources?: string},
  ): Promise<boolean> => {
    const hash = shapeGraphHash(text);
    const stored = records.get(graph);
    if (!options.force && stored?.contentHash === hash) return false;
    if (stored) {
      await ShapesGraph.update(graph)
        .set(record.sources ? {sources: record.sources} : {})
        .replaceContent(turtle(text), {contentHash: hash})
        .exec(ds);
    } else {
      await ShapesGraph.create({id: graph, ...record} as {id: string; package: string})
        .withContent(turtle(text), {contentHash: hash})
        .exec(ds);
    }
    run.wroteGraph = true;
    return true;
  };

  const registered = packagesWithShapes();
  const only = options.packages ? new Set(options.packages) : undefined;
  const cleanupIris: string[] = [];
  for (const name of registered) {
    if (only && !only.has(name)) continue;
    const text = (await options.turtleFor?.(name)) ?? packageShapesTurtle(name);
    if (text === undefined) continue;
    const graph = ShapesGraph.iriFor(name);
    const written = await write(graph, text, {package: name, sources: SHAPES_SOURCE});
    (written ? result.written : result.skipped).push(name);
    for (const shape of packageShapes(name)) cleanupIris.push(shape.id);
  }

  if (options.appShapes) {
    const {graph, package: pkg} = options.appShapes;
    const all = registered.flatMap((name) => packageShapes(name));
    const text = singleOwnerShapesTurtle(all);
    if (text !== undefined) {
      result.appGraph = (await write(graph, text, pkg ? {package: pkg} : {})) ? 'written' : 'skipped';
    } else if (records.has(graph)) {
      await ShapesGraph.delete(graph).exec(ds);
      run.wroteGraph = true;
      result.appGraph = 'dropped';
    } else {
      result.appGraph = 'skipped';
    }
  }

  // The one-time cleanup: the shapes an earlier sync wrote into the default graph, now held by
  // their package's graph. Each loses its own description only (its triples, the blank nodes
  // under them, and its owned subtree: property shapes, lists, paths and generated shapes); the
  // links other default-graph shapes hold to it (`core:isExtending`, `sh:node`, …) stay, since a
  // shape that stays still names it. Shapes no package of this run holds stay.
  const stale = await readStoredHashes(cleanupIris, ds);
  for (const iri of [...stale.keys()].sort()) {
    await DeleteBuilder.from(NodeShape, {id: iri})._keepingIncoming().exec(ds);
    result.cleaned++;
  }

  if (options.orphanScope === 'all' && !only) {
    const live = new Set(registered);
    for (const [graph, record] of [...records].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (graph === options.appShapes?.graph || !record.package || live.has(record.package)) continue;
      if (record.packageHashes.length) continue; // a shared graph (another mode's)
      // Only package graphs (`{baseUri}pkg/{slug}/graph/shapes`), never an app's own graph.
      if (!PACKAGE_SHAPES_GRAPH.test(graph)) continue;
      await ShapesGraph.delete(graph).exec(ds);
      run.wroteGraph = true;
      result.pruned.push(record.package);
    }
  }

  result.written.sort();
  result.skipped.sort();
  return result;
}
