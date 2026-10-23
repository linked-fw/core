/*
 * Shape graphs on the inferring store: a patch of one shape's statements (its concise bounded
 * description, with an `sh:inversePath` blank node) leaves no orphan blank node.
 */
import {afterAll, beforeAll, expect, test} from '@jest/globals';
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
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {NamedGraph, ShapesGraph} from '../shapes/NamedGraph';
import {shapesToTurtle} from '../shapes/shapesToTurtle';
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
const LIVE_FUSEKI_TIMEOUT = 30_000;

async function count(where: string): Promise<number> {
  const json = await executeSparqlQuery(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`);
  return Number(json.results.bindings[0].n.value);
}

/** Blank nodes in `graph` that no statement points at. */
const orphanBlankNodes = (graph: string) =>
  count(`GRAPH <${graph}> { ?b ?p ?o FILTER(isBlank(?b)) FILTER NOT EXISTS { ?x ?y ?b } }`);

describeFuseki('shape graphs on the inferring store', () => {
  let store: FusekiStore;

  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  test(
    'a CBD patch of a shape with an sh:inversePath leaves no orphan blank node',
    async () => {
      await ShapesGraph.create({id: G, package: PKG})
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
