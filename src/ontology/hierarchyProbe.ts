/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Which class hierarchy a store infers from, measured on the store itself before the ontology
 * sync writes its first package graph; the sync warns when the answer is not `'named-graphs'`.
 * Core never checks a store's product or version: it writes a probe and reads it back through the
 * dataset's normal query path.
 *
 * The probe uses two temporary graphs, both recorded as `OntologyGraph`s: a hierarchy graph that
 * feeds the hierarchy, and a data graph that does not (`feedsHierarchy false`):
 *
 * ```turtle
 * probe:Named rdfs:subClassOf sd:NamedGraph .   # in the hierarchy graph
 * probe:named a probe:Named .                   # in the data graph
 * probe:default a probe:Default .               # in the data graph
 * ```
 *
 * 1. `probe:named` read as an `sd:NamedGraph` (an ask through the `NamedGraph` shape, `.from()`
 *    the data graph) → **`'named-graphs'`**: the hierarchy of a registered graph reaches nodes
 *    stored in other graphs (a store that infers over every graph answers the same).
 * 2. Else `probe:Default rdfs:subClassOf sd:NamedGraph` is written into the default graph and
 *    `probe:default` asked the same way → **`'default-graph'`**: the store infers only from the
 *    default graph's hierarchy.
 * 3. Else **`'none'`**: the store does not infer classes.
 *
 * The default-graph axiom is removed and both graphs dropped afterwards, whatever the answer
 * (`finally`, best effort). A probe a crashed process left behind is swept by the next probe:
 * every probe record older than {@link STALE_PROBE_MS} is dropped, with its default-graph axiom
 * (when the axiom cannot be removed, the graphs are kept as the marker for that sweep). The graphs
 * are `{data root}/graph/import/linked-inference-probe-{random}` and `…-{random}-data` (the store's
 * data root, else `DATA_ROOT`, else linked.cm): names of the import kind, which no graph route
 * writes (import graphs are ontologies fetched by URL, `OntologyGraph` records); the records name
 * the package `@_linked/inference-probe`, which no app registers (so `orphanScope: 'all'` prunes a
 * leftover too).
 *
 * The answer is cached per dataset object for the process (on `globalThis`, so every copy of core
 * shares it); {@link resetHierarchyInference} drops it.
 *
 * @module @_linked/core/ontology/hierarchyProbe
 */

import type {IDataset} from '../interfaces/IDataset.js';
import {QueryBuilder} from '../queries/QueryBuilder.js';
import {ClassAxioms} from '../shapes/ClassAxioms.js';
import {NamedGraph, OntologyGraph} from '../shapes/NamedGraph.js';
import {sd} from '../ontologies/sd.js';
import {LINKED_DATA_ROOT} from '../shapes/SHACL.js';
import {dataRootOf} from '../utils/graphRouting.js';
import {LinkedStorage} from '../utils/LinkedStorage.js';
import {sharedState} from '../utils/sharedState.js';
import {RDFS_SUBCLASSOF} from './hierarchy.js';

/**
 * What a store infers `rdf:type` from: the hierarchy of the registered graphs (and the default
 * graph), only the default graph's, or nothing.
 */
export type HierarchyInference = 'named-graphs' | 'default-graph' | 'none';

/** The package name a probe graph's record carries; no app registers it. */
export const INFERENCE_PROBE_PACKAGE = '@_linked/inference-probe';

/** A probe record older than this (five minutes) belongs to a probe that did not clean up. */
export const STALE_PROBE_MS = 5 * 60_000;

const PROBE_GRAPH = /\/graph\/import\/linked-inference-probe-([a-z0-9]+)(?:-data)?$/;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

type Exec = {exec: (target?: IDataset) => Promise<unknown>};

/** Stands for the global router when the sync runs without a dataset and none is set. */
const GLOBAL_ROUTER = {};

const probeState = sharedState('@_linked/core', 'hierarchyProbe', () => ({
  results: new WeakMap<object, Promise<HierarchyInference>>(),
  /** The datasets the sync has warned about (one warning per probe answer). */
  warned: new WeakSet<object>(),
}));

const cacheKey = (ds?: IDataset): object =>
  ds ?? (LinkedStorage.getDefaultDataset() as object | undefined) ?? GLOBAL_ROUTER;

function randomToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return (uuid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`)
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 20);
}

/**
 * Which hierarchy `ds` (default: the global router) infers from, probed once per dataset and
 * cached (see the module doc). Rejects when the probe cannot run, with the store's error (a store
 * without graph queries rejects with `unsupported-query-kind`); a rejected probe is not cached.
 */
export function probeHierarchyInference(ds?: IDataset): Promise<HierarchyInference> {
  const key = cacheKey(ds);
  let result = probeState.results.get(key);
  if (!result) {
    result = runProbe(ds);
    probeState.results.set(key, result);
    result.catch(() => {
      if (probeState.results.get(key) === result) probeState.results.delete(key);
    });
  }
  return result;
}

/**
 * Drop the cached probe answer of `ds` (default: the global router's), for a process that knows
 * the store behind it changed; the next sync probes again.
 */
export function resetHierarchyInference(ds?: IDataset): void {
  probeState.results.delete(cacheKey(ds));
  probeState.warned?.delete(cacheKey(ds));
}

/**
 * Log `message` once per dataset (the same key the probe answer is cached under), until
 * {@link resetHierarchyInference}. For the warnings the ontology sync gives on a probe's answer.
 */
export function warnOnceForDataset(ds: IDataset | undefined, message: string): void {
  // A copy of core older than this field shares the container: fill the gap.
  const warned = (probeState.warned ??= new WeakSet<object>());
  const key = cacheKey(ds);
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** The class IRIs of the probe with `token`. */
const probeTerms = (token: string) => {
  const base = `${LINKED_DATA_ROOT}ont/core/inferenceProbe/${token}`;
  return {
    named: {cls: `${base}/Named`, instance: `${base}/named`},
    inDefault: {cls: `${base}/Default`, instance: `${base}/default`},
  };
};

const defaultAxiom = (token: string, change: 'add' | 'remove', ds?: IDataset) =>
  (ClassAxioms.update({subClassOf: {[change]: [{id: sd.NamedGraph.id}]}} as never).for({
    id: probeTerms(token).inDefault.cls,
  }) as unknown as Exec).exec(ds);

/**
 * Drop the probe graphs older than {@link STALE_PROBE_MS} (a probe that crashed before its
 * `finally`), and the default-graph axiom each may have left. Best effort: a sweep that fails
 * leaves the probe to run, and the next probe sweeps again.
 */
async function sweepStaleProbes(ds?: IDataset): Promise<void> {
  try {
    const rows =
      ((await OntologyGraph.select((r) => [r.package, r.modified]).exec(ds)) as Array<{
        id: string;
        package?: unknown;
        modified?: unknown;
      }> | null) ?? [];
    const now = Date.now();
    for (const row of rows) {
      const match = row?.id ? PROBE_GRAPH.exec(row.id) : null;
      if (!match || row.package !== INFERENCE_PROBE_PACKAGE) continue;
      const at = row.modified instanceof Date ? row.modified.getTime() : Date.parse(String(row.modified));
      if (Number.isFinite(at) && now - at < STALE_PROBE_MS) continue;
      await defaultAxiom(match[1], 'remove', ds);
      await OntologyGraph.delete(row.id).exec(ds);
    }
  } catch {
    // Best effort (above).
  }
}

async function runProbe(ds?: IDataset): Promise<HierarchyInference> {
  await sweepStaleProbes(ds);
  const token = randomToken();
  const root = (dataRootOf(ds) ?? LINKED_DATA_ROOT).replace(/\/+$/, '');
  const hierarchyGraph = `${root}/graph/import/linked-inference-probe-${token}`;
  const dataGraph = `${hierarchyGraph}-data`;
  const {named, inDefault} = probeTerms(token);
  const nt = (text: string) => ({mediaType: 'application/n-triples' as const, text});
  const found = async (instance: string): Promise<boolean> =>
    (await (QueryBuilder.from(NamedGraph as never).for(instance).from(dataGraph) as unknown as {
      exists: (target?: IDataset) => Promise<boolean>;
    }).exists(ds)) === true;

  let axiomAdded = false;
  try {
    // The instances live in a graph that does not feed the hierarchy: the hierarchy of a feeding
    // graph must reach nodes stored elsewhere, not only its own.
    await OntologyGraph.create({id: dataGraph, package: INFERENCE_PROBE_PACKAGE, feedsHierarchy: false})
      .withContent(
        nt(
          `<${named.instance}> <${RDF_TYPE}> <${named.cls}> .\n` +
            `<${inDefault.instance}> <${RDF_TYPE}> <${inDefault.cls}> .\n`,
        ),
      )
      .exec(ds);
    await OntologyGraph.create({id: hierarchyGraph, package: INFERENCE_PROBE_PACKAGE})
      .withContent(nt(`<${named.cls}> <${RDFS_SUBCLASSOF}> <${sd.NamedGraph.id}> .\n`))
      .exec(ds);
    if (await found(named.instance)) return 'named-graphs';
    axiomAdded = true;
    await defaultAxiom(token, 'add', ds);
    return (await found(inDefault.instance)) ? 'default-graph' : 'none';
  } finally {
    // Best effort, never masking the probe's own answer or error. When the default-graph axiom
    // cannot be removed the graphs stay, so the next probe's sweep finds the token and removes it.
    let axiomLeft = false;
    if (axiomAdded) {
      await defaultAxiom(token, 'remove', ds).catch(() => {
        axiomLeft = true;
      });
    }
    if (!axiomLeft) {
      for (const graph of [hierarchyGraph, dataGraph]) {
        await OntologyGraph.delete(graph).exec(ds).catch(() => undefined);
      }
    }
  }
}
