/*
 * Where the routed syncs write (graphSyncTargets): every package's graphs in the default dataset
 * without pins; a pinned shape adds its dataset to its package's shape graph, to the ontology it
 * targets, and (with contains properties) to the app graph; a sub-shape follows its parent's pin;
 * the shape shapes and the term shapes pinned apart are both targets (no refusal).
 */
import {afterEach, describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty, NodeShape, PropertyShape} from '../shapes/SHACL';
import {LinkedStorage} from '../utils/LinkedStorage';
import {graphSyncTargets, ONTOLOGY_TERM_CLASSES, SHAPE_SHAPE_CLASSES, targetClassOf} from '../shapes/syncTargets';
import {MemoryGraphStore} from '../test-helpers/memory-graph-store';
import '../shapes/index';

const ONTO_NS = 'http://example.org/st-onto/';
const X = 'http://example.org/st#';
const RDFS_CLASS = 'http://www.w3.org/2000/01/rdf-schema#Class';

// An ontology-only package: data, no shapes.
linkedPackage('st-onto').linkedOntology({}, createNameSpace(ONTO_NS), 'st-onto', async () => [
  `<${ONTO_NS}Thing> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${ONTO_NS}Root> .`,
]);

const a = linkedPackage('st-a');

@a.linkedShape
class StPart extends Shape {
  static targetClass = {id: `${X}Part`};
}

@a.linkedShape
class StOwner extends Shape {
  static targetClass = {id: `${X}Owner`};
  @objectProperty({path: {id: `${X}part`}, shape: StPart, maxCount: 1, contains: true})
  get part(): StPart {
    return null;
  }
}

@a.linkedShape
class StSubOwner extends StOwner {
  static targetClass = {id: `${X}SubOwner`};
}

const b = linkedPackage('st-b');

/** A shape of another package targeting the ontology-only package's class. */
@b.linkedShape
class StThing extends Shape {
  static targetClass = {id: `${ONTO_NS}Thing`};
  @literalProperty({path: {id: `${X}title`}, maxCount: 1})
  get title(): string {
    return null;
  }
}

/** A term shape (rdfs:Class), as @_linked/rdfs registers one. */
@b.linkedShape
class StClassTerm extends Shape {
  static targetClass = {id: RDFS_CLASS};
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
afterEach(() => {
  for (const shape of pinned.splice(0)) LinkedStorage.unsetDatasetForShape(shape);
});

const ids = (list: unknown[] | undefined) => (list ?? []).map((ds) => (ds as MemoryGraphStore).id);

describe('graphSyncTargets', () => {
  test('the watched classes', () => {
    expect(SHAPE_SHAPE_CLASSES).toEqual(['http://www.w3.org/ns/shacl#NodeShape', 'http://www.w3.org/ns/shacl#PropertyShape']);
    expect(ONTOLOGY_TERM_CLASSES).toContain(RDFS_CLASS);
    expect(targetClassOf(StSubOwner)).toBe(`${X}SubOwner`);
    expect(targetClassOf(NodeShape)).toBe(SHAPE_SHAPE_CLASSES[0]);
  });

  test('without pins every graph goes to the default dataset only', () => {
    const t = graphSyncTargets();
    for (const name of ['st-a', 'st-b', '@_linked/core']) expect(ids(t.shapes.get(name))).toEqual(['main']);
    expect(ids(t.ontologies.get('st-onto'))).toEqual(['main']);
    expect(ids(t.appShapes)).toEqual(['main']);
    expect(ids(t.datasets)).toEqual(['main']);
    expect(t.shapes.has('st-onto')).toBe(false);
    expect(t.ontologies.has('st-a')).toBe(false);
  });

  test("a pinned shape adds its dataset to its package's shapes and to the ontology it targets", () => {
    pin(two, StThing);
    const t = graphSyncTargets();
    expect(ids(t.shapes.get('st-b'))).toEqual(['main', 'two']);
    expect(ids(t.shapes.get('st-a'))).toEqual(['main']);
    // The ontology-only package follows the shape that targets its class.
    expect(ids(t.ontologies.get('st-onto'))).toEqual(['main', 'two']);
    // StThing declares no contains property.
    expect(ids(t.appShapes)).toEqual(['main']);
  });

  test("a sub-shape follows its parent's pin; a shape declaring contains takes the app graph along", () => {
    pin(two, StOwner);
    const t = graphSyncTargets();
    expect(ids(t.shapes.get('st-a'))).toEqual(['main', 'two']);
    expect(ids(t.appShapes)).toEqual(['main', 'two']);
    const t2 = (() => {
      LinkedStorage.unsetDatasetForShape(StOwner);
      pin(three, StSubOwner);
      return graphSyncTargets();
    })();
    expect(ids(t2.shapes.get('st-a'))).toEqual(['main', 'three']);
    // The app graph follows the shapes that declare the contains property, not their sub-shapes.
    expect(ids(t2.appShapes)).toEqual(['main']);
  });

  test('NodeShape and PropertyShape pinned to two datasets: every shape graph goes to both, no refusal', () => {
    pin(two, NodeShape);
    pin(three, PropertyShape);
    const t = graphSyncTargets();
    // Each package's own shapes stay in main, so main stays a target too.
    for (const name of ['st-a', 'st-b']) expect(ids(t.shapes.get(name))).toEqual(['main', 'two', 'three']);
    expect(ids(t.appShapes)).toEqual(['main', 'two', 'three']);
  });

  test('the term shapes pinned: every ontology graph goes there too', () => {
    pin(three, StClassTerm);
    const t = graphSyncTargets();
    expect(ids(t.ontologies.get('st-onto'))).toEqual(['main', 'three']);
    // A shape graph does not follow the term shapes.
    expect(ids(t.shapes.get('st-a'))).toEqual(['main']);
  });

  test('every shape of a package pinned away and the shape shapes with it: main is no target', () => {
    pin(two, StThing, StClassTerm, NodeShape, PropertyShape);
    const t = graphSyncTargets();
    expect(ids(t.shapes.get('st-b'))).toEqual(['two']);
    expect(ids(t.shapes.get('st-a'))).toEqual(['main', 'two']);
  });
});
