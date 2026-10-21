/*
 * The shape check: shape `extends` and the class hierarchy agree; a shape does not borrow
 * another's class; a mirror package uses only its standard's terms; overrides narrow the class.
 */
import {beforeAll, describe, expect, jest, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';
import type {NodeShapeData} from '../shapes/nodeShapeData';
import {
  checkShapeHierarchy,
  type ShapeCheckFinding,
} from '../shapes/checkShapeHierarchy';
import type {HierarchyTriple} from '../ontology/hierarchy';
import {xsd} from '../ontologies/xsd';

const NS = 'http://example.org/check/';
const ex = (term: string) => ({id: `${NS}${term}`});
const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';

const a = linkedPackage('check-a');
const b = linkedPackage('check-b');

@a.linkedShape
class Animal extends Shape {
  static targetClass = ex('Animal');
}
@a.linkedShape
class Dog extends Animal {
  static targetClass = ex('Dog');
}
@a.linkedShape
class Cat extends Shape {
  static targetClass = ex('Cat');
}
@a.linkedShape
class Kitten extends Cat {
  static targetClass = ex('Kitten');
}
@a.linkedShape
class ThingShape extends Shape {
  static targetClass = {id: OWL_THING};
}
@a.linkedShape
class PetA extends Shape {
  static targetClass = ex('Pet');
}
@a.linkedShape
class PetB extends Shape {
  static targetClass = ex('Pet');
}
@a.linkedShape
class Bird extends Shape {
  static targetClass = ex('Bird');
}
@b.linkedShape
class Vehicle extends Shape {
  static targetClass = ex('Vehicle');
}
@a.linkedShape
class Car extends Shape {
  static targetClass = ex('Car');
}
@a.linkedShape
class Person extends Shape {
  static targetClass = ex('Person');
}
@a.linkedShape
class Employee extends Person {}
@a.linkedShape({sharedTargetClass: true})
class Profile extends Person {}
@a.linkedShape
class Shelter extends Shape {
  static targetClass = ex('Shelter');
  @objectProperty({path: ex('resident'), shape: Animal, class: ex('Animal')})
  get resident(): Animal {
    return null;
  }
}
@a.linkedShape
class CatShelter extends Shelter {
  static targetClass = ex('CatShelter');
  @objectProperty({path: ex('resident'), shape: Animal, class: ex('Cat')})
  get resident(): Animal {
    return null;
  }
}
@a.linkedShape
class Garage extends Shelter {
  static targetClass = ex('Garage');
  @objectProperty({path: ex('resident'), shape: Animal, class: ex('Vehicle')})
  get resident(): Animal {
    return null;
  }
}

const sub = (s: string, o: string): HierarchyTriple => ({
  s: s.includes('://') ? s : `${NS}${s}`,
  o: o.includes('://') ? o : `${NS}${o}`,
});
const HIERARCHY: HierarchyTriple[] = [
  sub('Dog', 'Animal'),
  sub('Cat', 'Animal'),
  sub('Kitten', 'Cat'),
  sub('Animal', OWL_THING),
  sub('Bird', 'Pet'),
  sub('Car', 'Vehicle'),
  sub('Horse', 'Animal'),
  sub('CatShelter', 'Shelter'),
  sub('Garage', 'Shelter'),
];

const id = (cls: {shape: NodeShapeData}) => cls.shape.id;
const about = (findings: ShapeCheckFinding[], shape: string) =>
  findings.filter((f) => f.shape === shape);

let findings: ShapeCheckFinding[];
beforeAll(async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  // A shape known only as data: Horse ⊑ Animal, not extending Animal.
  registerRuntimeShape({
    id: `${NS}shape/Horse`,
    label: 'Horse',
    targetClass: ex('Horse'),
    propertyShapes: [],
  } as NodeShapeData);
  findings = await checkShapeHierarchy({hierarchy: HIERARCHY});
});

describe('extends-without-subclass', () => {
  test('an extends the hierarchy states is clean', () => {
    expect(about(findings, id(Dog))).toEqual([]);
    expect(about(findings, id(Kitten))).toEqual([]);
  });

  test('an extends without the subclass axiom is an error naming both classes', async () => {
    const without = await checkShapeHierarchy({
      hierarchy: HIERARCHY.filter((t) => t.s !== `${NS}Dog`),
    });
    expect(about(without, id(Dog))).toEqual([
      expect.objectContaining({
        kind: 'extends-without-subclass',
        severity: 'error',
        iri: `${NS}Dog`,
        message: expect.stringMatching(/Dog extends Animal.*rdfs:subClassOf <http:\/\/example\.org\/check\/Animal>/),
      }),
    ]);
  });
});

describe('subclass-without-extends', () => {
  test('one root in the same package: an error at the shape, with the fix', () => {
    expect(about(findings, id(Cat))).toEqual([
      expect.objectContaining({
        kind: 'subclass-without-extends',
        severity: 'error',
        iri: `${NS}Animal`,
        message: expect.stringMatching(/make Cat extend Animal/),
      }),
    ]);
  });

  test('reported once, at the lowest shape responsible', () => {
    // Kitten ⊑ Cat ⊑ Animal: the missing link to Animal is Cat's.
    expect(about(findings, id(Kitten))).toEqual([]);
  });

  test('a meta class is never the superclass', () => {
    expect(findings.filter((f) => f.iri === OWL_THING)).toEqual([]);
    expect(about(findings, id(Animal))).toEqual([]);
    expect(ThingShape.shape.id).toBeDefined();
  });

  test('several roots: a warning', () => {
    expect(about(findings, id(Bird))).toEqual([
      expect.objectContaining({kind: 'subclass-without-extends', severity: 'warning', iri: `${NS}Pet`}),
    ]);
  });

  test('a root in a package outside the dependencies: a warning; inside them: an error', async () => {
    expect(about(findings, id(Car))).toEqual([
      expect.objectContaining({kind: 'subclass-without-extends', severity: 'warning', iri: `${NS}Vehicle`}),
    ]);
    const withDeps = await checkShapeHierarchy({
      hierarchy: HIERARCHY,
      dependencies: {'check-a': ['check-mid'], 'check-mid': ['check-b']},
    });
    expect(about(withDeps, id(Car))).toEqual([
      expect.objectContaining({kind: 'subclass-without-extends', severity: 'error'}),
    ]);
    expect(Vehicle).toBeDefined();
  });

  test('a data-only shape: a warning', () => {
    expect(about(findings, `${NS}shape/Horse`)).toEqual([
      expect.objectContaining({kind: 'subclass-without-extends', severity: 'warning', iri: `${NS}Animal`}),
    ]);
  });
});

describe('borrowed-target-class', () => {
  test('a sub-shape without its own class is an error; sharedTargetClass exempts a profile', () => {
    expect(about(findings, id(Employee))).toEqual([
      expect.objectContaining({kind: 'borrowed-target-class', severity: 'error', iri: `${NS}Person`}),
    ]);
    expect(about(findings, id(Person))).toEqual([]);
    expect(about(findings, id(Profile))).toEqual([]);
  });

  test('several unrelated roots of one class: each is an error', () => {
    for (const pet of [PetA, PetB]) {
      expect(about(findings, id(pet))).toEqual([
        expect.objectContaining({
          kind: 'borrowed-target-class',
          message: expect.stringMatching(/one of several unrelated shapes .*PetA, PetB/),
        }),
      ]);
    }
  });
});

describe('override-not-tightened', () => {
  test('a narrower class passes, an unrelated class warns', () => {
    expect(about(findings, id(CatShelter))).toEqual([]);
    expect(about(findings, id(Garage))).toEqual([
      expect.objectContaining({
        kind: 'override-not-tightened',
        severity: 'warning',
        message: expect.stringMatching(/Garage\.resident .*class .*Vehicle is not .*Animal/),
      }),
    ]);
  });

  test('a data-only shape is checked for every case', async () => {
    registerRuntimeShape({
      id: `${NS}shape/LooseShelter`,
      label: 'LooseShelter',
      extends: {id: id(Shelter)},
      targetClass: ex('LooseShelter'),
      propertyShapes: [
        {
          id: `${NS}shape/LooseShelter/resident`,
          label: 'resident',
          path: ex('occupant'),
          datatype: xsd.string,
        },
      ],
    } as unknown as NodeShapeData);
    const all = await checkShapeHierarchy({
      hierarchy: [...HIERARCHY, sub('LooseShelter', 'Shelter')],
    });
    const messages = about(all, `${NS}shape/LooseShelter`).map((f) => `${f.kind} ${f.message}`);
    expect(messages).toEqual([
      expect.stringMatching(/^override-not-tightened .*path cannot change/),
    ]);
  });
});

describe('ordering', () => {
  test('findings are sorted by kind, then shape, then iri', () => {
    const order = [
      'extends-without-subclass',
      'subclass-without-extends',
      'borrowed-target-class',
      'mirror-undefined-term',
      'override-not-tightened',
    ];
    const keys = findings.map((f) => [order.indexOf(f.kind), f.shape ?? '', f.iri ?? ''] as const);
    const sorted = [...keys].sort((x, y) =>
      x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0),
    );
    expect(keys).toEqual(sorted);
  });
});

describe('mirror-undefined-term', () => {
  test('a mirror package reports every term in its namespace its data does not define', async () => {
    const STD = 'http://example.org/std/';
    const std = createNameSpace(STD);
    const mirror = linkedPackage('check-mirror', {mirrors: STD});
    const terms = {standard: {Defined: std('Defined'), Invented: std('Invented')}, _self: std('')};
    mirror.linkedOntology(
      terms,
      std,
      'std',
      async () => [
        `@prefix std: <${STD}> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n` +
          `std:Defined a rdfs:Class .\nstd:name a rdf:Property .\n`.replace(
            'rdf:Property',
            '<http://www.w3.org/1999/02/22-rdf-syntax-ns#Property>',
          ),
      ],
      '../data/std.ttl',
    );
    @mirror.linkedShape
    class StdThing extends Shape {
      static targetClass = std('Defined');
      @literalProperty({path: std('name')})
      get name(): string {
        return '';
      }
      @literalProperty({path: std('madeUp')})
      get madeUp(): string {
        return '';
      }
    }
    const all = await checkShapeHierarchy({hierarchy: HIERARCHY});
    const mirrorFindings = all.filter((f) => f.kind === 'mirror-undefined-term');
    expect(mirrorFindings).toEqual([
      expect.objectContaining({severity: 'error', iri: `${STD}Invented`}),
      expect.objectContaining({severity: 'error', shape: StdThing.shape.id, iri: `${STD}madeUp`}),
    ]);
    expect(mirrorFindings[0].shape).toBeUndefined();
  });
});
