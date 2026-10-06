/**
 * Resolving what a relation property points at.
 *
 * `sh:node` names the shape a value is viewed through; `sh:class` names only the class the
 * value is an instance of. A class-only relation is resolved to a shape at read time — from
 * the registry, or from a caller's own set of shapes (a project's catalog) — and must never
 * reach into the registry when a set is given, because the registry also holds framework
 * shapes for the same classes.
 */
import {afterEach, beforeAll, describe, expect, jest, test} from '@jest/globals';
import {linkedShape} from '../package';
import {Shape} from '../shapes/Shape';
import {
  createNodeShapeData,
  createPropertyShapeData,
  type NodeShapeData,
  type PropertyShapeData,
} from '../shapes/nodeShapeData';
import {toWire, type NodeShapeWire} from '../shapes/nodeShapeWire';
import {registerRuntimeShapes} from '../shapes/registerRuntimeShape';
import {isRelation, rangeClassOf, resolveRelationShape} from '../shapes/relationShape';
import {validate} from '../shapes/validation';
import {shacl} from '../ontologies/shacl';
import {xsd} from '../ontologies/xsd';
import {getShapesForTargetClass, getTargetClassId} from '../utils/ShapeClass';
import {SelectBuilder} from '../queries/QueryBuilder';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';

const NS = 'https://example.org/relation-shape/';
const shapeIri = (name: string) => `${NS}shape/${name}`;
const classIri = (name: string) => `${NS}vocab#${name}`;

function dataShape(
  name: string,
  opts: {targetClass?: string; extendsName?: string; properties?: Partial<PropertyShapeData>[]} = {},
): NodeShapeData {
  const shape = createNodeShapeData(shapeIri(name));
  shape.label = name;
  if (opts.targetClass) shape.targetClass = {id: opts.targetClass};
  if (opts.extendsName) shape.extends = {id: shapeIri(opts.extendsName)};
  shape.propertyShapes = (opts.properties ?? []).map((fields) => {
    const prop = createPropertyShapeData();
    Object.assign(prop, {
      id: `${shape.id}/${fields.label}`,
      path: {id: `${NS}prop/${fields.label}`},
      parentNodeShape: shape,
      ...fields,
    });
    return prop;
  });
  return shape;
}

// Registered: two shapes for Person (Employee extends Person), one for Org, and a shape
// whose targetClass is only inherited.
const PERSON = classIri('Person');
const ORG = classIri('Org');

@linkedShape
class RelPerson extends Shape {
  static targetClass = {id: classIri('ClassBacked')} as any;
}

@linkedShape
class RelEmployee extends RelPerson {}

beforeAll(() => {
  registerRuntimeShapes([
    dataShape('Person', {targetClass: PERSON}),
    dataShape('Employee', {targetClass: PERSON, extendsName: 'Person'}),
    dataShape('Contractor', {extendsName: 'Person'}),
    dataShape('Org', {targetClass: ORG}),
    dataShape('Untyped', {properties: [{label: 'note', datatype: xsd.string}]}),
    dataShape('Holder', {
      targetClass: classIri('Holder'),
      properties: [
        {label: 'member', class: {id: PERSON}},
        {label: 'name', datatype: xsd.string},
      ],
    }),
  ]);
});

describe('getTargetClassId', () => {
  test('reads an own targetClass by id, reference, data and class', () => {
    expect(getTargetClassId(shapeIri('Org'))).toBe(ORG);
    expect(getTargetClassId({id: shapeIri('Org')})).toBe(ORG);
    expect(getTargetClassId(dataShape('Loose', {targetClass: ORG}))).toBe(ORG);
    expect(getTargetClassId(RelPerson)).toBe(classIri('ClassBacked'));
  });

  test('inherits through extends for a data-only shape, and through the class chain', () => {
    expect(getTargetClassId(shapeIri('Contractor'))).toBe(PERSON);
    expect(getTargetClassId(RelEmployee)).toBe(classIri('ClassBacked'));
    expect(getTargetClassId(RelEmployee.shape)).toBe(classIri('ClassBacked'));
  });

  test('returns undefined, without throwing, when nothing in the chain declares one', () => {
    expect(getTargetClassId(shapeIri('Untyped'))).toBeUndefined();
    expect(getTargetClassId(`${NS}shape/NeverRegistered`)).toBeUndefined();
  });

  test('resolves inheritance inside a given set before the registry', () => {
    const catalog = [
      dataShape('CatalogBase', {targetClass: classIri('CatalogThing')}),
      dataShape('CatalogChild', {extendsName: 'CatalogBase'}),
    ];
    expect(getTargetClassId(shapeIri('CatalogChild'), catalog)).toBe(classIri('CatalogThing'));
    expect(getTargetClassId(shapeIri('CatalogChild'))).toBeUndefined();
  });

  test('a scan over a shape with no targetClass still throws its explanation', () => {
    const query = SelectBuilder.from(shapeIri('Untyped')).select((b: any) => [b.note]);
    expect(() => selectToSparql(lower(query as never) as never)).toThrow(
      /Cannot resolve an rdf:type for shape ".*Untyped": no targetClass is declared/,
    );
  });
});

describe('getShapesForTargetClass', () => {
  test('defaults to the registry, most specific first, inherited targetClass included', () => {
    const ids = getShapesForTargetClass(PERSON).map((s) => s.id);
    // Employee and Contractor both extend Person, so both come before it; they tie and go by id.
    expect(ids).toEqual([shapeIri('Contractor'), shapeIri('Employee'), shapeIri('Person')]);
  });

  test('matches the targetClass exactly', () => {
    expect(getShapesForTargetClass(ORG).map((s) => s.id)).toEqual([shapeIri('Org')]);
    expect(getShapesForTargetClass(classIri('Nothing'))).toEqual([]);
  });

  test('sees shapes registered after the first lookup', () => {
    getShapesForTargetClass(classIri('Late'));
    registerRuntimeShapes([dataShape('Late', {targetClass: classIri('Late')})]);
    expect(getShapesForTargetClass(classIri('Late')).map((s) => s.id)).toEqual([
      shapeIri('Late'),
    ]);
  });

  test('an explicit set excludes shapes that are only in the registry', () => {
    const catalog = [dataShape('ProjectPerson', {targetClass: PERSON})];
    expect(getShapesForTargetClass(PERSON, catalog).map((s) => s.id)).toEqual([
      shapeIri('ProjectPerson'),
    ]);
  });

  test('accepts wire-form shapes and returns them as given', () => {
    const catalog: NodeShapeWire[] = [toWire(dataShape('WirePerson', {targetClass: PERSON}))];
    const [found] = getShapesForTargetClass(PERSON, catalog);
    expect(found).toBe(catalog[0]);
  });

  test('orders an unregistered set by its own extends, then by id', () => {
    const catalog = [
      dataShape('B_Base', {targetClass: classIri('Doc')}),
      dataShape('A_Other', {targetClass: classIri('Doc')}),
      dataShape('Z_Mid', {targetClass: classIri('Doc'), extendsName: 'B_Base'}),
      dataShape('C_Leaf', {extendsName: 'Z_Mid'}),
    ];
    expect(getShapesForTargetClass(classIri('Doc'), catalog).map((s) => s.id)).toEqual([
      shapeIri('C_Leaf'),
      shapeIri('Z_Mid'),
      shapeIri('A_Other'),
      shapeIri('B_Base'),
    ]);
  });

  test('a set member extending a registered shape inherits its targetClass', () => {
    const catalog = [dataShape('ProjectOrgUnit', {extendsName: 'Org'})];
    expect(getShapesForTargetClass(ORG, catalog).map((s) => s.id)).toEqual([
      shapeIri('ProjectOrgUnit'),
    ]);
  });
});

describe('relation helpers', () => {
  afterEach(() => jest.restoreAllMocks());

  test('isRelation: sh:node, sh:class, or a node kind that is not literal', () => {
    expect(isRelation({valueShape: {id: shapeIri('Org')}})).toBe(true);
    expect(isRelation({class: {id: ORG}})).toBe(true);
    expect(isRelation({nodeKind: shacl.IRI})).toBe(true);
    expect(isRelation({nodeKind: shacl.BlankNode})).toBe(true);
    expect(isRelation({nodeKind: shacl.BlankNodeOrIRI})).toBe(true);
    expect(isRelation({nodeKind: shacl.Literal})).toBe(false);
    expect(isRelation({})).toBe(false);
  });

  test('rangeClassOf: sh:class first, else the sh:node shape\'s targetClass', () => {
    expect(rangeClassOf({class: {id: ORG}, valueShape: {id: shapeIri('Person')}})).toBe(ORG);
    expect(rangeClassOf({valueShape: {id: shapeIri('Contractor')}})).toBe(PERSON);
    expect(rangeClassOf({})).toBeUndefined();
    const catalog = [dataShape('OnlyInCatalog', {targetClass: classIri('Catalogued')})];
    expect(rangeClassOf({valueShape: {id: shapeIri('OnlyInCatalog')}}, catalog)).toBe(
      classIri('Catalogued'),
    );
  });

  test('resolveRelationShape: a declared sh:node wins', () => {
    expect(
      resolveRelationShape({valueShape: {id: shapeIri('Org')}, class: {id: PERSON}}),
    ).toEqual({shapeId: shapeIri('Org'), candidates: [shapeIri('Org')], source: 'node'});
  });

  test('resolveRelationShape: a class-only relation resolves through the given set', () => {
    const catalog = [dataShape('ProjectOrg', {targetClass: ORG})];
    expect(resolveRelationShape({class: {id: ORG}}, catalog)).toEqual({
      shapeId: shapeIri('ProjectOrg'),
      candidates: [shapeIri('ProjectOrg')],
      source: 'class',
    });
  });

  test('resolveRelationShape: no candidate, or no class, is none', () => {
    expect(resolveRelationShape({class: {id: classIri('Nothing')}})).toEqual({
      candidates: [],
      source: 'none',
    });
    expect(resolveRelationShape({nodeKind: shacl.IRI})).toEqual({candidates: [], source: 'none'});
  });

  test('resolveRelationShape: several candidates warn once per class, naming them all', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const first = resolveRelationShape({class: {id: PERSON}});
    resolveRelationShape({class: {id: PERSON}});
    expect(first.shapeId).toBe(shapeIri('Contractor'));
    expect(first.source).toBe('class');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain(PERSON);
    for (const id of first.candidates) expect(message).toContain(id);
    expect(message).toContain(`Using '${shapeIri('Contractor')}'`);
  });
});

describe('validation treats sh:class as node-valued', () => {
  test('a class-only relation rejects a literal and accepts a reference', () => {
    const holder = dataShape('HolderCheck', {
      targetClass: classIri('Holder'),
      properties: [{label: 'member', class: {id: PERSON}}],
    });
    const literal = validate(holder, {member: 'not a node'}, {mode: 'partial'});
    expect(literal.conforms).toBe(false);
    expect(literal.results[0].sourceConstraintComponent.id).toBe(
      shacl.NodeKindConstraintComponent.id,
    );
    expect(validate(holder, {member: {id: `${NS}people/1`}}, {mode: 'partial'}).conforms).toBe(
      true,
    );
  });

  test('a datatype alongside sh:class does not make it literal', () => {
    const holder = dataShape('HolderMixed', {
      properties: [{label: 'member', class: {id: PERSON}, datatype: xsd.string}],
    });
    const report = validate(holder, {member: {id: `${NS}people/1`}}, {mode: 'partial'});
    expect(
      report.results.some(
        (r) => r.sourceConstraintComponent.id === shacl.NodeKindConstraintComponent.id,
      ),
    ).toBe(false);
  });
});
