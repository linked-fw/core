/*
 * The ontology sync against recording stores.
 *
 * On package graphs: one graph query per changed package (create or replace, the N-Triples body,
 * the sync's hash), nothing for an unchanged one, force, orphan records, and the removal of what
 * the default-graph sync kept (its nodes' lines, except those another node lists).
 *
 * The default-graph fallback (a store that refuses graph queries, or has no `graphQuery`):
 * per-class diff updates then the sync node; an unchanged package writes nothing; a changed one
 * removes only what no other package lists; force, packages, orphan pruning; the hash vector.
 */
import {beforeEach, describe, expect, jest, test} from '@jest/globals';
import {createHash} from 'node:crypto';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {
  ontologyGraphHash,
  ontologySyncHash,
  ontologySyncNodeIri,
  ontologyTriplesText,
  syncOntologies,
} from '../ontology/syncOntologies';
import {OntologyGraph} from '../shapes/NamedGraph';
import {unsupportedGraphQuery} from '../queries/graphQuery';
import type {GraphQuery, GraphResult} from '../queries/IntermediateRepresentation';
import {getRegisteredOntologies} from '../utils/Package';
import {OntologySync} from '../shapes/OntologySync';
import {builtInShapeIris} from '../utils/ShapeCatalog';
import {setOntologyHierarchy, superClassesOf} from '../ontology/classHierarchy';

const NS = 'http://example.org/sync/';
const SUB = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const line = (s: string, o: string) => `<${NS}${s}> <${SUB}> <${NS}${o}> .`;
const ttl = (...pairs: Array<[string, string]>) =>
  `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix ex: <${NS}> .\n` +
  pairs.map(([s, o]) => `ex:${s} rdfs:subClassOf ex:${o} .`).join('\n');

type Row = {id: string; packageName: string; ontologyHash: string; ontologyTriples: string};

/** The shape a select reads (the IR's root, or the DSL-JSON's `shape`). */
const shapeOf = (query: any): string | undefined => {
  const shape = query?.root?.shape ?? query?.shape;
  return typeof shape === 'string' ? shape : shape?.id;
};

/** Records updates; answers the sync-node select from `nodes`; refuses graph queries. */
class Recording extends SparqlDataset {
  updates: string[] = [];
  selects = 0;
  graphQueries = 0;
  nodes: Row[] = [];
  override async selectQuery(query: any): Promise<any> {
    if (shapeOf(query) === OntologyGraph.shape.id) return [];
    this.selects++;
    return this.nodes.map((n) => ({...n}));
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

const node = (pkg: string, lines: string[]): Row => {
  const text = [...lines].sort().join('\n');
  return {id: ontologySyncNodeIri(pkg), packageName: pkg, ontologyHash: ontologySyncHash(text), ontologyTriples: text};
};

/** The hash fields of a node that lists `lines`. */
const hashOf = (lines: string[]) => ({ontologyHash: ontologySyncHash([...lines].sort().join('\n'))});

let ds: Recording;
beforeEach(() => {
  ds = new Recording();
  data['sync-a'] = ttl(['A', 'B'], ['B', 'C']);
  data['sync-b'] = ttl(['X', 'Y']);
});

const updatesFor = (subject: string) =>
  ds.updates.filter((u) => !u.includes('ontologySync/') && u.includes(`<${NS}${subject}> `));
/** The updates whose triples have `subject` as their subject (not as their object). */
const updatesOn = (subject: string) =>
  ds.updates.filter((u) => !u.includes('ontologySync/') && u.includes(`<${NS}${subject}> rdfs:subClassOf`));
const nodeWrites = () => ds.updates.filter((u) => u.includes('ontologySync/'));

describe('syncOntologies: the default-graph fallback', () => {
  test('the hash vector', () => {
    const text = ontologyTriplesText([
      {s: `${NS}B`, o: `${NS}C`},
      {s: `${NS}A`, o: `${NS}B`},
    ]);
    expect(text).toBe(`${line('A', 'B')}\n${line('B', 'C')}`);
    expect(ontologySyncHash(text)).toBe('f3244d691a083cd0262366241989ce43cf255e518a4d9aa975bdb82d8ed22915');
    expect(ontologySyncHash('')).toBe('e1be00311f5b13d3c6ad2d801dc6a290afa8719a7b1bf759b627c3366434ccef');
  });

  test('a first sync writes one update per subject class, then the sync node, last', async () => {
    const result = await syncOntologies(ds, {packages: ['sync-a']});
    expect(result).toEqual({written: ['sync-a'], skipped: [], pruned: []});
    // The graph path read the sync nodes and was refused at its first write; the fallback reads them again.
    expect(ds.graphQueries).toBe(1);
    expect(ds.selects).toBe(2);
    expect(ds.updates).toHaveLength(3);
    expect(ds.updates[0]).toContain(`<${NS}A> rdfs:subClassOf <${NS}B> .`);
    expect(ds.updates[1]).toContain(`<${NS}B> rdfs:subClassOf <${NS}C> .`);
    // The class updates never type the class.
    for (const update of ds.updates.slice(0, 2)) expect(update).not.toMatch(/rdf:type/);
    const last = ds.updates[2];
    expect(last).toContain(`<${ontologySyncNodeIri('sync-a')}> rdf:type core:OntologySync .`);
    expect(last).toContain(ontologySyncHash(`${line('A', 'B')}\n${line('B', 'C')}`));
  });

  test('the sync sets the in-memory hierarchy from its parse, also for a skipped package', async () => {
    setOntologyHierarchy([]);
    ds.nodes = [node('sync-a', [line('A', 'B'), line('B', 'C')])];
    await syncOntologies(ds, {packages: ['sync-a']});
    expect(superClassesOf(`${NS}A`)).toEqual(new Set([`${NS}A`, `${NS}B`, `${NS}C`]));
    expect(superClassesOf(`${NS}X`)).toEqual(new Set([`${NS}X`, `${NS}Y`]));
  });

  test('an unchanged package writes nothing', async () => {
    ds.nodes = [node('sync-a', [line('A', 'B'), line('B', 'C')]), node('sync-b', [line('X', 'Y')])];
    const result = await syncOntologies(ds, {packages: ['sync-a', 'sync-b']});
    expect(result).toEqual({written: [], skipped: ['sync-a', 'sync-b'], pruned: []});
    expect(ds.updates).toEqual([]);
  });

  test('force re-inserts every listed triple of an unchanged package, then the sync node', async () => {
    ds.nodes = [node('sync-a', [line('A', 'B'), line('B', 'C')])];
    const result = await syncOntologies(ds, {packages: ['sync-a'], force: true});
    expect(result.written).toEqual(['sync-a']);
    // Diffed against an empty stored set: one insert per subject class, nothing removed.
    expect(ds.updates).toHaveLength(3);
    expect(updatesOn('A')[0]).toContain(`<${NS}A> rdfs:subClassOf <${NS}B> .`);
    expect(updatesOn('B')[0]).toContain(`<${NS}B> rdfs:subClassOf <${NS}C> .`);
    for (const update of ds.updates.slice(0, 2)) expect(update).not.toMatch(/DELETE \{[^}]*subClassOf/);
    expect(nodeWrites()).toHaveLength(1);
    expect(ds.updates[2]).toContain('ontologySync/sync-a');
  });

  test('force still removes the stored lines the package no longer lists', async () => {
    // Stored: A ⊑ B and B ⊑ C; the package now lists only A ⊑ B, under the same hash as stored
    // (the dataset was edited by hand), so only force writes.
    ds.nodes = [{...node('sync-a', [line('A', 'B'), line('B', 'C')]), ...hashOf([line('A', 'B')])}];
    data['sync-a'] = ttl(['A', 'B']);
    const result = await syncOntologies(ds, {packages: ['sync-a'], force: true});
    expect(result.written).toEqual(['sync-a']);
    expect(updatesOn('A')[0]).toContain(`<${NS}A> rdfs:subClassOf <${NS}B> .`);
    expect(updatesOn('B')).toHaveLength(1);
    expect(updatesOn('B')[0]).toMatch(/DELETE \{[^}]*<http:\/\/example\.org\/sync\/B> rdfs:subClassOf <http:\/\/example\.org\/sync\/C>/);
  });

  test('a changed package removes old − new, adds new − old, and keeps what another package lists', async () => {
    // sync-a used to list A ⊑ B, B ⊑ C and X ⊑ Y; it now lists A ⊑ B and A ⊑ D.
    ds.nodes = [node('sync-a', [line('A', 'B'), line('B', 'C'), line('X', 'Y')])];
    data['sync-a'] = ttl(['A', 'B'], ['A', 'D']);
    const result = await syncOntologies(ds, {packages: ['sync-a']});
    expect(result.written).toEqual(['sync-a']);
    // A: D added (B stays, it is in both).
    expect(updatesFor('A')).toHaveLength(1);
    expect(updatesFor('A')[0]).toContain(`<${NS}A> rdfs:subClassOf <${NS}D> .`);
    expect(updatesFor('A')[0]).not.toMatch(/DELETE[^}]*<http:\/\/example\.org\/sync\/B>/);
    // B: C removed.
    expect(updatesFor('B')).toHaveLength(1);
    expect(updatesFor('B')[0]).toMatch(/DELETE \{[^}]*<http:\/\/example\.org\/sync\/B> rdfs:subClassOf <http:\/\/example\.org\/sync\/C>/);
    // X ⊑ Y is listed by sync-b: kept, no update for X.
    expect(updatesFor('X')).toEqual([]);
    expect(ds.updates).toHaveLength(3);
    expect(ds.updates[2]).toContain('ontologySync/sync-a');
  });

  test('two packages changing in one run never delete a triple the other still lists', async () => {
    ds.nodes = [node('sync-a', [line('S', 'T')]), node('sync-b', [line('X', 'Y')])];
    // The shared triple moves from sync-a to sync-b.
    data['sync-a'] = ttl(['A', 'B']);
    data['sync-b'] = ttl(['X', 'Y'], ['S', 'T']);
    await syncOntologies(ds, {packages: ['sync-a', 'sync-b']});
    expect(ds.updates.filter((u) => /DELETE \{[^}]*<http:\/\/example\.org\/sync\/S> rdfs:subClassOf/.test(u))).toEqual([]);
  });

  test('packages limits the run', async () => {
    const result = await syncOntologies(ds, {packages: ['sync-b']});
    expect(result.written).toEqual(['sync-b']);
    expect(updatesFor('A')).toEqual([]);
  });

  test("orphanScope 'all' removes an unregistered package's triples and node", async () => {
    ds.nodes = [
      node('sync-a', [line('A', 'B'), line('B', 'C')]),
      node('sync-b', [line('X', 'Y')]),
      node('sync-gone', [line('G', 'H'), line('A', 'B')]),
    ];
    // Only the test's packages and the orphan: other files' registrations are not in this worker.
    const result = await syncOntologies(ds, {orphanScope: 'all'});
    expect(result.pruned).toEqual(['sync-gone']);
    expect(updatesFor('G')).toHaveLength(1);
    expect(updatesFor('G')[0]).toMatch(/DELETE \{[^}]*<http:\/\/example\.org\/sync\/G> rdfs:subClassOf <http:\/\/example\.org\/sync\/H>/);
    // A ⊑ B is still listed by sync-a.
    expect(updatesFor('A')).toEqual([]);
    expect(ds.updates.at(-1)).toMatch(/DELETE/);
    expect(ds.updates.at(-1)).toContain('ontologySync/sync-gone');
  });

  test('without orphanScope nothing is pruned', async () => {
    ds.nodes = [node('sync-gone', [line('G', 'H')])];
    const result = await syncOntologies(ds, {packages: ['sync-a', 'sync-b']});
    expect(result.pruned).toEqual([]);
    expect(updatesFor('G')).toEqual([]);
  });

  test('an unreadable package is skipped with its warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      linkedPackage('sync-json').linkedOntology({}, ownNs('sync-json'), 'sync-json', async () => ({'@graph': []}), '../data/x.json');
      const result = await syncOntologies(ds, {packages: ['sync-json']});
      expect(result).toEqual({written: [], skipped: ['sync-json'], pruned: []});
      expect(ds.updates).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
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
 * A store with graph queries: captures each one, answers the record select from `records` and
 * the sync-node select from `nodes`, records the SPARQL updates (the removal of node lines).
 */
class GraphRecording extends SparqlDataset {
  updates: string[] = [];
  graphQueries: GraphQuery[] = [];
  records: GraphRow[] = [];
  nodes: Row[] = [];
  override async selectQuery(query: any): Promise<any> {
    if (shapeOf(query) === OntologyGraph.shape.id) return this.records.map((r) => ({...r}));
    if (shapeOf(query) === OntologySync.shape.id) return this.nodes.map((n) => ({...n}));
    throw new Error(`unexpected select of ${shapeOf(query)}`);
  }
  override async graphQuery(query: GraphQuery): Promise<GraphResult> {
    this.graphQueries.push(query);
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
    expect(result).toEqual({written: ['sync-a', 'sync-b'], skipped: [], pruned: []});
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
    expect(result).toEqual({written: [], skipped: ['sync-a', 'sync-b'], pruned: []});
    expect(gs.graphQueries).toEqual([]);
    expect(gs.updates).toEqual([]);
  });

  test('a changed package is replaced whole, with its record; the unchanged one is left', async () => {
    gs.records = [recordOf('sync-a', 'old'), recordOf('sync-b')];
    const result = await syncOntologies(gs, {packages: ['sync-a', 'sync-b']});
    expect(result).toEqual({written: ['sync-a'], skipped: ['sync-b'], pruned: []});
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

  test("a written package's default-graph lines go, except those another node lists; then its node", async () => {
    // sync-a's node lists A ⊑ B, B ⊑ C and S ⊑ T; sync-gone's node (not in this run) lists S ⊑ T too.
    gs.nodes = [node('sync-a', [line('A', 'B'), line('B', 'C'), line('S', 'T')]), node('sync-gone', [line('S', 'T')])];
    const result = await syncOntologies(gs, {packages: ['sync-a']});
    expect(result.written).toEqual(['sync-a']);
    // The graph first, then the removals, the node last.
    expect(gs.graphQueries).toHaveLength(1);
    const removals = gs.updates.filter((u) => !u.includes('ontologySync/'));
    expect(removals).toHaveLength(2);
    expect(removals.join('\n')).toMatch(/DELETE \{[^}]*<http:\/\/example\.org\/sync\/A> rdfs:subClassOf <http:\/\/example\.org\/sync\/B>/);
    expect(removals.join('\n')).toMatch(/DELETE \{[^}]*<http:\/\/example\.org\/sync\/B> rdfs:subClassOf <http:\/\/example\.org\/sync\/C>/);
    expect(removals.join('\n')).not.toContain(`<${NS}S>`);
    for (const update of removals) expect(update).not.toMatch(/INSERT/);
    expect(gs.updates.at(-1)).toMatch(/DELETE/);
    expect(gs.updates.at(-1)).toContain('ontologySync/sync-a');
    expect(gs.updates.filter((u) => u.includes('ontologySync/sync-gone'))).toEqual([]);
  });

  test('a line two written packages listed goes with the second', async () => {
    gs.nodes = [node('sync-a', [line('S', 'T')]), node('sync-b', [line('S', 'T'), line('X', 'Y')])];
    await syncOntologies(gs, {packages: ['sync-a', 'sync-b']});
    const removalsOfS = gs.updates.filter((u) => /DELETE \{[^}]*<http:\/\/example\.org\/sync\/S> rdfs:subClassOf/.test(u));
    expect(removalsOfS).toHaveLength(1);
    // sync-a's node is gone before sync-b's removal, which then removes S ⊑ T.
    const nodeA = gs.updates.findIndex((u) => u.includes('ontologySync/sync-a'));
    expect(gs.updates.indexOf(removalsOfS[0])).toBeGreaterThan(nodeA);
  });

  test('an unchanged package still finishes the removal of its node', async () => {
    gs.records = [recordOf('sync-a')];
    gs.nodes = [node('sync-a', [line('A', 'B')])];
    const result = await syncOntologies(gs, {packages: ['sync-a']});
    expect(result.skipped).toEqual(['sync-a']);
    expect(gs.graphQueries).toEqual([]);
    expect(gs.updates).toHaveLength(2);
    expect(gs.updates.at(-1)).toContain('ontologySync/sync-a');
  });

  test("orphanScope 'all' removes the default-graph lines and node of a package no longer registered", async () => {
    gs.records = [recordOf('sync-a'), recordOf('sync-b')];
    gs.nodes = [node('sync-gone', [line('G', 'H')])];
    const result = await syncOntologies(gs, {orphanScope: 'all'});
    expect(result.pruned).toEqual(['sync-gone']);
    expect(gs.updates.some((u) => /DELETE \{[^}]*<http:\/\/example\.org\/sync\/G> rdfs:subClassOf/.test(u))).toBe(true);
    expect(gs.updates.at(-1)).toContain('ontologySync/sync-gone');
  });

  test('a graph write failure other than unsupported-query-kind is thrown, never a fallback', async () => {
    gs.graphQuery = async () => {
      throw new Error('store down');
    };
    await expect(syncOntologies(gs, {packages: ['sync-a']})).rejects.toThrow('store down');
    expect(gs.updates).toEqual([]);
  });

  test('a dataset without graphQuery takes the default-graph path', async () => {
    const legacy = new Recording();
    Object.defineProperty(legacy, 'graphQuery', {value: undefined});
    const result = await syncOntologies(legacy, {packages: ['sync-a']});
    expect(result.written).toEqual(['sync-a']);
    expect(legacy.graphQueries).toBe(0);
    // Exactly the default-graph updates: one per subject class, then the sync node; one node read.
    expect(legacy.selects).toBe(1);
    expect(legacy.updates).toHaveLength(3);
    expect(legacy.updates[2]).toContain('ontologySync/sync-a');
  });
});
