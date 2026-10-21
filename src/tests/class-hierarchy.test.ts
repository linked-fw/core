/*
 * The class hierarchy in memory: the shape tree's edges, the ontology triples once set, and
 * `loadOntologyHierarchy` / `checkShapeHierarchy` filling it.
 */
import {beforeEach, describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {Shape} from '../shapes/Shape';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';
import {
  setOntologyHierarchy,
  subClassesOf,
  superClassesOf,
} from '../ontology/classHierarchy';
import {loadOntologyHierarchy} from '../ontology/hierarchy';
import {checkShapeHierarchy} from '../shapes/checkShapeHierarchy';

const NS = 'http://example.org/classes/';
const ex = (term: string) => ({id: `${NS}${term}`});
const iri = (term: string) => `${NS}${term}`;
const set = (...terms: string[]) => new Set(terms.map((t) => (t.includes('://') ? t : iri(t))));

const pkg = linkedPackage('class-hierarchy-test');

@pkg.linkedShape
class Organism extends Shape {
  static targetClass = ex('Organism');
}
@pkg.linkedShape
class Animal extends Organism {
  static targetClass = ex('Animal');
}
@pkg.linkedShape
class Dog extends Animal {
  static targetClass = ex('Dog');
}
/** Inherits Dog's class: adds no edge. */
@pkg.linkedShape({sharedTargetClass: true})
class DogProfile extends Dog {}

// The ontology data a package registers, read by loadOntologyHierarchy.
const data = {
  ttl: `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <${NS}> .
ex:Puppy rdfs:subClassOf ex:Dog .
ex:Plant rdfs:subClassOf ex:Organism .`,
};
linkedPackage('class-hierarchy-data').linkedOntology(
  {},
  createNameSpace('http://example.org/ns/class-hierarchy-data/'),
  'chd',
  async () => [data.ttl],
  '../data/chd.ttl',
);

beforeEach(() => setOntologyHierarchy([]));

describe('the class hierarchy in memory', () => {
  test('the shape tree alone gives the closure', () => {
    void DogProfile;
    expect(superClassesOf(iri('Dog'))).toEqual(set('Dog', 'Animal', 'Organism'));
    expect(subClassesOf(iri('Organism'))).toEqual(set('Organism', 'Animal', 'Dog'));
    expect(subClassesOf(iri('Dog'))).toEqual(set('Dog'));
  });

  test('an unknown IRI is its own only superclass and subclass', () => {
    expect(superClassesOf(iri('Nothing'))).toEqual(set('Nothing'));
    expect(subClassesOf(iri('Nothing'))).toEqual(set('Nothing'));
  });

  test('the ontology triples join the shape edges once set, and replace the previous ones', () => {
    setOntologyHierarchy([{s: iri('Puppy'), o: iri('Dog')}]);
    expect(superClassesOf(iri('Puppy'))).toEqual(set('Puppy', 'Dog', 'Animal', 'Organism'));
    expect(subClassesOf(iri('Organism'))).toEqual(set('Organism', 'Animal', 'Dog', 'Puppy'));

    setOntologyHierarchy([{s: iri('Kitten'), o: iri('Animal')}]);
    expect(superClassesOf(iri('Puppy'))).toEqual(set('Puppy'));
    expect(subClassesOf(iri('Animal'))).toEqual(set('Animal', 'Dog', 'Kitten'));
  });

  test('a cycle terminates', () => {
    setOntologyHierarchy([
      {s: iri('Loop1'), o: iri('Loop2')},
      {s: iri('Loop2'), o: iri('Loop1')},
    ]);
    expect(superClassesOf(iri('Loop1'))).toEqual(set('Loop1', 'Loop2'));
    expect(subClassesOf(iri('Loop2'))).toEqual(set('Loop1', 'Loop2'));
  });

  test('a shape registered after a read is seen', () => {
    expect(superClassesOf(iri('Wolf'))).toEqual(set('Wolf'));
    registerRuntimeShape({
      id: 'http://example.org/classes/shapes/Wolf',
      label: 'Wolf',
      targetClass: ex('Wolf'),
      extends: {id: (Animal as typeof Shape).shape.id},
      propertyShapes: [],
    } as never);
    expect(superClassesOf(iri('Wolf'))).toEqual(set('Wolf', 'Animal', 'Organism'));
  });

  test('loadOntologyHierarchy parses the registered data, sets and returns it', async () => {
    const triples = await loadOntologyHierarchy();
    expect(triples).toEqual(
      expect.arrayContaining([
        {s: iri('Plant'), o: iri('Organism')},
        {s: iri('Puppy'), o: iri('Dog')},
      ]),
    );
    expect(superClassesOf(iri('Puppy'))).toEqual(set('Puppy', 'Dog', 'Animal', 'Organism'));
    expect(subClassesOf(iri('Organism'))).toEqual(
      set('Organism', 'Animal', 'Dog', 'Puppy', 'Plant', 'Wolf'),
    );
  });

  test('checkShapeHierarchy without a hierarchy loads and sets it; with one, sets nothing', async () => {
    await checkShapeHierarchy({hierarchy: [{s: iri('Puppy'), o: iri('Dog')}]});
    expect(superClassesOf(iri('Plant'))).toEqual(set('Plant'));
    expect(superClassesOf(iri('Puppy'))).toEqual(set('Puppy'));
    await checkShapeHierarchy();
    expect(superClassesOf(iri('Plant'))).toEqual(set('Plant', 'Organism'));
  });
});
