/*
 * `.some()` / `.every()` / `.none()` and property access on a plural relation whose value shape has
 * no authored class: a data-only `sh:node`, or `sh:class` only. They resolve the members' shape
 * through the relation (and the shape's adapter) instead of the authored-class registry.
 */
import {beforeAll, describe, expect, test} from '@jest/globals';
import {createNodeShapeData, createPropertyShapeData, type NodeShapeData} from '../shapes/nodeShapeData';
import {registerRuntimeShapes} from '../shapes/registerRuntimeShape';
import {SelectBuilder} from '../queries/QueryBuilder';
import {selectToSparql} from '../sparql/irToAlgebra';
import {lower} from '../queries/lower';
import {shacl} from '../ontologies/shacl';
import {xsd} from '../ontologies/xsd';

const NS = 'https://example.org/data-only-relation-some/';
const TEAM = `${NS}shape/Team`;
const MEMBER = `${NS}shape/Member`;
const vocab = (term: string) => ({id: `${NS}vocab#${term}`});

function dataShape(id: string, targetClass: string, props: Array<Record<string, unknown>>): NodeShapeData {
  const shape = createNodeShapeData(id);
  shape.label = id.split('/').pop()!;
  shape.targetClass = vocab(targetClass);
  shape.propertyShapes = props.map((p) => {
    const prop = createPropertyShapeData();
    Object.assign(prop, {id: `${id}/${p.label}`, parentNodeShape: shape, ...p});
    return prop;
  });
  return shape;
}

beforeAll(() => {
  registerRuntimeShapes([
    dataShape(MEMBER, 'Member', [{label: 'name', path: vocab('name'), datatype: xsd.string, maxCount: 1}]),
    dataShape(TEAM, 'Team', [
      {label: 'members', path: vocab('member'), valueShape: {id: MEMBER}, nodeKind: shacl.IRI},
      {label: 'leads', path: vocab('lead'), class: vocab('Member'), nodeKind: shacl.IRI},
      {label: 'sponsors', path: vocab('sponsor'), class: vocab('Unshaped'), nodeKind: shacl.IRI},
    ]),
  ]);
});

const sparql = (query: unknown) => selectToSparql(lower(query as never) as never);
const m1 = {id: `${NS}m1`};

describe('a plural relation to a data-only shape', () => {
  test('.some() on a data-only sh:node', () => {
    const query = SelectBuilder.from(TEAM).where((t: any) => t.members.some((m: any) => m.equals(m1)));
    const text = sparql(query);
    expect(text).toContain(`FILTER(EXISTS {`);
    expect(text).toContain(`<${NS}vocab#member> ?a1`);
    expect(text).toContain(`FILTER(?a1 = <${m1.id}>)`);
  });

  test('.some() reads a property of the data-only member shape', () => {
    const query = SelectBuilder.from(TEAM).where((t: any) =>
      t.members.some((m: any) => m.name.equals('Ada')),
    );
    expect(sparql(query)).toContain(`<${NS}vocab#name>`);
  });

  test('.every() and .none() on a relation declared with sh:class only', () => {
    const every = SelectBuilder.from(TEAM).where((t: any) => t.leads.every((m: any) => m.equals(m1)));
    expect(sparql(every)).toContain(`FILTER(!(EXISTS {`);
    const none = SelectBuilder.from(TEAM).where((t: any) => t.leads.none((m: any) => m.name.equals('Ada')));
    expect(sparql(none)).toContain(`<${NS}vocab#name>`);
  });

  test('a sh:class with no shape targeting it still allows equals', () => {
    const query = SelectBuilder.from(TEAM).where((t: any) => t.sponsors.some((m: any) => m.equals(m1)));
    expect(sparql(query)).toContain(`<${NS}vocab#sponsor> ?a1`);
  });

  test('property access on the set selects through the data-only shape', () => {
    const query = SelectBuilder.from(TEAM).select((t: any) => [t.members.name]);
    expect(sparql(query)).toContain(`<${NS}vocab#name>`);
  });
});

describe('sub-queries on a set of data-only members', () => {
  test('.select() on a data-only sh:node', () => {
    const query = SelectBuilder.from(TEAM).select((t: any) => [t.members.select((m: any) => [m.name])]);
    const text = sparql(query);
    expect(text).toContain(`<${NS}vocab#member>`);
    expect(text).toContain(`<${NS}vocab#name>`);
  });

  test('.select() on a relation declared with sh:class only', () => {
    const query = SelectBuilder.from(TEAM).select((t: any) => [t.leads.select((m: any) => [m.name])]);
    expect(sparql(query)).toContain(`<${NS}vocab#name>`);
  });

  test('.selectAll() on a data-only sh:node', () => {
    const query = SelectBuilder.from(TEAM).select((t: any) => [t.members.selectAll()]);
    expect(sparql(query)).toContain(`<${NS}vocab#name>`);
  });

  test('.selectAll() on a relation declared with sh:class only', () => {
    const query = SelectBuilder.from(TEAM).select((t: any) => [t.leads.selectAll()]);
    expect(sparql(query)).toContain(`<${NS}vocab#name>`);
  });

  test('.selectAll() on a sh:class with no shape targeting it says to declare sh:node', () => {
    expect(() => sparql(SelectBuilder.from(TEAM).select((t: any) => [t.sponsors.selectAll()]))).toThrow(
      /selectAll\(\) on 'sponsors'.*Declare sh:node/,
    );
  });

  test('.where() on a data-only sh:node', () => {
    const query = SelectBuilder.from(TEAM).select((t: any) => [
      t.members.where((m: any) => m.name.equals('Ada')),
    ]);
    const text = sparql(query);
    expect(text).toContain(`<${NS}vocab#name>`);
    expect(text).toContain(`"Ada"`);
  });

  test('.where() on a relation declared with sh:class only', () => {
    const query = SelectBuilder.from(TEAM).select((t: any) => [
      t.leads.where((m: any) => m.name.equals('Ada')),
    ]);
    expect(sparql(query)).toContain(`"Ada"`);
  });

  test('a sh:class with no shape targeting it still allows .where() on equals', () => {
    const query = SelectBuilder.from(TEAM).select((t: any) => [
      t.sponsors.where((m: any) => m.equals(m1)),
    ]);
    expect(sparql(query)).toContain(`<${m1.id}>`);
  });
});
