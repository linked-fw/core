/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The ontology sync: writes each registered package's whole ontology data into its own named
 * graph, `{package IRI}/graph/ontology`, recorded in the graph registry as an `OntologyGraph`
 * that feeds the store's class hierarchy.
 *
 * Skipped by a content hash per package (`linked-ontology-sync/2\n` + the package's raw file
 * texts), compared with the record's `core:contentHash`: an unchanged package writes nothing, a
 * changed or new one is replaced whole in one graph query (the body as N-Triples).
 *
 * The `'package'` and shared modes need a store with graph queries: one without them (a dataset
 * class without `graphQuery`, or one that answers `unsupported-query-kind`) is refused with an
 * error naming it.
 *
 * Before the first package graph is written, the store is probed once per dataset
 * (`hierarchyProbe.ts`) for the hierarchy it infers from; a sync with nothing to write probes
 * nothing and sends no request beyond its reads (an unforked branch stays unforked). The
 * answer only decides a warning: on every store with graph queries the ontology data goes into
 * package graphs and nothing of the hierarchy is kept in the default graph. A store that infers
 * only from the default graph (`'default-graph'`) or not at all (`'none'`) gets one warning per
 * dataset that class-scoped reads miss subclass instances.
 *
 * That is the `'package'` mode, the default. The global `ontologyGraph` target (`getGraphTargets`)
 * (`utils/graphTargets.ts`) chooses the others: a shared graph IRI holds every package's data in
 * one `OntologyGraph`, rebuilt whole when any package changes ({@link sharedOntologyGraphHash});
 * `'default'` keeps the whole ontology in the default graph, replacing every package-owned term in
 * one update when the combined hash changes ({@link defaultGraphOntologyHash}). Data another mode
 * left is reported in one warning, never moved.
 *
 * Runs at app boot and through the app's control route, before shape sync. Server only (the
 * readers load `n3`).
 *
 * @module @_linked/core/ontology/syncOntologies
 */

import type {IDataset} from '../interfaces/IDataset.js';
import {QueryBuilder} from '../queries/QueryBuilder.js';
import {assertNoActiveCatalog} from '../utils/ShapeClass.js';
import {sha256Hex} from '../utils/sha256.js';
import {OntologySync} from '../shapes/OntologySync.js';
import {NamedGraph, OntologyGraph} from '../shapes/NamedGraph.js';
import {isGraphQueryError} from '../queries/graphQuery.js';
import {
  probeDefaultGraphInference,
  probeHierarchyInference,
  warnOnceForDataset,
  type HierarchyInference,
} from './hierarchyProbe.js';
import {defaultGraphTermsFromTurtle, nTriplesFromTurtle} from './hierarchy.js';
import {getGraphTargets, isSharedGraphTarget, type GraphTarget} from '../utils/graphTargets.js';
import {LinkedStorage} from '../utils/LinkedStorage.js';
import {getAllShapeClasses} from '../utils/ShapeClass.js';
import {dataRootOf} from '../utils/graphRouting.js';
import {LINKED_DATA_ROOT} from '../shapes/SHACL.js';
import {DEFAULT_GRAPH_TERMS_DEPTH} from '../queries/defaultGraphTerms.js';
import {coreOntology} from '../ontologies/linked-core.js';
import {
  readPackageOntologies,
  registrationsByPackage,
  setHierarchyFromPackages,
  type PackageOntologyData,
} from './registryData.js';

export interface SyncOntologiesOptions {
  /** Write every package, even when its stored hash matches: its graph is replaced whole. */
  force?: boolean;
  /** Only these packages (npm names). */
  packages?: string[];
  /**
   * `'all'` (without `packages`): drop the ontology graph of every package that is no longer
   * registered. Default `'none'`.
   */
  orphanScope?: 'none' | 'all';
}

export interface SyncOntologiesResult {
  /** Packages whose ontology graph was written (in the `'default'` mode: whose terms were). */
  written: string[];
  /** Packages left as they were: unchanged, or their data could not be read. */
  skipped: string[];
  /**
   * Packages no longer registered whose graph was dropped (`orphanScope: 'all'`); in a shared
   * graph, the packages its record listed that the rebuild left out.
   */
  pruned: string[];
  /** Where the run wrote: the global `ontologyGraph` target (`'package'`, `'default'` or the shared graph's IRI). */
  target?: GraphTarget;
}

/** What the ontology graph hash covers before the package's texts; a new prefix re-syncs every dataset once. */
export const ONTOLOGY_GRAPH_HASH_PREFIX = 'linked-ontology-sync/2\n';

/**
 * The content hash of a package's ontology graph: SHA-256 (hex) of
 * {@link ONTOLOGY_GRAPH_HASH_PREFIX} + the package's raw data file texts, in registration order,
 * joined with `\n`. Recorded as the graph's `core:contentHash`.
 */
export function ontologyGraphHash(texts: string[]): string {
  return sha256Hex(ONTOLOGY_GRAPH_HASH_PREFIX + texts.join('\n'));
}

type Exec = {exec: (target?: IDataset) => Promise<unknown>};

/** What one run knows before it writes: the parsed packages and the scope. */
interface SyncRun {
  ds?: IDataset;
  options?: SyncOntologiesOptions;
  only?: Set<string>;
  parsed: Map<string, PackageOntologyData>;
  unreadable: string[];
  registered: Set<string>;
}

/**
 * The node the `'default'` mode records its combined hash on, in the default graph (an
 * `OntologySync`). Outside every package namespace, and replaced in the same update as the terms.
 */
export const DEFAULT_GRAPH_ONTOLOGY_NODE = 'https://linked.cm/pkg/core/ontology-sync/default-graph';

/**
 * The `'default'` mode's record in `ds`: its hash, or `undefined` when there is none. Read in
 * every mode, so a run can name that mode's data.
 */
async function readDefaultModeState(ds?: IDataset): Promise<{hash?: string} | undefined> {
  const rows =
    ((await (QueryBuilder.from(OntologySync).select(['ontologyHash']) as unknown as Exec).exec(ds)) as Array<{
      id: string;
      ontologyHash?: unknown;
    }> | null) ?? [];
  const row = rows.find((r) => r?.id === DEFAULT_GRAPH_ONTOLOGY_NODE);
  return row ? {hash: typeof row.ontologyHash === 'string' ? row.ontologyHash : undefined} : undefined;
}

/** An `OntologyGraph` record as the sync reads it. */
export type OntologyRecord = {package?: string; contentHash?: string; packageHashes: string[]};

/** Every `OntologyGraph` record of `ds`, by graph, in one read. */
export async function readOntologyRecords(ds?: IDataset): Promise<Map<string, OntologyRecord>> {
  const rows =
    ((await OntologyGraph.select((r) => [r.package, r.contentHash, r.packageHashes]).exec(ds)) as Array<{
      id: string;
      package?: unknown;
      contentHash?: unknown;
      packageHashes?: unknown;
    }> | null) ?? [];
  const records = new Map<string, OntologyRecord>();
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

/** A package's own ontology graph IRI (`{package IRI}/graph/ontology`). */
const PACKAGE_ONTOLOGY_GRAPH = /\/pkg\/[^/]+\/graph\/ontology$/;

/** The shared ontology graphs among `records` (those listing package hashes), sorted. */
const sharedRecords = (records: Map<string, OntologyRecord>, except?: string): string[] =>
  [...records]
    .filter(([graph, record]) => graph !== except && record.packageHashes.length > 0)
    .map(([graph]) => graph)
    .sort();

/** The package ontology graphs among `records` (a package's own graph, with its record), sorted. */
const packageRecords = (records: Map<string, OntologyRecord>): string[] =>
  [...records]
    .filter(([graph, record]) => PACKAGE_ONTOLOGY_GRAPH.test(graph) && !!record.package && !record.packageHashes.length)
    .map(([graph]) => graph)
    .sort();

/** What a run found of another mode's data. */
interface OtherModeFindings {
  packageGraphs?: string[];
  sharedGraphs?: string[];
  defaultGraphOntology?: boolean;
}

/**
 * Log one warning naming the data of another `ontologyGraph` mode the run found. The sync never
 * moves it: changing the mode means clearing first (see "Ontology and shape graphs" in the README).
 */
function warnOtherModes(mode: GraphTarget, ds: IDataset | undefined, found: OtherModeFindings): void {
  const parts: string[] = [];
  if (found.packageGraphs?.length) {
    parts.push(`package ontology graphs (the 'package' mode): ${found.packageGraphs.map((g) => `<${g}>`).join(', ')}`);
  }
  if (found.sharedGraphs?.length) {
    parts.push(`shared ontology graphs: ${found.sharedGraphs.map((g) => `<${g}>`).join(', ')}`);
  }
  if (found.defaultGraphOntology) {
    parts.push(`the ontology in the default graph (the 'default' mode, <${DEFAULT_GRAPH_ONTOLOGY_NODE}>)`);
  }
  if (!parts.length) return;
  const where = mode === 'package' ? "'package'" : mode === 'default' ? "'default'" : `<${mode}>`;
  console.warn(
    `[syncOntologies] ontologyGraph is ${where}, but the dataset${datasetLabel(ds)} also holds ` +
      `${parts.join('; ')}. The sync leaves it as it is and never copies it: clear it to switch ` +
      'modes (see "Ontology and shape graphs" in @_linked/core\'s README).',
  );
}

const datasetLabel = (ds?: IDataset): string => {
  const name = (ds as {dataset?: unknown} | undefined)?.dataset;
  return typeof name === 'string' && name ? ` ${name}` : '';
};

/** A registration's data file as recorded in `dcterms:source`: leading `./` and `../` removed. */
const sourceFile = (file: string): string => file.replace(/^(?:\.\.?\/)+/, '');

/** The data files of a package's registrations, in registration order: its graph record's `dcterms:source`. */
export function packageSources(name: string): string[] {
  const files = (registrationsByPackage().get(name) ?? [])
    .filter((registration) => typeof registration.load === 'function')
    .flatMap((registration) => registration.files.map(sourceFile));
  return [...new Set(files)];
}

/**
 * Sync the ontology data of every registered package (or of `options.packages`) into `ds`
 * (default: the global router), one named graph per package; see the module doc.
 *
 * Per package: skipped when its record's hash matches (no write, so an unforked branch stays
 * unforked); otherwise its graph is created or replaced in one graph query. A package whose data
 * cannot be read is skipped with a warning (see `readPackageOntologies`). A store without graph
 * queries is refused in the `'package'` and shared modes.
 */
export async function syncOntologies(
  ds?: IDataset,
  options?: SyncOntologiesOptions,
): Promise<SyncOntologiesResult> {
  assertNoActiveCatalog();
  // Every registered package is read, also outside `packages`: the shared and default modes
  // rebuild from all of them, and the in-memory hierarchy needs every package.
  const data = await readPackageOntologies();
  // The same parse fills the in-memory hierarchy (what `loadOntologyHierarchy` does).
  setHierarchyFromPackages(data.packages);
  return syncParsedOntologies(ds, options, data);
}

/**
 * The sync of {@link syncOntologies} on packages already read (`readPackageOntologies`): `parsed`
 * and `unreadable` are the packages the run knows. The shared and default modes rebuild from
 * exactly these, so a caller that passes a subset makes that subset the graph's members. Sets no
 * hierarchy: the caller does, from every package. The routed sync (`shapes/syncTargets`) calls it
 * once per target dataset with that dataset's packages.
 */
export async function syncParsedOntologies(
  ds: IDataset | undefined,
  options: SyncOntologiesOptions | undefined,
  {packages: parsed, skipped: unreadable}: {packages: Map<string, PackageOntologyData>; skipped: string[]},
): Promise<SyncOntologiesResult> {
  assertNoActiveCatalog();
  const run: SyncRun = {
    ds,
    options,
    only: options?.packages ? new Set(options.packages) : undefined,
    parsed,
    unreadable,
    registered: new Set(registrationsByPackage().keys()),
  };
  const target = getGraphTargets().ontologyGraph;
  if (target === 'default') return syncDefaultMode(run);
  // A dataset class built against an older core has no graph queries.
  if (ds && typeof (ds as Partial<IDataset>).graphQuery !== 'function') throw noGraphQueries(target, ds);
  if (isSharedGraphTarget(target)) return syncSharedGraph(run, target);
  return syncGraphs(run);
}

/**
 * The error for a store without graph queries in the `'package'` or a shared mode: those modes
 * write named graphs, and there is no other way to keep the ontology in them.
 */
function noGraphQueries(mode: GraphTarget, ds?: IDataset): Error {
  const where = mode === 'package' ? "'package'" : `<${mode}>`;
  const store = ds?.constructor?.name ? ` ${ds.constructor.name}` : '';
  return new Error(
    `[syncOntologies] ontologyGraph is ${where}, but the store${store}${datasetLabel(ds)} has no graph ` +
      "queries (IDataset.graphQuery, which SparqlDataset has), so it cannot hold ontology graphs. " +
      "Use a store with graph queries, or ontologyGraph 'default'.",
  );
}

/** The README section a store that does not infer from the registered graphs is pointed to. */
const STORE_REQUIREMENTS = 'See "Store requirements" in @_linked/core\'s README.';

/**
 * Probe the store before the first package graph is written (once per dataset, cached), and warn
 * once when it does not infer from the registered graphs. The answer only drives that warning:
 * the sync writes package graphs on every store. Returns `'unsupported'` for a store that refuses
 * graph queries (the probe's are the first it is sent).
 */
async function probeBeforeWrite(ds?: IDataset): Promise<HierarchyInference | 'unsupported' | 'unknown'> {
  let inference: HierarchyInference;
  try {
    inference = await probeHierarchyInference(ds);
  } catch (error) {
    if (isGraphQueryError(error, 'unsupported-query-kind')) return 'unsupported';
    warnOnceForDataset(
      ds,
      `[syncOntologies] Could not measure which class hierarchy the store infers from ` +
        `(${(error as Error)?.message ?? error}); the ontology data is written into package graphs ` +
        'only, so a class-scoped read misses the instances of subclasses unless the store infers ' +
        `from those graphs. ${STORE_REQUIREMENTS}`,
    );
    return 'unknown';
  }
  if (inference !== 'named-graphs') {
    warnOnceForDataset(
      ds,
      '[syncOntologies] The store does not infer rdf:type from the graphs the registry marks ' +
        `feedsHierarchy (the probe answered '${inference}'): a class-scoped read misses the ` +
        `instances of subclasses. ${STORE_REQUIREMENTS}`,
    );
  }
  return inference;
}

/**
 * The sync on package graphs. The store is probed only when a package graph is about to be
 * written, so a sync with nothing to write sends no request beyond its reads.
 */
async function syncGraphs(run: SyncRun): Promise<SyncOntologiesResult> {
  const {ds, options, only} = run;
  const result: SyncOntologiesResult = {written: [], skipped: [], pruned: []};

  const recordByGraph = await readOntologyRecords(ds);
  const defaultState = await readDefaultModeState(ds);
  warnOtherModes('package', ds, {
    sharedGraphs: sharedRecords(recordByGraph),
    defaultGraphOntology: defaultState !== undefined,
  });

  const plan = [...run.parsed.keys()]
    .sort()
    .filter((name) => !only || only.has(name))
    .map((name) => {
      const data = run.parsed.get(name)!;
      const graph = OntologyGraph.iriFor(name);
      const hash = ontologyGraphHash(data.texts);
      const record = recordByGraph.get(graph);
      return {name, data, graph, hash, record, write: Boolean(options?.force) || record?.contentHash !== hash};
    });

  if (plan.some((p) => p.write) && (await probeBeforeWrite(ds)) === 'unsupported') {
    throw noGraphQueries('package', ds);
  }

  for (const name of run.unreadable) {
    if (!only || only.has(name)) result.skipped.push(name);
  }

  for (const {name, data, graph, hash, record, write} of plan) {
    if (!write) {
      result.skipped.push(name);
    } else {
      const content = {
        mediaType: 'application/n-triples' as const,
        text: await nTriplesFromTurtle(data.texts, data.sources),
      };
      const sources = packageSources(name);
      if (record) {
        await OntologyGraph.update(graph)
          .set({sources})
          .replaceContent(content, {contentHash: hash})
          .exec(ds);
      } else {
        await createPackageGraph(graph, name, sources, content, hash, ds);
      }
      result.written.push(name);
    }
  }

  if (options?.orphanScope === 'all' && !only) {
    const pruned = new Set<string>();
    for (const [graph, record] of [...recordByGraph].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      // A package's own graph only: a shared graph (another mode's) is never pruned here.
      if (!record.package || run.registered.has(record.package) || record.packageHashes.length) continue;
      await OntologyGraph.delete(graph).exec(ds);
      pruned.add(record.package);
    }
    result.pruned.push(...[...pruned].sort());
  }

  result.skipped.sort();
  return {...result, target: 'package'};
}

/**
 * Create a package's ontology graph that had no `OntologyGraph` record when the sync read the
 * registry. When the create is refused (`graph-exists`): another process created it meanwhile
 * (two apps booting at once), so it is replaced instead; or the graph holds triples without an
 * `OntologyGraph` record (an older tool's load, a record of another class), and since the
 * package's ontology graph is the sync's own, it is dropped and created again.
 */
async function createPackageGraph(
  graph: string,
  name: string,
  sources: string[],
  content: {mediaType: 'application/n-triples'; text: string},
  hash: string,
  ds?: IDataset,
): Promise<void> {
  await createOntologyGraph(graph, {package: name}, {sources}, content, hash, ds);
}

/**
 * Create an ontology graph the sync owns (a package's, or the shared one) with `fixed` plus `fields`
 * on its record; on `graph-exists`, replace it (`fields` set again), or drop and create it again
 * when it holds triples without an `OntologyGraph` record. See {@link createPackageGraph}.
 */
async function createOntologyGraph(
  graph: string,
  fixed: Record<string, unknown>,
  fields: Record<string, unknown>,
  content: {mediaType: 'application/n-triples'; text: string},
  hash: string,
  ds?: IDataset,
): Promise<void> {
  const create = () =>
    OntologyGraph.create({id: graph, ...fixed, ...fields} as {id: string; package: string})
      .withContent(content, {contentHash: hash})
      .exec(ds);
  try {
    await create();
    return;
  } catch (error) {
    if (!isGraphQueryError(error, 'graph-exists')) throw error;
  }
  try {
    await OntologyGraph.update(graph).set(fields).replaceContent(content, {contentHash: hash}).exec(ds);
  } catch (error) {
    if (!isGraphQueryError(error, 'graph-not-registered')) throw error;
    await NamedGraph.delete(graph).exec(ds);
    await create();
  }
}

/** What a shared ontology graph's hash covers before its parts; a new prefix rebuilds it once. */
export const SHARED_ONTOLOGY_GRAPH_HASH_PREFIX = 'linked-ontology-shared/1\n';

/**
 * The content hash of a shared ontology graph: SHA-256 (hex) of
 * {@link SHARED_ONTOLOGY_GRAPH_HASH_PREFIX} + one `"{package} {hash}"` line per package (sorted by
 * name), each hash the package's {@link ontologyGraphHash}.
 */
export function sharedOntologyGraphHash(parts: Array<{name: string; hash: string}>): string {
  return sha256Hex(SHARED_ONTOLOGY_GRAPH_HASH_PREFIX + packageHashLines(parts).join('\n'));
}

/** What the `'default'` mode's hash covers before its namespaces and parts. */
export const DEFAULT_GRAPH_ONTOLOGY_HASH_PREFIX = 'linked-ontology-default/1\n';

/**
 * The combined hash of the `'default'` mode: SHA-256 (hex) of
 * {@link DEFAULT_GRAPH_ONTOLOGY_HASH_PREFIX} + the swept namespaces (sorted, one per line), an
 * empty line, and one `"{package} {hash}"` line per package (sorted by name).
 */
export function defaultGraphOntologyHash(
  namespaces: string[],
  parts: Array<{name: string; hash: string}>,
): string {
  return sha256Hex(
    DEFAULT_GRAPH_ONTOLOGY_HASH_PREFIX +
      [...namespaces].sort().join('\n') +
      '\n\n' +
      packageHashLines(parts).join('\n'),
  );
}

const packageHashLines = (parts: Array<{name: string; hash: string}>): string[] =>
  [...parts].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => `${p.name} ${p.hash}`);

/** Every package of the run, sorted, and each one's {@link ontologyGraphHash}. */
const packageParts = (run: SyncRun) =>
  [...run.parsed.keys()].sort().map((name) => ({name, hash: ontologyGraphHash(run.parsed.get(name)!.texts)}));

/** `names` limited to `options.packages` (what a result reports), sorted. */
const reported = (run: SyncRun, names: string[]): string[] =>
  names.filter((name) => !run.only || run.only.has(name)).sort();

/**
 * A run that must not rebuild a whole ontology (shared graph or default graph) because a package's
 * data could not be read: a rebuild without it would drop its terms. Warns and skips everything.
 */
function skipUnreadable(run: SyncRun, where: string, target: GraphTarget): SyncOntologiesResult {
  console.warn(
    `[syncOntologies] ${where} is not rebuilt: the ontology data of ${run.unreadable.join(', ')} ` +
      'could not be read, and a rebuild without it would drop its terms. Fix the package and sync again.',
  );
  return {
    written: [],
    skipped: reported(run, [...run.parsed.keys(), ...run.unreadable]),
    pruned: [],
    target,
  };
}

/**
 * The shared mode (`ontologyGraph` is an IRI): every package's ontology data in the one
 * `OntologyGraph` at `graph` (feeding the hierarchy), rebuilt whole in one graph query when the
 * combined hash ({@link sharedOntologyGraphHash}) differs from the record's. The record lists
 * every package's hash (`packageHashes`) and its data files (`sources`, `{package}/{file}`). The
 * probe runs before that write, as in the package mode. Other modes' data is reported, never moved.
 */
async function syncSharedGraph(run: SyncRun, graph: string): Promise<SyncOntologiesResult> {
  const {ds, options} = run;
  const records = await readOntologyRecords(ds);
  const defaultState = await readDefaultModeState(ds);
  warnOtherModes(graph, ds, {
    packageGraphs: packageRecords(records),
    sharedGraphs: sharedRecords(records, graph),
    defaultGraphOntology: defaultState !== undefined,
  });
  const names = [...run.parsed.keys()].sort();
  if (run.unreadable.length) return skipUnreadable(run, `The shared ontology graph <${graph}>`, graph);

  const parts = packageParts(run);
  const hash = sharedOntologyGraphHash(parts);
  const record = records.get(graph);
  if (!options?.force && record?.contentHash === hash) {
    return {written: [], skipped: reported(run, names), pruned: [], target: graph};
  }
  if ((await probeBeforeWrite(ds)) === 'unsupported') throw noGraphQueries(graph, ds);
  const content = {
    mediaType: 'application/n-triples' as const,
    text: await nTriplesFromTurtle(
      names.flatMap((name) => run.parsed.get(name)!.texts),
      names.flatMap((name) => run.parsed.get(name)!.sources),
    ),
  };
  const fields = {
    sources: names.flatMap((name) => packageSources(name).map((file) => `${name}/${file}`)),
    packageHashes: packageHashLines(parts),
  };
  if (record) {
    await OntologyGraph.update(graph).set(fields).replaceContent(content, {contentHash: hash}).exec(ds);
  } else {
    await createOntologyGraph(graph, {}, fields, content, hash, ds);
  }
  const pruned = (record?.packageHashes ?? [])
    .map((line) => line.split(' ')[0])
    .filter((name) => name && !run.parsed.has(name) && !run.unreadable.includes(name));
  return {written: reported(run, names), skipped: [], pruned: [...new Set(pruned)].sort(), target: graph};
}

/**
 * The namespaces the `'default'` mode sweeps: each registered ontology with data of the run's
 * packages (`ns('')`), sorted. Throws when one would sweep more than ontology terms: one that is
 * empty, that the store's data root starts with (the app's own data), or that a registered
 * shape's IRI starts with (the shapes share the default graph in that mode).
 */
function defaultModeNamespaces(run: SyncRun, target: IDataset): string[] {
  const namespaces = new Set<string>();
  for (const name of run.parsed.keys()) {
    for (const registration of registrationsByPackage().get(name) ?? []) {
      if (typeof registration.load !== 'function') continue;
      namespaces.add(registration.ns('').id);
    }
  }
  const root = `${dataRootOf(target) ?? LINKED_DATA_ROOT.replace(/\/+$/, '')}/`;
  const shapeIris = [...getAllShapeClasses().keys()];
  for (const ns of namespaces) {
    const why = !ns
      ? 'it is empty'
      : !/[/#]$/.test(ns)
        ? 'it does not end in "/" or "#", so it would match other IRIs that start the same way'
      : root.startsWith(ns)
        ? `the data root <${root}> lies inside it`
        : shapeIris.some((iri) => iri.startsWith(ns))
          ? `the shape <${shapeIris.find((iri) => iri.startsWith(ns))}> lies inside it`
          : undefined;
    if (why) {
      throw new Error(
        `[syncOntologies] ontologyGraph 'default' replaces every subject in a package's ontology ` +
          `namespace, and the namespace <${ns}> would reach more than ontology terms (${why}). ` +
          "Give the ontology a namespace of its own, or use 'package' or a shared graph IRI.",
      );
    }
  }
  return [...namespaces].sort();
}

/**
 * The `'default'` mode: the whole ontology of every package in the default graph. When the
 * combined hash ({@link defaultGraphOntologyHash}) differs from the one on
 * {@link DEFAULT_GRAPH_ONTOLOGY_NODE}, one update (`IDataset.replaceDefaultGraphTerms`) deletes
 * every package-owned term (each subject in a package's ontology namespace, and each subject of a
 * package's current Turtle, with all its outgoing triples and the blank nodes under them) and
 * inserts every package's data and the new hash. Subjects outside that set are never touched. An
 * unchanged hash writes nothing and probes nothing. Other modes' data is reported, never moved.
 */
async function syncDefaultMode(run: SyncRun): Promise<SyncOntologiesResult> {
  const {ds, options} = run;
  const target = ds ?? (LinkedStorage.getDefaultDataset() as IDataset | undefined);
  if (!target || typeof target.replaceDefaultGraphTerms !== 'function') {
    throw new Error(
      `[syncOntologies] ontologyGraph is 'default', but the store${target ? ` ${target.constructor?.name ?? ''}` : ''} ` +
        'cannot replace default-graph terms (IDataset.replaceDefaultGraphTerms, which SparqlDataset ' +
        "has). Use 'package' or a shared graph IRI for this store.",
    );
  }
  const defaultState = await readDefaultModeState(ds);
  let records = new Map<string, OntologyRecord>();
  try {
    records = await readOntologyRecords(ds);
  } catch {
    // A store without a graph registry holds no other mode's graphs.
  }
  warnOtherModes('default', ds, {
    packageGraphs: packageRecords(records),
    sharedGraphs: sharedRecords(records),
  });
  const names = [...run.parsed.keys()].sort();
  if (run.unreadable.length) return skipUnreadable(run, 'The ontology in the default graph', 'default');

  const namespaces = defaultModeNamespaces(run, target);
  const hash = defaultGraphOntologyHash(namespaces, packageParts(run));
  if (!options?.force && defaultState?.hash === hash) {
    return {written: [], skipped: reported(run, names), pruned: [], target: 'default'};
  }

  const lines = new Set<string>();
  const subjects = new Set<string>([DEFAULT_GRAPH_ONTOLOGY_NODE]);
  for (const [i, name] of names.entries()) {
    const data = run.parsed.get(name)!;
    const terms = await defaultGraphTermsFromTurtle(data.texts, data.sources, `p${i}_`);
    if (terms.unanchoredBlankNodes > 0) {
      throw new Error(
        `[syncOntologies] The ontology data of ${name} has ${terms.unanchoredBlankNodes} blank ` +
          "node(s) that no IRI subject links to; ontologyGraph 'default' can only replace a blank " +
          'node through the term it belongs to. Give it an IRI, or use another mode.',
      );
    }
    if (terms.blankDepth > DEFAULT_GRAPH_TERMS_DEPTH) {
      throw new Error(
        `[syncOntologies] The ontology data of ${name} nests blank nodes ${terms.blankDepth} steps ` +
          `deep; ontologyGraph 'default' replaces at most ${DEFAULT_GRAPH_TERMS_DEPTH}.`,
      );
    }
    for (const line of terms.nTriples.split('\n')) if (line) lines.add(line);
    for (const subject of terms.subjects) {
      if (!namespaces.some((ns) => subject.startsWith(ns))) subjects.add(subject);
    }
  }
  lines.add(`<${DEFAULT_GRAPH_ONTOLOGY_NODE}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${OntologySync.targetClass.id}> .`);
  lines.add(`<${DEFAULT_GRAPH_ONTOLOGY_NODE}> <${coreOntology.ontologyHash.id}> "${hash}" .`);

  try {
    if (!(await probeDefaultGraphInference(ds))) {
      warnOnceForDataset(
        ds,
        "[syncOntologies] ontologyGraph is 'default', but the store does not infer rdf:type from " +
          'the default graph\'s rdfs:subClassOf: a class-scoped read misses the instances of ' +
          `subclasses. ${STORE_REQUIREMENTS}`,
      );
    }
  } catch (error) {
    warnOnceForDataset(
      ds,
      `[syncOntologies] Could not measure whether the store infers from the default graph ` +
        `(${(error as Error)?.message ?? error}). ${STORE_REQUIREMENTS}`,
    );
  }
  await target.replaceDefaultGraphTerms({
    namespaces,
    subjects: [...subjects].sort(),
    insert: [...lines].join('\n') + '\n',
  });
  return {written: reported(run, names), skipped: [], pruned: [], target: 'default'};
}
