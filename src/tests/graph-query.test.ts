/*
 * Graph queries without a store: the wire check, the typed refusals, the runtime guard for a
 * dataset without graphQuery, routing by the record shape, and the graph API's statics (each
 * call → exactly one GraphQuery).
 */
import {afterEach, describe, expect, test} from '@jest/globals';
import {
  assertGraphWritable,
  GraphQueryError,
  isGraphQueryError,
  parseGraphQuery,
} from '../queries/graphQuery';
import type {GraphContent, GraphQuery, GraphResult} from '../queries/IntermediateRepresentation';
import {resolveGraphQuery} from '../queries/queryDispatch';
import {fromJSON} from '../queries/fromJSON';
import {LinkedStorage} from '../utils/LinkedStorage';
import {graphs} from '../ontologies/graphs';
import type {IDataset} from '../interfaces/IDataset';
import {unusedDatasetMethods} from '../test-helpers/test-utils';
import {DraftGraph, NamedGraph, OntologyGraph, ShapesGraph} from '../shapes/NamedGraph';
import {lower} from '../queries/lower';
import {CountBuilder} from '../queries/CountBuilder';
import {selectToSparql, countToSparql} from '../sparql/irToAlgebra';
import {builtInShapeIris} from '../utils/ShapeCatalog';
import {getNodeShapeUri} from '../shapes/SHACL';

const G = 'https://linked.cm/pkg/example/graph/ontology';
const ONTOLOGY_GRAPH = 'https://linked.cm/ont/core/OntologyGraph';

/** A dataset that records the graph queries it receives. */
function graphStore() {
  const received: GraphQuery[] = [];
  const store: IDataset = {
    ...unusedDatasetMethods,
    selectQuery: async () => [] as any,
    graphQuery: async (q: GraphQuery): Promise<GraphResult> => {
      received.push(q);
      return {graph: q.graph, changed: true};
    },
  };
  return {store, received};
}

describe('parseGraphQuery', () => {
  const query: GraphQuery = {
    kind: 'graph_replace',
    graph: G,
    recordClass: ONTOLOGY_GRAPH,
    record: {version: '1.7.0'},
    content: {mediaType: 'application/n-triples', text: '<urn:a> <urn:b> <urn:c> .\n'},
    contentHash: 'abc',
  };

  test('a graph query survives a JSON round trip unchanged', () => {
    const wire = JSON.parse(JSON.stringify({v: '1.1', ...query}));
    expect(parseGraphQuery(wire)).toEqual(query);
  });

  test('a patch round-trips', () => {
    const patch: GraphQuery = {
      kind: 'graph_patch',
      graph: G,
      recordClass: ONTOLOGY_GRAPH,
      patch: {
        insert: {mediaType: 'text/turtle', text: '<urn:a> <urn:b> <urn:c> .'},
        delete: {mediaType: 'application/n-triples', text: '<urn:a> <urn:b> <urn:d> .'},
      },
    };
    expect(parseGraphQuery(JSON.parse(JSON.stringify(patch)))).toEqual(patch);
  });

  test('unknown fields are dropped', () => {
    expect(parseGraphQuery({...query, extra: 1})).toEqual(query);
  });

  test.each([
    [{...query, kind: 'graph_load'}, /kind must be one of/],
    [{...query, graph: 'not an iri'}, /graph must be an absolute IRI/],
    [{...query, graph: 'urn:x> } ; DROP ALL ; INSERT DATA { <urn:y'}, /graph must be an absolute IRI/],
    [{...query, recordClass: 7}, /recordClass must be an absolute IRI/],
    [{...query, content: {mediaType: 'application/ld+json', text: '{}'}}, /mediaType must be one of/],
    [{...query, content: undefined}, /graph_replace needs content/],
    [{...query, kind: 'graph_drop'}, /content is only for/],
    [{kind: 'graph_create', graph: G, recordClass: ONTOLOGY_GRAPH, patch: {}}, /patch is only for graph_patch/],
    [{...query, record: ['a']}, /record must be an object/],
    [{...query, v: '2.0'}, /Unsupported DSL-JSON wire version/],
  ])('refuses a malformed query (%#)', (json, message) => {
    expect(() => parseGraphQuery(json)).toThrow(message);
  });

  test('fromJSON refuses a graph query and names parseGraphQuery', () => {
    expect(() => fromJSON(query as any)).toThrow(/parseGraphQuery/);
  });
});

describe('refusals', () => {
  test.each(Object.entries(graphs))('a write to graphs.%s is refused as read-only', (_name, iri) => {
    let err: unknown;
    try {
      assertGraphWritable(iri);
    } catch (e) {
      err = e;
    }
    expect(isGraphQueryError(err, 'graph-name-read-only')).toBe(true);
  });

  test('a package graph is writable', () => {
    expect(() => assertGraphWritable(G)).not.toThrow();
  });

  test('isGraphQueryError matches the brand of another copy', () => {
    const foreign = Object.create(
      Object.assign(Object.create(Error.prototype), {
        [Symbol.for('@_linked/core:GraphQueryError')]: true,
      }),
    );
    foreign.code = 'graph-exists';
    expect(isGraphQueryError(foreign)).toBe(true);
    expect(isGraphQueryError(foreign, 'graph-exists')).toBe(true);
    expect(isGraphQueryError(foreign, 'graph-not-registered')).toBe(false);
    expect(isGraphQueryError(new Error('x'))).toBe(false);
  });
});

describe('the runtime guard and routing', () => {
  const q: GraphQuery = {kind: 'graph_drop', graph: G, recordClass: ONTOLOGY_GRAPH};

  test('a dataset without graphQuery is refused with unsupported-query-kind', async () => {
    const old = {selectQuery: async () => []};
    const err = await resolveGraphQuery(old as any, q).catch((e) => e);
    expect(err).toBeInstanceOf(GraphQueryError);
    expect(isGraphQueryError(err, 'unsupported-query-kind')).toBe(true);
    expect(err.graph).toBe(G);
  });

  test('LinkedStorage applies the same guard to the routed dataset', async () => {
    LinkedStorage.setDefaultDataset({selectQuery: async () => []} as any);
    const err = await LinkedStorage.graphQuery(q).catch((e) => e);
    expect(isGraphQueryError(err, 'unsupported-query-kind')).toBe(true);
  });

  test('LinkedStorage sends a graph query to the default dataset when nothing is pinned', async () => {
    const {store, received} = graphStore();
    LinkedStorage.setDefaultDataset(store);
    await expect(LinkedStorage.graphQuery(q)).resolves.toEqual({graph: G, changed: true});
    expect(received).toEqual([q]);
  });
});

describe('the graph API', () => {
  const nt: GraphContent = {mediaType: 'application/n-triples', text: '<urn:a> <urn:b> <urn:c> .\n'};
  const DRAFT_GRAPH = 'https://linked.cm/ont/core/DraftGraph';
  const NAMED_GRAPH = 'http://www.w3.org/ns/sparql-service-description#NamedGraph';

  /** Run `call` against a recording target and return the queries it sent. */
  async function sent(call: (target: IDataset) => Promise<unknown>): Promise<GraphQuery[]> {
    const {store, received} = graphStore();
    await call(store);
    return received;
  }

  test('iriFor builds package graph IRIs', () => {
    expect(OntologyGraph.iriFor('@_linked/schema')).toBe('https://linked.cm/pkg/schema/graph/ontology');
    expect(ShapesGraph.iriFor('@_linked/core')).toBe('https://linked.cm/pkg/core/graph/shapes');
  });

  test('create(...).withContent(c) is one graph_create with the own fields', async () => {
    const queries = await sent((t) =>
      OntologyGraph.create({id: G, package: '@_linked/example', version: '1.0.0'}).withContent(nt).exec(t),
    );
    expect(queries).toEqual([
      {
        kind: 'graph_create',
        graph: G,
        recordClass: ONTOLOGY_GRAPH,
        record: {package: '@_linked/example', version: '1.0.0'},
        content: nt,
      },
    ]);
  });

  test('create without content registers an empty graph', async () => {
    const queries = await sent((t) => DraftGraph.create({id: G}).exec(t));
    expect(queries).toEqual([{kind: 'graph_create', graph: G, recordClass: DRAFT_GRAPH, record: {}}]);
  });

  test('update(iri).set() alone is one graph_patch with a record and no body', async () => {
    const queries = await sent((t) => OntologyGraph.update(G).set({version: '2.0.0'}).exec(t));
    expect(queries).toEqual([
      {kind: 'graph_patch', graph: G, recordClass: ONTOLOGY_GRAPH, record: {version: '2.0.0'}},
    ]);
  });

  test('update(iri).set().replaceContent(c) is one graph_replace', async () => {
    const queries = await sent((t) =>
      OntologyGraph.update(G).set({version: '2.0.0'}).replaceContent(nt, {contentHash: 'h1'}).exec(t),
    );
    expect(queries).toEqual([
      {
        kind: 'graph_replace',
        graph: G,
        recordClass: ONTOLOGY_GRAPH,
        record: {version: '2.0.0'},
        content: nt,
        contentHash: 'h1',
      },
    ]);
  });

  test('update(iri).set().patchContent(p) is one graph_patch with record and patch', async () => {
    const queries = await sent((t) =>
      OntologyGraph.update(G).set({version: '2.0.0'}).patchContent({insert: nt}).exec(t),
    );
    expect(queries).toEqual([
      {kind: 'graph_patch', graph: G, recordClass: ONTOLOGY_GRAPH, record: {version: '2.0.0'}, patch: {insert: nt}},
    ]);
  });

  test('replaceContent, patchContent and delete on NamedGraph', async () => {
    const queries = await sent(async (t) => {
      await NamedGraph.replaceContent(G, nt).exec(t);
      await NamedGraph.patchContent(G, {delete: nt}, {contentHash: 'file'}).exec(t);
      await OntologyGraph.delete(G).exec(t);
    });
    expect(queries).toEqual([
      {kind: 'graph_replace', graph: G, recordClass: NAMED_GRAPH, content: nt},
      {kind: 'graph_patch', graph: G, recordClass: NAMED_GRAPH, patch: {delete: nt}, contentHash: 'file'},
      {kind: 'graph_drop', graph: G, recordClass: ONTOLOGY_GRAPH},
    ]);
  });

  test('awaiting a builder sends it through LinkedStorage, routed by the record shape', async () => {
    const fallback = graphStore();
    const pinned = graphStore();
    LinkedStorage.setDefaultDataset(fallback.store);
    LinkedStorage.setDatasetForShapes(pinned.store, NamedGraph);
    await OntologyGraph.delete(G);
    expect(pinned.received).toHaveLength(1);
    expect(fallback.received).toHaveLength(0);
  });

  test('a write to a portable name is refused before anything is sent', async () => {
    const {store, received} = graphStore();
    const err = await NamedGraph.replaceContent(graphs.union, nt).exec(store).catch((e) => e);
    expect(isGraphQueryError(err, 'graph-name-read-only')).toBe(true);
    const reg = await OntologyGraph.delete(graphs.registry).exec(store).catch((e) => e);
    expect(isGraphQueryError(reg, 'graph-name-read-only')).toBe(true);
    expect(received).toHaveLength(0);
  });

  test('a call in a browser is refused; the import is not', async () => {
    const g = globalThis as Record<string, unknown>;
    g.window = {};
    g.document = {};
    try {
      const {store, received} = graphStore();
      await expect(OntologyGraph.delete(G).exec(store)).rejects.toThrow(/server only/);
      expect(received).toHaveLength(0);
    } finally {
      delete g.window;
      delete g.document;
    }
  });

  test("Shape's other mutation statics are refused on graph records", () => {
    expect(() => NamedGraph.upsert()).toThrow(/graph queries/);
    expect(() => OntologyGraph.deleteAll()).toThrow(/graph queries/);
    expect(() => OntologyGraph.deleteWhere()).toThrow(/graph queries/);
  });

  test('the four graph-record shapes are built-ins', () => {
    for (const name of ['NamedGraph', 'OntologyGraph', 'ShapesGraph', 'DraftGraph']) {
      expect(builtInShapeIris()).toContain(getNodeShapeUri('@_linked/core', name));
    }
  });

  test('select, count and ask of a graph-record shape read the registry', async () => {
    const select = lower(NamedGraph.select((r) => [r.name, r.contentHash]) as any);
    expect(selectToSparql(select as any)).toContain(`GRAPH <${graphs.registry}>`);
    const count = lower(CountBuilder.of({shapeClass: OntologyGraph as any}));
    expect(countToSparql(count as any)).toContain(`GRAPH <${graphs.registry}>`);
  });
});

afterEach(() => {
  for (const shape of [...LinkedStorage.getShapeToDatasetMap().keys()]) {
    LinkedStorage.unsetDatasetForShape(shape);
  }
});
