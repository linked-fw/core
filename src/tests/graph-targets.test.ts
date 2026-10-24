/*
 * Graph targets (`ontologyGraph`, `shapeGraph`): the checked values (keywords, absolute IRIs, the
 * env variables), the one global setting (`setGraphTargets` / `getGraphTargets`, no store or
 * `loadStores` path), the readers per mode
 * (`graphs.allOntologies` / `graphs.allShapes`), the default-graph sweep's SPARQL (golden), and the
 * blank-node analysis of the `'default'` mode.
 */
import {afterEach, describe, expect, jest, test} from '@jest/globals';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {
  getGraphTargets,
  graphTargetOptionsFromEnv,
  parseGraphTarget,
  parseGraphTargetOptions,
  setGraphTargets,
} from '../utils/graphTargets';
import {sharedStateKey} from '../utils/sharedState';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {expandReadGraphs} from '../utils/graphRegistryCache';
import {graphs} from '../ontologies/graphs';
import {coreOntology} from '../ontologies/linked-core';
import {defaultGraphTermsToSparql} from '../sparql/defaultGraphTerms';
import {defaultGraphTermsFromTurtle} from '../ontology/hierarchy';
import {loadStores} from '../utils/loadStores';
import {QueryBuilder} from '../queries/QueryBuilder';
import {NodeShape} from '../shapes/SHACL';
import '../shapes/index';

const SHARED = 'https://data.example.org/graph/ontology';

class Plain extends SparqlDataset {
  updates: string[] = [];
  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

describe('graph target values', () => {
  test('the keywords and absolute IRIs are taken; unset and empty mean unset', () => {
    expect(parseGraphTarget('package', 'ontologyGraph')).toBe('package');
    expect(parseGraphTarget('default', 'shapeGraph')).toBe('default');
    expect(parseGraphTarget(SHARED, 'ontologyGraph')).toBe(SHARED);
    expect(parseGraphTarget('urn:example:shapes', 'shapeGraph')).toBe('urn:example:shapes');
    expect(parseGraphTarget(undefined, 'ontologyGraph')).toBeUndefined();
    expect(parseGraphTarget('', 'ontologyGraph')).toBeUndefined();
  });

  test.each([
    ['Package'],
    ['packages'],
    ['graph/ontology'],
    ['/graph/ontology'],
    ['https://example.org/a b'],
    ['https://example.org/<x>'],
    ['1http://example.org/'],
  ])('%j is refused with a clear error', (value) => {
    expect(() => parseGraphTarget(value, 'ontologyGraph', 'env LINKED_ONTOLOGY_GRAPH')).toThrow(
      new RegExp(
        `^Invalid ontologyGraph ${JSON.stringify(value).replace(/[[\]\\^$.|?*+()<>/]/g, '\\$&')} \\(from env LINKED_ONTOLOGY_GRAPH\\): expected 'package'`,
      ),
    );
  });

  test('a value that is not a string, a portable graph name or a store-native name is refused', () => {
    expect(() => parseGraphTarget(42, 'shapeGraph')).toThrow(/^Invalid shapeGraph: expected 'package'.*got 42/);
    expect(() => parseGraphTarget(graphs.default, 'shapeGraph')).toThrow(/cannot be written/);
    expect(() => parseGraphTarget(graphs.registry, 'ontologyGraph')).toThrow(/cannot be written/);
    expect(() => parseGraphTarget('urn:x-arq:DefaultGraph', 'ontologyGraph')).toThrow(/cannot be written/);
    expect(() => parseGraphTarget('https://linked.cm/pkg/schema/graph/ontology', 'ontologyGraph')).toThrow(
      /a package's own graph/,
    );
  });

  test('the env variables are read from the map given, named in errors, and may not share one graph', () => {
    expect(graphTargetOptionsFromEnv({})).toEqual({});
    expect(graphTargetOptionsFromEnv({LINKED_ONTOLOGY_GRAPH: '', LINKED_SHAPE_GRAPH: 'default'})).toEqual({
      shapeGraph: 'default',
    });
    expect(graphTargetOptionsFromEnv({LINKED_ONTOLOGY_GRAPH: SHARED})).toEqual({ontologyGraph: SHARED});
    expect(() => graphTargetOptionsFromEnv({LINKED_SHAPE_GRAPH: 'shapes'})).toThrow(
      /^Invalid shapeGraph "shapes" \(from env LINKED_SHAPE_GRAPH\)/,
    );
    expect(() => graphTargetOptionsFromEnv({LINKED_ONTOLOGY_GRAPH: SHARED, LINKED_SHAPE_GRAPH: SHARED})).toThrow(
      /both name <https:\/\/data.example.org\/graph\/ontology>/,
    );
    expect(parseGraphTargetOptions({ontologyGraph: 'default', shapeGraph: 'default'})).toEqual({
      ontologyGraph: 'default',
      shapeGraph: 'default',
    });
  });
});

describe('the global setting', () => {
  afterEach(() => setGraphTargets({}));

  test("nothing set is 'package' for both", () => {
    expect(getGraphTargets()).toEqual({ontologyGraph: 'package', shapeGraph: 'package'});
  });

  test('each call is checked and replaces both settings; {} restores the default', () => {
    setGraphTargets({ontologyGraph: SHARED, shapeGraph: 'default'});
    expect(getGraphTargets()).toEqual({ontologyGraph: SHARED, shapeGraph: 'default'});
    setGraphTargets({shapeGraph: 'default'});
    expect(getGraphTargets()).toEqual({ontologyGraph: 'package', shapeGraph: 'default'});
    expect(() => setGraphTargets({ontologyGraph: 'x'})).toThrow(/^Invalid ontologyGraph "x"/);
    expect(() => setGraphTargets({ontologyGraph: SHARED, shapeGraph: SHARED})).toThrow(/both name/);
    // A refused call leaves the setting as it was.
    expect(getGraphTargets()).toEqual({ontologyGraph: 'package', shapeGraph: 'default'});
    setGraphTargets({});
    expect(getGraphTargets()).toEqual({ontologyGraph: 'package', shapeGraph: 'package'});
  });

  test('the state is on globalThis, so a second copy of core sees it', () => {
    setGraphTargets({ontologyGraph: 'default'});
    const state = (globalThis as Record<symbol, unknown>)[sharedStateKey('@_linked/core', 'graphTargets')];
    expect(state).toMatchObject({targets: {ontologyGraph: 'default', shapeGraph: 'package'}});
  });

  test('a store takes no targets: its options and the store methods are gone', () => {
    const store = new Plain({ontologyGraph: 'default'} as never) as unknown as Record<string, unknown>;
    expect(store.graphTargets).toBeUndefined();
    expect(store.setGraphTargets).toBeUndefined();
  });

  test('loadStores passes a config verbatim, sets no target, and warns about one', async () => {
    const HOOK = Symbol.for('@_linked/core:importModule');
    class Configured extends Plain {
      constructor(readonly config: unknown) {
        super();
      }
    }
    const previous = (globalThis as Record<symbol, unknown>)[HOOK];
    (globalThis as Record<symbol, unknown>)[HOOK] = async () => ({Configured});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stores = await loadStores<Configured>({
        datasets: {
          a: {store: 'fake/Configured', config: {ontologyGraph: 'default'}},
          b: {store: 'fake/Configured', config: {}},
        },
      });
      expect(stores.a.config).toEqual({ontologyGraph: 'default'});
      expect(getGraphTargets()).toEqual({ontologyGraph: 'package', shapeGraph: 'package'});
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining('alias "a" sets ontologyGraph in its config, which no store reads'),
      ]);
    } finally {
      warn.mockRestore();
      (globalThis as Record<symbol, unknown>)[HOOK] = previous;
    }
  });
});

describe('the readers follow the mode', () => {
  const PKG_ONT = 'https://linked.cm/pkg/a/graph/ontology';
  const PKG_SHAPES = 'https://linked.cm/pkg/a/graph/shapes';
  const registry = async () =>
    new Map([
      [PKG_ONT, new Set([coreOntology.OntologyGraph.id])],
      [PKG_SHAPES, new Set([coreOntology.ShapesGraph.id])],
    ]);
  const mapGraphName = (iri: string) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null);
  const expand = (names: string[], ontologyGraph: string, shapeGraph = 'package') => {
    setGraphTargets({ontologyGraph, shapeGraph});
    return expandReadGraphs(names, {registry, mapGraphName});
  };
  afterEach(() => setGraphTargets({}));

  test("'package': the registry's graphs of that kind", async () => {
    expect(await expand([graphs.allOntologies], 'package')).toEqual({defaultGraph: false, graphs: [PKG_ONT]});
    expect(await expand([graphs.allShapes], 'package')).toEqual({defaultGraph: false, graphs: [PKG_SHAPES]});
  });

  test('a shared IRI: that graph only, whatever else the registry lists', async () => {
    expect(await expand([graphs.allOntologies], SHARED)).toEqual({defaultGraph: false, graphs: [SHARED]});
    expect(await expand([graphs.allShapes, 'https://x/g'], 'package', 'urn:shapes')).toEqual({
      defaultGraph: false,
      graphs: ['urn:shapes', 'https://x/g'],
    });
  });

  test("'default': the default graph, alone or with other graphs", async () => {
    expect(await expand([graphs.allOntologies], 'default')).toEqual({defaultGraph: true});
    expect(await expand([graphs.allShapes, graphs.default], 'package', 'default')).toEqual({defaultGraph: true});
    expect(await expand([graphs.allShapes, 'https://x/g', graphs.default], 'package', 'default')).toEqual({
      defaultGraph: false,
      graphs: [graphs.default, 'https://x/g'],
    });
  });
});

describe("a store's reads follow the global setting", () => {
  class Recording extends SparqlDataset {
    selects: string[] = [];
    protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
      this.selects.push(sparql);
      return {head: {vars: []}, results: {bindings: []}};
    }
    protected async executeSparqlUpdate(): Promise<void> {}
  }
  type Exec = {exec: (ds: unknown) => Promise<unknown>};
  const readAllShapes = (store: Recording) =>
    (QueryBuilder.from(NodeShape).select([]).from(graphs.allShapes) as unknown as Exec).exec(store);
  afterEach(() => setGraphTargets({}));

  test('a shared IRI is read as that graph; the default graph as without .from()', async () => {
    const store = new Recording();
    setGraphTargets({shapeGraph: 'urn:example:shapes'});
    await readAllShapes(store);
    expect(store.selects.at(-1)).toContain('<urn:example:shapes>');
    setGraphTargets({shapeGraph: 'default'});
    await readAllShapes(store);
    expect(store.selects.at(-1)).not.toMatch(/GRAPH|FROM NAMED/);
  });
});

describe('the default-graph sweep', () => {
  const request = {
    namespaces: ['http://example.org/ont/', 'http://example.org/vocab#'],
    subjects: ['http://example.org/other#Thing', 'https://linked.cm/pkg/core/ontology-sync/default-graph'],
    insert: '<http://example.org/ont/A> <http://www.w3.org/2000/01/rdf-schema#label> "A" .\n',
  };

  test('golden SPARQL', () => {
    const golden = readFileSync(path.resolve(process.cwd(), 'src/tests/fixtures/default-graph-terms.sparql'), 'utf8');
    expect(defaultGraphTermsToSparql(request)).toBe(golden.trimEnd());
  });

  test('a delete alone, an insert alone, and nothing', () => {
    expect(defaultGraphTermsToSparql({...request, insert: ''})).not.toContain('INSERT DATA');
    expect(defaultGraphTermsToSparql({namespaces: [], subjects: [], insert: request.insert})).toBe(
      `INSERT DATA {\n${request.insert.trim()}\n}`,
    );
    expect(defaultGraphTermsToSparql({namespaces: [], subjects: [], insert: ''})).toBe('');
  });

  test('an unsafe IRI or an empty namespace is refused', () => {
    expect(() => defaultGraphTermsToSparql({namespaces: [], subjects: ['http://x/a>b'], insert: ''})).toThrow(/Invalid IRI/);
    expect(() => defaultGraphTermsToSparql({namespaces: [''], subjects: [], insert: ''})).toThrow(/empty namespace/);
  });

  test('a store sends it as one update', async () => {
    const store = new Plain();
    await store.replaceDefaultGraphTerms(request);
    expect(store.updates).toEqual([defaultGraphTermsToSparql(request)]);
    await store.replaceDefaultGraphTerms({namespaces: [], subjects: [], insert: ''});
    expect(store.updates).toHaveLength(1);
  });
});

describe('the blank-node analysis of the default mode', () => {
  const P = '@prefix ex: <http://example.org/ont/> . @prefix owl: <http://www.w3.org/2002/07/owl#> .\n';

  test('subjects, N-Triples, and the depth of a restriction in a union in a restriction', async () => {
    const data = await defaultGraphTermsFromTurtle(
      [
        P +
          'ex:A a owl:Class ; owl:equivalentClass [ a owl:Restriction ; owl:onProperty ex:p ; ' +
          'owl:someValuesFrom [ owl:unionOf ( ex:B [ a owl:Restriction ; owl:onProperty ex:q ; owl:hasValue ex:v ] ex:C ) ] ] .\n' +
          'ex:B a owl:Class .',
      ],
      undefined,
      'p0_',
    );
    expect(data.subjects).toEqual(['http://example.org/ont/A', 'http://example.org/ont/B']);
    // restriction (1) → union class (2) → the list cells (3, along rdf:rest) → the inner restriction (4).
    expect(data.blankDepth).toBe(4);
    expect(data.unanchoredBlankNodes).toBe(0);
    expect(data.nTriples).toMatch(/^<http:\/\/example.org\/ont\/A> <http:\/\/www.w3.org\/1999\/02\/22-rdf-syntax-ns#type>/);
    expect(data.nTriples).toContain(' _:');
  });

  test('a blank node no IRI reaches is counted', async () => {
    const data = await defaultGraphTermsFromTurtle([P + '[] a owl:AllDisjointClasses ; owl:members ( ex:A ex:B ) .']);
    expect(data.subjects).toEqual([]);
    expect(data.unanchoredBlankNodes).toBe(3);
  });
});
