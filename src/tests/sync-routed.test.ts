/*
 * The routed syncs on in-memory stores: each target gets the same text and hash, a second run
 * writes nothing, a moved pin prunes the graph from the default dataset and reports it elsewhere,
 * the shared modes hold each dataset's own packages, the hierarchy covers every package, and a
 * failing dataset is reported while the others sync.
 */
import {afterEach, describe, expect, jest, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {Shape} from '../shapes/Shape';
import {literalProperty, NodeShape, PropertyShape} from '../shapes/SHACL';
import {LinkedStorage} from '../utils/LinkedStorage';
import {OntologyGraph, ShapesGraph} from '../shapes/NamedGraph';
import {setGraphTargets} from '../utils/graphTargets';
import {superClassesOf} from '../ontology/classHierarchy';
import {ONTOLOGY_TERM_CLASSES, syncOntologiesRouted, syncShapeGraphsRouted, targetClassOf} from '../shapes/syncTargets';
import {getAllShapeClasses} from '../utils/ShapeClass';
import {syncShapeGraphs} from '../shapes/syncShapeGraphs';
import {MemoryGraphStore} from '../test-helpers/memory-graph-store';
import '../shapes/index';

const NS_A = 'http://example.org/sr-onto-a/';
const NS_B = 'http://example.org/sr-onto-b/';
const SUB = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const X = 'http://example.org/sr#';

linkedPackage('sr-onto-a').linkedOntology({}, createNameSpace(NS_A), 'sr-onto-a', async () => [
  `<${NS_A}Kid> <${SUB}> <${NS_A}Person> .`,
]);
linkedPackage('sr-onto-b').linkedOntology({}, createNameSpace(NS_B), 'sr-onto-b', async () => [
  `<${NS_B}Album> <${SUB}> <${NS_B}Work> .`,
]);

const {linkedShape: aShape} = linkedPackage('sr-a');
@aShape
class SrPerson extends Shape {
  static targetClass = {id: `${NS_A}Person`};
  @literalProperty({path: {id: `${X}name`}, maxCount: 1})
  get name(): string {
    return null;
  }
}

const {linkedShape: bShape} = linkedPackage('sr-b');
@bShape
class SrAlbum extends Shape {
  static targetClass = {id: `${NS_B}Album`};
  @literalProperty({path: {id: `${X}title`}, maxCount: 1})
  get title(): string {
    return null;
  }
}

const {linkedShape: termsShape} = linkedPackage('sr-terms');

/** A term shape (rdfs:Class), as @_linked/rdfs registers one. */
@termsShape
class SrClassTerm extends Shape {
  static targetClass = {id: 'http://www.w3.org/2000/01/rdf-schema#Class'};
}

const main = new MemoryGraphStore('main');
const two = new MemoryGraphStore('two');
const three = new MemoryGraphStore('three');
LinkedStorage.setDefaultDataset(main);

const pinned: Function[] = [];
const pin = (ds: MemoryGraphStore, ...shapes: Function[]) => {
  LinkedStorage.setDatasetForShapes(ds, ...shapes);
  pinned.push(...shapes);
};
const unpin = (...shapes: Function[]) => shapes.forEach((s) => LinkedStorage.unsetDatasetForShape(s));

afterEach(() => {
  unpin(...pinned.splice(0));
  setGraphTargets({});
  for (const ds of [main, two, three]) {
    ds.graphs.clear();
    ds.graphQueries = [];
    ds.failing = false;
  }
  jest.restoreAllMocks();
});

const SHAPES_B = ShapesGraph.iriFor('sr-b');
const SHAPES_A = ShapesGraph.iriFor('sr-a');
const ONTO_B = OntologyGraph.iriFor('sr-onto-b');
const ONTO_A = OntologyGraph.iriFor('sr-onto-a');
const APP = 'https://acme.example/app/sr/graph/shapes';
/** This file's packages: core's own Turtle, generated in a test process, holds fixture lists with fresh IRIs. */
const OWN = {packages: ['sr-a', 'sr-b']};

describe('syncShapeGraphsRouted', () => {
  test('without pins: one target, the calls syncShapeGraphs alone makes', async () => {
    const routed = await syncShapeGraphsRouted({...OWN, appShapes: {graph: APP}});
    expect(routed.targets.map((t) => t.dataset)).toEqual(['MemoryGraphStore "main"']);
    const alone = new MemoryGraphStore('alone');
    await syncShapeGraphs(alone, {...OWN, appShapes: {graph: APP}});
    expect(main.graphQueries).toEqual(alone.graphQueries);
    expect(routed).toMatchObject({pruned: [], leftovers: [], failed: []});
  });

  test('a pinned package goes to both datasets with the same text and hash; a second run writes nothing', async () => {
    pin(two, SrAlbum);
    const first = await syncShapeGraphsRouted(OWN);
    expect(first.targets.map((t) => t.dataset)).toEqual(['MemoryGraphStore "main"', 'MemoryGraphStore "two"']);
    expect(first.targets[1].result.written).toEqual(['sr-b']);
    expect([...two.graphs.keys()]).toEqual([SHAPES_B]);
    expect(two.graphs.get(SHAPES_B)).toEqual(main.graphs.get(SHAPES_B));
    expect(main.graphs.has(SHAPES_A)).toBe(true);

    main.graphQueries = [];
    two.graphQueries = [];
    const second = await syncShapeGraphsRouted(OWN);
    expect(main.graphQueries).toEqual([]);
    expect(two.graphQueries).toEqual([]);
    expect(second.targets[1].result.skipped).toEqual(['sr-b']);
  });

  test('a moved pin: reported in the dataset it left, never dropped there', async () => {
    pin(two, SrAlbum);
    await syncShapeGraphsRouted(OWN);
    // Keep "two" known to the router (a dataset nothing is pinned to any more is not read).
    pin(two, SrClassTerm);
    unpin(SrAlbum);
    pin(three, SrAlbum);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const moved = await syncShapeGraphsRouted(OWN);
    expect(three.graphs.has(SHAPES_B)).toBe(true);
    expect(two.graphs.has(SHAPES_B)).toBe(true);
    expect(moved.leftovers).toEqual([{dataset: 'MemoryGraphStore "two"', package: 'sr-b', graph: SHAPES_B}]);
    expect(moved.pruned).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(`<${SHAPES_B}> (sr-b) in MemoryGraphStore "two"`);
  });

  test("a package routed away from the default dataset is pruned there; other packages' graphs stay", async () => {
    await syncShapeGraphsRouted(OWN);
    expect(main.graphs.has(SHAPES_B)).toBe(true);
    pin(two, SrAlbum, NodeShape, PropertyShape);
    const moved = await syncShapeGraphsRouted(OWN);
    expect(moved.pruned).toEqual([{dataset: 'MemoryGraphStore "main"', package: 'sr-b', graph: SHAPES_B}]);
    expect(main.graphs.has(SHAPES_B)).toBe(false);
    expect(main.graphs.has(SHAPES_A)).toBe(true);
    expect(two.graphs.has(SHAPES_B)).toBe(true);
    // prune: false leaves it.
    await syncShapeGraphsRouted({...OWN, force: true});
    unpin(SrAlbum, NodeShape, PropertyShape);
    pinned.splice(0);
    await syncShapeGraphsRouted(OWN);
    pin(two, SrAlbum, NodeShape, PropertyShape);
    expect((await syncShapeGraphsRouted({...OWN, prune: false})).pruned).toEqual([]);
    expect(main.graphs.has(SHAPES_B)).toBe(true);
  });

  test("a shared shape graph per dataset holds that dataset's packages", async () => {
    const SHARED = 'https://example.org/graph/shapes';
    setGraphTargets({shapeGraph: SHARED});
    pin(two, SrAlbum);
    const routed = await syncShapeGraphsRouted(OWN);
    const lines = (ds: MemoryGraphStore) => ds.graphs.get(SHARED)!.record.packageHashes as string[];
    expect(lines(two).map((l) => l.split(' ')[0])).toEqual(['sr-b']);
    expect(lines(main).map((l) => l.split(' ')[0])).toEqual(['sr-a', 'sr-b']);
    expect(routed.targets[1].result.target).toBe(SHARED);
  });

  test('a failing dataset is reported; the others sync', async () => {
    pin(two, SrAlbum);
    two.failing = true;
    const routed = await syncShapeGraphsRouted(OWN);
    expect(routed.failed).toEqual([{dataset: 'MemoryGraphStore "two"', error: expect.stringContaining('store two is down')}]);
    expect(routed.targets.map((t) => t.dataset)).toEqual(['MemoryGraphStore "main"']);
    expect(main.graphs.has(SHAPES_B)).toBe(true);
  });
});

describe('syncOntologiesRouted', () => {
  test('an ontology follows the shapes targeting its classes; the hierarchy covers every package', async () => {
    pin(two, SrAlbum);
    const routed = await syncOntologiesRouted();
    expect(routed.targets.map((t) => t.dataset)).toEqual(['MemoryGraphStore "main"', 'MemoryGraphStore "two"']);
    expect([...two.graphs.keys()]).toEqual([ONTO_B]);
    expect(two.graphs.get(ONTO_B)).toEqual(main.graphs.get(ONTO_B));
    expect(main.graphs.has(ONTO_A)).toBe(true);
    expect(superClassesOf(`${NS_A}Kid`)).toContain(`${NS_A}Person`);
    expect(superClassesOf(`${NS_B}Album`)).toContain(`${NS_B}Work`);

    two.graphQueries = [];
    await syncOntologiesRouted();
    expect(two.graphQueries).toEqual([]);
  });

  test('routed away from the default dataset: pruned there', async () => {
    await syncOntologiesRouted();
    expect(main.graphs.has(ONTO_B)).toBe(true);
    // Every term shape pinned away with the album: main no longer gets sr-onto-b.
    const termShapes = [...getAllShapeClasses().values()].filter((c) => ONTOLOGY_TERM_CLASSES.includes(targetClassOf(c) ?? ''));
    expect(termShapes).toContain(SrClassTerm);
    pin(two, SrAlbum, ...termShapes);
    const moved = await syncOntologiesRouted();
    expect(moved.pruned.map((p) => p.package)).toContain('sr-onto-b');
    expect(main.graphs.has(ONTO_B)).toBe(false);
  });

  test("a shared ontology graph per dataset holds that dataset's packages", async () => {
    const SHARED = 'https://example.org/graph/ontology';
    setGraphTargets({ontologyGraph: SHARED});
    pin(two, SrAlbum);
    await syncOntologiesRouted();
    const names = (ds: MemoryGraphStore) =>
      (ds.graphs.get(SHARED)!.record.packageHashes as string[]).map((l) => l.split(' ')[0]);
    expect(names(two)).toEqual(['sr-onto-b']);
    expect(names(main)).toEqual(expect.arrayContaining(['sr-onto-a', 'sr-onto-b']));
  });

  test('a failing dataset is reported; the others sync', async () => {
    pin(two, SrAlbum);
    two.failing = true;
    const routed = await syncOntologiesRouted();
    expect(routed.failed).toEqual([{dataset: 'MemoryGraphStore "two"', error: expect.stringContaining('store two is down')}]);
    expect(main.graphs.has(ONTO_B)).toBe(true);
  });

  test("the 'default' mode warns once for a dataset that does not get every package (backlog 068)", async () => {
    setGraphTargets({ontologyGraph: 'default'});
    pin(two, SrAlbum);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const routed = await syncOntologiesRouted({packages: ['sr-onto-a', 'sr-onto-b']});
    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("routing sends the ontologies of"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('elsewhere than MemoryGraphStore "two"');
    expect(said[0]).toContain('sr-onto-a');
    expect(routed.pruned).toEqual([]);
    await syncOntologiesRouted({packages: ['sr-onto-a', 'sr-onto-b']});
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('routing sends the ontologies of'))).toHaveLength(1);
  });
});
