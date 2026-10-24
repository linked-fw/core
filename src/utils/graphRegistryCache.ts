/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The graph registry as a read sees it: which graphs a dataset's registry lists, by record class,
 * cached per process and per dataset so that expanding `graphs.allOntologies` (or
 * `graphs.allShapes`) costs no request on most reads.
 *
 * - **One read per dataset:** a store loads its registry with one query and caches it under its
 *   dataset's key; concurrent reads share one load.
 * - **Own writes:** a store that runs a graph query updates its own entry in the same step
 *   ({@link noteGraphQuery}), so its next read sees the change.
 * - **Pushed invalidation:** a process told that another one changed a dataset's graphs (CN pushes
 *   this to the apps it runs) drops the entry with {@link invalidateGraphRegistry}.
 * - **Backstop:** an entry older than {@link GRAPH_REGISTRY_MAX_AGE_MS} is re-read, for writes
 *   nobody pushes (scripts, standalone apps).
 *
 * Writes never depend on the cache: a graph query checks the registry itself.
 */
import type {GraphQuery} from '../queries/IntermediateRepresentation.js';
import {GraphQueryError} from '../queries/graphQuery.js';
import {graphs} from '../ontologies/graphs.js';
import {coreOntology} from '../ontologies/linked-core.js';
import {sharedState} from './sharedState.js';

/** An entry older than this is re-read (30 seconds). */
export const GRAPH_REGISTRY_MAX_AGE_MS = 30_000;

/** One registry record as a store reads it: a graph and one of its record's classes. */
export type GraphRegistryRow = {graph: string; recordClass: string};

/** The registry of one dataset: graph IRI → the classes of its record. */
export type GraphRegistrySnapshot = ReadonlyMap<string, ReadonlySet<string>>;

type Entry = {graphs: Map<string, Set<string>>; loadedAt: number};

/**
 * Kept on `globalThis` (see `sharedState`): a second copy of core in the process (Vite's SSR
 * runner next to Node, two bundles) shares one cache, so an invalidation reaches every copy.
 */
const cacheState = sharedState('@_linked/core', 'graphRegistryCache', () => ({
  entries: new Map<string, Entry>(),
  loads: new Map<string, Promise<Entry>>(),
  /** Bumped by every invalidation, so a load that started before one is not stored after it. */
  generations: new Map<string, number>(),
}));
const {entries, loads, generations} = cacheState;

const generationOf = (key: string) => generations.get(key) ?? 0;

/**
 * The registry of the dataset `key`, from the cache when the entry is younger than
 * {@link GRAPH_REGISTRY_MAX_AGE_MS}, else from `load` (one load at a time per dataset).
 */
export async function readGraphRegistry(
  key: string,
  load: () => Promise<GraphRegistryRow[]>,
): Promise<GraphRegistrySnapshot> {
  const entry = entries.get(key);
  if (entry && Date.now() - entry.loadedAt <= GRAPH_REGISTRY_MAX_AGE_MS) return entry.graphs;
  let pending = loads.get(key);
  if (!pending) {
    const generation = generationOf(key);
    const started: Promise<Entry> = load()
      .then((rows) => {
        const loaded: Entry = {graphs: new Map(), loadedAt: Date.now()};
        for (const {graph, recordClass} of rows) {
          const classes = loaded.graphs.get(graph) ?? new Set<string>();
          classes.add(recordClass);
          loaded.graphs.set(graph, classes);
        }
        if (generationOf(key) === generation) entries.set(key, loaded);
        return loaded;
      })
      .finally(() => {
        if (loads.get(key) === started) loads.delete(key);
      });
    loads.set(key, started);
    pending = started;
  }
  return (await pending).graphs;
}

/**
 * Drop the cached registry of the dataset `key` (every dataset's when omitted): the next read
 * re-reads it. Called when another process changed a dataset's graphs (CN's push to an app).
 */
export function invalidateGraphRegistry(key?: string): void {
  const keys = key === undefined ? [...new Set([...entries.keys(), ...loads.keys()])] : [key];
  for (const k of keys) {
    entries.delete(k);
    loads.delete(k);
    generations.set(k, generationOf(k) + 1);
  }
}

/**
 * Update the cached registry of the dataset `key` after this process ran `query` on it: a create
 * adds the graph under its record class, a drop removes it; replaces and patches change no
 * record's class. With a load in flight (which may not see the write) the entry is dropped.
 */
export function noteGraphQuery(key: string, query: GraphQuery): void {
  if (loads.has(key)) {
    invalidateGraphRegistry(key);
    return;
  }
  const entry = entries.get(key);
  if (!entry) return;
  if (query.kind === 'graph_create') {
    const classes = entry.graphs.get(query.graph) ?? new Set<string>();
    classes.add(query.recordClass);
    entry.graphs.set(query.graph, classes);
  } else if (query.kind === 'graph_drop') {
    entry.graphs.delete(query.graph);
  }
}

/** The portable names that stand for the graphs the registry lists of one class. */
const REGISTRY_KINDS: ReadonlyMap<string, string> = new Map([
  [graphs.allOntologies, coreOntology.OntologyGraph.id],
  [graphs.allShapes, coreOntology.ShapesGraph.id],
]);

/** What a store reads for a `.from()` set: the default graph as without `.from()`, or named graphs. */
export type ExpandedReadGraphs = {defaultGraph: true} | {defaultGraph: false; graphs: string[]};

/**
 * Expand a `.from()` set to the graphs a store reads:
 * - `graphs.allOntologies` / `graphs.allShapes` → every graph the registry lists with an
 *   `OntologyGraph` / `ShapesGraph` record (sorted, so the query text is stable);
 * - `graphs.default` alone → the default graph, read as without `.from()`;
 * - `graphs.default` with other graphs → kept as `graphs.default`: the generator reads the set
 *   through `VALUES` with the store's name for the default graph (Jena's `FROM NAMED
 *   <urn:x-arq:DefaultGraph>` matches nothing); refused (`unsupported-query-kind`) when the store
 *   has no name for it (`mapGraphName`);
 * - `graphs.union` alone → the store's name for it (`mapGraphName`); without one the read is
 *   refused (`unsupported-query-kind`); with other graphs it is refused (it holds them already);
 * - any other IRI (`graphs.registry` included) → itself.
 *
 * The result may be empty (no graph of that kind is registered): the read matches nothing.
 */
export async function expandReadGraphs(
  names: readonly string[],
  context: {
    registry: () => Promise<GraphRegistrySnapshot>;
    mapGraphName?: (iri: string) => string | null;
  },
): Promise<ExpandedReadGraphs> {
  if (names.length === 1 && names[0] === graphs.default) return {defaultGraph: true};
  const out: string[] = [];
  const add = (iri: string) => {
    if (!out.includes(iri)) out.push(iri);
  };
  for (const name of names) {
    const kind = REGISTRY_KINDS.get(name);
    if (kind) {
      const registry = await context.registry();
      const listed = [...registry].filter(([, classes]) => classes.has(kind)).map(([graph]) => graph);
      listed.sort().forEach(add);
    } else if (name === graphs.default && names.length > 1) {
      // Read with the other graphs through VALUES under the store's name for it (the generator
      // maps it); a store without a name for it cannot read such a set.
      if (!context.mapGraphName?.(name)) {
        throw new GraphQueryError(
          'unsupported-query-kind',
          `This store has no name for <${name}>, so it cannot read it together with other ` +
            `graphs; a SPARQL store maps it with SparqlOptions.mapGraphName.`,
          name,
        );
      }
      add(name);
    } else if (name === graphs.default || name === graphs.union) {
      if (names.length > 1) {
        throw new GraphQueryError(
          'unsupported-query-kind',
          `<${name}> can only be read on its own, not together with other graphs: the union ` +
            `graph already holds every named graph.`,
          name,
        );
      }
      const mapped = context.mapGraphName ? context.mapGraphName(name) : null;
      if (!mapped) {
        throw new GraphQueryError(
          'unsupported-query-kind',
          `This store has no name for <${name}>; a SPARQL store maps it with ` +
            `SparqlOptions.mapGraphName.`,
          name,
        );
      }
      add(mapped);
    } else {
      add(name);
    }
  }
  return {defaultGraph: false, graphs: out};
}
