/*
 * validateByClass: a node is validated against every registered shape that targets one of its
 * classes or a superclass of one (SHACL class targeting, in process).
 */
import {beforeEach, describe, expect, test} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import type {NodeShapeData} from '../shapes/nodeShapeData';
import {validateByClass} from '../shapes/validation';
import {setOntologyHierarchy} from '../ontology/classHierarchy';
import {shacl} from '../ontologies/shacl';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';

const base = 'linked://tmp/by-class/';
const cls = (s: string) => `${base}types/${s}`;
const prop = (s: string) => ({id: `${base}props/${s}`});
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

@linkedShape
class Animal extends Shape {
  static targetClass = {id: cls('Animal')};
  @literalProperty({path: prop('name'), minCount: 1, maxCount: 1})
  get name(): string {
    return '';
  }
}

/** A sub-shape with its own class. */
@linkedShape
class Dog extends Animal {
  static targetClass = {id: cls('Dog')};
  @literalProperty({path: prop('breed'), maxCount: 1})
  get breed(): string {
    return '';
  }
}

/** A sub-shape that inherits Dog's class: never selected on its own. */
@linkedShape({sharedTargetClass: true})
class ShowDog extends Dog {
  @literalProperty({path: prop('title'), minCount: 1})
  get title(): string {
    return '';
  }
}

@linkedShape
class Robot extends Shape {
  static targetClass = {id: cls('Robot')};
  @literalProperty({path: prop('serial'), minCount: 1, maxCount: 1})
  get serial(): string {
    return '';
  }
}

const shapeOf = (c: {shape: NodeShapeData}) => c.shape;
const propertyShapeId = (c: {shape: NodeShapeData}, label: string) =>
  shapeOf(c).propertyShapes.find((ps) => ps.label === label)!.id;
const components = (report: ReturnType<typeof validateByClass>) =>
  report.results.map((r) => r.sourceConstraintComponent.id);

beforeEach(() => setOntologyHierarchy([]));

describe('validateByClass', () => {
  test('a subclass node is validated against the superclass shape', () => {
    // Puppy has no shape; the ontology makes it a Dog, so Dog's and Animal's shapes run.
    setOntologyHierarchy([{s: cls('Puppy'), o: cls('Dog')}]);
    const report = validateByClass({id: 'urn:puppy:1', type: cls('Puppy'), breed: ['a', 'b']});
    expect(report.conforms).toBe(false);
    expect(components(report).sort()).toEqual(
      [shacl.MaxCountConstraintComponent.id, shacl.MinCountConstraintComponent.id].sort(),
    );
    const missingName = report.results.find(
      (r) => r.sourceConstraintComponent.id === shacl.MinCountConstraintComponent.id,
    )!;
    // Reported once although Dog's shape and Animal's both check `name`: the superclass's
    // property shape is the source.
    expect(missingName.sourceShape).toEqual({id: propertyShapeId(Animal, 'name')});
    expect(missingName.focusNode).toEqual({id: 'urn:puppy:1'});
    const tooManyBreeds = report.results.find(
      (r) => r.sourceConstraintComponent.id === shacl.MaxCountConstraintComponent.id,
    )!;
    expect(tooManyBreeds.sourceShape).toEqual({id: propertyShapeId(Dog, 'breed')});
  });

  test('without the ontology, a class with no shape and no shape edge validates nothing', () => {
    const report = validateByClass({type: cls('Puppy'), breed: ['a', 'b']});
    expect(report.conforms).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].resultSeverity).toEqual(shacl.Info);
    expect(report.results[0].resultMessage).toContain(cls('Puppy'));
  });

  test("a subclass's properties are not undeclared for the superclass shape", () => {
    const report = validateByClass({type: {id: cls('Dog')}, name: 'Rex', breed: 'collie'});
    expect(report).toEqual({conforms: true, results: []});
  });

  test('a sub-shape with its own class runs for a node of that class; one inheriting its class does not', () => {
    // ShowDog requires `title`, but it borrows Dog's class, so a Dog node is not a ShowDog.
    const report = validateByClass({type: cls('Dog'), name: 'Rex', breed: ['a', 'b']});
    expect(components(report)).toEqual([shacl.MaxCountConstraintComponent.id]);
    expect(report.results[0].sourceShape).toEqual({id: propertyShapeId(Dog, 'breed')});
    void ShowDog;
    // An Animal node does not run Dog's shape.
    expect(validateByClass({type: cls('Animal'), name: 'Rex'})).toEqual({conforms: true, results: []});
  });

  test('a node with two types is validated against both; a property neither declares is reported once', () => {
    const report = validateByClass({
      [RDF_TYPE]: [cls('Dog'), {id: cls('Robot')}],
      name: 'K9',
      colour: 'grey',
    });
    expect(report.conforms).toBe(false);
    expect(components(report).sort()).toEqual(
      [shacl.ClosedConstraintComponent.id, shacl.MinCountConstraintComponent.id].sort(),
    );
    const missing = report.results.find(
      (r) => r.sourceConstraintComponent.id === shacl.MinCountConstraintComponent.id,
    )!;
    expect(missing.sourceShape).toEqual({id: propertyShapeId(Robot, 'serial')});
    expect(report.results.find((r) => r.propertyPath === 'colour')).toBeDefined();
  });

  test('no type at all validates nothing and says so', () => {
    const report = validateByClass({name: 'nobody'});
    expect(report.conforms).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].resultSeverity).toEqual(shacl.Info);
    expect(report.results[0].resultMessage).toMatch(/no known type/);
  });

  test('`types` overrides the data', () => {
    const report = validateByClass({type: cls('Dog'), name: 'Rex'}, {types: [cls('Robot')]});
    expect(report.conforms).toBe(false);
    // Robot alone: `name` is undeclared, `serial` missing; the `type` key is not a property.
    expect(components(report).sort()).toEqual(
      [shacl.ClosedConstraintComponent.id, shacl.MinCountConstraintComponent.id].sort(),
    );
    expect(report.results.some((r) => r.propertyPath === 'type')).toBe(false);
  });

  test('a shape known only as data is picked the same way', () => {
    registerRuntimeShape({
      id: `${base}shapes/Cat`,
      label: 'Cat',
      targetClass: {id: cls('Cat')},
      extends: {id: shapeOf(Animal).id},
      propertyShapes: [],
    } as never);
    const report = validateByClass({type: cls('Cat')});
    expect(components(report)).toEqual([shacl.MinCountConstraintComponent.id]);
    expect(report.results[0].sourceShape).toEqual({id: propertyShapeId(Animal, 'name')});
  });

  test('partial mode checks only the values given', () => {
    const report = validateByClass({type: cls('Dog'), breed: 'collie'}, {mode: 'partial'});
    expect(report).toEqual({conforms: true, results: []});
  });
});
