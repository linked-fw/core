/*
 * The ontology sync on the inferring store (an image that builds its hierarchy from the graph
 * registry, `6.2.0-2`): the first sync writes one ontology graph per package with its record, the
 * second writes nothing, a label change rewrites only that package, a superclass select returns
 * subclass instances through a package graph and loses them when the axiom goes; a dataset the
 * default-graph sync wrote ends with no hierarchy of synced packages in the default graph, a
 * hand-written axiom kept and inference intact; a store without graph queries takes the old path.
 * Plus the measurement of a first sync of schema.org's data, and of the second, skipped one.
 */
import {afterAll, beforeAll, expect, test} from '@jest/globals';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {
  createTestDataset,
  DATASET_NAME,
  executeSparqlQuery,
  executeSparqlUpdate,
  FUSEKI_BASE_URL,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {Shape} from '../shapes/Shape';
import {literalProperty} from '../shapes/SHACL';
import {QueryBuilder} from '../queries/QueryBuilder';
import {ontologyGraphHash, ontologySyncNodeIri, syncOntologies} from '../ontology/syncOntologies';
import {OntologyGraph} from '../shapes/NamedGraph';
import {unsupportedGraphQuery} from '../queries/graphQuery';
import type {GraphQuery, GraphResult} from '../queries/IntermediateRepresentation';
import type {IDataset} from '../interfaces/IDataset';

const EX = 'http://example.org/sync-live/';
const ex = (term: string) => ({id: `${EX}${term}`});
const pkg = linkedPackage('ontology-sync-live-test');

@pkg.linkedShape
class LiveAnimal extends Shape {
  static targetClass = ex('Animal');
  @literalProperty({path: ex('name'), maxCount: 1})
  get name(): string {
    return null;
  }
}

/** Counts the updates it sends. */
class CountingStore extends FusekiStore {
  updates = 0;
  protected override async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates++;
    return super.executeSparqlUpdate(sparql);
  }
}

/** The same store refusing graph queries, as a store without graph support does. */
class NoGraphStore extends CountingStore {
  override async graphQuery(query: GraphQuery): Promise<GraphResult> {
    throw unsupportedGraphQuery(query);
  }
}

let liveData = '';
pkg.linkedOntology({}, createNameSpace(`${EX}ns/`), 'sync-live', async () => [liveData], '../data/sync-live.ttl');
let otherData = '';
linkedPackage('ontology-sync-live-other').linkedOntology(
  {},
  createNameSpace(`${EX}other/`),
  'sync-live-other',
  async () => [otherData],
  '../data/sync-live-other.ttl',
);
const LIVE = ['ontology-sync-live-other', 'ontology-sync-live-test'];

// The measurement uses schema.org's whole data when LINKED_SCHEMA_TTL names it, else the
// hierarchy fixture (952 rdfs:subClassOf).
const fullSchemaPath = process.env.LINKED_SCHEMA_TTL;
const schemaHierarchy = readFileSync(
  fullSchemaPath && existsSync(fullSchemaPath)
    ? fullSchemaPath
    : path.resolve(process.cwd(), 'src/tests/fixtures/ontology-data/schema-hierarchy.ttl'),
  'utf8',
);
linkedPackage('ontology-sync-schema-fixture').linkedOntology(
  {},
  createNameSpace('https://schema.org/'),
  'schema-fixture',
  async () => [schemaHierarchy],
  '../data/schema-hierarchy.ttl',
);

/** Every graph of the dataset, the registry and package graphs included. */
const dropAll = () => executeSparqlUpdate('DROP ALL');

const SUB = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const PREFIXES = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`;
const dogIsAnimal = `${PREFIXES}<${EX}Dog> rdfs:subClassOf <${EX}Animal> ; rdfs:label "Dog" .\n`;
const catIsPet = `${PREFIXES}<${EX}Cat> rdfs:subClassOf <${EX}Pet> ; rdfs:label "Cat" .\n`;

describeFuseki('ontology sync on package graphs', () => {
  let store: CountingStore;

  beforeAll(async () => {
    await createTestDataset();
    await dropAll();
    store = new CountingStore(FUSEKI_BASE_URL, DATASET_NAME);
  });
  afterAll(async () => {
    await dropAll();
  });

  const animalNames = async () => {
    const rows = (await (QueryBuilder.from(LiveAnimal).select(['name']) as unknown as {
      exec: (ds: IDataset) => Promise<Array<{id: string; name?: string}>>;
    }).exec(store)) ?? [];
    return rows.map((r) => r.name).sort();
  };
  const ask = async (sparql: string) => (await executeSparqlQuery(sparql)).boolean as boolean;
  const records = async () =>
    ((await OntologyGraph.select((r) => [r.package, r.contentHash, r.feedsHierarchy, r.sources]).exec(store)) as Array<{
      id: string;
      package?: string;
      contentHash?: string;
      feedsHierarchy?: boolean;
      sources?: string[];
    }>).sort((a, b) => (a.id < b.id ? -1 : 1));
  const modifiedOf = async (graph: string) =>
    (await executeSparqlQuery(
      `SELECT ?m WHERE { GRAPH <https://linked.cm/pkg/core/graph/registry> { <${graph}> <http://purl.org/dc/terms/modified> ?m } }`,
    )).results.bindings.map((b: any) => b.m.value);
  const defaultGraphHierarchy = async () =>
    (await executeSparqlQuery(`SELECT ?s ?o WHERE { ?s <${SUB}> ?o FILTER(STRSTARTS(STR(?s), "${EX}")) }`))
      .results.bindings.map((b: any) => `${b.s.value} ${b.o.value}`)
      .sort();

  test('the first sync writes one graph per package with its record; the second writes nothing', async () => {
    liveData = dogIsAnimal;
    otherData = catIsPet;
    const first = await syncOntologies(store, {packages: LIVE});
    expect(first).toEqual({written: LIVE, skipped: [], pruned: []});
    const rows = await records();
    expect(rows.map((r) => r.package)).toEqual(LIVE);
    for (const row of rows) {
      expect(row.id).toBe(OntologyGraph.iriFor(row.package!));
      expect(row.feedsHierarchy).toBe(true);
    }
    expect(rows.find((r) => r.package === 'ontology-sync-live-test')).toMatchObject({
      contentHash: ontologyGraphHash([dogIsAnimal]),
      sources: ['data/sync-live.ttl'],
    });
    // The data is in the package graph, not in the default graph.
    const graph = OntologyGraph.iriFor('ontology-sync-live-test');
    expect(await ask(`ASK { GRAPH <${graph}> { <${EX}Dog> <${SUB}> <${EX}Animal> ; <http://www.w3.org/2000/01/rdf-schema#label> "Dog" } }`)).toBe(true);
    expect(await defaultGraphHierarchy()).toEqual([]);

    store.updates = 0;
    const again = await syncOntologies(store, {packages: LIVE});
    expect(again).toEqual({written: [], skipped: LIVE, pruned: []});
    expect(store.updates).toBe(0);
  });

  test('a label change rewrites only that package', async () => {
    const other = OntologyGraph.iriFor('ontology-sync-live-other');
    const before = await modifiedOf(other);
    liveData = dogIsAnimal.replace('"Dog"', '"Hound"');
    store.updates = 0;
    const result = await syncOntologies(store, {packages: LIVE});
    expect(result).toEqual({written: ['ontology-sync-live-test'], skipped: ['ontology-sync-live-other'], pruned: []});
    expect(store.updates).toBe(1);
    expect(await modifiedOf(other)).toEqual(before);
    const graph = OntologyGraph.iriFor('ontology-sync-live-test');
    expect(await ask(`ASK { GRAPH <${graph}> { <${EX}Dog> <http://www.w3.org/2000/01/rdf-schema#label> "Hound" } }`)).toBe(true);
    expect(await ask(`ASK { GRAPH <${graph}> { <${EX}Dog> <http://www.w3.org/2000/01/rdf-schema#label> "Dog" } }`)).toBe(false);
  });

  test('a superclass select returns subclass instances through the package graph, and not after the axiom goes', async () => {
    await executeSparqlUpdate(
      `INSERT DATA { <${EX}rex> a <${EX}Dog> ; <${EX}name> "Rex" . <${EX}tom> a <${EX}Animal> ; <${EX}name> "Tom" . }`,
    );
    liveData = dogIsAnimal;
    await syncOntologies(store, {packages: LIVE});
    expect(await animalNames()).toEqual(['Rex', 'Tom']);

    liveData = `${PREFIXES}<${EX}Dog> rdfs:label "Dog" .\n`;
    await syncOntologies(store, {packages: LIVE});
    expect(await animalNames()).toEqual(['Tom']);

    // force rewrites an unchanged package.
    liveData = dogIsAnimal;
    await syncOntologies(store, {packages: LIVE});
    store.updates = 0;
    const forced = await syncOntologies(store, {packages: ['ontology-sync-live-test'], force: true});
    expect(forced.written).toEqual(['ontology-sync-live-test']);
    expect(store.updates).toBe(1);
    expect(await animalNames()).toEqual(['Rex', 'Tom']);
    await executeSparqlUpdate(`DELETE WHERE { <${EX}rex> ?p ?o } ; DELETE WHERE { <${EX}tom> ?p ?o }`);
  });

  test('a dataset the default-graph sync wrote ends with no hierarchy of synced packages there; hand-written axioms stay', async () => {
    await dropAll();
    // The default-graph sync (a store without graph queries) writes both packages' hierarchy.
    liveData = dogIsAnimal;
    otherData = `${PREFIXES}<${EX}Cat> rdfs:subClassOf <${EX}Pet> .\n<${EX}Dog> rdfs:subClassOf <${EX}Animal> .\n`;
    const legacy = new NoGraphStore(FUSEKI_BASE_URL, DATASET_NAME);
    const old = await syncOntologies(legacy, {packages: LIVE});
    expect(old.written).toEqual(LIVE);
    expect(await defaultGraphHierarchy()).toEqual([`${EX}Cat ${EX}Pet`, `${EX}Dog ${EX}Animal`]);
    expect(await ask(`ASK { <${ontologySyncNodeIri('ontology-sync-live-test')}> ?p ?o }`)).toBe(true);
    // A hand-written axiom no package lists, and an instance of the subclass.
    await executeSparqlUpdate(
      `INSERT DATA { <${EX}Puppy> <${SUB}> <${EX}Dog> . <${EX}bo> a <${EX}Puppy> ; <${EX}name> "Bo" . }`,
    );
    expect(await animalNames()).toEqual(['Bo']);

    const result = await syncOntologies(store, {packages: LIVE});
    expect(result.written).toEqual(LIVE);
    expect(await defaultGraphHierarchy()).toEqual([`${EX}Puppy ${EX}Dog`]);
    for (const name of LIVE) {
      expect(await ask(`ASK { <${ontologySyncNodeIri(name)}> ?p ?o }`)).toBe(false);
    }
    // Inference through the package graphs plus the hand-written axiom.
    expect(await ask(`ASK { ?x a <${EX}Animal> }`)).toBe(true);
    expect(await ask(`ASK { <${EX}bo> a <${EX}Animal> }`)).toBe(true);
    expect(await animalNames()).toEqual(['Bo']);
  });

  test('a store without graph queries takes the default-graph path', async () => {
    await dropAll();
    liveData = dogIsAnimal;
    const legacy = new NoGraphStore(FUSEKI_BASE_URL, DATASET_NAME);
    const result = await syncOntologies(legacy, {packages: ['ontology-sync-live-test']});
    expect(result.written).toEqual(['ontology-sync-live-test']);
    expect(await defaultGraphHierarchy()).toEqual([`${EX}Dog ${EX}Animal`]);
    expect(await records()).toEqual([]);
    await dropAll();
  });

  test("measure: the first sync of schema.org's data, and the second", async () => {
    await dropAll();
    store.updates = 0;
    const started = Date.now();
    const first = await syncOntologies(store, {packages: ['ontology-sync-schema-fixture']});
    const firstMs = Date.now() - started;
    const firstUpdates = store.updates;
    expect(first.written).toEqual(['ontology-sync-schema-fixture']);
    const graph = OntologyGraph.iriFor('ontology-sync-schema-fixture');
    const count = await executeSparqlQuery(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);

    store.updates = 0;
    const again = Date.now();
    const second = await syncOntologies(store, {packages: ['ontology-sync-schema-fixture']});
    const secondMs = Date.now() - again;
    expect(second.skipped).toEqual(['ontology-sync-schema-fixture']);
    expect(store.updates).toBe(0);

    // One graph query: one update.
    expect(firstUpdates).toBe(1);
    console.log(
      `[measure] first schema.org ontology sync: ${firstMs} ms, ${firstUpdates} update, ` +
        `${count.results.bindings[0].n.value} triples in its graph; ` +
        `second (skipped) sync: ${secondMs} ms, 0 updates`,
    );
  }, 300_000);
});
