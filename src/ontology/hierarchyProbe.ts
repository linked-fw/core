/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Which class hierarchy a store infers from, measured on the store itself before the ontology
 * sync moves the hierarchy out of the default graph. Core never checks a store's product or
 * version: it writes a probe and reads it back through the dataset's normal query path.
 *
 * The probe, in a temporary graph registered as an `OntologyGraph` (so it feeds the hierarchy):
 *
 * ```turtle
 * probe:Named rdfs:subClassOf sd:NamedGraph .   # the hierarchy, in the registered graph
 * probe:named a probe:Named .
 * probe:default a probe:Default .
 * ```
 *
 * 1. `probe:named` read as an `sd:NamedGraph` (an ask through the `NamedGraph` shape, `.from()`
 *    the probe graph) → **`'named-graphs'`**: the store infers from the hierarchy of registered
 *    graphs (a store that infers over every graph answers the same).
 * 2. Else `probe:Default rdfs:subClassOf sd:NamedGraph` is written into the default graph and
 *    `probe:default` asked the same way → **`'default-graph'`**: the store infers only from the
 *    default graph's hierarchy.
 * 3. Else **`'none'`**: the store does not infer classes.
 *
 * The default-graph axiom is removed and the probe graph dropped afterwards, whatever the answer.
 * The probe graph is `{data root}/graph/import/linked-inference-probe-{random}` (the store's data
 * root, else `DATA_ROOT`, else linked.cm): a graph name of the import kind, which no graph route
 * writes and an app's gateway admits; its record names the package `@_linked/inference-probe`,
 * which no app registers, so a probe a crash left behind is pruned by the next sync with
 * `orphanScope: 'all'`.
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

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

type Exec = {exec: (target?: IDataset) => Promise<unknown>};

/** Stands for the global router when the sync runs without a dataset and none is set. */
const GLOBAL_ROUTER = {};

const probeState = sharedState('@_linked/core', 'hierarchyProbe', () => ({
  results: new WeakMap<object, Promise<HierarchyInference>>(),
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
}

async function runProbe(ds?: IDataset): Promise<HierarchyInference> {
  const token = randomToken();
  const root = (dataRootOf(ds) ?? LINKED_DATA_ROOT).replace(/\/+$/, '');
  const graph = `${root}/graph/import/linked-inference-probe-${token}`;
  const base = `${LINKED_DATA_ROOT}ont/core/inferenceProbe/${token}`;
  const named = {cls: `${base}/Named`, instance: `${base}/named`};
  const inDefault = {cls: `${base}/Default`, instance: `${base}/default`};
  const text =
    `<${named.cls}> <${RDFS_SUBCLASSOF}> <${sd.NamedGraph.id}> .\n` +
    `<${named.instance}> <${RDF_TYPE}> <${named.cls}> .\n` +
    `<${inDefault.instance}> <${RDF_TYPE}> <${inDefault.cls}> .\n`;
  const found = async (instance: string): Promise<boolean> =>
    (await (QueryBuilder.from(NamedGraph as never).for(instance).from(graph) as unknown as {
      exists: (target?: IDataset) => Promise<boolean>;
    }).exists(ds)) === true;
  const axiom = (change: 'add' | 'remove') =>
    (ClassAxioms.update({subClassOf: {[change]: [{id: sd.NamedGraph.id}]}} as never).for({
      id: inDefault.cls,
    }) as unknown as Exec).exec(ds);

  await OntologyGraph.create({id: graph, package: INFERENCE_PROBE_PACKAGE})
    .withContent({mediaType: 'application/n-triples', text})
    .exec(ds);
  try {
    if (await found(named.instance)) return 'named-graphs';
    await axiom('add');
    try {
      return (await found(inDefault.instance)) ? 'default-graph' : 'none';
    } finally {
      await axiom('remove');
    }
  } finally {
    await OntologyGraph.delete(graph).exec(ds);
  }
}
