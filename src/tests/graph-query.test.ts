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
import type {GraphQuery, GraphResult} from '../queries/IntermediateRepresentation';
import {resolveGraphQuery} from '../queries/queryDispatch';
import {fromJSON} from '../queries/fromJSON';
import {LinkedStorage} from '../utils/LinkedStorage';
import {graphs} from '../ontologies/graphs';
import type {IDataset} from '../interfaces/IDataset';
import {unusedDatasetMethods} from '../test-helpers/test-utils';

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

afterEach(() => {
  for (const shape of [...LinkedStorage.getShapeToDatasetMap().keys()]) {
    LinkedStorage.unsetDatasetForShape(shape);
  }
});
