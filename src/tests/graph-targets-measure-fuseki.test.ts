/*
 * A measurement of `ontologyGraph: 'default'` on a populated default graph: schema.org's class
 * hierarchy fixture (952 rdfs:subClassOf) as a package, next to 20 000 instance triples under the
 * app's IRIs. The first sync, a changed one (each rebuilds the whole ontology in one update), and an
 * unchanged one. The instance data is untouched.
 */
import {afterAll, beforeAll, expect, test} from '@jest/globals';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createTestDataset, DATASET_NAME, executeSparqlQuery, executeSparqlUpdate, FUSEKI_BASE_URL} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {syncOntologies} from '../ontology/syncOntologies';
import {setGraphTargets} from '../utils/graphTargets';

const fixture = readFileSync(path.resolve(process.cwd(), 'src/tests/fixtures/ontology-data/schema-hierarchy.ttl'), 'utf8');
let data = fixture;
linkedPackage('gmode-measure-schema').linkedOntology(
  {},
  createNameSpace('http://schema.org/'),
  'gmode-measure-schema',
  async () => [data],
  '../data/schema-hierarchy.ttl',
);

class CountingStore extends FusekiStore {
  updates = 0;
  protected override async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates++;
    return super.executeSparqlUpdate(sparql);
  }
}

const count = async (where: string) =>
  Number((await executeSparqlQuery(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`)).results.bindings[0].n.value);

describeFuseki("graph targets: measure 'default' on a populated default graph", () => {
  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const s = `<https://data.example.org/measure/item/${i}>`;
      lines.push(`${s} a <https://schema.org/Product> ; <https://schema.org/name> "Item ${i}" ; <https://schema.org/sku> "${i}" ; <https://schema.org/position> ${i} .`);
    }
    await executeSparqlUpdate(`INSERT DATA { ${lines.join('\n')} }`);
  }, 120_000);
  afterAll(async () => {
    setGraphTargets({});
    await executeSparqlUpdate('DROP ALL');
  });

  test('first, changed and unchanged sync', async () => {
    setGraphTargets({ontologyGraph: 'default'});
    const store = new CountingStore(FUSEKI_BASE_URL, DATASET_NAME);
    const instances = await count('?s ?p ?o FILTER(STRSTARTS(STR(?s), "https://data.example.org/measure/"))');
    expect(instances).toBe(20_000);
    let t = Date.now();
    await syncOntologies(store);
    const first = Date.now() - t;
    data = fixture + '\n<http://schema.org/Product> <http://www.w3.org/2000/01/rdf-schema#label> "Product" .\n';
    store.updates = 0;
    t = Date.now();
    await syncOntologies(store);
    const changed = Date.now() - t;
    expect(store.updates).toBe(1);
    store.updates = 0;
    t = Date.now();
    await syncOntologies(store);
    const unchanged = Date.now() - t;
    expect(store.updates).toBe(0);
    expect(await count('?s ?p ?o FILTER(STRSTARTS(STR(?s), "https://data.example.org/measure/"))')).toBe(instances);
    const terms = await count('?s ?p ?o FILTER(STRSTARTS(STR(?s), "http://schema.org/"))');
    console.log(
      `[measure] ontologyGraph 'default', ${instances} instance triples beside it: first sync ${first} ms, ` +
        `changed ${changed} ms (1 update), unchanged ${unchanged} ms (0 updates); ${terms} schema.org triples`,
    );
  }, 300_000);
});
