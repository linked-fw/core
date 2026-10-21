/*
 * Direction I with multiple inheritance: one in-scope superclass shape on the extends chain
 * satisfies it, and each superclass shape off the chain is a warning. CN's `Dataset`
 * (`createNow:Dataset ⊑ dcat:Dataset, schema:CreativeWork`) extends `CreativeWork`; dcat ships a
 * `Resource` shape and no `Dataset` shape.
 */
import {beforeAll, describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import type {NodeShapeData} from '../shapes/nodeShapeData';
import {checkShapeHierarchy, type ShapeCheckFinding} from '../shapes/checkShapeHierarchy';
import type {HierarchyTriple} from '../ontology/hierarchy';

const SCHEMA = 'http://example.org/mi/schema/';
const DCAT = 'http://example.org/mi/dcat#';
const CN = 'http://example.org/mi/createNow/';

const schema = linkedPackage('mi-schema');
const dcat = linkedPackage('mi-dcat');
const cn = linkedPackage('mi-create-now');

@schema.linkedShape
class Thing extends Shape {
  static targetClass = {id: `${SCHEMA}Thing`};
}
@schema.linkedShape
class CreativeWork extends Thing {
  static targetClass = {id: `${SCHEMA}CreativeWork`};
}
@schema.linkedShape
class Article extends CreativeWork {
  static targetClass = {id: `${SCHEMA}Article`};
}
@dcat.linkedShape
class Resource extends Shape {
  static targetClass = {id: `${DCAT}Resource`};
}
/** CN's case: extends CreativeWork; dcat's Resource is off the chain. */
@cn.linkedShape
class Dataset extends CreativeWork {
  static targetClass = {id: `${CN}Dataset`};
}
/** The same classes, extending nothing: the chain satisfies nothing. */
@cn.linkedShape
class Catalogue extends Shape {
  static targetClass = {id: `${CN}Catalogue`};
}
/** A Report is an Article, but its shape extends CreativeWork: Article is below the chain's
 * anchor, so extending it instead is possible and the missing link stays an error. */
@cn.linkedShape
class Report extends CreativeWork {
  static targetClass = {id: `${CN}Report`};
}

const t = (s: string, o: string): HierarchyTriple => ({s, o});
const HIERARCHY: HierarchyTriple[] = [
  t(`${SCHEMA}CreativeWork`, `${SCHEMA}Thing`),
  t(`${SCHEMA}Article`, `${SCHEMA}CreativeWork`),
  t(`${DCAT}Dataset`, `${DCAT}Resource`),
  t(`${CN}Dataset`, `${DCAT}Dataset`),
  t(`${CN}Dataset`, `${SCHEMA}CreativeWork`),
  t(`${CN}Catalogue`, `${DCAT}Dataset`),
  t(`${CN}Catalogue`, `${SCHEMA}CreativeWork`),
  t(`${CN}Report`, `${SCHEMA}Article`),
];
const DEPENDENCIES = {'mi-create-now': ['mi-schema', 'mi-dcat']};

const id = (cls: {shape: NodeShapeData}) => cls.shape.id;
const directionI = (findings: ShapeCheckFinding[], shape: {shape: NodeShapeData}) =>
  findings
    .filter((f) => f.kind === 'subclass-without-extends' && f.shape === id(shape))
    .map((f) => ({iri: f.iri, severity: f.severity}));

let findings: ShapeCheckFinding[];
beforeAll(async () => {
  void [Article, Resource];
  findings = await checkShapeHierarchy({hierarchy: HIERARCHY, dependencies: DEPENDENCIES});
});

describe('direction I with multiple inheritance', () => {
  test("CN's Dataset: extending CreativeWork satisfies it; dcat's Resource is a warning", () => {
    expect(directionI(findings, Dataset)).toEqual([{iri: `${DCAT}Resource`, severity: 'warning'}]);
    const warning = findings.find((f) => f.shape === id(Dataset))!;
    expect(warning.message).toMatch(/multiple inheritance/);
    expect(warning.message).toContain('CreativeWork');
    expect(findings.filter((f) => f.shape === id(Dataset) && f.severity === 'error')).toEqual([]);
  });

  test('extending none of them is an error for each (Thing too: no ancestor covers it)', () => {
    expect(directionI(findings, Catalogue)).toEqual([
      {iri: `${DCAT}Resource`, severity: 'error'},
      {iri: `${SCHEMA}CreativeWork`, severity: 'error'},
      {iri: `${SCHEMA}Thing`, severity: 'error'},
    ]);
  });

  test('a superclass shape below the chain stays an error', () => {
    expect(directionI(findings, Report)).toEqual([{iri: `${SCHEMA}Article`, severity: 'error'}]);
  });

  test('without the dependency map, every one is out of scope: warnings only', async () => {
    const outOfScope = await checkShapeHierarchy({hierarchy: HIERARCHY});
    for (const shape of [Dataset, Catalogue, Report]) {
      expect(directionI(outOfScope, shape).every((f) => f.severity === 'warning')).toBe(true);
    }
    expect(directionI(outOfScope, Dataset)).toEqual([{iri: `${DCAT}Resource`, severity: 'warning'}]);
  });
});
