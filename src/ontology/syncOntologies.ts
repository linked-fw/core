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
 * changed or new one is replaced whole in one graph query (the body as N-Triples). After a
 * package's graph is written or found unchanged, the class hierarchy an earlier sync kept in the default graph for
 * that package (its `OntologySync` node's lines) is removed there, then the node; hand-written
 * default-graph axioms stay.
 *
 * A store without graph queries (`unsupported-query-kind`) gets the earlier default-graph sync:
 * each package's `rdfs:subClassOf` triples diffed into the default graph against an
 * `OntologySync` node (hash `linked-ontology-sync/1\n` + the lines).
 *
 * Before the first package graph is written, the store is probed once per dataset
 * (`hierarchyProbe.ts`) for the hierarchy it infers from; a sync with nothing to write probes
 * nothing, so with no default-graph hierarchy left from an earlier sync it sends no request
 * beyond its reads (an unforked branch stays unforked). Removing such a leftover is a write,
 * made once. The
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
import {DeleteBuilder} from '../queries/DeleteBuilder.js';
import {assertNoActiveCatalog} from '../utils/ShapeClass.js';
import {sha256Hex} from '../utils/sha256.js';
import {OntologySync} from '../shapes/OntologySync.js';
import {ClassAxioms} from '../shapes/ClassAxioms.js';
import {NamedGraph, OntologyGraph} from '../shapes/NamedGraph.js';
import {isGraphQueryError} from '../queries/graphQuery.js';
import {
  probeDefaultGraphInference,
  probeHierarchyInference,
  warnOnceForDataset,
  type HierarchyInference,
} from './hierarchyProbe.js';
import {
  defaultGraphTermsFromTurtle,
  nTriplesFromTurtle,
  RDFS_SUBCLASSOF,
  type HierarchyTriple,
} from './hierarchy.js';
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
  /**
   * Write every package, even when its stored hash matches: its graph is replaced whole. On a
   * store without graph queries, every triple the package lists is inserted again (and the
   * stored lines it no longer lists are removed), which repairs a dataset whose triples were
   * removed while its sync nodes stayed.
   */
  force?: boolean;
  /** Only these packages (npm names). */
  packages?: string[];
  /**
   * `'all'` (without `packages`): drop the ontology graph of every package that is no longer
   * registered, and remove what an earlier sync kept in the default graph for it. Default
   * `'none'`.
   */
  orphanScope?: 'none' | 'all';
}

export interface SyncOntologiesResult {
  /** Packages whose ontology graph (or, without graph queries, hierarchy) was written. */
  written: string[];
  /** Packages left as they were: unchanged, or their data could not be read. */
  skipped: string[];
  /**
   * Packages no longer registered whose graph or hierarchy was removed (`orphanScope: 'all'`); in
   * a shared graph, the packages its record listed that the rebuild left out.
   */
  pruned: string[];
  /**
   * Where the run wrote: the global `ontologyGraph` target (`'package'`, `'default'` or the
   * shared graph's IRI). A store without graph queries in `'package'` or shared mode got the
   * default-graph hierarchy sync instead, reported as `'package'` or the IRI with `fallback` set.
   */
  target?: GraphTarget;
  /** Set when a store without graph queries got the default-graph hierarchy sync instead. */
  fallback?: true;
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

/**
 * The sync node of a package (the default-graph sync of stores without graph queries).
 * @deprecated Used by that fallback and by the removal of its data; package graphs need none.
 */
export function ontologySyncNodeIri(packageName: string): string {
  return `https://linked.cm/ont/core/ontologySync/${encodeURIComponent(packageName)}`;
}

/** One kept triple as an N-Triples line. @deprecated The default-graph fallback's form. */
export const toNTriplesLine = ({s, o}: HierarchyTriple): string =>
  `<${s}> <${RDFS_SUBCLASSOF}> <${o}> .`;

const LINE = /^<([^>]*)> <[^>]*> <([^>]*)> \.$/;
const fromNTriplesLine = (line: string): HierarchyTriple | undefined => {
  const match = LINE.exec(line);
  return match ? {s: match[1], o: match[2]} : undefined;
};

/**
 * The stored form of a package's triples: sorted N-Triples lines joined with `\n`, no trailing newline.
 * @deprecated The default-graph fallback's form.
 */
export function ontologyTriplesText(triples: HierarchyTriple[]): string {
  return [...new Set(triples.map(toNTriplesLine))].sort().join('\n');
}

/**
 * The content hash of a package's stored triples (`linked-ontology-sync/1\n` + the lines).
 * @deprecated The default-graph fallback's hash; package graphs use {@link ontologyGraphHash}.
 */
export function ontologySyncHash(ontologyTriples: string): string {
  return sha256Hex(`linked-ontology-sync/1\n${ontologyTriples}`);
}

const splitLines = (text: string | undefined): string[] =>
  text ? text.split('\n').filter((line) => line.length > 0) : [];

type Exec = {exec: (target?: IDataset) => Promise<unknown>};

/** Runs `tasks` with at most `limit` in flight; rejects with the first failure. */
async function runBounded(tasks: Array<() => Promise<unknown>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, tasks.length)}, worker));
}

/**
 * The per-class updates that turn the stored lines `old` into `next`, never removing a line in
 * `keep`: one update per subject class whose superclass set changes. With `addAll`, every line of
 * `next` is added, also those already in `old` (the dataset may have lost them).
 */
function diffUpdates(
  old: Set<string>,
  next: Set<string>,
  keep: Set<string>,
  ds?: IDataset,
  addAll = false,
): Array<() => Promise<unknown>> {
  const bySubject = new Map<string, {add: string[]; remove: string[]}>();
  const entry = (s: string) => {
    let e = bySubject.get(s);
    if (!e) bySubject.set(s, (e = {add: [], remove: []}));
    return e;
  };
  for (const line of next) {
    if (!addAll && old.has(line)) continue;
    const t = fromNTriplesLine(line);
    if (t) entry(t.s).add.push(t.o);
  }
  for (const line of old) {
    if (next.has(line) || keep.has(line)) continue;
    const t = fromNTriplesLine(line);
    if (t) entry(t.s).remove.push(t.o);
  }
  return [...bySubject.keys()].sort().map((s) => {
    const {add, remove} = bySubject.get(s)!;
    const change: {add?: {id: string}[]; remove?: {id: string}[]} = {};
    if (add.length) change.add = add.sort().map((id) => ({id}));
    if (remove.length) change.remove = remove.sort().map((id) => ({id}));
    return () =>
      (ClassAxioms.update({subClassOf: change} as never).for({id: s}) as unknown as Exec).exec(ds);
  });
}

/** What one run knows before it writes: the parsed packages and the scope. */
interface SyncRun {
  ds?: IDataset;
  options?: SyncOntologiesOptions;
  only?: Set<string>;
  parsed: Map<string, PackageOntologyData>;
  unreadable: string[];
  registered: Set<string>;
}

/** A plan-070 sync node as read. */
type StoredNode = {hash?: string; lines: Set<string>};

/**
 * The node the `'default'` mode records its combined hash on, in the default graph: an
 * `OntologySync` without a package name. Outside every package namespace, and replaced in the same
 * update as the terms.
 */
export const DEFAULT_GRAPH_ONTOLOGY_NODE = 'https://linked.cm/pkg/core/ontology-sync/default-graph';

/** Every `OntologySync` node in `ds`, by package name. */
async function readSyncNodes(ds?: IDataset): Promise<Map<string, StoredNode>> {
  return (await readSyncState(ds)).nodes;
}

/**
 * The `OntologySync` nodes of `ds` in one read: the default-graph sync's (by package name) and the
 * `'default'` mode's node (its hash, or `undefined` when there is none).
 */
async function readSyncState(
  ds?: IDataset,
): Promise<{nodes: Map<string, StoredNode>; defaultState?: {hash?: string}}> {
  const rows =
    ((await (QueryBuilder.from(OntologySync).select([
      'packageName',
      'ontologyHash',
      'ontologyTriples',
    ]) as unknown as Exec).exec(ds)) as Array<{
      id: string;
      packageName?: unknown;
      ontologyHash?: unknown;
      ontologyTriples?: unknown;
    }> | null) ?? [];
  const nodes = new Map<string, StoredNode>();
  let defaultState: {hash?: string} | undefined;
  for (const row of rows) {
    if (row?.id === DEFAULT_GRAPH_ONTOLOGY_NODE) {
      defaultState = {hash: typeof row.ontologyHash === 'string' ? row.ontologyHash : undefined};
      continue;
    }
    if (!row || typeof row.packageName !== 'string') continue;
    nodes.set(row.packageName, {
      hash: typeof row.ontologyHash === 'string' ? row.ontologyHash : undefined,
      lines: new Set(splitLines(typeof row.ontologyTriples === 'string' ? row.ontologyTriples : '')),
    });
  }
  return {nodes, defaultState};
}

/** An `OntologyGraph` record as the sync reads it. */
type OntologyRecord = {package?: string; contentHash?: string; packageHashes: string[]};

/** Every `OntologyGraph` record of `ds`, by graph, in one read. */
async function readOntologyRecords(ds?: IDataset): Promise<Map<string, OntologyRecord>> {
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
  defaultGraphHierarchy?: string[];
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
  if (found.defaultGraphHierarchy?.length) {
    parts.push(`a default-graph class hierarchy of ${found.defaultGraphHierarchy.join(', ')} (the earlier default-graph sync)`);
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

/**
 * Remove what the default-graph sync kept for `name`: every line its node lists that no node in
 * `remaining` (other than its own) lists, then the node. `remaining` loses `name`.
 */
async function removeSyncNode(
  name: string,
  remaining: Map<string, StoredNode>,
  ds?: IDataset,
): Promise<void> {
  const node = remaining.get(name);
  if (!node) return;
  const keep = new Set<string>();
  for (const [other, entry] of remaining) {
    if (other !== name) entry.lines.forEach((line) => keep.add(line));
  }
  await runBounded(diffUpdates(node.lines, new Set(), keep, ds), 8);
  await (DeleteBuilder.from(OntologySync, {id: ontologySyncNodeIri(name)}) as unknown as Exec).exec(ds);
  remaining.delete(name);
}

/** A registration's data file as recorded in `dcterms:source`: leading `./` and `../` removed. */
const sourceFile = (file: string): string => file.replace(/^(?:\.\.?\/)+/, '');

/** The data files of a package's registrations, in registration order. */
function packageSources(name: string): string[] {
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
 * unforked, unless an earlier sync left default-graph lines for it to remove); otherwise its graph is created or replaced in one graph query, then what an
 * earlier sync kept for it in the default graph is removed. A package whose data cannot be read
 * is skipped with a warning (see `readPackageOntologies`). A store without graph queries gets the
 * earlier default-graph sync.
 */
export async function syncOntologies(
  ds?: IDataset,
  options?: SyncOntologiesOptions,
): Promise<SyncOntologiesResult> {
  assertNoActiveCatalog();
  // Every registered package is read, also outside `packages`: the default-graph sync needs
  // their triples to decide what a changed package may remove.
  const {packages: parsed, skipped: unreadable} = await readPackageOntologies();
  // The same parse fills the in-memory hierarchy (what `loadOntologyHierarchy` does).
  setHierarchyFromPackages(parsed);
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
  if (ds && typeof (ds as Partial<IDataset>).graphQuery !== 'function') {
    return {...(await syncDefaultGraph(run)), target, fallback: true};
  }
  if (isSharedGraphTarget(target)) return syncSharedGraph(run, target);
  return syncGraphs(run);
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
 * written, so a sync with nothing to write sends no request beyond its reads. On every probe
 * answer, what an earlier sync kept in the default graph for a package goes.
 */
async function syncGraphs(run: SyncRun): Promise<SyncOntologiesResult> {
  const {ds, options, only} = run;
  const result: SyncOntologiesResult = {written: [], skipped: [], pruned: []};

  const recordByGraph = await readOntologyRecords(ds);
  const {nodes, defaultState} = await readSyncState(ds);
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
    // Nothing was written yet: the store gets the default-graph sync instead.
    return {...(await syncDefaultGraph(run)), target: 'package', fallback: true};
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
    // Written or unchanged, the package's graph holds its data: what an earlier sync kept for it
    // in the default graph goes (also finishing a removal an earlier run did not complete).
    await removeSyncNode(name, nodes, ds);
  }

  if (options?.orphanScope === 'all' && !only) {
    const pruned = new Set<string>();
    for (const [graph, record] of [...recordByGraph].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      // A package's own graph only: a shared graph (another mode's) is never pruned here.
      if (!record.package || run.registered.has(record.package) || record.packageHashes.length) continue;
      await OntologyGraph.delete(graph).exec(ds);
      pruned.add(record.package);
    }
    for (const name of [...nodes.keys()].sort()) {
      if (run.registered.has(name)) continue;
      await removeSyncNode(name, nodes, ds);
      pruned.add(name);
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

/**
 * The default-graph sync, for a store without graph queries: each package's class hierarchy (its
 * `rdfs:subClassOf` triples) diffed into the default graph.
 *
 * Per package: skipped when the stored hash matches (no write at all); otherwise one update per
 * subject class whose superclass set changed, at most eight at a time, then the sync node, last,
 * so an interrupted sync is redone by the next one. The triples a changed package no longer
 * lists are removed unless another package lists them. Only triples a package's sync node lists
 * are ever removed: a triple no stored node lists (written by hand, or by an earlier tool) stays.
 * `force` inserts every listed triple again, repairing a dataset that lost them.
 */
async function syncDefaultGraph(run: SyncRun): Promise<SyncOntologiesResult> {
  const {ds, options, only} = run;
  const result: SyncOntologiesResult = {written: [], skipped: [], pruned: []};
  const nextLines = new Map<string, Set<string>>();
  for (const [name, data] of run.parsed) {
    nextLines.set(name, new Set(splitLines(ontologyTriplesText(data.triples))));
  }
  const stored = await readSyncNodes(ds);

  /** Every line another package lists: its new lines when readable, else its stored ones. */
  const listedElsewhere = (pkg: string, exclude: Set<string> = new Set()): Set<string> => {
    const lines = new Set<string>();
    const names = new Set([...nextLines.keys(), ...stored.keys()]);
    for (const other of names) {
      if (other === pkg || exclude.has(other)) continue;
      const source = nextLines.get(other) ?? stored.get(other)?.lines;
      source?.forEach((line) => lines.add(line));
    }
    return lines;
  };

  for (const name of run.unreadable) {
    if (!only || only.has(name)) result.skipped.push(name);
  }

  for (const name of [...nextLines.keys()].sort()) {
    if (only && !only.has(name)) continue;
    const next = nextLines.get(name)!;
    const text = [...next].join('\n');
    const hash = ontologySyncHash(text);
    const previous = stored.get(name);
    if (!options?.force && previous?.hash === hash) {
      result.skipped.push(name);
      continue;
    }
    // `force` adds against an empty stored set, so lines the dataset lost come back; it still
    // removes the stored lines the package no longer lists.
    const updates = diffUpdates(
      previous?.lines ?? new Set(),
      next,
      listedElsewhere(name),
      ds,
      options?.force === true,
    );
    await runBounded(updates, 8);
    await (OntologySync.upsert({
      packageName: name,
      ontologyHash: hash,
      ontologyTriples: text,
    } as never).for({id: ontologySyncNodeIri(name)}) as unknown as Exec).exec(ds);
    result.written.push(name);
  }

  if (options?.orphanScope === 'all' && !only) {
    const orphans = new Set([...stored.keys()].filter((name) => !run.registered.has(name)));
    for (const name of [...orphans].sort()) {
      // Other orphans are pruned in the same run, so their lines do not keep this one's.
      const keep = listedElsewhere(name, orphans);
      const updates = diffUpdates(stored.get(name)!.lines, new Set(), keep, ds);
      await runBounded(updates, 8);
      await (DeleteBuilder.from(OntologySync, {id: ontologySyncNodeIri(name)}) as unknown as Exec).exec(ds);
      result.pruned.push(name);
    }
  }

  result.skipped.sort();
  return result;
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
  const {nodes, defaultState} = await readSyncState(ds);
  warnOtherModes(graph, ds, {
    packageGraphs: packageRecords(records),
    sharedGraphs: sharedRecords(records, graph),
    defaultGraphOntology: defaultState !== undefined,
    defaultGraphHierarchy: [...nodes.keys()].sort(),
  });
  const names = [...run.parsed.keys()].sort();
  if (run.unreadable.length) return skipUnreadable(run, `The shared ontology graph <${graph}>`, graph);

  const parts = packageParts(run);
  const hash = sharedOntologyGraphHash(parts);
  const record = records.get(graph);
  if (!options?.force && record?.contentHash === hash) {
    return {written: [], skipped: reported(run, names), pruned: [], target: graph};
  }
  if ((await probeBeforeWrite(ds)) === 'unsupported') {
    return {...(await syncDefaultGraph(run)), target: graph, fallback: true};
  }
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
  const {nodes, defaultState} = await readSyncState(ds);
  let records = new Map<string, OntologyRecord>();
  try {
    records = await readOntologyRecords(ds);
  } catch {
    // A store without a graph registry holds no other mode's graphs.
  }
  // The earlier default-graph sync's nodes lie in core's ontology namespace: a rebuild replaces
  // them with the rest of core's terms, so they are named here before that happens.
  warnOtherModes('default', ds, {
    packageGraphs: packageRecords(records),
    sharedGraphs: sharedRecords(records),
    defaultGraphHierarchy: [...nodes.keys()].sort(),
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
