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
 * package's graph is written, the class hierarchy an earlier sync kept in the default graph for
 * that package (its `OntologySync` node's lines) is removed there, then the node; hand-written
 * default-graph axioms stay.
 *
 * A store without graph queries (`unsupported-query-kind`) gets the earlier default-graph sync:
 * each package's `rdfs:subClassOf` triples diffed into the default graph against an
 * `OntologySync` node (hash `linked-ontology-sync/1\n` + the lines).
 *
 * Before anything is written, the store is probed once per dataset (`hierarchyProbe.ts`) for the
 * hierarchy it infers from, and the move out of the default graph happens only when it is the
 * registered graphs':
 * - `'named-graphs'`: package graphs, and the default-graph hierarchy is removed (above).
 * - `'default-graph'`: the default-graph sync only, as for a store without graph queries; one
 *   warning.
 * - `'none'`: package graphs and the default-graph sync both (the hierarchy stays in the default
 *   graph too); one warning that class-scoped reads miss subclass instances.
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
import {OntologyGraph} from '../shapes/NamedGraph.js';
import {isGraphQueryError} from '../queries/graphQuery.js';
import {probeHierarchyInference, type HierarchyInference} from './hierarchyProbe.js';
import {nTriplesFromTurtle, RDFS_SUBCLASSOF, type HierarchyTriple} from './hierarchy.js';
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
  /** Packages no longer registered whose graph or hierarchy was removed (`orphanScope: 'all'`). */
  pruned: string[];
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

/** Every `OntologySync` node in `ds`, by package name. */
async function readSyncNodes(ds?: IDataset): Promise<Map<string, StoredNode>> {
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
  const stored = new Map<string, StoredNode>();
  for (const row of rows) {
    if (!row || typeof row.packageName !== 'string') continue;
    stored.set(row.packageName, {
      hash: typeof row.ontologyHash === 'string' ? row.ontologyHash : undefined,
      lines: new Set(splitLines(typeof row.ontologyTriples === 'string' ? row.ontologyTriples : '')),
    });
  }
  return stored;
}

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
 * Per package: skipped when its record's hash matches (no write at all, so an unforked branch
 * stays unforked); otherwise its graph is created or replaced in one graph query, then what an
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
  // A dataset class built against an older core has no graph queries.
  if (ds && typeof (ds as Partial<IDataset>).graphQuery !== 'function') {
    return syncDefaultGraph(run);
  }
  let inference: HierarchyInference;
  try {
    inference = await probeHierarchyInference(ds);
  } catch (error) {
    // A store either runs graph queries or refuses the first one (the probe's), before anything
    // was written.
    if (isGraphQueryError(error, 'unsupported-query-kind')) return syncDefaultGraph(run);
    warnOnce(
      ds,
      `[syncOntologies] Could not measure which class hierarchy the store infers from ` +
        `(${(error as Error)?.message ?? error}); the hierarchy stays in the default graph as ` +
        'well as in the package graphs.',
    );
    inference = 'none';
  }
  if (inference === 'default-graph') {
    warnOnce(
      ds,
      '[syncOntologies] The store infers classes only from the default graph, not from the ' +
        "graphs the registry marks feedsHierarchy: the class hierarchy stays in the default " +
        'graph and the ontology data is not moved into package graphs. See "Store requirements" ' +
        "in @_linked/core's README.",
    );
    return syncDefaultGraph(run);
  }
  if (inference === 'none') {
    warnOnce(
      ds,
      '[syncOntologies] The store does not infer rdf:type through rdfs:subClassOf: a read of a ' +
        "class will not return its subclasses' instances. The ontology data is written into " +
        'package graphs and the class hierarchy kept in the default graph as well. See "Store ' +
        `requirements" in @_linked/core's README.`,
    );
  }
  const keepDefaultGraph = inference !== 'named-graphs';
  const graphsResult = await syncGraphs(run, keepDefaultGraph);
  if (!keepDefaultGraph) return graphsResult;
  return mergeResults(graphsResult, await syncDefaultGraph(run));
}

/** The results of the two syncs of one run: a package written by either is written. */
function mergeResults(a: SyncOntologiesResult, b: SyncOntologiesResult): SyncOntologiesResult {
  const written = new Set([...a.written, ...b.written]);
  const skipped = new Set([...a.skipped, ...b.skipped].filter((name) => !written.has(name)));
  return {
    written: [...written].sort(),
    skipped: [...skipped].sort(),
    pruned: [...new Set([...a.pruned, ...b.pruned])].sort(),
  };
}

const warnedDatasets = new WeakSet<object>();
const WARNED_GLOBAL = {};

/** One warning per dataset per process: the probe's answer is cached as long. */
function warnOnce(ds: IDataset | undefined, message: string): void {
  const key = ds ?? WARNED_GLOBAL;
  if (warnedDatasets.has(key)) return;
  warnedDatasets.add(key);
  console.warn(message);
}

/**
 * The sync on package graphs. With `keepDefaultGraph` (a store that does not infer from the
 * registered graphs) what the default-graph sync kept stays; the caller runs that sync as well.
 */
async function syncGraphs(run: SyncRun, keepDefaultGraph = false): Promise<SyncOntologiesResult> {
  const {ds, options, only} = run;
  const result: SyncOntologiesResult = {written: [], skipped: [], pruned: []};

  const records =
    ((await OntologyGraph.select((r) => [r.package, r.contentHash]).exec(ds)) as Array<{
      id: string;
      package?: unknown;
      contentHash?: unknown;
    }> | null) ?? [];
  const recordByGraph = new Map<string, {package?: string; contentHash?: string}>();
  for (const row of records) {
    if (!row?.id) continue;
    recordByGraph.set(row.id, {
      package: typeof row.package === 'string' ? row.package : undefined,
      contentHash: typeof row.contentHash === 'string' ? row.contentHash : undefined,
    });
  }
  const nodes = await readSyncNodes(ds);

  for (const name of run.unreadable) {
    if (!only || only.has(name)) result.skipped.push(name);
  }

  for (const name of [...run.parsed.keys()].sort()) {
    if (only && !only.has(name)) continue;
    const data = run.parsed.get(name)!;
    const graph = OntologyGraph.iriFor(name);
    const hash = ontologyGraphHash(data.texts);
    const record = recordByGraph.get(graph);
    if (!options?.force && record?.contentHash === hash) {
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
        await OntologyGraph.create({id: graph, package: name, sources})
          .withContent(content, {contentHash: hash})
          .exec(ds);
      }
      result.written.push(name);
    }
    // Written or unchanged, the package's graph holds its data: what the default-graph sync kept
    // for it goes (also finishing a removal an earlier run did not complete), once the store is
    // known to infer from the package graphs.
    if (!keepDefaultGraph) await removeSyncNode(name, nodes, ds);
  }

  if (options?.orphanScope === 'all' && !only) {
    const pruned = new Set<string>();
    for (const [graph, record] of [...recordByGraph].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!record.package || run.registered.has(record.package)) continue;
      await OntologyGraph.delete(graph).exec(ds);
      pruned.add(record.package);
    }
    // The default-graph sync that follows prunes its own orphans.
    for (const name of keepDefaultGraph ? [] : [...nodes.keys()].sort()) {
      if (run.registered.has(name)) continue;
      await removeSyncNode(name, nodes, ds);
      pruned.add(name);
    }
    result.pruned.push(...[...pruned].sort());
  }

  result.skipped.sort();
  return result;
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
