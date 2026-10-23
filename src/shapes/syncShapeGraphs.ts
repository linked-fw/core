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
   * Set when the store has no graph queries and the default-graph sync ran instead: how many
   * of its writes ran.
   */
  defaultGraph?: number;
}

type ShapesRecord = {package?: string; contentHash?: string};

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
  // A dataset class built against an older core has no graph queries.
  if (ds && typeof (ds as Partial<IDataset>).graphQuery !== 'function') {
    return syncDefaultGraph(ds);
  }
  const run = {wroteGraph: false};
  try {
    return await syncGraphs(run, ds, options);
  } catch (error) {
    // A store either runs graph queries or refuses the first one, before anything was written.
    if (!run.wroteGraph && isGraphQueryError(error, 'unsupported-query-kind')) {
      return syncDefaultGraph(ds);
    }
    throw error;
  }
}

/** The default-graph sync (`syncShapes`), for a store without graph queries. */
async function syncDefaultGraph(ds?: IDataset): Promise<SyncShapeGraphsResult> {
  const thunks = await syncShapes(ds);
  for (const run of thunks) await run();
  return {written: [], skipped: [], pruned: [], cleaned: 0, defaultGraph: thunks.length};
}

async function syncGraphs(
  run: {wroteGraph: boolean},
  ds: IDataset | undefined,
  options: SyncShapeGraphsOptions,
): Promise<SyncShapeGraphsResult> {
  const result: SyncShapeGraphsResult = {written: [], skipped: [], pruned: [], cleaned: 0};
  const rows =
    ((await ShapesGraph.select((r) => [r.package, r.contentHash]).exec(ds)) as Array<{
      id: string;
      package?: unknown;
      contentHash?: unknown;
    }> | null) ?? [];
  const records = new Map<string, ShapesRecord>();
  for (const row of rows) {
    if (!row?.id) continue;
    records.set(row.id, {
      package: typeof row.package === 'string' ? row.package : undefined,
      contentHash: typeof row.contentHash === 'string' ? row.contentHash : undefined,
    });
  }

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
  // their package's graph. Each goes with its owned subtree (property shapes, lists, paths and
  // generated shapes), through the delete cascade. Shapes no package of this run holds stay.
  const stale = await readStoredHashes(cleanupIris, ds);
  for (const iri of [...stale.keys()].sort()) {
    await DeleteBuilder.from(NodeShape, {id: iri}).exec(ds);
    result.cleaned++;
  }

  if (options.orphanScope === 'all' && !only) {
    const live = new Set(registered);
    for (const [graph, record] of [...records].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (graph === options.appShapes?.graph || !record.package || live.has(record.package)) continue;
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
