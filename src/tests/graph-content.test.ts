/*
 * graphContent: the text and hash of each package graph and of the app graph equal what the
 * 'package'-mode syncs write and record, and it writes nothing.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {OntologyGraph, ShapesGraph} from '../shapes/NamedGraph';
import {syncShapeGraphs} from '../shapes/syncShapeGraphs';
import {syncOntologies} from '../ontology/syncOntologies';
import {graphContent} from '../shapes/syncTargets';
import {MemoryGraphStore} from '../test-helpers/memory-graph-store';
import '../shapes/index';

const NS = 'http://example.org/gc-onto/';
const X = 'http://example.org/gc#';
const SUB = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

// Two data files with the same blank node label: joined as Turtle they would be one node.
linkedPackage('gc-onto').linkedOntology(
  {},
  createNameSpace(NS),
  'gc-onto',
  async () => [
    `@prefix ex: <${NS}> .\nex:A <${SUB}> ex:B .\nex:A ex:note _:n .\n_:n ex:text "one" .`,
    `@prefix ex: <${NS}> .\nex:C <${SUB}> ex:B .\nex:C ex:note _:n .\n_:n ex:text "two" .`,
  ],
  ['../data/a.ttl', '../data/b.ttl'],
);

const {linkedShape} = linkedPackage('gc-shapes');

@linkedShape
class GcPart extends Shape {
  static targetClass = {id: `${X}Part`};
}

@linkedShape
class GcWhole extends Shape {
  static targetClass = {id: `${X}Whole`};
  @literalProperty({path: {id: `${X}name`}, maxCount: 1})
  get name(): string {
    return null;
  }
  @objectProperty({path: {id: `${X}part`}, shape: GcPart, maxCount: 1, contains: true})
  get part(): GcPart {
    return null;
  }
}

const APP = 'https://acme.example/app/gc/graph/shapes';

describe('graphContent', () => {
  test('equals what the package-mode syncs write and record', async () => {
    const ds = new MemoryGraphStore('gc');
    const content = await graphContent({packages: ['gc-shapes', 'gc-onto'], appShapes: {graph: APP}});
    expect(ds.graphQueries).toEqual([]);

    await syncOntologies(ds, {packages: ['gc-onto']});
    await syncShapeGraphs(ds, {packages: ['gc-shapes'], appShapes: {graph: APP}});

    const onto = content.packages.find((p) => p.name === 'gc-onto')!;
    expect(onto.shapes).toBeUndefined();
    expect(onto.ontology).toMatchObject({graph: OntologyGraph.iriFor('gc-onto'), mediaType: 'application/n-triples'});
    const ontoStored = ds.graphs.get(OntologyGraph.iriFor('gc-onto'))!;
    expect(onto.ontology!.text).toBe(ontoStored.text);
    expect(onto.ontology!.hash).toBe(ontoStored.contentHash);
    expect(onto.ontology!.sources).toEqual(['data/a.ttl', 'data/b.ttl']);
    // The two `_:n` stay two nodes.
    expect(new Set(onto.ontology!.text.match(/_:\S+/g)).size).toBe(2);

    const shapes = content.packages.find((p) => p.name === 'gc-shapes')!;
    expect(shapes.ontology).toBeUndefined();
    const shapesStored = ds.graphs.get(ShapesGraph.iriFor('gc-shapes'))!;
    expect(shapes.shapes).toEqual({
      graph: ShapesGraph.iriFor('gc-shapes'),
      mediaType: 'text/turtle',
      text: shapesStored.text,
      hash: shapesStored.contentHash,
      sources: ['data/shapes.ttl'],
    });

    const appStored = ds.graphs.get(APP)!;
    expect(content.appGraph).toEqual({graph: APP, mediaType: 'text/turtle', text: appStored.text, hash: appStored.contentHash, sources: []});
  });

  test('without packages: every package with shapes or ontology data; appGraph left out without appShapes', async () => {
    const content = await graphContent();
    const names = content.packages.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['@_linked/core', 'gc-onto', 'gc-shapes']));
    expect(names).toEqual([...names].sort());
    expect('appGraph' in content).toBe(false);
  });

  test('a name without shapes or data is answered empty; the turtle a caller passes is used', async () => {
    const content = await graphContent({packages: ['gc-none', 'gc-shapes'], turtleFor: (n) => (n === 'gc-shapes' ? '# file\n' : undefined)});
    expect(content.packages).toEqual([
      {name: 'gc-none'},
      {name: 'gc-shapes', shapes: expect.objectContaining({text: '# file\n'})},
    ]);
  });
});
