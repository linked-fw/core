/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The ontology sync: writes each registered package's class hierarchy (its `rdfs:subClassOf`
 * triples) into a dataset, so the store's inference sees every class the app's packages define.
 *
 * Skipped by a content hash per package, stored with the triples on a sync node
 * (`OntologySync`, one per package): an unchanged package writes nothing, and a changed one is
 * replaced by a diff — the triples it no longer lists are removed unless another package lists
 * them, the new ones are added. Triples a dataset held before a package's first sync are never
 * removed. Everything goes through Linked Queries, in the default graph.
 *
 * Runs at app boot and through the app's control route, before shape sync. Server only (the
 * hierarchy reader loads `n3`).
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
import {RDFS_SUBCLASSOF, type HierarchyTriple} from './hierarchy.js';
import {readPackageOntologies, registrationsByPackage} from './registryData.js';

export interface SyncOntologiesOptions {
  /** Write every package, even when its stored hash matches. */
  force?: boolean;
  /** Only these packages (npm names). */
  packages?: string[];
  /**
   * `'all'` (without `packages`): remove the hierarchy of every package that has a sync node but
   * is no longer registered, and its node. Default `'none'`.
   */
  orphanScope?: 'none' | 'all';
}

export interface SyncOntologiesResult {
  /** Packages whose hierarchy was written. */
  written: string[];
  /** Packages left as they were: unchanged, or their data could not be read. */
  skipped: string[];
  /** Packages no longer registered whose hierarchy was removed (`orphanScope: 'all'`). */
  pruned: string[];
}

/** The sync node of a package. */
export function ontologySyncNodeIri(packageName: string): string {
  return `https://linked.cm/ont/core/ontologySync/${encodeURIComponent(packageName)}`;
}

/** One kept triple as an N-Triples line. */
export const toNTriplesLine = ({s, o}: HierarchyTriple): string =>
  `<${s}> <${RDFS_SUBCLASSOF}> <${o}> .`;

const LINE = /^<([^>]*)> <[^>]*> <([^>]*)> \.$/;
const fromNTriplesLine = (line: string): HierarchyTriple | undefined => {
  const match = LINE.exec(line);
  return match ? {s: match[1], o: match[2]} : undefined;
};

/** The stored form of a package's triples: sorted N-Triples lines joined with `\n`, no trailing newline. */
export function ontologyTriplesText(triples: HierarchyTriple[]): string {
  return [...new Set(triples.map(toNTriplesLine))].sort().join('\n');
}

/** The content hash of a package's stored triples. */
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
 * `keep`: one update per subject class whose superclass set changes.
 */
function diffUpdates(
  old: Set<string>,
  next: Set<string>,
  keep: Set<string>,
  ds?: IDataset,
): Array<() => Promise<unknown>> {
  const bySubject = new Map<string, {add: string[]; remove: string[]}>();
  const entry = (s: string) => {
    let e = bySubject.get(s);
    if (!e) bySubject.set(s, (e = {add: [], remove: []}));
    return e;
  };
  for (const line of next) {
    if (old.has(line)) continue;
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

/**
 * Sync the class hierarchy of every registered package (or of `options.packages`) into `ds`
 * (default: the global router).
 *
 * Per package: skipped when the stored hash matches (no write at all, so an unforked branch stays
 * unforked); otherwise one update per subject class whose superclass set changed, at most eight
 * at a time, then the sync node, last, so an interrupted sync is redone by the next one. A
 * package whose data cannot be read is skipped with a warning (see `readPackageOntologies`).
 */
export async function syncOntologies(
  ds?: IDataset,
  options?: SyncOntologiesOptions,
): Promise<SyncOntologiesResult> {
  assertNoActiveCatalog();
  const result: SyncOntologiesResult = {written: [], skipped: [], pruned: []};
  const only = options?.packages ? new Set(options.packages) : undefined;

  // Every registered package is read, also outside `packages`: their new triples decide what a
  // changed package may remove.
  const {packages: parsed, skipped: unreadable} = await readPackageOntologies();
  const registered = new Set(registrationsByPackage().keys());
  const nextLines = new Map<string, Set<string>>();
  for (const [name, data] of parsed) {
    nextLines.set(name, new Set(splitLines(ontologyTriplesText(data.triples))));
  }

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
  const stored = new Map<string, {hash?: string; lines: Set<string>}>();
  for (const row of rows) {
    if (!row || typeof row.packageName !== 'string') continue;
    stored.set(row.packageName, {
      hash: typeof row.ontologyHash === 'string' ? row.ontologyHash : undefined,
      lines: new Set(splitLines(typeof row.ontologyTriples === 'string' ? row.ontologyTriples : '')),
    });
  }

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

  for (const name of unreadable) {
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
    const updates = diffUpdates(previous?.lines ?? new Set(), next, listedElsewhere(name), ds);
    await runBounded(updates, 8);
    await (OntologySync.upsert({
      packageName: name,
      ontologyHash: hash,
      ontologyTriples: text,
    } as never).for({id: ontologySyncNodeIri(name)}) as unknown as Exec).exec(ds);
    result.written.push(name);
  }

  if (options?.orphanScope === 'all' && !only) {
    const orphans = new Set([...stored.keys()].filter((name) => !registered.has(name)));
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
