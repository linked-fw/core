/*
 * The routed syncs on two Fuseki datasets of their own: a pinned package's shape and ontology
 * graphs land in both, unchanged on a second run; once routing sends nothing of it to the
 * default dataset any more, its graphs are dropped there and stay in the other one.
 */
import {afterAll, beforeAll, expect, test} from '@jest/globals';
import {createDataset, DATASET_NAME, deleteDataset, FUSEKI_BASE_URL} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {Shape} from '../shapes/Shape';
import {literalProperty, NodeShape, PropertyShape} from '../shapes/SHACL';
import {LinkedStorage} from '../utils/LinkedStorage';
import {OntologyGraph, ShapesGraph} from '../shapes/NamedGraph';
import {getAllShapeClasses} from '../utils/ShapeClass';
import {ONTOLOGY_TERM_CLASSES, syncOntologiesRouted, syncShapeGraphsRouted, targetClassOf} from '../shapes/syncTargets';
import '../shapes/index';

const NS = 'http://example.org/srf-onto/';
const X = 'http://example.org/srf#';
const PKG = 'srf-shapes';
const ONTO = 'srf-onto';

linkedPackage(ONTO).linkedOntology({}, createNameSpace(NS), ONTO, async () => [
  `<${NS}Single> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${NS}Work> .`,
], '../data/srf-onto.ttl');

const {linkedShape} = linkedPackage(PKG);
@linkedShape
class SrfSingle extends Shape {
  static targetClass = {id: `${NS}Single`};
  @literalProperty({path: {id: `${X}title`}, maxCount: 1})
  get title(): string {
    return null;
  }
}

const {linkedShape: termsShape} = linkedPackage('srf-terms');

/** A term shape (rdfs:Class), as @_linked/rdfs registers one. */
@termsShape
class SrfClassTerm extends Shape {
  static targetClass = {id: 'http://www.w3.org/2000/01/rdf-schema#Class'};
}

const A = DATASET_NAME;
const B = `${DATASET_NAME}-b`;
const SHAPES_G = ShapesGraph.iriFor(PKG);
const ONTO_G = OntologyGraph.iriFor(ONTO);
const TIMEOUT = 30_000;

async function ask(dataset: string, graph: string): Promise<boolean> {
  const response = await fetch(`${FUSEKI_BASE_URL}/${dataset}/sparql`, {
    method: 'POST',
    headers: {'Content-Type': 'application/sparql-query', Accept: 'application/sparql-results+json'},
    body: `ASK { GRAPH <${graph}> { ?s ?p ?o } }`,
  });
  if (!response.ok) throw new Error(`ASK on ${dataset}: ${response.status}`);
  return ((await response.json()) as {boolean: boolean}).boolean;
}

describeFuseki('the routed syncs on two datasets', () => {
  let a: FusekiStore;
  let b: FusekiStore;

  beforeAll(async () => {
    for (const name of [A, B]) {
      await deleteDataset(name);
      await createDataset(name, {dbType: 'mem'});
    }
    a = new FusekiStore(FUSEKI_BASE_URL, A);
    b = new FusekiStore(FUSEKI_BASE_URL, B);
    LinkedStorage.setDefaultDataset(a);
  }, TIMEOUT);

  afterAll(async () => {
    for (const name of [A, B]) await deleteDataset(name);
  }, TIMEOUT);

  const sync = async () => ({
    ontologies: await syncOntologiesRouted({packages: [ONTO]}),
    shapes: await syncShapeGraphsRouted({packages: [PKG]}),
  });

  test(
    'a pinned package lands in both; a second run writes nothing; routed away from the default, it is pruned there',
    async () => {
      LinkedStorage.setDatasetForShapes(b, SrfSingle);
      const first = await sync();
      expect(first.shapes.failed).toEqual([]);
      expect(first.ontologies.failed).toEqual([]);
      for (const dataset of [A, B]) {
        expect(await ask(dataset, SHAPES_G)).toBe(true);
        expect(await ask(dataset, ONTO_G)).toBe(true);
      }

      const second = await sync();
      expect(second.shapes.targets.flatMap((t) => t.result.written)).toEqual([]);
      expect(second.ontologies.targets.flatMap((t) => t.result.written)).toEqual([]);

      // Nothing of the package, nor the shapes describing its graphs, routes to A any more.
      const termShapes = [...getAllShapeClasses().values()].filter((c) =>
        ONTOLOGY_TERM_CLASSES.includes(targetClassOf(c) ?? ''),
      );
      expect(termShapes).toContain(SrfClassTerm);
      LinkedStorage.setDatasetForShapes(b, NodeShape, PropertyShape, ...termShapes);
      const moved = await sync();
      expect(moved.shapes.pruned).toEqual([expect.objectContaining({package: PKG, graph: SHAPES_G})]);
      expect(moved.ontologies.pruned).toEqual([expect.objectContaining({package: ONTO, graph: ONTO_G})]);
      expect(await ask(A, SHAPES_G)).toBe(false);
      expect(await ask(A, ONTO_G)).toBe(false);
      expect(await ask(B, SHAPES_G)).toBe(true);
      expect(await ask(B, ONTO_G)).toBe(true);
    },
    TIMEOUT * 2,
  );
});
