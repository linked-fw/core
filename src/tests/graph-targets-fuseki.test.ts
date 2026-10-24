/*
 * The graph targets on the inferring store, every mode for the ontology and the shape sync:
 *
 * - `'package'`: one graph per package (as before), set explicitly.
 * - a shared IRI: one registered graph holding every package, its record listing each package's
 *   hash and files; nothing else written; rebuilt whole in one update when a package changes;
 *   `graphs.allOntologies` / `graphs.allShapes` read it; inference through it.
 * - `'default'`: the whole ontology in the default graph, in one update, and the default-graph
 *   shape sync. A renamed term leaves nothing behind, a removed blank-node restriction goes whole,
 *   instance data and a class of no package are untouched; the readers read the default graph; a
 *   shape rewrite keeps the links other shapes hold to it.
 *
 * An unchanged sync sends no update (so no probe) in every mode, and a sync that finds another
 * mode's data warns once and leaves it.
 */
import {afterAll, beforeAll, describe, expect, jest, test} from '@jest/globals';
import {
  createDataset,
  createTestDataset,
  DATASET_NAME,
  deleteDataset,
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
import {NodeShape} from '../shapes/SHACL';
import {QueryBuilder} from '../queries/QueryBuilder';
import {graphs} from '../ontologies/graphs';
import {
  DEFAULT_GRAPH_ONTOLOGY_NODE,
  ontologyGraphHash,
  syncOntologies,
} from '../ontology/syncOntologies';
import {OntologyGraph, ShapesGraph} from '../shapes/NamedGraph';
import {probeDefaultGraphInference} from '../ontology/hierarchyProbe';
import {syncShapeGraphs} from '../shapes/syncShapeGraphs';
import {packageShapesTurtle} from '../shapes/shapesToTurtle';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {IDataset} from '../interfaces/IDataset';
import '../shapes/index';

const EX = 'http://example.org/gmode/';
const A = `${EX}a/`;
const B = `${EX}b/`;
const OTHER = `${EX}other/`;
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SUB = `${RDFS}subClassOf`;
const LABEL = `${RDFS}label`;
const SH = 'http://www.w3.org/ns/shacl#';
const CORE = 'https://linked.cm/ont/core/';
const REG = graphs.registry;
const SHARED_ONT = 'https://data.example.org/gmode/graph/ontology';
const SHARED_SHAPES = 'https://data.example.org/gmode/graph/shapes';
const APP = 'https://data.example.org/gmode/app/graph/shapes';
const PKG_A = 'gmode-a';
const PKG_B = 'gmode-b';
const LIVE_TIMEOUT = 60_000;

const pkgA = linkedPackage(PKG_A);
const PREFIXES =
  `@prefix rdfs: <${RDFS}> . @prefix owl: <http://www.w3.org/2002/07/owl#> .\n` +
  `@prefix a: <${A}> . @prefix b: <${B}> . @prefix other: <${OTHER}> .\n`;
let aData = '';
let bData = '';
pkgA.linkedOntology({}, createNameSpace(A), 'gmode-a', async () => [aData], '../data/gmode-a.ttl');
linkedPackage(PKG_B).linkedOntology({}, createNameSpace(B), 'gmode-b', async () => [bData], '../data/gmode-b.ttl');

@pkgA.linkedShape
class GmPet extends Shape {
  static targetClass = {id: `${A}Pet`};
  @literalProperty({path: {id: `${A}name`}, maxCount: 1})
  get name(): string {
    return null;
  }
}

@pkgA.linkedShape
class GmDog extends GmPet {
  static targetClass = {id: `${A}Dog`};
}

/** Reads ontology classes and their labels, for the readers of `graphs.allOntologies`. */
@pkgA.linkedShape
class GmClass extends Shape {
  static targetClass = {id: 'http://www.w3.org/2002/07/owl#Class'};
}

/** Counts the updates it sends. */
class CountingStore extends FusekiStore {
  updates = 0;
  constructor(options?: SparqlOptions) {
    super(FUSEKI_BASE_URL, DATASET_NAME, options);
  }
  protected override async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates++;
    return super.executeSparqlUpdate(sparql);
  }
}

type Exec<T> = {exec: (ds: IDataset) => Promise<T>};

const dropAll = () => executeSparqlUpdate('DROP ALL');
const ask = async (sparql: string): Promise<boolean> => (await executeSparqlQuery(sparql)).boolean === true;
async function count(where: string): Promise<number> {
  const json = await executeSparqlQuery(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`);
  return Number(json.results.bindings[0].n.value);
}
const petNames = async (store: IDataset) =>
  (((await (QueryBuilder.from(GmPet).select(['name']) as unknown as Exec<Array<{name?: string}>>).exec(store)) ?? [])
    .map((r) => r.name)
    .sort());
const classLabels = async (store: IDataset) =>
  (((await (QueryBuilder.from(GmClass).select(['label']).from(graphs.allOntologies) as unknown as Exec<
    Array<{id: string; label?: string}>
  >).exec(store)) ?? [])
    .filter((r) => r.id.startsWith(EX))
    .map((r) => `${r.id.slice(EX.length)} ${r.label ?? ''}`.trim())
    .sort());
const shapeIdsFromAllShapes = async (store: IDataset) =>
  (((await (QueryBuilder.from(NodeShape).select([]).from(graphs.allShapes) as unknown as Exec<Array<{id: string}>>).exec(
    store,
  )) ?? []).map((r) => r.id));
/** Every warning core logged during `run`, as text. */
async function warningsOf(run: () => Promise<unknown>): Promise<string[]> {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await run();
    return warn.mock.calls.map((c) => String(c[0]));
  } finally {
    warn.mockRestore();
  }
}

const dogData = () =>
  `${PREFIXES}a:Dog a owl:Class ; rdfs:subClassOf a:Pet ; rdfs:label "Dog" .\n` +
  `a:Pet a owl:Class ; rdfs:label "Pet" .\n`;
const catData = (label = 'Cat') => `${PREFIXES}b:Cat a owl:Class ; rdfs:subClassOf a:Pet ; rdfs:label "${label}" .\n`;

describeFuseki('graph targets: ontologyGraph', () => {
  beforeAll(async () => {
    await createTestDataset();
  });
  afterAll(async () => {
    await dropAll();
  });

  describe("'package'", () => {
    test('one graph per package, then nothing', async () => {
      await dropAll();
      aData = dogData();
      bData = catData();
      const store = new CountingStore({ontologyGraph: 'package'});
      const first = await syncOntologies(store, {packages: [PKG_A, PKG_B]});
      expect(first).toMatchObject({written: [PKG_A, PKG_B], target: 'package'});
      expect(await ask(`ASK { GRAPH <${OntologyGraph.iriFor(PKG_A)}> { <${A}Dog> <${SUB}> <${A}Pet> } }`)).toBe(true);
      expect(await ask(`ASK { GRAPH <${OntologyGraph.iriFor(PKG_B)}> { <${B}Cat> <${SUB}> <${A}Pet> } }`)).toBe(true);
      expect(await classLabels(store)).toEqual(['a/Dog Dog', 'a/Pet Pet', 'b/Cat Cat']);
      store.updates = 0;
      expect(await syncOntologies(store, {packages: [PKG_A, PKG_B]})).toMatchObject({written: [], skipped: [PKG_A, PKG_B]});
      expect(store.updates).toBe(0);
    }, LIVE_TIMEOUT);
  });

  describe('a shared graph IRI', () => {
    let store: CountingStore;
    beforeAll(async () => {
      await dropAll();
      store = new CountingStore({ontologyGraph: SHARED_ONT});
    });

    test('one registered graph holds every package; its record lists each package; nothing else is written', async () => {
      aData = dogData();
      bData = catData();
      const first = await syncOntologies(store);
      expect(first.target).toBe(SHARED_ONT);
      expect(first.written).toEqual(expect.arrayContaining([PKG_A, PKG_B]));
      const records = (await OntologyGraph.select((r) => [r.package, r.feedsHierarchy, r.packageHashes, r.sources]).exec(
        store,
      )) as Array<{id: string; feedsHierarchy?: boolean; packageHashes?: string[]; sources?: string[]}>;
      expect(records.map((r) => r.id)).toEqual([SHARED_ONT]);
      expect(records[0].feedsHierarchy).toBe(true);
      expect(records[0].packageHashes).toEqual(
        expect.arrayContaining([`${PKG_A} ${ontologyGraphHash([aData])}`, `${PKG_B} ${ontologyGraphHash([bData])}`]),
      );
      expect(records[0].sources).toEqual(expect.arrayContaining([`${PKG_A}/data/gmode-a.ttl`, `${PKG_B}/data/gmode-b.ttl`]));
      expect(await ask(`ASK { GRAPH <${SHARED_ONT}> { <${A}Dog> <${SUB}> <${A}Pet> . <${B}Cat> <${LABEL}> "Cat" } }`)).toBe(true);
      // No package graph, and nothing of the packages in the default graph.
      expect(await ask(`ASK { GRAPH <${OntologyGraph.iriFor(PKG_A)}> { ?s ?p ?o } }`)).toBe(false);
      expect(await count(`?s ?p ?o FILTER(STRSTARTS(STR(?s), "${EX}"))`)).toBe(0);
      // The readers read the shared graph, and the store infers through it.
      expect(await classLabels(store)).toEqual(['a/Dog Dog', 'a/Pet Pet', 'b/Cat Cat']);
      await executeSparqlUpdate(
        `INSERT DATA { <${EX}data/rex> a <${A}Dog> ; <${A}name> "Rex" . <${EX}data/tom> a <${B}Cat> ; <${A}name> "Tom" . }`,
      );
      expect(await petNames(store)).toEqual(['Rex', 'Tom']);
    }, LIVE_TIMEOUT);

    test('an unchanged sync sends nothing', async () => {
      store.updates = 0;
      const again = await syncOntologies(store);
      expect(again.written).toEqual([]);
      expect(again.skipped).toEqual(expect.arrayContaining([PKG_A, PKG_B]));
      expect(store.updates).toBe(0);
    }, LIVE_TIMEOUT);

    test('a change to one package rebuilds the whole graph in one update', async () => {
      bData = catData('Kitten');
      store.updates = 0;
      const result = await syncOntologies(store);
      expect(result.written).toEqual(expect.arrayContaining([PKG_A, PKG_B]));
      expect(store.updates).toBe(1);
      expect(await classLabels(store)).toEqual(['a/Dog Dog', 'a/Pet Pet', 'b/Cat Kitten']);
      const [record] = (await OntologyGraph.select((r) => [r.packageHashes]).exec(store)) as unknown as Array<{packageHashes?: string[]}>;
      expect(record.packageHashes).toContain(`${PKG_B} ${ontologyGraphHash([bData])}`);
      expect(record.packageHashes).not.toContain(`${PKG_B} ${ontologyGraphHash([catData()])}`);
      expect(await petNames(store)).toEqual(['Rex', 'Tom']);
    }, LIVE_TIMEOUT);
  });

  describe("'default'", () => {
    let store: CountingStore;
    const restriction =
      `a:Pet owl:equivalentClass [ a owl:Restriction ; owl:onProperty a:name ; ` +
      `owl:someValuesFrom [ owl:unionOf ( a:Dog [ a owl:Restriction ; owl:onProperty a:name ; owl:hasValue "x" ] ) ] ] .\n`;
    /** The blank subjects of the default graph. */
    const blankNodes = async () =>
      Number(
        (await executeSparqlQuery('SELECT (COUNT(DISTINCT ?b) AS ?n) WHERE { ?b ?p ?o FILTER(isBlank(?b)) }')).results
          .bindings[0].n.value,
      );

    beforeAll(async () => {
      await dropAll();
      store = new CountingStore({ontologyGraph: 'default'});
      // Instance data under the app's IRIs, a class of no package, and a term of package a that
      // is not in its Turtle (written by hand: the next sync may overwrite it).
      await executeSparqlUpdate(
        `INSERT DATA { <${EX}data/rex> a <${A}Dog> ; <${A}name> "Rex" . ` +
          `<${OTHER}Bird> <${SUB}> <${OTHER}Animal> ; <${LABEL}> "Bird" . ` +
          `<${A}Hand> <${LABEL}> "by hand" . }`,
      );
    });

    test('the whole ontology goes into the default graph in one update, with its hash', async () => {
      aData = dogData() + `${PREFIXES}${restriction}other:Thing rdfs:label "annotated by a" .\n`;
      bData = catData();
      expect(await blankNodes()).toBe(0);
      store.updates = 0;
      const first = await syncOntologies(store);
      expect(first.target).toBe('default');
      expect(first.written).toEqual(expect.arrayContaining([PKG_A, PKG_B]));
      // The probe (a write and a cleanup) and the one update of the ontology.
      expect(store.updates).toBe(3);
      expect(await ask(`ASK { <${A}Dog> <${SUB}> <${A}Pet> ; <${LABEL}> "Dog" . <${B}Cat> <${LABEL}> "Cat" }`)).toBe(true);
      expect(await ask(`ASK { <${DEFAULT_GRAPH_ONTOLOGY_NODE}> <${CORE}ontologyHash> ?h }`)).toBe(true);
      // restriction, union class, one list cell… two cells, inner restriction: 5 blank subjects.
      expect(await blankNodes()).toBe(5);
      // No graph was written, no record.
      expect(await count(`GRAPH ?g { ?s ?p ?o }`)).toBe(0);
      // The term outside the Turtle was in package a's namespace: replaced (gone).
      expect(await ask(`ASK { <${A}Hand> ?p ?o }`)).toBe(false);
      // Readers and inference use the default graph.
      expect(await classLabels(store)).toEqual(['a/Dog Dog', 'a/Pet Pet', 'b/Cat Cat']);
      expect(await petNames(store)).toEqual(['Rex']);
    }, LIVE_TIMEOUT);

    test('an unchanged sync sends nothing (no probe either)', async () => {
      store.updates = 0;
      const again = await syncOntologies(store);
      expect(again.written).toEqual([]);
      expect(store.updates).toBe(0);
    }, LIVE_TIMEOUT);

    test('a renamed term leaves nothing behind; a removed restriction goes whole; other subjects stay', async () => {
      aData =
        `${PREFIXES}a:Hound a owl:Class ; rdfs:subClassOf a:Pet ; rdfs:label "Hound" .\n` +
        `a:Pet a owl:Class ; rdfs:label "Pet" .\nother:Thing rdfs:label "annotated again" .\n`;
      store.updates = 0;
      await syncOntologies(store);
      expect(store.updates).toBe(1);
      expect(await ask(`ASK { <${A}Dog> ?p ?o }`)).toBe(false);
      expect(await ask(`ASK { <${A}Hound> <${SUB}> <${A}Pet> ; <${LABEL}> "Hound" }`)).toBe(true);
      expect(await blankNodes()).toBe(0);
      expect(await count(`<${A}Pet> ?p ?o`)).toBe(2);
      // A subject of the Turtle outside the namespaces is replaced, not added to.
      expect(await count(`<${OTHER}Thing> ?p ?o`)).toBe(1);
      expect(await ask(`ASK { <${OTHER}Thing> <${LABEL}> "annotated again" }`)).toBe(true);
      // Instance data and the class of no package are untouched.
      expect(await ask(`ASK { <${EX}data/rex> a <${A}Dog> ; <${A}name> "Rex" }`)).toBe(true);
      expect(await ask(`ASK { <${OTHER}Bird> <${SUB}> <${OTHER}Animal> ; <${LABEL}> "Bird" }`)).toBe(true);
      expect(await classLabels(store)).toEqual(['a/Hound Hound', 'a/Pet Pet', 'b/Cat Cat']);
    }, LIVE_TIMEOUT);
  });

  describe("'default': what it refuses, and the probe", () => {
    test('a blank node no term links to is refused before anything is sent', async () => {
      await dropAll();
      const store = new CountingStore({ontologyGraph: 'default'});
      aData = dogData() + `${PREFIXES}[] a owl:AllDisjointClasses ; owl:members ( a:Dog a:Pet ) .\n`;
      bData = catData();
      await expect(syncOntologies(store)).rejects.toThrow(/The ontology data of gmode-a has 3 blank node\(s\) that no IRI subject links to/);
      expect(store.updates).toBe(0);
      aData = dogData();
    }, LIVE_TIMEOUT);

    test('a store that cannot replace default-graph terms is refused', async () => {
      const store = new CountingStore({ontologyGraph: 'default'});
      (store as unknown as {replaceDefaultGraphTerms?: unknown}).replaceDefaultGraphTerms = undefined;
      await expect(syncOntologies(store)).rejects.toThrow(/cannot replace default-graph terms/);
    }, LIVE_TIMEOUT);

    test('the probe tests the default graph and leaves nothing behind; a store that does not infer is warned about', async () => {
      await dropAll();
      expect(await probeDefaultGraphInference(new CountingStore())).toBe(true);
      expect(await count('?s ?p ?o')).toBe(0);
      const plain = `${DATASET_NAME}-gmode-plain`;
      await deleteDataset(plain);
      await createDataset(plain, {dbType: 'mem'});
      try {
        const store = new FusekiStore(FUSEKI_BASE_URL, plain, {ontologyGraph: 'default'});
        const warnings = await warningsOf(() => syncOntologies(store));
        expect(warnings.filter((w) => w.includes('does not infer rdf:type from the default graph'))).toHaveLength(1);
      } finally {
        await deleteDataset(plain);
      }
    }, LIVE_TIMEOUT);
  });

  describe('data of another mode', () => {
    test('is reported once by each sync, and left as it is', async () => {
      await dropAll();
      aData = dogData();
      bData = catData();
      await syncOntologies(new CountingStore({ontologyGraph: 'package'}), {packages: [PKG_A, PKG_B]});

      const toDefault = new CountingStore({ontologyGraph: 'default'});
      const warnings = (await warningsOf(() => syncOntologies(toDefault))).filter((w) => w.includes('also holds'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("ontologyGraph is 'default'");
      expect(warnings[0]).toContain(`<${OntologyGraph.iriFor(PKG_A)}>`);
      // Not moved: the package graphs are still there.
      expect(await ask(`ASK { GRAPH <${OntologyGraph.iriFor(PKG_A)}> { <${A}Dog> ?p ?o } }`)).toBe(true);

      const toShared = new CountingStore({ontologyGraph: SHARED_ONT});
      const shared = (await warningsOf(() => syncOntologies(toShared))).filter((w) => w.includes('also holds'));
      expect(shared).toHaveLength(1);
      expect(shared[0]).toContain('package ontology graphs');
      expect(shared[0]).toContain("the ontology in the default graph (the 'default' mode");

      const back = (await warningsOf(() => syncOntologies(new CountingStore({ontologyGraph: 'package'}), {packages: [PKG_A, PKG_B]}))).filter(
        (w) => w.includes('also holds'),
      );
      expect(back).toHaveLength(1);
      expect(back[0]).toContain(`shared ontology graphs: <${SHARED_ONT}>`);
      expect(back[0]).toContain('the default graph');
      // The package mode never prunes the shared graph.
      expect(await ask(`ASK { GRAPH <${SHARED_ONT}> { ?s ?p ?o } }`)).toBe(true);
    }, LIVE_TIMEOUT);
  });
});

describeFuseki('graph targets: shapeGraph', () => {
  const RUN = {packages: ['@_linked/core', PKG_A], appShapes: {graph: APP, package: '@acme/gmode'}};

  beforeAll(async () => {
    await createTestDataset();
  });
  afterAll(async () => {
    await dropAll();
  });

  test("'package': one graph per package and the app graph, then nothing", async () => {
    await dropAll();
    const store = new CountingStore({shapeGraph: 'package'});
    const first = await syncShapeGraphs(store, RUN);
    expect(first).toMatchObject({written: ['@_linked/core', PKG_A], appGraph: 'written', target: 'package'});
    expect(await ask(`ASK { GRAPH <${ShapesGraph.iriFor(PKG_A)}> { <${GmDog.shape.id}> ?p ?o } }`)).toBe(true);
    expect(await shapeIdsFromAllShapes(store)).toEqual(expect.arrayContaining([GmPet.shape.id, GmDog.shape.id]));
    store.updates = 0;
    expect(await syncShapeGraphs(store, RUN)).toMatchObject({written: [], appGraph: 'skipped'});
    expect(store.updates).toBe(0);
  }, LIVE_TIMEOUT);

  describe('a shared graph IRI', () => {
    let store: CountingStore;
    let variant = '';
    const turtleFor = (name: string) => {
      const text = packageShapesTurtle(name);
      return name === PKG_A && text ? text + variant : text;
    };
    beforeAll(async () => {
      await dropAll();
      store = new CountingStore({shapeGraph: SHARED_SHAPES});
    });

    test('one graph holds every package and the app shapes; its record lists them; nothing else is written', async () => {
      const first = await syncShapeGraphs(store, {...RUN, turtleFor});
      expect(first).toMatchObject({written: ['@_linked/core', PKG_A], appGraph: 'written', target: SHARED_SHAPES});
      const records = (await ShapesGraph.select((r) => [r.packageHashes, r.sources]).exec(store)) as unknown as Array<{
        id: string;
        packageHashes?: string[];
        sources?: string[];
      }>;
      expect(records.map((r) => r.id)).toEqual([SHARED_SHAPES]);
      expect(records[0].packageHashes).toHaveLength(2);
      expect(records[0].sources).toEqual(['@_linked/core/data/shapes.ttl', `${PKG_A}/data/shapes.ttl`]);
      expect(await ask(`ASK { GRAPH <${SHARED_SHAPES}> { <${GmDog.shape.id}> <${CORE}isExtending> <${GmPet.shape.id}> } }`)).toBe(true);
      expect(await ask(`ASK { GRAPH <${SHARED_SHAPES}> { <${NodeShape.shape.id}> a <${SH}NodeShape> } }`)).toBe(true);
      expect(await ask(`ASK { GRAPH <${ShapesGraph.iriFor(PKG_A)}> { ?s ?p ?o } }`)).toBe(false);
      expect(await ask(`ASK { GRAPH <${APP}> { ?s ?p ?o } }`)).toBe(false);
      expect(await count(`<${GmPet.shape.id}> ?p ?o`)).toBe(0);
      expect(await shapeIdsFromAllShapes(store)).toEqual(expect.arrayContaining([GmPet.shape.id, GmDog.shape.id]));
    }, LIVE_TIMEOUT);

    test('an unchanged sync sends nothing; a change rebuilds the graph in one update', async () => {
      store.updates = 0;
      expect(await syncShapeGraphs(store, {...RUN, turtleFor})).toMatchObject({written: [], appGraph: 'skipped'});
      expect(store.updates).toBe(0);

      variant = `\n<${EX}shapes/Extra> a <${SH}NodeShape> .\n`;
      const result = await syncShapeGraphs(store, {...RUN, turtleFor});
      expect(result.written).toEqual(['@_linked/core', PKG_A]);
      expect(store.updates).toBe(1);
      expect(await ask(`ASK { GRAPH <${SHARED_SHAPES}> { <${EX}shapes/Extra> a <${SH}NodeShape> . <${GmPet.shape.id}> ?p ?o } }`)).toBe(true);
      // A run without appShapes (a control-route sync) leaves the app's generated shapes in it.
      store.updates = 0;
      const {appShapes: _app, ...withoutApp} = RUN;
      expect((await syncShapeGraphs(store, {...withoutApp, turtleFor})).written).toEqual([]);
      expect(store.updates).toBe(0);
    }, LIVE_TIMEOUT);
  });

  describe("'default'", () => {
    let store: CountingStore;
    beforeAll(async () => {
      await dropAll();
      store = new CountingStore({shapeGraph: 'default'});
    });

    test('the shapes go into the default graph; the readers read it; then nothing', async () => {
      const first = await syncShapeGraphs(store, RUN);
      expect(first.target).toBe('default');
      expect(first.defaultGraph).toBeGreaterThan(0);
      expect(await ask(`ASK { <${GmDog.shape.id}> <${CORE}isExtending> <${GmPet.shape.id}> }`)).toBe(true);
      expect(await count(`GRAPH ?g { ?s ?p ?o }`)).toBe(0);
      expect(await shapeIdsFromAllShapes(store)).toEqual(expect.arrayContaining([GmPet.shape.id, GmDog.shape.id]));
      store.updates = 0;
      expect((await syncShapeGraphs(store, RUN)).defaultGraph).toBe(0);
      expect(store.updates).toBe(0);
    }, LIVE_TIMEOUT);

    test("a shape's rewrite keeps the links other shapes hold to it", async () => {
      const STAY = `${EX}shapes/Staying`;
      await executeSparqlUpdate(
        `INSERT DATA { <${STAY}> a <${SH}NodeShape> ; <${CORE}isExtending> <${GmPet.shape.id}> ; ` +
          `<${SH}node> <${GmPet.shape.id}> . }`,
      );
      const forced = await syncShapeGraphs(store, {...RUN, force: true});
      expect(forced.defaultGraph).toBeGreaterThan(0);
      expect(await ask(`ASK { <${STAY}> <${CORE}isExtending> <${GmPet.shape.id}> ; <${SH}node> <${GmPet.shape.id}> }`)).toBe(true);
      expect(await ask(`ASK { <${GmDog.shape.id}> <${CORE}isExtending> <${GmPet.shape.id}> }`)).toBe(true);
      expect(await ask(`ASK { <${GmPet.shape.id}> a <${SH}NodeShape> }`)).toBe(true);
    }, LIVE_TIMEOUT);
  });

  test('data of another mode is reported once by each sync, and left as it is', async () => {
    await dropAll();
    await syncShapeGraphs(new CountingStore({shapeGraph: 'package'}), RUN);
    const toDefault = (await warningsOf(() => syncShapeGraphs(new CountingStore({shapeGraph: 'default'}), RUN))).filter((w) =>
      w.includes('also holds'),
    );
    expect(toDefault).toHaveLength(1);
    expect(toDefault[0]).toContain(`<${ShapesGraph.iriFor(PKG_A)}>`);
    expect(toDefault[0]).toContain(`the app's shape graph <${APP}>`);
    expect(await ask(`ASK { GRAPH <${ShapesGraph.iriFor(PKG_A)}> { <${GmDog.shape.id}> ?p ?o } }`)).toBe(true);

    const toShared = (await warningsOf(() => syncShapeGraphs(new CountingStore({shapeGraph: SHARED_SHAPES}), RUN))).filter((w) =>
      w.includes('also holds'),
    );
    expect(toShared).toHaveLength(1);
    expect(toShared[0]).toContain('package shape graphs');
    expect(toShared[0]).toContain("registered shape(s) in the default graph (the 'default' mode)");

    const back = (await warningsOf(() => syncShapeGraphs(new CountingStore({shapeGraph: 'package'}), RUN))).filter((w) =>
      w.includes('also holds'),
    );
    expect(back).toHaveLength(1);
    expect(back[0]).toContain(`shared shape graphs: <${SHARED_SHAPES}>`);
  }, LIVE_TIMEOUT);
});
