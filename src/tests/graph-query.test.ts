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
import {graphCreateOutcomeAnswer, unusedDatasetMethods} from '../test-helpers/test-utils';
import {ComponentsGraph, DraftGraph, NamedGraph, OntologyGraph, ShapesGraph} from '../shapes/NamedGraph';
import {lower} from '../queries/lower';
import {CountBuilder} from '../queries/CountBuilder';
import {selectToSparql, countToSparql} from '../sparql/irToAlgebra';
import {builtInShapeIris} from '../utils/ShapeCatalog';
import {getNodeShapeUri} from '../shapes/SHACL';
import {SparqlDataset} from '../sparql/SparqlDataset';
import {sha256Hex} from '../utils/sha256';

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
    [{kind: 'graph_create', graph: G, recordClass: ONTOLOGY_GRAPH, patch: {insert: {mediaType: 'text/turtle', text: ''}}}, /patch is only for graph_patch/],
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

  test('a ComponentsGraph records its package, version and commit', async () => {
    const commit = 'a'.repeat(40);
    const queries = await sent(async (t) => {
      await ComponentsGraph.create({id: G, package: '@_linked/example', version: '1.0.0'}).withContent(nt).exec(t);
      await ComponentsGraph.update(G).set({commit}).replaceContent(nt).exec(t);
    });
    expect(queries).toEqual([
      {
        kind: 'graph_create',
        graph: G,
        recordClass: 'https://linked.cm/ont/core/ComponentsGraph',
        record: {package: '@_linked/example', version: '1.0.0'},
        content: nt,
      },
      {
        kind: 'graph_replace',
        graph: G,
        recordClass: 'https://linked.cm/ont/core/ComponentsGraph',
        record: {commit},
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

  test('the five graph-record shapes are built-ins', () => {
    for (const name of ['NamedGraph', 'OntologyGraph', 'ShapesGraph', 'ComponentsGraph', 'DraftGraph']) {
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

describe('SparqlDataset.graphQuery', () => {
  const REG = graphs.registry;
  const nt: GraphContent = {mediaType: 'application/n-triples', text: '<urn:a> <urn:b> "x\\ny" .\n'};
  const ttl: GraphContent = {
    mediaType: 'text/turtle',
    text: '@prefix ex: <http://example.org/> .\nex:A a ex:Class ; ex:label "A"@en .',
  };

  /**
   * A SPARQL dataset that records what it sends and answers the registry ASK as told; a create's
   * outcome read finds its claim unless the graph is registered (or `populated`).
   */
  class RecordingSparql extends SparqlDataset {
    updates: string[] = [];
    asks: string[] = [];
    constructor(
      private registered: boolean,
      private populated = false,
    ) {
      super();
    }
    protected async executeSparqlSelect(sparql: string): Promise<any> {
      this.asks.push(sparql);
      const outcome = graphCreateOutcomeAnswer(sparql, {registered: this.registered, populated: this.populated});
      if (outcome) return outcome;
      return {head: {}, boolean: this.registered};
    }
    protected async executeSparqlUpdate(sparql: string): Promise<void> {
      this.updates.push(sparql);
    }
  }

  test('graph_create: one conditional update with the body and the whole record, then its outcome', async () => {
    const ds = new RecordingSparql(false);
    const result = await OntologyGraph.create({id: G, package: '@_linked/example', version: '1.0.0'})
      .withContent(ttl)
      .exec(ds);
    const NAME = 'http://www.w3.org/ns/sparql-service-description#name';
    const CLAIM = 'https://linked.cm/ont/core/graphCreateClaim';
    expect(ds.updates).toHaveLength(2);
    const [update, cleanup] = ds.updates;
    const ops = update.split(' ;\n');
    const free =
      `FILTER NOT EXISTS { GRAPH <${REG}> { <${G}> <${NAME}> <${G}> } } ` +
      `FILTER NOT EXISTS { GRAPH <${G}> { ?s_c ?p_c ?o_c } }`;
    expect(ops[0]).toBe(
      `DELETE { GRAPH <${REG}> { <${G}> ?p_r ?o_r } } WHERE { GRAPH <${REG}> { <${G}> ?p_r ?o_r } ${free} }`,
    );
    expect(ops[1].startsWith(`INSERT { GRAPH <${G}> {\n`)).toBe(true);
    expect(ops[1].endsWith(` } WHERE { ${free} }`)).toBe(true);
    expect(ops).toHaveLength(2);
    expect(update).not.toContain('DROP');
    expect(update).toContain('<http://example.org/A> <http://example.org/label> "A"@en .');
    const claim = /<https:\/\/linked\.cm\/ont\/core\/graphCreateClaim> "([^"]+)"/.exec(update)![1];
    expect(ds.asks).toEqual([expect.stringContaining(`"${claim}"`)]);
    expect(ds.asks[0].startsWith('SELECT ?claimed ?registered ?populated')).toBe(true);
    expect(cleanup).toBe(`DELETE DATA { GRAPH <${REG}> { <${G}> <${CLAIM}> "${claim}" } }`);
    expect(update).toContain(`a <${ONTOLOGY_GRAPH}>`);
    expect(update).toContain(`<http://www.w3.org/ns/sparql-service-description#name> <${G}>`);
    expect(update).toContain('<https://linked.cm/ont/core/feedsHierarchy> "true"^^<http://www.w3.org/2001/XMLSchema#boolean>');
    expect(update).toContain('<https://linked.cm/ont/core/package> "@_linked/example"');
    expect(update).toContain(`<https://linked.cm/ont/core/contentHash> "${sha256Hex(ttl.text)}"`);
    expect(update).toContain(`<http://purl.org/dc/terms/modified> "${result.modified}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`);
    expect(result).toMatchObject({graph: G, contentHash: sha256Hex(ttl.text), changed: true});
  });

  test('graph_create of a registered graph is refused with graph-exists; its update wrote nothing', async () => {
    const ds = new RecordingSparql(true);
    const err = await OntologyGraph.create({id: G, package: 'p'}).exec(ds).catch((e) => e);
    expect(isGraphQueryError(err, 'graph-exists')).toBe(true);
    expect((err as Error).message).toMatch(/already registered/);
    expect(ds.updates).toHaveLength(1); // the conditional update only: no claim to remove
  });

  test('graph_create of a graph that holds triples without a record is refused with graph-exists', async () => {
    const ds = new RecordingSparql(false, true);
    const err = await NamedGraph.create({id: G}).withContent(nt).exec(ds).catch((e) => e);
    expect(isGraphQueryError(err, 'graph-exists')).toBe(true);
    expect((err as Error).message).toMatch(/holds triples but has no record/);
    expect(ds.updates).toHaveLength(1);
  });

  test('graph_replace and graph_patch of an unregistered graph are refused', async () => {
    const ds = new RecordingSparql(false);
    for (const call of [
      () => NamedGraph.replaceContent(G, nt).exec(ds),
      () => NamedGraph.patchContent(G, {insert: nt}).exec(ds),
      () => OntologyGraph.update(G).set({version: '2'}).exec(ds),
    ]) {
      expect(isGraphQueryError(await call().catch((e) => e), 'graph-not-registered')).toBe(true);
    }
    expect(ds.updates).toEqual([]);
  });

  test("graph_replace: the master plan's update, plus the own fields passed", async () => {
    const ds = new RecordingSparql(true);
    await OntologyGraph.update(G).set({version: '2.0.0'}).replaceContent(nt, {contentHash: 'filehash'}).exec(ds);
    const ops = ds.updates[0].split(' ;\n');
    // Every operation runs only while the record exists: a replace that loses a race with a drop
    // writes nothing, so no half record is left.
    const rec = `GRAPH <${REG}> { <${G}> <http://www.w3.org/ns/sparql-service-description#name> <${G}> ; a <${ONTOLOGY_GRAPH}> }`;
    expect(ops[0]).toBe(
      `DELETE { GRAPH <${G}> { ?s_c ?p_c ?o_c } } WHERE { ${rec} GRAPH <${G}> { ?s_c ?p_c ?o_c } }`,
    );
    expect(ops[1]).toBe(`INSERT { GRAPH <${G}> {\n<urn:a> <urn:b> "x\\ny" .\n} } WHERE { FILTER EXISTS { ${rec} } }`);
    const field = (p: string, n: number) => `GRAPH <${REG}> { <${G}> <${p}> ?v${n} }`;
    expect(ops.slice(2, 5)).toEqual([
      `DELETE { ${field('https://linked.cm/ont/core/contentHash', 0)} } WHERE { ${rec} ${field('https://linked.cm/ont/core/contentHash', 0)} }`,
      `DELETE { ${field('http://purl.org/dc/terms/modified', 1)} } WHERE { ${rec} ${field('http://purl.org/dc/terms/modified', 1)} }`,
      `DELETE { ${field('https://linked.cm/ont/core/version', 2)} } WHERE { ${rec} ${field('https://linked.cm/ont/core/version', 2)} }`,
    ]);
    expect(ops[5].endsWith(`WHERE { FILTER EXISTS { ${rec} } }`)).toBe(true);
    expect(ops[5]).toContain('"filehash"');
    expect(ops[5]).toContain('<https://linked.cm/ont/core/version> "2.0.0"');
    expect(ops).toHaveLength(6);
  });

  test('graph_patch: DELETE DATA then INSERT DATA, and a new hash', async () => {
    const ds = new RecordingSparql(true);
    const del: GraphContent = {mediaType: 'application/n-triples', text: '<urn:a> <urn:b> <urn:old> .'};
    const result = await NamedGraph.patchContent(G, {insert: nt, delete: del}).exec(ds);
    const ops = ds.updates[0].split(' ;\n');
    const rec = `GRAPH <${REG}> { <${G}> <http://www.w3.org/ns/sparql-service-description#name> <${G}> }`;
    expect(ops[0]).toBe(`DELETE { GRAPH <${G}> {\n<urn:a> <urn:b> <urn:old> .\n} } WHERE { ${rec} }`);
    expect(ops[1]).toContain(`INSERT { GRAPH <${G}> {`);
    expect(ops[1].endsWith(`WHERE { FILTER EXISTS { ${rec} } }`)).toBe(true);
    expect(result.contentHash).toBe(sha256Hex(`${del.text}\n${nt.text}`));
    expect(ops.join('\n')).not.toContain('version');
  });

  test('graph_patch record only: own fields, hash and modified kept; a change of the record', async () => {
    const ds = new RecordingSparql(true);
    const result = await OntologyGraph.update(G).set({version: '3'}).exec(ds);
    const rec = `GRAPH <${REG}> { <${G}> <http://www.w3.org/ns/sparql-service-description#name> <${G}> ; a <${ONTOLOGY_GRAPH}> }`;
    const field = `GRAPH <${REG}> { <${G}> <https://linked.cm/ont/core/version> ?v0 }`;
    expect(ds.updates).toEqual([
      `DELETE { ${field} } WHERE { ${rec} ${field} } ;\n` +
        `INSERT { GRAPH <${REG}> { <${G}> <https://linked.cm/ont/core/version> "3"^^<http://www.w3.org/2001/XMLSchema#string> . } } WHERE { FILTER EXISTS { ${rec} } }`,
    ]);
    expect(result).toEqual({graph: G, changed: true});
  });

  test('an update with neither a body nor a field writes nothing and is no change', async () => {
    const ds = new RecordingSparql(true);
    const result = await ds.graphQuery({kind: 'graph_patch', graph: G, recordClass: ONTOLOGY_GRAPH});
    expect(ds.updates).toEqual([]);
    expect(result).toEqual({graph: G, changed: false});
  });

  test('graph_create with an empty list field leaves the field out', async () => {
    const ds = new RecordingSparql(false);
    await OntologyGraph.create({id: G, package: 'p', sources: []}).withContent(ttl).exec(ds);
    expect(ds.updates[0]).not.toContain('<http://purl.org/dc/terms/source>');
    expect(ds.updates[0]).toContain('<https://linked.cm/ont/core/package> "p"');
  });

  test('graph_patch setting a list field to empty deletes its values and inserts nothing for it', async () => {
    const ds = new RecordingSparql(true);
    await OntologyGraph.update(G).set({sources: []}).exec(ds);
    const rec = `GRAPH <${REG}> { <${G}> <http://www.w3.org/ns/sparql-service-description#name> <${G}> ; a <${ONTOLOGY_GRAPH}> }`;
    const field = `GRAPH <${REG}> { <${G}> <http://purl.org/dc/terms/source> ?v0 }`;
    expect(ds.updates).toEqual([`DELETE { ${field} } WHERE { ${rec} ${field} }`]);
  });

  test('graph_drop: the graph and its record, no registry check', async () => {
    const ds = new RecordingSparql(false);
    await OntologyGraph.delete(G).exec(ds);
    expect(ds.asks).toEqual([]);
    expect(ds.updates).toEqual([
      `DROP SILENT GRAPH <${G}> ;\nDELETE WHERE { GRAPH <${REG}> { <${G}> ?p ?o } }`,
    ]);
  });

  test('a store refuses a portable name even when the query arrives raw', async () => {
    const ds = new RecordingSparql(true);
    const err = await ds
      .graphQuery({kind: 'graph_replace', graph: graphs.union, recordClass: ONTOLOGY_GRAPH, content: nt})
      .catch((e) => e);
    expect(isGraphQueryError(err, 'graph-name-read-only')).toBe(true);
    const unknown = await ds.graphQuery({kind: 'graph_load', graph: G, recordClass: ONTOLOGY_GRAPH} as any).catch((e) => e);
    expect(isGraphQueryError(unknown, 'unsupported-query-kind')).toBe(true);
  });

  test('bodies are parsed: invalid text, quads and relative IRIs are refused', async () => {
    const ds = new RecordingSparql(true);
    const replace = (content: GraphContent) => NamedGraph.replaceContent(G, content).exec(ds).catch((e) => e);
    expect(String(await replace({mediaType: 'application/n-triples', text: '} } ; DROP ALL ; INSERT DATA { {'})))
      .toMatch(/not valid N-Triples/);
    expect(String(await replace({mediaType: 'text/turtle', text: '<rel> <urn:p> <urn:o> .'}))).toMatch(/IRI/);
    expect(ds.updates).toEqual([]);
  });

  test('graph_patch deletes a blank-node structure as a pattern through its IRI subject (CBD)', async () => {
    const ds = new RecordingSparql(true);
    const del: GraphContent = {
      mediaType: 'text/turtle',
      text:
        '<urn:ps> <urn:label> "kids" ; <http://www.w3.org/ns/shacl#path> [ <http://www.w3.org/ns/shacl#inversePath> <urn:parent> ] .\n' +
        '<urn:seq> <http://www.w3.org/ns/shacl#path> ( <urn:a> [ <http://www.w3.org/ns/shacl#inversePath> <urn:b> ] ) .',
    };
    const insert: GraphContent = {
      mediaType: 'text/turtle',
      text: '<urn:ps> <http://www.w3.org/ns/shacl#path> [ <http://www.w3.org/ns/shacl#inversePath> <urn:mother> ] .',
    };
    await NamedGraph.patchContent(G, {delete: del, insert}).exec(ds);
    const ops = ds.updates[0].split(' ;\n');
    const SH = 'http://www.w3.org/ns/shacl#';
    const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const rec = `GRAPH <${REG}> { <${G}> <http://www.w3.org/ns/sparql-service-description#name> <${G}> }`;
    expect(ops[0]).toBe(`DELETE { GRAPH <${G}> {\n<urn:ps> <urn:label> "kids" .\n} } WHERE { ${rec} }`);
    const inv = `<urn:ps> <${SH}path> ?b0 . ?b0 <${SH}inversePath> <urn:parent> .`;
    expect(ops[1]).toBe(
      `DELETE { GRAPH <${G}> { ${inv} } } WHERE { ${rec} GRAPH <${G}> { ${inv} } FILTER(isBlank(?b0)) }`,
    );
    const seq =
      `<urn:seq> <${SH}path> ?b0 . ?b0 <${RDF}first> <urn:a> . ?b0 <${RDF}rest> ?b1 . ` +
      `?b1 <${RDF}first> ?b2 . ?b1 <${RDF}rest> <${RDF}nil> . ?b2 <${SH}inversePath> <urn:b> .`;
    expect(ops[2]).toBe(
      `DELETE { GRAPH <${G}> { ${seq} } } WHERE { ${rec} GRAPH <${G}> { ${seq} } FILTER(isBlank(?b0) && isBlank(?b1) && isBlank(?b2)) }`,
    );
    expect(ops[3].startsWith(`INSERT { GRAPH <${G}> {\n`)).toBe(true);
    expect(ops[3]).toContain(`<${SH}inversePath> <urn:mother>`);
    expect(ops).toHaveLength(4 + 3); // + the record's hash and modified time
  });

  test('a blank node shared by two triples or reached from no IRI subject cannot be deleted', async () => {
    const ds = new RecordingSparql(true);
    const patch = (text: string) =>
      NamedGraph.patchContent(G, {delete: {mediaType: 'text/turtle', text}}).exec(ds).catch((e) => e);
    expect(String(await patch('<urn:s> <urn:p> _:x . <urn:t> <urn:p> _:x .'))).toMatch(/more than one triple/);
    expect(String(await patch('_:x <urn:p> <urn:o> .'))).toMatch(/no IRI subject reaches/);
    expect(String(await patch('_:x <urn:p> _:y . _:y <urn:p> _:x .'))).toMatch(/no IRI subject reaches/);
    expect(ds.updates).toEqual([]);
  });

  test('unknown record classes and fields are refused', async () => {
    const ds = new RecordingSparql(false);
    const cls = await ds.graphQuery({kind: 'graph_create', graph: G, recordClass: 'urn:not-a-record'}).catch((e) => e);
    expect(String(cls)).toMatch(/not a graph record class/);
    const field = await OntologyGraph.create({id: G, package: 'p', colour: 'red'} as any).exec(ds).catch((e) => e);
    expect(String(field)).toMatch(/no field "colour"/);
    const auto = await OntologyGraph.create({id: G, package: 'p', contentHash: 'x'} as any).exec(ds).catch((e) => e);
    expect(String(auto)).toMatch(/filled in by core/);
  });
});

describe('store-reserved names, feedsHierarchy, record classes', () => {
  class ScriptedSparql extends SparqlDataset {
    updates: string[] = [];
    asks: string[] = [];
    constructor(private registered: boolean) {
      super();
    }
    protected async executeSparqlSelect(sparql: string): Promise<any> {
      this.asks.push(sparql);
      return graphCreateOutcomeAnswer(sparql, {registered: this.registered}) ?? {head: {}, boolean: this.registered};
    }
    protected async executeSparqlUpdate(sparql: string): Promise<void> {
      this.updates.push(sparql);
    }
  }
  const nt: GraphContent = {mediaType: 'application/n-triples', text: '<urn:a> <urn:b> <urn:c> .'};

  test.each(['urn:x-arq:DefaultGraph', 'urn:x-arq:UnionGraph'])(
    'a graph query on %s is refused before any SPARQL is sent',
    async (name) => {
      const ds = new ScriptedSparql(true);
      for (const call of [
        () => DraftGraph.create({id: name}).withContent(nt).exec(ds),
        () => NamedGraph.replaceContent(name, nt).exec(ds),
        () => NamedGraph.patchContent(name, {insert: nt}).exec(ds),
        () => NamedGraph.delete(name).exec(ds),
      ]) {
        expect(isGraphQueryError(await call().catch((e) => e), 'graph-name-read-only')).toBe(true);
      }
      expect(ds.asks).toEqual([]);
      expect(ds.updates).toEqual([]);
    },
  );

  test('a store can reserve other names', async () => {
    class Reserving extends ScriptedSparql {
      protected override isReservedGraphName(iri: string): boolean {
        return iri.startsWith('urn:store:');
      }
    }
    const err = await NamedGraph.delete('urn:store:x').exec(new Reserving(true)).catch((e) => e);
    expect(isGraphQueryError(err, 'graph-name-read-only')).toBe(true);
  });

  test('feedsHierarchy is an OntologyGraph field only; drafts and shapes graphs record false', async () => {
    const ds = new ScriptedSparql(false);
    await OntologyGraph.create({id: G, package: 'p', feedsHierarchy: false}).exec(ds);
    expect(ds.updates[0]).toContain('feedsHierarchy> "false"');
    for (const call of [
      () => DraftGraph.create({id: G, feedsHierarchy: true} as any).exec(ds),
      () => ShapesGraph.create({id: G, package: 'p', feedsHierarchy: true} as any).exec(ds),
    ]) {
      expect(String(await call().catch((e) => e))).toMatch(/no field "feedsHierarchy"/);
    }
    await ShapesGraph.create({id: G, package: 'p'}).exec(ds); // after the first create's write and claim removal
    expect(ds.updates[2]).toContain('feedsHierarchy> "false"');
  });

  test('a ComponentsGraph writes its commit as core:commit and never feeds the hierarchy', async () => {
    const ds = new ScriptedSparql(false);
    await ComponentsGraph.create({id: G, package: 'p', version: '1.0.0', commit: 'b'.repeat(40)}).exec(ds);
    expect(ds.updates[0]).toContain(`<https://linked.cm/ont/core/commit> "${'b'.repeat(40)}"`);
    expect(ds.updates[0]).toContain('feedsHierarchy> "false"');
  });

  test('replace and patch through a subclass ask for a record of that class; NamedGraph does not', async () => {
    const ds = new ScriptedSparql(true);
    await OntologyGraph.update(G).set({version: '2'}).exec(ds);
    expect(ds.asks[0]).toContain(`; a <${ONTOLOGY_GRAPH}>`);
    await NamedGraph.replaceContent(G, nt).exec(ds);
    expect(ds.asks[1]).not.toContain('; a <');
    const mismatch = new ScriptedSparql(false);
    const err = await OntologyGraph.update(G).set({version: '2'}).replaceContent(nt).exec(mismatch).catch((e) => e);
    expect(isGraphQueryError(err, 'graph-not-registered')).toBe(true);
    expect(err.message).toMatch(/no record of class/);
  });
});

describe('review fixes', () => {
  /** A SPARQL dataset without askQuery: asks go through its selectQuery and core's result mapping. */
  class NoAskSparql extends SparqlDataset {
    selects: string[] = [];
    constructor(private ids: string[]) {
      super();
    }
    protected async executeSparqlSelect(sparql: string): Promise<any> {
      this.selects.push(sparql);
      return {head: {vars: ['a0']}, results: {bindings: this.ids.map((id) => ({a0: {type: 'uri', value: id}}))}};
    }
    protected async executeSparqlUpdate(): Promise<void> {}
  }
  const noAsk = (ids: string[]) => {
    const ds = new NoAskSparql(ids);
    (ds as {askQuery?: unknown}).askQuery = undefined;
    return ds;
  };

  test('a subject ask on a store without askQuery answers through the single-result select', async () => {
    await expect(OntologyGraph.exists(G, noAsk([G]))).resolves.toBe(true);
    await expect(OntologyGraph.exists(G, noAsk([]))).resolves.toBe(false);
    const ds = noAsk([G]);
    await OntologyGraph.exists(G, ds);
    expect(ds.selects[0]).toContain('LIMIT 1');
  });

  test('an ask without a subject (nullSubject) is false without a select', async () => {
    const ds = noAsk([G]);
    const {resolveExistence} = await import('../queries/queryDispatch');
    const ask = {toJSON: () => ({op: 'ask', shape: OntologyGraph.shape.id, nullSubject: true})} as any;
    await expect(resolveExistence(ds, ask)).resolves.toBe(false);
    expect(ds.selects).toEqual([]);
  });

  test('a relative graph name is refused before anything is sent', async () => {
    const {store, received} = graphStore();
    await expect(DraftGraph.create({id: 'foo'}).exec(store)).rejects.toThrow(/absolute IRI/);
    expect(received).toEqual([]);
  });

  test('an empty patch is refused at the boundary', () => {
    expect(() =>
      parseGraphQuery({kind: 'graph_patch', graph: G, recordClass: ONTOLOGY_GRAPH, patch: {}}),
    ).toThrow(/patch needs insert, delete or both/);
  });
});

afterEach(() => {
  for (const shape of [...LinkedStorage.getShapeToDatasetMap().keys()]) {
    LinkedStorage.unsetDatasetForShape(shape);
  }
});
