/*
 * The inference probe and what the ontology sync does with each answer, against stub stores:
 * every answer writes package graphs only and removes what an earlier sync kept in the default
 * graph; `'default-graph'` and `'none'` warn once per dataset; a sync with nothing to write runs no
 * probe; the answer cached per dataset, the probe cleaned up even when it fails, and stale probes
 * swept.
 */
import {beforeEach, describe, expect, jest, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {ontologyGraphHash, ontologySyncHash, ontologySyncNodeIri, syncOntologies} from '../ontology/syncOntologies';
import {
  INFERENCE_PROBE_PACKAGE,
  probeHierarchyInference,
  resetHierarchyInference,
  STALE_PROBE_MS,
  type HierarchyInference,
} from '../ontology/hierarchyProbe';
import {OntologyGraph} from '../shapes/NamedGraph';
import {OntologySync} from '../shapes/OntologySync';
import type {GraphQuery, GraphResult} from '../queries/IntermediateRepresentation';
import {inferenceProbeAnswer, isInferenceProbeGraph} from '../test-helpers/test-utils';

const NS = 'http://example.org/probe-sync/';
const SUB = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const line = (s: string, o: string) => `<${NS}${s}> <${SUB}> <${NS}${o}> .`;
const PKG = 'probe-sync-a';
linkedPackage(PKG).linkedOntology(
  {},
  createNameSpace(`http://example.org/ns/${PKG}/`),
  PKG,
  async () => [`@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<${NS}A> rdfs:subClassOf <${NS}B> .`],
  '../data/probe-sync-a.ttl',
);

const shapeOf = (query: any): string | undefined => {
  const shape = query?.root?.shape ?? query?.shape;
  return typeof shape === 'string' ? shape : shape?.id;
};

/** A store that infers as `inference` and records what the probe and the sync send. */
class StubStore extends SparqlDataset {
  graphQueries: GraphQuery[] = [];
  probeQueries: GraphQuery[] = [];
  updates: string[] = [];
  asks = 0;
  nodes: Array<{id: string; packageName: string; ontologyHash: string; ontologyTriples: string}> = [];
  failAsk = false;
  /** OntologyGraph records the store holds (a stale probe's, for the sweep). */
  records: Array<{id: string; package: string; modified?: Date; contentHash?: string}> = [];
  constructor(public inference: HierarchyInference) {
    super();
  }
  override async askQuery(query: any): Promise<boolean> {
    this.asks++;
    if (this.failAsk) throw new Error('ask failed');
    const answer = inferenceProbeAnswer(query, this.inference);
    if (answer === undefined) throw new Error('unexpected ask');
    return answer;
  }
  override async selectQuery(query: any): Promise<any> {
    if (shapeOf(query) === OntologyGraph.shape.id) return this.records.map((r) => ({...r}));
    if (shapeOf(query) === OntologySync.shape.id) return this.nodes.map((n) => ({...n}));
    throw new Error(`unexpected select of ${shapeOf(query)}`);
  }
  override async graphQuery(query: GraphQuery): Promise<GraphResult> {
    (isInferenceProbeGraph(query.graph) ? this.probeQueries : this.graphQueries).push(query);
    return {graph: query.graph, changed: true};
  }
  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

/** The default-graph node an earlier sync left for the package. */
const oldNode = () => {
  const text = line('A', 'B');
  return {id: ontologySyncNodeIri(PKG), packageName: PKG, ontologyHash: ontologySyncHash(text), ontologyTriples: text};
};
const probeAxiomUpdates = (store: StubStore) => store.updates.filter((u) => u.includes('inferenceProbe/'));
const syncUpdates = (store: StubStore) => store.updates.filter((u) => !u.includes('inferenceProbe/'));

let warn: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  warn?.mockRestore();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
const syncWarnings = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[syncOntologies]'));

describe('probeHierarchyInference', () => {
  test.each<[HierarchyInference, number]>([
    ['named-graphs', 1],
    ['default-graph', 2],
    ['none', 2],
  ])('a store that infers %s is answered so, after %i ask(s)', async (inference, asks) => {
    const store = new StubStore(inference);
    expect(await probeHierarchyInference(store)).toBe(inference);
    expect(store.asks).toBe(asks);
    // Two temporary graphs, created then dropped: the instances in one that does not feed the
    // hierarchy, the hierarchy in one that does.
    expect(store.probeQueries.map((q) => q.kind)).toEqual(['graph_create', 'graph_create', 'graph_drop', 'graph_drop']);
    const [data, hierarchy] = store.probeQueries;
    expect(data.graph).toBe(`${hierarchy.graph}-data`);
    expect(data.record).toEqual({package: INFERENCE_PROBE_PACKAGE, feedsHierarchy: false});
    expect(data.content?.text).not.toContain(SUB);
    expect(hierarchy.recordClass).toBe(OntologyGraph.targetClass.id);
    expect(hierarchy.record).toEqual({package: INFERENCE_PROBE_PACKAGE});
    expect(hierarchy.content?.text).toContain(`<${SUB}> <http://www.w3.org/ns/sparql-service-description#NamedGraph>`);
    expect(store.probeQueries.slice(2).map((q) => q.graph)).toEqual([hierarchy.graph, data.graph]);
    // The default-graph axiom is written only when the registered graph did not infer, and
    // removed again.
    expect(probeAxiomUpdates(store)).toHaveLength(inference === 'named-graphs' ? 0 : 2);
  });

  test('the answer is cached per dataset; reset drops it', async () => {
    const store = new StubStore('named-graphs');
    await probeHierarchyInference(store);
    await probeHierarchyInference(store);
    expect(store.probeQueries).toHaveLength(4);
    await probeHierarchyInference(new StubStore('none'));
    resetHierarchyInference(store);
    await probeHierarchyInference(store);
    expect(store.probeQueries).toHaveLength(8);
  });

  test('a probe sweeps the probe graphs a crashed probe left, older than five minutes', async () => {
    const store = new StubStore('named-graphs');
    const stale = 'https://linked.cm/graph/import/linked-inference-probe-abc123-data';
    const fresh = 'https://linked.cm/graph/import/linked-inference-probe-def456';
    store.records = [
      {id: stale, package: INFERENCE_PROBE_PACKAGE, modified: new Date(Date.now() - STALE_PROBE_MS - 1000)},
      {id: fresh, package: INFERENCE_PROBE_PACKAGE, modified: new Date()},
      {id: OntologyGraph.iriFor(PKG), package: PKG, modified: new Date(0)},
    ];
    await probeHierarchyInference(store);
    const drops = store.probeQueries.filter((q) => q.kind === 'graph_drop').map((q) => q.graph);
    expect(drops).toContain(stale);
    expect(drops).not.toContain(fresh);
    expect(store.graphQueries).toEqual([]); // the package's own graph is left alone
    // Its default-graph axiom is removed with it.
    expect(store.updates.some((u) => u.includes('inferenceProbe/abc123/Default'))).toBe(true);
  });

  test('a probe that fails cleans up and is not cached', async () => {
    const store = new StubStore('default-graph');
    store.failAsk = true;
    await expect(probeHierarchyInference(store)).rejects.toThrow('ask failed');
    expect(store.probeQueries.map((q) => q.kind)).toEqual(['graph_create', 'graph_create', 'graph_drop', 'graph_drop']);
    store.failAsk = false;
    expect(await probeHierarchyInference(store)).toBe('default-graph');
    expect(probeAxiomUpdates(store)).toHaveLength(2); // added and removed
  });
});

describe('syncOntologies by the probe answer', () => {
  const PKG_TEXT = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<${NS}A> rdfs:subClassOf <${NS}B> .`;
  const record = (contentHash: string) => ({id: OntologyGraph.iriFor(PKG), package: PKG, contentHash});
  const defaultGraphInserts = (store: StubStore) =>
    syncUpdates(store).filter((u) => u.includes('INSERT') && u.includes(`<${NS}A> rdfs:subClassOf <${NS}B>`));

  test('an unchanged sync sends no write and runs no probe', async () => {
    const store = new StubStore('named-graphs');
    store.records = [record(ontologyGraphHash([PKG_TEXT]))];
    const result = await syncOntologies(store, {packages: [PKG]});
    expect(result).toEqual({written: [], skipped: [PKG], pruned: []});
    expect(store.probeQueries).toEqual([]);
    expect(store.asks).toBe(0);
    expect(store.graphQueries).toEqual([]);
    expect(store.updates).toEqual([]);
    expect(syncWarnings()).toEqual([]);
  });

  test('a changed sync probes once, before it writes', async () => {
    const store = new StubStore('named-graphs');
    store.records = [record('an-older-hash')];
    const result = await syncOntologies(store, {packages: [PKG]});
    expect(result.written).toEqual([PKG]);
    expect(store.probeQueries.map((q) => q.kind)).toEqual(['graph_create', 'graph_create', 'graph_drop', 'graph_drop']);
    expect(store.graphQueries.map((q) => [q.kind, q.graph])).toEqual([['graph_replace', OntologyGraph.iriFor(PKG)]]);
    // A second changed sync of the same dataset uses the cached answer.
    await syncOntologies(store, {packages: [PKG]});
    expect(store.probeQueries).toHaveLength(4);
  });

  test("'named-graphs': the package graph is written and the default-graph hierarchy removed", async () => {
    const store = new StubStore('named-graphs');
    store.nodes = [oldNode()];
    const result = await syncOntologies(store, {packages: [PKG]});
    expect(result.written).toEqual([PKG]);
    expect(store.graphQueries.map((q) => [q.kind, q.graph])).toEqual([['graph_create', OntologyGraph.iriFor(PKG)]]);
    const removal = syncUpdates(store);
    expect(removal.some((u) => u.includes('DELETE') && u.includes(`<${NS}A>`))).toBe(true);
    expect(removal.at(-1)).toContain(`ontologySync/${PKG}`);
    expect(syncWarnings()).toEqual([]);
  });

  test.each<HierarchyInference>(['default-graph', 'none'])(
    "'%s': the package graph only, no default-graph copy, the old one removed, one warning",
    async (inference) => {
      const store = new StubStore(inference);
      const first = await syncOntologies(store, {packages: [PKG]});
      expect(first).toEqual({written: [PKG], skipped: [], pruned: []});
      expect(store.graphQueries.map((q) => q.kind)).toEqual(['graph_create']);
      expect(defaultGraphInserts(store)).toEqual([]);
      expect(syncUpdates(store).some((u) => u.includes('ontologySync/'))).toBe(false);
      // What an earlier sync kept in the default graph goes.
      store.nodes = [oldNode()];
      store.updates = [];
      await syncOntologies(store, {packages: [PKG]});
      expect(defaultGraphInserts(store)).toEqual([]);
      const removal = syncUpdates(store);
      expect(removal.some((u) => u.includes('DELETE') && u.includes(`<${NS}A>`))).toBe(true);
      expect(removal.at(-1)).toContain(`ontologySync/${PKG}`);
      expect(store.probeQueries).toHaveLength(4);
      expect(syncWarnings()).toHaveLength(1);
      expect(syncWarnings()[0]).toMatch(/does not infer rdf:type from the graphs the registry marks feedsHierarchy/);
      expect(syncWarnings()[0]).toContain(`'${inference}'`);
      expect(syncWarnings()[0]).toMatch(/misses the instances of subclasses/);
      expect(syncWarnings()[0]).toMatch(/Store requirements/);
    },
  );

  test('a probe that fails for another reason still writes only the package graph and warns', async () => {
    const store = new StubStore('named-graphs');
    store.failAsk = true;
    store.nodes = [oldNode()];
    const result = await syncOntologies(store, {packages: [PKG]});
    expect(result.written).toEqual([PKG]);
    expect(store.graphQueries.map((q) => q.kind)).toEqual(['graph_create']);
    expect(defaultGraphInserts(store)).toEqual([]);
    expect(syncUpdates(store).some((u) => u.includes('DELETE'))).toBe(true);
    expect(syncWarnings()).toHaveLength(1);
    expect(syncWarnings()[0]).toMatch(/Could not measure/);
    expect(syncWarnings()[0]).toMatch(/Store requirements/);
  });
});
