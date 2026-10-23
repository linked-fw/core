/*
 * Graph queries on the inferring store: a create writes the body and the registry record, a
 * replace of an unregistered graph is refused, a patch changes the hash, a record-only update
 * keeps it, a delete removes graph and record, a write to a portable name is refused, and a
 * select of NamedGraph returns an OntologyGraph record through inference. Plus the large-body
 * measurement: one update against a GSP PUT and a separate record update.
 *
 * The class hierarchy core.ttl declares (core:OntologyGraph rdfs:subClassOf sd:NamedGraph) is
 * written into the default graph here, where every image reads its hierarchy from, so the
 * inference check does not depend on the image that reads hierarchies from the registry.
 */
import {afterAll, beforeAll, expect, test} from '@jest/globals';
import {existsSync, readFileSync} from 'node:fs';
import {
  createTestDataset,
  DATASET_NAME,
  deleteTestDataset,
  executeSparqlQuery,
  executeSparqlUpdate,
  FUSEKI_BASE_URL,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {DraftGraph, NamedGraph, OntologyGraph} from '../shapes/NamedGraph';
import {graphs} from '../ontologies/graphs';
import {isGraphQueryError} from '../queries/graphQuery';
import type {GraphContent} from '../queries/IntermediateRepresentation';
import {sha256Hex} from '../utils/sha256';

const SD = 'http://www.w3.org/ns/sparql-service-description#';
const CORE = 'https://linked.cm/ont/core/';
const REG = graphs.registry;
const G = OntologyGraph.iriFor('@_linked/graph-query-live');
const OTHER = OntologyGraph.iriFor('@_linked/graph-query-live-unregistered');

/** Counts the updates it sends. */
class CountingStore extends FusekiStore {
  updates = 0;
  protected override async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates++;
    return super.executeSparqlUpdate(sparql);
  }
}

const nt = (lines: string[]): GraphContent => ({
  mediaType: 'application/n-triples',
  text: lines.map((l) => `${l}\n`).join(''),
});

/** The record's fields, read straight from the registry graph. */
async function record(graph: string): Promise<Record<string, string[]>> {
  const json = await executeSparqlQuery(
    `SELECT ?p ?o WHERE { GRAPH <${REG}> { <${graph}> ?p ?o } }`,
  );
  const fields: Record<string, string[]> = {};
  for (const b of json.results.bindings) {
    const key = b.p.value.replace(CORE, 'core:').replace(SD, 'sd:').replace('http://purl.org/dc/terms/', 'dcterms:');
    (fields[key] ??= []).push(b.o.value);
  }
  return fields;
}

async function tripleCount(graph: string): Promise<number> {
  const json = await executeSparqlQuery(
    `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
  );
  return Number(json.results.bindings[0].n.value);
}

describeFuseki('graph queries on the inferring store', () => {
  let store: CountingStore;

  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    await executeSparqlUpdate(
      `INSERT DATA { <${CORE}OntologyGraph> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${SD}NamedGraph> . }`,
    );
    store = new CountingStore(FUSEKI_BASE_URL, DATASET_NAME);
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  const body = nt([
    '<http://example.org/A> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/B> .',
    '<http://example.org/A> <http://www.w3.org/2000/01/rdf-schema#label> "A"@en .',
  ]);

  test('create writes the body and a record with hash and modified, in one update', async () => {
    store.updates = 0;
    const result = await OntologyGraph.create({
      id: G,
      package: '@_linked/graph-query-live',
      version: '1.0.0',
      sources: ['data/live.ttl'],
    })
      .withContent(body)
      .exec(store);
    expect(store.updates).toBe(1);
    expect(result).toMatchObject({graph: G, contentHash: sha256Hex(body.text), changed: true});
    expect(await tripleCount(G)).toBe(2);
    const fields = await record(G);
    // The store infers sd:NamedGraph from the class.
    expect(fields['http://www.w3.org/1999/02/22-rdf-syntax-ns#type']).toContain(`${CORE}OntologyGraph`);
    expect(fields['sd:name']).toEqual([G]);
    expect(fields['core:package']).toEqual(['@_linked/graph-query-live']);
    expect(fields['core:version']).toEqual(['1.0.0']);
    expect(fields['core:feedsHierarchy']).toEqual(['true']);
    expect(fields['core:contentHash']).toEqual([sha256Hex(body.text)]);
    expect(fields['dcterms:modified']).toEqual([result.modified]);
    expect(fields['dcterms:source']).toEqual(['data/live.ttl']);
    // The body went to the graph, not to the default graph.
    const stray = await executeSparqlQuery('ASK { <http://example.org/A> ?p ?o }');
    expect(stray.boolean).toBe(false);
  });

  test('a second create of the same graph is refused', async () => {
    const err = await OntologyGraph.create({id: G, package: 'x'}).exec(store).catch((e) => e);
    expect(isGraphQueryError(err, 'graph-exists')).toBe(true);
  });

  test('replace on an unregistered graph is refused and writes nothing', async () => {
    store.updates = 0;
    const err = await NamedGraph.replaceContent(OTHER, body).exec(store).catch((e) => e);
    expect(isGraphQueryError(err, 'graph-not-registered')).toBe(true);
    expect(store.updates).toBe(0);
    expect(await tripleCount(OTHER)).toBe(0);
  });

  test('patch changes the body and the hash', async () => {
    const before = await record(G);
    const result = await NamedGraph.patchContent(G, {
      delete: nt(['<http://example.org/A> <http://www.w3.org/2000/01/rdf-schema#label> "A"@en .']),
      insert: nt(['<http://example.org/A> <http://www.w3.org/2000/01/rdf-schema#label> "Ay"@en .']),
    }).exec(store);
    const after = await record(G);
    expect(after['core:contentHash']).toEqual([result.contentHash]);
    expect(after['core:contentHash']).not.toEqual(before['core:contentHash']);
    expect(after['core:version']).toEqual(['1.0.0']);
    const label = await executeSparqlQuery(
      `SELECT ?l WHERE { GRAPH <${G}> { <http://example.org/A> <http://www.w3.org/2000/01/rdf-schema#label> ?l } }`,
    );
    expect(label.results.bindings.map((b: any) => b.l.value)).toEqual(['Ay']);
  });

  test('update().set() alone changes the record and keeps the hash and the load time', async () => {
    const before = await record(G);
    store.updates = 0;
    const result = await OntologyGraph.update(G).set({version: '1.1.0'}).exec(store);
    expect(result.changed).toBe(false);
    expect(store.updates).toBe(1);
    const after = await record(G);
    expect(after['core:version']).toEqual(['1.1.0']);
    expect(after['core:contentHash']).toEqual(before['core:contentHash']);
    expect(after['dcterms:modified']).toEqual(before['dcterms:modified']);
  });

  test('update().set().replaceContent() replaces body and record fields in one update', async () => {
    store.updates = 0;
    const next = nt(['<http://example.org/C> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/B> .']);
    await OntologyGraph.update(G).set({version: '1.2.0'}).replaceContent(next).exec(store);
    expect(store.updates).toBe(1);
    expect(await tripleCount(G)).toBe(1);
    const fields = await record(G);
    expect(fields['core:version']).toEqual(['1.2.0']);
    expect(fields['core:contentHash']).toEqual([sha256Hex(next.text)]);
  });

  test('a select of NamedGraph returns the OntologyGraph record (inference)', async () => {
    const rows = (await NamedGraph.select((r) => [r.name, r.contentHash, r.feedsHierarchy]).exec(store)) as Array<{
      id: string;
      name?: {id: string};
      contentHash?: string;
      feedsHierarchy?: boolean;
    }>;
    expect(rows.map((r) => r.id)).toEqual([G]);
    expect(rows[0].name?.id).toBe(G);
    expect(rows[0].feedsHierarchy).toBe(true);
    const typed = (await OntologyGraph.select((r) => [r.package, r.version]).exec(store)) as Array<{
      package?: string;
      version?: string;
    }>;
    expect(typed).toEqual([expect.objectContaining({package: '@_linked/graph-query-live', version: '1.2.0'})]);
  });

  test('replace through a subclass refuses a record of another class', async () => {
    const draft = `${G}-draft`;
    await DraftGraph.create({id: draft}).exec(store);
    const err = await OntologyGraph.update(draft).set({version: '9'}).exec(store).catch((e) => e);
    expect(isGraphQueryError(err, 'graph-not-registered')).toBe(true);
    await NamedGraph.replaceContent(draft, body).exec(store);
    expect(await tripleCount(draft)).toBe(2);
    expect((await record(draft))['core:feedsHierarchy']).toEqual(['false']);
    await DraftGraph.delete(draft).exec(store);
  });

  test('the store names urn:x-arq:DefaultGraph and urn:x-arq:UnionGraph are refused', async () => {
    store.updates = 0;
    for (const name of ['urn:x-arq:DefaultGraph', 'urn:x-arq:UnionGraph']) {
      const err = await NamedGraph.replaceContent(name, body).exec(store).catch((e) => e);
      expect(isGraphQueryError(err, 'graph-name-read-only')).toBe(true);
    }
    expect(store.updates).toBe(0);
  });

  test('a write to graphs.union is refused', async () => {
    store.updates = 0;
    const err = await store
      .graphQuery({kind: 'graph_replace', graph: graphs.union, recordClass: `${CORE}OntologyGraph`, content: body})
      .catch((e) => e);
    expect(isGraphQueryError(err, 'graph-name-read-only')).toBe(true);
    expect(store.updates).toBe(0);
  });

  test('delete removes the graph and its record', async () => {
    await OntologyGraph.delete(G).exec(store);
    expect(await tripleCount(G)).toBe(0);
    expect(await record(G)).toEqual({});
    expect(await NamedGraph.select().exec(store)).toEqual([]);
  });

  test('measure: a ~16k-triple body as one update, and as a GSP PUT plus a record update', async () => {
    const schemaPath = process.env.LINKED_SCHEMA_TTL;
    const content: GraphContent =
      schemaPath && existsSync(schemaPath)
        ? {mediaType: 'text/turtle', text: readFileSync(schemaPath, 'utf8')}
        : nt(
            Array.from({length: 16000}, (_, i) =>
              `<http://example.org/big/s${i}> <http://www.w3.org/2000/01/rdf-schema#label> "label ${i} with some text"@en .`,
            ),
          );
    const big = OntologyGraph.iriFor('@_linked/graph-query-measure');
    await OntologyGraph.create({id: big, package: '@_linked/graph-query-measure'}).exec(store);

    let started = Date.now();
    await NamedGraph.replaceContent(big, content).exec(store);
    const updateMs = Date.now() - started;
    const triples = await tripleCount(big);

    // The alternative: the body by the Graph Store Protocol, the record by a second update.
    started = Date.now();
    const put = await fetch(
      `${FUSEKI_BASE_URL}/${DATASET_NAME}/data?graph=${encodeURIComponent(big)}`,
      {method: 'PUT', headers: {'Content-Type': content.mediaType}, body: content.text},
    );
    expect(put.ok).toBe(true);
    await executeSparqlUpdate(
      `DELETE WHERE { GRAPH <${REG}> { <${big}> <${CORE}contentHash> ?h } } ;\n` +
        `INSERT DATA { GRAPH <${REG}> { <${big}> <${CORE}contentHash> "${sha256Hex(content.text)}" } }`,
    );
    const putMs = Date.now() - started;
    expect(await tripleCount(big)).toBe(triples);
    console.log(
      `[graph-query measure] ${schemaPath ? 'schema.org' : 'synthetic'} body: ${triples} triples, ` +
        `${(content.text.length / 1e6).toFixed(2)} MB ${content.mediaType}; one update ${updateMs} ms; ` +
        `GSP PUT + record update ${putMs} ms (two transactions)`,
    );
    await OntologyGraph.delete(big).exec(store);
  }, 120000);
});
