/*
 * The ontology sync against a recording store: per-class diff updates then the sync node; an
 * unchanged package writes nothing; a changed one removes only what no other package lists;
 * force, packages, orphan pruning; the hash vector.
 */
import {beforeEach, describe, expect, jest, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {
  ontologySyncHash,
  ontologySyncNodeIri,
  ontologyTriplesText,
  syncOntologies,
} from '../ontology/syncOntologies';
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

/** Records updates; answers the sync-node select from `nodes`. */
class Recording extends SparqlDataset {
  updates: string[] = [];
  selects = 0;
  nodes: Row[] = [];
  override async selectQuery(query: any): Promise<any> {
    this.selects++;
    return this.nodes.map((n) => ({...n}));
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

let ds: Recording;
beforeEach(() => {
  ds = new Recording();
  data['sync-a'] = ttl(['A', 'B'], ['B', 'C']);
  data['sync-b'] = ttl(['X', 'Y']);
});

const updatesFor = (subject: string) =>
  ds.updates.filter((u) => !u.includes('ontologySync/') && u.includes(`<${NS}${subject}> `));
const nodeWrites = () => ds.updates.filter((u) => u.includes('ontologySync/'));

describe('syncOntologies', () => {
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
    expect(ds.selects).toBe(1);
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

  test('force rewrites an unchanged package', async () => {
    ds.nodes = [node('sync-a', [line('A', 'B'), line('B', 'C')])];
    const result = await syncOntologies(ds, {packages: ['sync-a'], force: true});
    expect(result.written).toEqual(['sync-a']);
    // Nothing to add or remove: only the sync node.
    expect(ds.updates).toHaveLength(1);
    expect(nodeWrites()).toHaveLength(1);
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
