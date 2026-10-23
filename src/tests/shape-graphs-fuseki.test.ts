/*
 * Shape graphs on the inferring store: the sync writes each package's graph and record, then
 * skips it; the shapes an earlier sync wrote into the default graph are removed; a patch of one
 * shape's statements (its concise bounded description, with an `sh:inversePath` blank node)
 * leaves no orphan blank node; and with shapes stored as declared, a sub-shape's instances are
 * still checked against the super-shape (SHACL targeting through `rdfs:subClassOf`).
 */
import {afterAll, beforeAll, expect, test} from '@jest/globals';
import {
  createTestDataset,
  DATASET_NAME,
  deleteTestDataset,
  executeSparqlQuery,
  executeSparqlUpdate,
  FUSEKI_BASE_URL,
  validateWithJenaShacl,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {NamedGraph, ShapesGraph} from '../shapes/NamedGraph';
import {shapesToTurtle} from '../shapes/shapesToTurtle';
import {syncShapeGraphs} from '../shapes/syncShapeGraphs';
import {syncShape} from '../shapes/syncShapes';
import {NodeShape} from '../shapes/SHACL';
import {QueryBuilder} from '../queries/QueryBuilder';
import {graphs} from '../ontologies/graphs';
import '../shapes/index';

const PKG = 'shape-graphs-live';
const {linkedShape} = linkedPackage(PKG);
const X = 'https://example.org/sg#';
const SH = 'http://www.w3.org/ns/shacl#';

@linkedShape
class SgPerson extends Shape {
  static targetClass = {id: `${X}Person`};

  @literalProperty({path: {id: `${X}name`}, minCount: 1, maxCount: 1})
  get name(): string {
    return null;
  }

  @objectProperty({path: {inv: {id: `${X}parent`}}})
  get children(): unknown {
    return null;
  }
}

@linkedShape
class SgEmployee extends SgPerson {
  static targetClass = {id: `${X}Employee`};

  @literalProperty({path: {id: `${X}employer`}, maxCount: 1})
  get employer(): string {
    return null;
  }
}

const G = ShapesGraph.iriFor(PKG);
const CORE_G = ShapesGraph.iriFor('@_linked/core');
const APP = 'https://acme.id.create.now/app/sg-live/graph/shapes';
const REG = graphs.registry;
const CORE = 'https://linked.cm/ont/core/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LIVE_FUSEKI_TIMEOUT = 30_000;

/** Counts the requests it sends. */
class CountingStore extends FusekiStore {
  updates = 0;
  protected override async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates++;
    return super.executeSparqlUpdate(sparql);
  }
}

async function count(where: string): Promise<number> {
  const json = await executeSparqlQuery(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`);
  return Number(json.results.bindings[0].n.value);
}

/** Blank nodes in `graph` that no statement points at. */
const orphanBlankNodes = (graph: string) =>
  count(`GRAPH <${graph}> { ?b ?p ?o FILTER(isBlank(?b)) FILTER NOT EXISTS { ?x ?y ?b } }`);

describeFuseki('shape graphs on the inferring store', () => {
  let store: CountingStore;

  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    // The registry's class hierarchy, as core.ttl declares it (selects of records infer through it).
    await executeSparqlUpdate(
      `INSERT DATA { <${CORE}ShapesGraph> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://www.w3.org/ns/sparql-service-description#NamedGraph> . }`,
    );
    store = new CountingStore(FUSEKI_BASE_URL, DATASET_NAME);
  });

  test(
    'the sync writes the package graphs and the app graph, then skips them, and cleans the default graph once',
    async () => {
      // What the default-graph sync wrote before shape graphs existed.
      await syncShape(SgPerson, store, {force: true})();
      expect(await count(`<${SgPerson.shape.id}> <${CORE}shapeHash> ?h`)).toBe(1);

      const options = {packages: ['@_linked/core', PKG], appShapes: {graph: APP, package: '@acme/sg-live'}};
      const first = await syncShapeGraphs(store, options);
      expect(first).toEqual({
        written: ['@_linked/core', PKG],
        skipped: [],
        pruned: [],
        cleaned: 1,
        appGraph: 'written',
      });
      // Records: ShapesGraph, not a hierarchy source.
      for (const graph of [G, CORE_G, APP]) {
        expect(await count(`GRAPH <${REG}> { <${graph}> a <${CORE}ShapesGraph> ; <${CORE}feedsHierarchy> false ; <${CORE}contentHash> ?h }`)).toBe(1);
      }
      // As declared: the sub-shape names its parent and holds only its own property shape.
      expect(await count(`GRAPH <${G}> { <${SgEmployee.shape.id}> <${CORE}isExtending> <${SgPerson.shape.id}> }`)).toBe(1);
      expect(await count(`GRAPH <${G}> { <${SgEmployee.shape.id}> <${SH}property> ?p }`)).toBe(1);
      // The default graph no longer holds the old shape, nor its property shapes.
      expect(await count(`<${SgPerson.shape.id}> ?p ?o`)).toBe(0);
      expect(await count(`<${SgPerson.shape.id}/name> ?p ?o`)).toBe(0);
      // Readers find the shapes through graphs.allShapes.
      const rows = (await (QueryBuilder.from(NodeShape).select(['extends']).from(graphs.allShapes) as unknown as {
        exec: (ds: unknown) => Promise<Array<{id: string; extends?: unknown}>>;
      }).exec(store)) ?? [];
      const ids = rows.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([SgPerson.shape.id, SgEmployee.shape.id, NodeShape.shape.id]));

      store.updates = 0;
      const second = await syncShapeGraphs(store, options);
      expect(second).toEqual({written: [], skipped: ['@_linked/core', PKG], pruned: [], cleaned: 0, appGraph: 'skipped'});
      expect(store.updates).toBe(0);
    },
    LIVE_FUSEKI_TIMEOUT,
  );

  test(
    "a sub-shape's instances still validate against the super-shape (SHACL targeting)",
    async () => {
      const data =
        `<${X}Employee> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${X}Person> .\n` +
        `<${X}e1> <${RDF_TYPE}> <${X}Employee> ; <${X}employer> "Acme" .\n` +
        `<${X}e2> <${RDF_TYPE}> <${X}Employee> ; <${X}name> "Eve" .\n`;
      await executeSparqlUpdate(`INSERT DATA { ${data} }`);
      // The select of the sub-shape's instances reads the inherited property.
      const rows = (await (QueryBuilder.from(SgEmployee).select((p: any) => [p.name]) as unknown as {
        exec: (ds: unknown) => Promise<Array<{id: string; name?: string}>>;
      }).exec(store)) ?? [];
      expect(rows.map((r) => r.id).sort()).toEqual([`${X}e1`, `${X}e2`]);

      // The shapes as the shape graph holds them: Employee names no `name` property of its own.
      const shapes = shapesToTurtle([SgPerson, SgEmployee]);
      expect(shapes).not.toContain(`${SgEmployee.shape.id}/name`);
      const report = await validateWithJenaShacl(shapes, data);
      expect(report).toMatch(/sh:conforms\s+false/);
      expect(report).toContain('MinCountConstraintComponent');
      expect(report).toContain(`<${X}e1>`);
      expect(report).not.toContain(`<${X}e2>`);
      expect(report).toContain(`${SgPerson.shape.id}/name`);
    },
    LIVE_FUSEKI_TIMEOUT,
  );
  afterAll(async () => {
    await deleteTestDataset();
  });

  test(
    'a CBD patch of a shape with an sh:inversePath leaves no orphan blank node',
    async () => {
      const G = ShapesGraph.iriFor(`${PKG}-cbd`);
      await ShapesGraph.create({id: G, package: `${PKG}-cbd`})
        .withContent({mediaType: 'text/turtle', text: shapesToTurtle([SgPerson, SgEmployee])})
        .exec(store);
      const children = `${SgPerson.shape.id}/children`;
      expect(await count(`GRAPH <${G}> { <${children}> <${SH}path> [ <${SH}inversePath> <${X}parent> ] }`)).toBe(1);
      const blanksBefore = await count(`GRAPH <${G}> { ?s ?p ?b FILTER(isBlank(?b)) }`);

      // The property shape's statements as shapes.ttl writes them, before and after the edit.
      const unit = (parent: string) => ({
        mediaType: 'text/turtle' as const,
        text:
          `@prefix sh: <${SH}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n` +
          `<${children}>\n  a sh:PropertyShape ;\n  rdfs:label "children" ;\n  sh:nodeKind sh:IRI ;\n` +
          `  sh:path [ sh:inversePath <${X}${parent}> ] .\n`,
      });
      await NamedGraph.patchContent(G, {delete: unit('parent'), insert: unit('mother')}).exec(store);

      expect(await count(`GRAPH <${G}> { ?s <${SH}inversePath> <${X}parent> }`)).toBe(0);
      expect(await count(`GRAPH <${G}> { <${children}> <${SH}path> [ <${SH}inversePath> <${X}mother> ] }`)).toBe(1);
      expect(await count(`GRAPH <${G}> { ?s ?p ?b FILTER(isBlank(?b)) }`)).toBe(blanksBefore);
      expect(await orphanBlankNodes(G)).toBe(0);
      expect(await count(`GRAPH <${G}> { <${children}> ?p ?o }`)).toBe(4);
    },
    LIVE_FUSEKI_TIMEOUT,
  );
});
