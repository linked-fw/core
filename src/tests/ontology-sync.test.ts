/*
 * The ontology sync against recording stores.
 *
 * On package graphs: one graph query per changed package (create or replace, the N-Triples body,
 * the sync's hash), nothing for an unchanged one, force, orphan records, graph-exists recovery.
 *
 * A store without graph queries (one that refuses them, or has no `graphQuery`) is refused in the
 * `'package'` and shared modes, before anything is written.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {createHash} from 'node:crypto';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {ontologyGraphHash, syncOntologies} from '../ontology/syncOntologies';
import {OntologyGraph} from '../shapes/NamedGraph';
import {GraphQueryError, unsupportedGraphQuery} from '../queries/graphQuery';
import type {GraphQuery, GraphResult} from '../queries/IntermediateRepresentation';
import {getRegisteredOntologies} from '../utils/Package';
import {OntologySync} from '../shapes/OntologySync';
import {builtInShapeIris} from '../utils/ShapeCatalog';
import {setOntologyHierarchy, superClassesOf} from '../ontology/classHierarchy';
import {inferenceProbeAnswer, isInferenceProbeGraph} from '../test-helpers/test-utils';
import {setGraphTargets} from '../utils/graphTargets';

const NS = 'http://example.org/sync/';
const SUB = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const line = (s: string, o: string) => `<${NS}${s}> <${SUB}> <${NS}${o}> .`;
const ttl = (...pairs: Array<[string, string]>) =>
  `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix ex: <${NS}> .\n` +
  pairs.map(([s, o]) => `ex:${s} rdfs:subClassOf ex:${o} .`).join('\n');

/** The shape a select reads (the IR's root, or the DSL-JSON's `shape`). */
const shapeOf = (query: any): string | undefined => {
  const shape = query?.root?.shape ?? query?.shape;
  return typeof shape === 'string' ? shape : shape?.id;
};

/** Records updates and selects; refuses graph queries. */
class Recording extends SparqlDataset {
  updates: string[] = [];
  selects = 0;
  graphQueries = 0;
  override async selectQuery(): Promise<any> {
    this.selects++;
    return [];
  }
  override async graphQuery(query: GraphQuery): Promise<GraphResult> {
    this.graphQueries++;
    throw unsupportedGraphQuery(query);
  }
  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

// The packages under test register through mutable loaders, so a test can change their data.
const data: Record<string, string> = {};
// Each registers its own namespace, so NS has no prefix and the SPARQL shows full IRIs.
const ownNs = (pkg: string) => createNameSpace(`http://example.org/ns/${pkg}/`);
const register = (pkg: string, prefix: string) =>
  linkedPackage(pkg).linkedOntology({}, ownNs(pkg), prefix, async () => [data[pkg] ?? ''], `../data/${prefix}.ttl`);
register('sync-a', 'sync-a');
register('sync-b', 'sync-b');

let ds: Recording;
beforeEach(() => {
  ds = new Recording();
  data['sync-a'] = ttl(['A', 'B'], ['B', 'C']);
  data['sync-b'] = ttl(['X', 'Y']);
});

describe('syncOntologies: a store without graph queries', () => {
  afterEach(() => setGraphTargets({}));

  test("is refused in the 'package' mode once the probe is refused, before anything is written", async () => {
    await expect(syncOntologies(ds, {packages: ['sync-a']})).rejects.toThrow(
      /ontologyGraph is 'package', but the store Recording has no graph queries/,
    );
    expect(ds.updates).toEqual([]);
  });

  test('a dataset without graphQuery is refused before any read', async () => {
    Object.defineProperty(ds, 'graphQuery', {value: undefined});
    await expect(syncOntologies(ds, {packages: ['sync-a']})).rejects.toThrow(/has no graph queries/);
    expect(ds.selects).toBe(0);
    expect(ds.updates).toEqual([]);
  });

  test('is refused in a shared mode', async () => {
    setGraphTargets({ontologyGraph: 'https://example.org/graph/ontology'});
    await expect(syncOntologies(ds)).rejects.toThrow(
      /ontologyGraph is <https:\/\/example\.org\/graph\/ontology>, but the store Recording has no graph queries/,
    );
    expect(ds.updates).toEqual([]);
  });

  test('OntologySync is a built-in; ClassAxioms is not', () => {
    expect(builtInShapeIris()).toContain(OntologySync.shape.id);
    expect(builtInShapeIris().some((iri) => iri.endsWith('/ClassAxioms'))).toBe(false);
    expect(getRegisteredOntologies().map((r) => r.packageName)).toEqual(
      expect.arrayContaining(['sync-a', 'sync-b']),
    );
  });
});

type GraphRow = {id: string; package: string; contentHash: string};

/**
 * A store with graph queries: captures each one, answers the record select from `records` (and
 * the `'default'` mode's record select with nothing), records the SPARQL updates.
 */
class GraphRecording extends SparqlDataset {
  updates: string[] = [];
  graphQueries: GraphQuery[] = [];
  /** The inference probe's own graph queries (kept apart from the sync's). */
  probeQueries: GraphQuery[] = [];
  records: GraphRow[] = [];
  /** What the store answers the inference probe. */
  inference: 'named-graphs' | 'default-graph' | 'none' = 'named-graphs';
  override async askQuery(query: any): Promise<boolean> {
    const answer = inferenceProbeAnswer(query, this.inference);
    if (answer === undefined) throw new Error('unexpected ask');
    return answer;
  }
  override async selectQuery(query: any): Promise<any> {
    if (shapeOf(query) === OntologyGraph.shape.id) return this.records.map((r) => ({...r}));
    if (shapeOf(query) === OntologySync.shape.id) return [];
    throw new Error(`unexpected select of ${shapeOf(query)}`);
  }
  override async graphQuery(query: GraphQuery): Promise<GraphResult> {
    (isInferenceProbeGraph(query.graph) ? this.probeQueries : this.graphQueries).push(query);
    return {graph: query.graph, contentHash: query.contentHash, changed: query.kind !== 'graph_patch'};
  }
  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

describe('syncOntologies: package graphs', () => {
  let gs: GraphRecording;
  const graphA = () => OntologyGraph.iriFor('sync-a');
  const graphB = () => OntologyGraph.iriFor('sync-b');
  const recordOf = (pkg: string, hash = ontologyGraphHash([data[pkg]])): GraphRow => ({
    id: OntologyGraph.iriFor(pkg),
    package: pkg,
    contentHash: hash,
  });
  beforeEach(() => {
    gs = new GraphRecording();
  });

  test('the hash vector: /2 over the raw texts joined with a newline', () => {
    expect(ontologyGraphHash(['a', 'b'])).toBe(
      createHash('sha256').update('linked-ontology-sync/2\na\nb').digest('hex'),
    );
    expect(ontologyGraphHash([])).toBe(
      createHash('sha256').update('linked-ontology-sync/2\n').digest('hex'),
    );
  });

  test('a first sync creates one graph per package with the N-Triples body, the sync hash and its sources', async () => {
    const result = await syncOntologies(gs, {packages: ['sync-a', 'sync-b']});
    expect(result).toMatchObject({written: ['sync-a', 'sync-b'], skipped: [], pruned: []});
    expect(gs.graphQueries).toHaveLength(2);
    const [a, b] = gs.graphQueries;
    expect(a).toMatchObject({
      kind: 'graph_create',
      graph: graphA(),
      recordClass: OntologyGraph.targetClass.id,
      record: {package: 'sync-a', sources: ['data/sync-a.ttl']},
      contentHash: ontologyGraphHash([data['sync-a']]),
    });
    expect(a.content?.mediaType).toBe('application/n-triples');
    expect(a.content?.text).toBe(`${line('A', 'B')}\n${line('B', 'C')}\n`);
    expect(b).toMatchObject({kind: 'graph_create', graph: graphB(), record: {package: 'sync-b'}});
    expect(b.content?.text).toBe(`${line('X', 'Y')}\n`);
    // No default-graph write.
    expect(gs.updates).toEqual([]);
  });

  test('an unchanged package sends no graph query', async () => {
    gs.records = [recordOf('sync-a'), recordOf('sync-b')];
    const result = await syncOntologies(gs, {packages: ['sync-a', 'sync-b']});
    expect(result).toMatchObject({written: [], skipped: ['sync-a', 'sync-b'], pruned: []});
    expect(gs.graphQueries).toEqual([]);
    expect(gs.updates).toEqual([]);
  });

  test('a changed package is replaced whole, with its record; the unchanged one is left', async () => {
    gs.records = [recordOf('sync-a', 'old'), recordOf('sync-b')];
    const result = await syncOntologies(gs, {packages: ['sync-a', 'sync-b']});
    expect(result).toMatchObject({written: ['sync-a'], skipped: ['sync-b'], pruned: []});
    expect(gs.graphQueries).toHaveLength(1);
    expect(gs.graphQueries[0]).toMatchObject({
      kind: 'graph_replace',
      graph: graphA(),
      record: {sources: ['data/sync-a.ttl']},
      contentHash: ontologyGraphHash([data['sync-a']]),
    });
    expect(gs.graphQueries[0].record).not.toHaveProperty('package');
  });

  test('force replaces a package whose hash matches', async () => {
    gs.records = [recordOf('sync-a')];
    const result = await syncOntologies(gs, {packages: ['sync-a'], force: true});
    expect(result.written).toEqual(['sync-a']);
    expect(gs.graphQueries.map((q) => q.kind)).toEqual(['graph_replace']);
  });

  test('the blank nodes of two files stay apart', async () => {
    const restriction = (prop: string) =>
      `@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n` +
      `_:b0 a owl:Restriction ; owl:onProperty <${NS}${prop}> .\n<${NS}${prop}C> rdfs:subClassOf _:b0 .\n`;
    linkedPackage('sync-bnodes').linkedOntology(
      {},
      ownNs('sync-bnodes'),
      'sync-bnodes',
      async () => [restriction('p'), restriction('q')],
      ['../data/one.ttl', '../data/two.ttl'],
    );
    await syncOntologies(gs, {packages: ['sync-bnodes']});
    const text = gs.graphQueries[0].content!.text;
    const labels = new Set([...text.matchAll(/_:[^\s]+/g)].map((m) => m[0]));
    expect(labels.size).toBe(2);
    expect(gs.graphQueries[0].record).toMatchObject({sources: ['data/one.ttl', 'data/two.ttl']});
  });

  test("orphanScope 'all' drops the graph of a package no longer registered", async () => {
    gs.records = [recordOf('sync-a'), recordOf('sync-b'), {id: 'https://linked.cm/pkg/sync-gone/graph/ontology', package: 'sync-gone', contentHash: 'x'}];
    const result = await syncOntologies(gs, {orphanScope: 'all'});
    expect(result.pruned).toEqual(['sync-gone']);
    expect(gs.graphQueries.filter((q) => q.kind === 'graph_drop')).toEqual([
      expect.objectContaining({graph: 'https://linked.cm/pkg/sync-gone/graph/ontology'}),
    ]);
  });

  test('without orphanScope no graph is dropped', async () => {
    gs.records = [{id: 'https://linked.cm/pkg/sync-gone/graph/ontology', package: 'sync-gone', contentHash: 'x'}];
    const result = await syncOntologies(gs, {packages: ['sync-a']});
    expect(result.pruned).toEqual([]);
    expect(gs.graphQueries.some((q) => q.kind === 'graph_drop')).toBe(false);
  });

  test('the sync sets the in-memory hierarchy from its parse, also for a skipped package', async () => {
    setOntologyHierarchy([]);
    gs.records = [recordOf('sync-a')];
    await syncOntologies(gs, {packages: ['sync-a']});
    expect(superClassesOf(`${NS}A`)).toEqual(new Set([`${NS}A`, `${NS}B`, `${NS}C`]));
    expect(superClassesOf(`${NS}X`)).toEqual(new Set([`${NS}X`, `${NS}Y`]));
  });

  test('an unreadable package is skipped with its warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      linkedPackage('sync-json').linkedOntology({}, ownNs('sync-json'), 'sync-json', async () => ({'@graph': []}), '../data/x.json');
      const result = await syncOntologies(gs, {packages: ['sync-json']});
      expect(result).toMatchObject({written: [], skipped: ['sync-json'], pruned: []});
      expect(gs.graphQueries).toEqual([]);
      expect(gs.updates).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('a create refused because another process created the graph meanwhile replaces it', async () => {
    const record = gs.graphQuery.bind(gs);
    gs.graphQuery = async (q) => {
      if (q.kind === 'graph_create' && !isInferenceProbeGraph(q.graph)) {
        gs.graphQueries.push(q);
        throw new GraphQueryError('graph-exists', 'taken', q.graph);
      }
      return record(q);
    };
    const result = await syncOntologies(gs, {packages: ['sync-a']});
    expect(result.written).toEqual(['sync-a']);
    expect(gs.graphQueries.map((q) => q.kind)).toEqual(['graph_create', 'graph_replace']);
  });

  test('a create refused because the graph holds triples without a record drops and creates it', async () => {
    let creates = 0;
    const record = gs.graphQuery.bind(gs);
    gs.graphQuery = async (q) => {
      if (isInferenceProbeGraph(q.graph)) return record(q);
      gs.graphQueries.push(q);
      if (q.kind === 'graph_create' && creates++ === 0) throw new GraphQueryError('graph-exists', 'triples', q.graph);
      if (q.kind === 'graph_replace') throw new GraphQueryError('graph-not-registered', 'no record', q.graph);
      return {graph: q.graph, changed: true};
    };
    await syncOntologies(gs, {packages: ['sync-a']});
    expect(gs.graphQueries.map((q) => q.kind)).toEqual(['graph_create', 'graph_replace', 'graph_drop', 'graph_create']);
  });

  test('a graph write failure other than unsupported-query-kind is thrown as it is', async () => {
    gs.graphQuery = async () => {
      throw new Error('store down');
    };
    await expect(syncOntologies(gs, {packages: ['sync-a']})).rejects.toThrow('store down');
    expect(gs.updates).toEqual([]);
  });
});
