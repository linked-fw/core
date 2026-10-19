/**
 * The SHACL-aligned validation report: `validate(shape, data)` returns every
 * violation as a `sh:ValidationResult`-shaped object instead of throwing on the
 * first one, and the create/update pipelines are built on the same call — so
 * `toJSON()`, `lower()` and `exec()` all reject exactly the same input.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty, objectProperty, linkedProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {NodeReferenceValue} from '../queries/QueryFactory';
import {validate, assertValid, ShapeValidationError} from '../shapes/validation';
import {shacl} from '../ontologies/shacl';
import {lower} from '../queries/lower';
import {lowerMutationJSON} from '../queries/lowerMutationJSON';


const base = 'linked://tmp/report/';
const prop = (s: string): NodeReferenceValue => ({id: `${base}props/${s}`});

@linkedShape
class Author extends Shape {
  static targetClass = {id: `${base}types/Author`} as any;

  @literalProperty({path: prop('fullName'), minCount: 1, maxCount: 1})
  get fullName(): string {
    return '';
  }
}

@linkedShape
class Slide extends Shape {
  static targetClass = {id: `${base}types/Slide`} as any;

  @literalProperty({path: prop('title'), minCount: 1, maxCount: 1})
  get title(): string {
    return '';
  }

  @literalProperty({path: prop('tag')})
  get tags(): string[] {
    return [];
  }

  @objectProperty({path: prop('author'), maxCount: 1, shape: Author})
  get author(): Author {
    return null;
  }

  @linkedProperty({path: prop('anything')})
  get anything(): unknown {
    return null;
  }
}

/** A real subclass, so `extends` is populated and inherited props live upstream. */
@linkedShape
class Employee extends Slide {
  static targetClass = {id: `${base}types/Employee`} as any;

  @literalProperty({path: prop('role'), maxCount: 1})
  get role(): string {
    return '';
  }
}

describe('validate() — report shape', () => {
  test('a conforming object reports conforms with no results', () => {
    expect(validate(Slide, {title: 'Q3', tags: ['a', 'b']})).toEqual({
      conforms: true,
      results: [],
    });
  });

  test('accepts a shape class or the plain NodeShapeData it carries', () => {
    expect(validate(Slide.shape, {title: 'Q3'})).toEqual(validate(Slide, {title: 'Q3'}));
  });

  test('collects every violation instead of throwing on the first', () => {
    const report = validate(Slide, {
      tags: [{id: 'x:1'}], // literal property given a node
      author: 'Rene', // relation property given a scalar
      slideNumber: 3, // undeclared
    });
    expect(report.conforms).toBe(false);
    expect(report.results).toHaveLength(4); // + missing required `title`
    expect(report.results.map((r) => r.propertyPath)).toEqual([
      'title',
      'tags',
      'author',
      'slideNumber',
    ]);
  });

  test('results carry SHACL vocabulary as node references, not strings', () => {
    const [result] = validate(Slide, {title: ['a', 'b']}).results;
    expect(result.sourceConstraintComponent).toEqual(shacl.MaxCountConstraintComponent);
    expect(result.sourceConstraintComponent.id).toBe(
      'http://www.w3.org/ns/shacl#MaxCountConstraintComponent',
    );
    expect(result.resultSeverity).toEqual(shacl.Violation);
    expect(result.resultPath).toEqual(prop('title'));
    expect(result.sourceShape).toBeTruthy();
    expect(result.resultMessage).toMatch(/at most 1 value/);
  });

  test('each constraint reports its own component', () => {
    const componentFor = (data: object) =>
      validate(Slide, data).results.map((r) => r.sourceConstraintComponent.id.split('#')[1]);

    expect(componentFor({title: 'ok', tags: ['a', 'b']})).toEqual([]);
    expect(componentFor({})).toEqual(['MinCountConstraintComponent']);
    expect(componentFor({title: ['a', 'b']})).toEqual(['MaxCountConstraintComponent']);
    expect(componentFor({title: {id: 'x:1'}})).toEqual(['NodeKindConstraintComponent']);
    expect(componentFor({title: 'ok', nope: 1})).toEqual(['ClosedConstraintComponent']);
  });

  test('focusNode is the node id when the data carries one', () => {
    expect(validate(Slide, {id: 'x:slide1', title: ['a', 'b']}).results[0].focusNode).toEqual(
      {id: 'x:slide1'},
    );
    expect(validate(Slide, {__id: 'x:slide2', title: ['a', 'b']}).results[0].focusNode).toEqual(
      {id: 'x:slide2'},
    );
    expect(validate(Slide, {title: ['a', 'b']}).results[0].focusNode).toBeUndefined();
  });

  test('a non-object is a node-level violation, not a crash', () => {
    const report = validate(Slide, 'just a string');
    expect(report.conforms).toBe(false);
    expect(report.results[0].sourceConstraintComponent).toEqual(shacl.NodeConstraintComponent);
  });

  test('an unregistered shape argument throws (a shape error, not a data violation)', () => {
    expect(() => validate({} as any, {title: 'x'})).toThrow(/requires a node shape/);
  });
});

describe('validate() — complete vs partial mode', () => {
  test('complete (the default) requires minCount properties to be present', () => {
    const report = validate(Slide, {tags: ['a']});
    expect(report.results.map((r) => r.propertyPath)).toEqual(['title']);
    expect(report.results[0].resultMessage).toMatch(/requires at least 1 value/);
  });

  test('partial skips presence checks — the store holds what the payload omits', () => {
    expect(validate(Slide, {tags: ['a']}, {mode: 'partial'}).conforms).toBe(true);
  });

  test('partial still checks the values that ARE provided', () => {
    expect(validate(Slide, {title: ['a', 'b']}, {mode: 'partial'}).conforms).toBe(false);
  });

  test('clearing a required property with null is a violation in either mode', () => {
    for (const mode of ['complete', 'partial'] as const) {
      const report = validate(Slide, {title: null}, {mode});
      expect(report.conforms).toBe(false);
      expect(report.results[0].resultMessage).toMatch(/cannot be cleared/);
    }
  });
});

describe('validate() — nested node descriptions', () => {
  test('descends into a nested create and reports a dotted property path', () => {
    const report = validate(Slide, {title: 'ok', author: {fullName: {id: 'x:1'}}});
    expect(report.results.map((r) => r.propertyPath)).toEqual(['author.fullName']);
    expect(report.results[0].sourceConstraintComponent).toEqual(
      shacl.NodeKindConstraintComponent,
    );
  });

  test('a nested create missing a required property is reported', () => {
    const report = validate(Slide, {title: 'ok', author: {}});
    expect(report.results.map((r) => r.propertyPath)).toEqual(['author.fullName']);
    expect(report.results[0].resultMessage).toMatch(/none were provided/);
  });

  test('a bare {id} reference is not descended into', () => {
    expect(validate(Slide, {title: 'ok', author: {id: 'x:existing'}}).conforms).toBe(true);
  });

  test('maxDepth bounds the descent', () => {
    const deep = {title: 'ok', author: {}};
    expect(validate(Slide, deep, {maxDepth: 0}).conforms).toBe(true);
    expect(validate(Slide, deep, {maxDepth: 1}).conforms).toBe(false);
  });
});

describe('validate() — values it cannot decide on are skipped', () => {
  test('set-modifications, undefined and functions are exempt', () => {
    const exempt = [
      {title: 'ok', tags: {add: ['x'], remove: ['y']}},
      {title: 'ok', tags: undefined},
      {title: 'ok', tags: () => 'computed'},
    ];
    for (const data of exempt) {
      expect(validate(Slide, data as any).conforms).toBe(true);
    }
  });

  test('an ambiguous node kind accepts both literals and nodes', () => {
    expect(validate(Slide, {title: 'ok', anything: 'scalar'}).conforms).toBe(true);
    expect(validate(Slide, {title: 'ok', anything: {id: 'x:1'}}).conforms).toBe(true);
  });
});

describe('a shape it cannot resolve is reported, never silently skipped', () => {
  // The validator resolves inherited and nested shapes through the registry by
  // id, so a caller holding only shape objects needs no classes. When a lookup
  // fails, the branch cannot be checked — reporting "conforms" would be a lie.

  test('a nested value whose declared shape is not registered', () => {
    const detached: any = {
      ...Slide.shape,
      id: `${Slide.shape.id}-detached`,
      propertyShapes: Slide.shape.propertyShapes.map((ps) =>
        ps.valueShape ? {...ps, valueShape: {id: `${ps.valueShape.id}-unregistered`}} : ps,
      ),
    };
    const report = validate(detached, {title: 'ok', author: {fullName: 'A'}});
    expect(report.conforms).toBe(false);
    expect(report.results[0].sourceConstraintComponent).toEqual(shacl.NodeConstraintComponent);
    expect(report.results[0].propertyPath).toBe('author');
    expect(report.results[0].resultMessage).toMatch(/-unregistered' does not resolve \(property 'author' of '.*-detached' points at it\)\.$/);
  });

  test('a nested value under a property that declares no shape', () => {
    const report = validate(Slide, {title: 'ok', anything: {some: 'object'}});
    expect(report.conforms).toBe(false);
    expect(report.results[0].resultMessage).toMatch(/declares no shape for its values/);
  });

  test('a shape whose inherited properties cannot be resolved', () => {
    // `extends` is only set for real shape inheritance, and the inherited
    // property shapes live on the parent — invisible if the id is unregistered.
    const detached: any = {...Employee.shape, id: `${Employee.shape.id}-detached`};
    expect(Employee.shape.extends).toBeTruthy();
    const report = validate(detached, {role: 'dev'});
    expect(report.conforms).toBe(false);
    expect(report.results[0].resultMessage).toMatch(/Cannot resolve the properties/);
  });

  test('registered shapes report none of this — object or class, same answer', () => {
    const data = {title: 'ok', author: {fullName: 'A'}};
    expect(validate(Slide.shape, data).conforms).toBe(true);
    expect(validate(Slide, data)).toEqual(validate(Slide.shape, data));
    expect(validate(Employee, {title: 'T', role: 'dev'}).conforms).toBe(true);
  });
});

describe('assertValid()', () => {
  test('throws a ShapeValidationError carrying the whole report', () => {
    let error: ShapeValidationError | undefined;
    try {
      assertValid(Slide, {tags: [{id: 'x:1'}]});
    } catch (e) {
      error = e as ShapeValidationError;
    }
    expect(error).toBeInstanceOf(ShapeValidationError);
    expect(error!.report.conforms).toBe(false);
    expect(error!.report.results).toHaveLength(2);
    // Every violation is in the message, not just the first.
    expect(error!.message).toMatch(/requires at least 1 value/);
    expect(error!.message).toMatch(/literal property/);
  });

  test('is silent when the data conforms', () => {
    expect(() => assertValid(Slide, {title: 'ok'})).not.toThrow();
  });
});

describe('inbound DSL-JSON is held to the same standard as a local build', () => {
  // `lowerMutationJSON` never touches a builder, so it needs its own gate — and
  // it is the *less* trusted input of the two.
  // Built through the real encoder rather than hand-written, so these stay
  // honest about the wire format.
  const createJSON = (data: object) =>
    ({...Slide.create({title: 'Q3'} as any).toJSON(), data}) as any;

  test('a create missing a required property is rejected at lowering', () => {
    expect(() => lowerMutationJSON(createJSON({}))).toThrow(ShapeValidationError);
    expect(() => lowerMutationJSON(createJSON({}))).toThrow(/requires at least 1 value/);
  });

  test('a conforming create lowers', () => {
    expect(() => lowerMutationJSON(createJSON({title: 'Q3'}))).not.toThrow();
  });

  test('a mistyped value is rejected at lowering', () => {
    expect(() => lowerMutationJSON(createJSON({title: {'@id': 'x:1'}}))).toThrow(
      /literal property/,
    );
  });

  test('an inbound update is validated in partial mode', () => {
    const updateJSON = (data: object) =>
      ({
        ...Slide.update({tags: ['a']} as any).for({id: 'x:s1'}).toJSON(),
        data,
      }) as any;
    // Absent properties are fine…
    expect(() => lowerMutationJSON(updateJSON({tags: 'a'}))).not.toThrow();
    // …but a provided value is checked.
    // Multi-value lists travel as `{'@list': […]}`; a bare array is an s-expr.
    expect(() =>
      lowerMutationJSON(updateJSON({title: {'@list': ['a', 'b']}})),
    ).toThrow(/at most 1 value/);
  });

  test('the wire and the builder reject the same payload', () => {
    expect(() =>
      lowerMutationJSON(createJSON({title: {'@list': ['a', 'b']}})),
    ).toThrow(ShapeValidationError);
    expect(() => Slide.create({title: ['a', 'b']} as any).toJSON()).toThrow(
      ShapeValidationError,
    );
  });
});

describe('the mutation pipelines use the same validator', () => {
  test('toJSON() and lower() reject identically on a create', () => {
    const incomplete = () => Slide.create({tags: ['a']} as any);
    expect(() => incomplete().toJSON()).toThrow(ShapeValidationError);
    expect(() => lower(incomplete() as any)).toThrow(ShapeValidationError);
  });

  test('toJSON() and lower() accept identically on a create', () => {
    const complete = () => Slide.create({title: 'ok'} as any);
    expect(() => complete().toJSON()).not.toThrow();
    expect(() => lower(complete() as any)).not.toThrow();
  });

  test('an update is validated in partial mode — absent properties are fine', () => {
    const update = () => Slide.update({tags: ['a']} as any).for({id: 'x:s1'});
    expect(() => update().toJSON()).not.toThrow();
    expect(() => lower(update() as any)).not.toThrow();
  });

  test('a thrown mutation error exposes the report for programmatic use', () => {
    try {
      Slide.create({tags: [{id: 'x:1'}]} as any).toJSON();
      throw new Error('should have thrown');
    } catch (e) {
      const report = (e as ShapeValidationError).report;
      expect(report.results.map((r) => r.propertyPath)).toEqual(['title', 'tags']);
    }
  });
});
