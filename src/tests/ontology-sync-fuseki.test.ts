/*
 * The ontology sync on the inferring store: after a sync, a superclass select returns subclass
 * instances; a resync without the axiom removes them again. Plus the measurement of a first sync
 * of schema.org's class hierarchy (952 rdfs:subClassOf), and of the second, skipped one.
 */
import {afterAll, beforeAll, expect, test} from '@jest/globals';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {
  clearAllData,
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
import {syncOntologies} from '../ontology/syncOntologies';
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

let liveData = '';
pkg.linkedOntology({}, createNameSpace(`${EX}ns/`), 'sync-live', async () => [liveData], '../data/sync-live.ttl');

const schemaHierarchy = readFileSync(
  path.resolve(process.cwd(), 'src/tests/fixtures/ontology-data/schema-hierarchy.ttl'),
  'utf8',
);
linkedPackage('ontology-sync-schema-fixture').linkedOntology(
  {},
  createNameSpace('https://schema.org/'),
  'schema-fixture',
  async () => [schemaHierarchy],
  '../data/schema-hierarchy.ttl',
);

describeFuseki('ontology sync on the inferring store', () => {
  let store: CountingStore;

  beforeAll(async () => {
    await createTestDataset();
    await clearAllData();
    store = new CountingStore(FUSEKI_BASE_URL, DATASET_NAME);
  });
  afterAll(async () => {
    await clearAllData();
  });

  const animalNames = async () => {
    const rows = (await (QueryBuilder.from(LiveAnimal).select(['name']) as unknown as {
      exec: (ds: IDataset) => Promise<Array<{id: string; name?: string}>>;
    }).exec(store)) ?? [];
    return rows.map((r) => r.name).sort();
  };

  test('a superclass select returns subclass instances after the sync, and not after the axiom goes', async () => {
    await executeSparqlUpdate(
      `INSERT DATA { <${EX}rex> a <${EX}Dog> ; <${EX}name> "Rex" . <${EX}tom> a <${EX}Animal> ; <${EX}name> "Tom" . }`,
    );
    expect(await animalNames()).toEqual(['Tom']);

    liveData = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<${EX}Dog> rdfs:subClassOf <${EX}Animal> .\n`;
    const first = await syncOntologies(store, {packages: ['ontology-sync-live-test']});
    expect(first.written).toEqual(['ontology-sync-live-test']);
    expect(await animalNames()).toEqual(['Rex', 'Tom']);

    // Unchanged: nothing written.
    store.updates = 0;
    const again = await syncOntologies(store, {packages: ['ontology-sync-live-test']});
    expect(again.skipped).toEqual(['ontology-sync-live-test']);
    expect(store.updates).toBe(0);

    liveData = '';
    await syncOntologies(store, {packages: ['ontology-sync-live-test']});
    expect(await animalNames()).toEqual(['Tom']);
    // The store holds no stray axiom.
    const ask = await executeSparqlQuery(`ASK { <${EX}Dog> <http://www.w3.org/2000/01/rdf-schema#subClassOf> ?c }`);
    expect(ask.boolean).toBe(false);
  });

  test("measure: the first sync of schema.org's hierarchy, and the second", async () => {
    store.updates = 0;
    const started = Date.now();
    const first = await syncOntologies(store, {packages: ['ontology-sync-schema-fixture']});
    const firstMs = Date.now() - started;
    const firstUpdates = store.updates;
    expect(first.written).toEqual(['ontology-sync-schema-fixture']);
    const count = await executeSparqlQuery(
      'SELECT (COUNT(*) AS ?n) WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#subClassOf> ?o FILTER(isIRI(?o)) }',
    );

    store.updates = 0;
    const again = Date.now();
    const second = await syncOntologies(store, {packages: ['ontology-sync-schema-fixture']});
    const secondMs = Date.now() - again;
    expect(second.skipped).toEqual(['ontology-sync-schema-fixture']);
    expect(store.updates).toBe(0);

    // One update per subject class (906) plus the sync node.
    expect(firstUpdates).toBe(907);
    console.log(
      `[measure] first schema.org ontology sync: ${firstMs} ms, ${firstUpdates} updates, ` +
        `${count.results.bindings[0].n.value} rdfs:subClassOf triples in the dataset; ` +
        `second (skipped) sync: ${secondMs} ms, 0 updates`,
    );
  }, 300_000);
});
