/*
 * The SHACL Core terms the metamodel gained (sh:name, sh:targetSubjectsOf, sh:deactivated,
 * sh:message, sh:severity, sh:and/xone/not on node shapes; sh:flags, sh:languageIn,
 * sh:uniqueLang, sh:qualifiedMinCount, nested sh:property on property shapes), PropertyGroup as
 * the value of sh:group, and core:sharedTargetClass: each is written by shape sync and survives
 * the wire.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, NodeShape, PropertyShape} from '../shapes/SHACL';
import {PropertyGroup} from '../shapes/PropertyGroup';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {syncShape} from '../shapes/syncShapes';
import {getPropertyShape, type NodeShapeData} from '../shapes/nodeShapeData';
import {fromWire, toWire} from '../shapes/nodeShapeWire';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';
import {getNodeShape} from '../utils/ShapeClass';
import {builtInShapeIris} from '../utils/ShapeCatalog';
import {shacl} from '../ontologies/shacl';
import '../shapes/index';

const {linkedShape} = linkedPackage('metamodel-terms-test');
const X = 'https://example.org/terms#';
const GROUP = `${X}basics`;

@linkedShape({sharedTargetClass: true})
class Termed extends Shape {
  static targetClass = {id: `${X}Termed`};
  @literalProperty({path: {id: `${X}title`}, maxCount: 1, group: GROUP, order: 1})
  get title(): string {
    return null;
  }
}

/** Records the updates a sync sends; selects answer with no rows. */
class Capture extends SparqlDataset {
  updates: string[] = [];
  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

const shape = Termed.shape as NodeShapeData;
Object.assign(shape, {
  name: 'Termed thing',
  targetSubjectsOf: [{id: `${X}mentions`}],
  deactivated: false,
  message: ['Not a termed thing'],
  severity: shacl.Warning,
  andShapes: [{id: `${X}A`}, {id: `${X}B`}],
  xoneShapes: [{id: `${X}C`}],
  notShape: {id: `${X}D`},
});
Object.assign(getPropertyShape(shape, 'title')!, {
  pattern: /^[A-Z]/,
  flags: 'i',
  languageIn: ['en', 'nl'],
  uniqueLang: true,
  qualifiedMinCount: 1,
  deactivated: true,
  message: ['Needs a title'],
  severity: shacl.Info,
  properties: [{id: `${X}nested`}],
});

const S = `<https://linked.cm/shape/metamodel-terms-test/Termed>`;
const P = `<https://linked.cm/shape/metamodel-terms-test/Termed/title>`;

describe('shape sync writes the new terms', () => {
  test('node shape, property shape, group and sharedTargetClass', async () => {
    const ds = new Capture();
    await syncShape(Termed, ds)();
    const insert = ds.updates.find((u) => u.includes('INSERT DATA'))!;
    for (const triple of [
      `${S} shacl:name "Termed thing" .`,
      `${S} shacl:targetSubjectsOf <${X}mentions> .`,
      `${S} shacl:deactivated "false"^^xsd:boolean .`,
      `${S} shacl:message "Not a termed thing" .`,
      `${S} shacl:severity shacl:Warning .`,
      `${S} shacl:not <${X}D> .`,
      `${S} core:sharedTargetClass "true"^^xsd:boolean .`,
      `${P} shacl:group <${GROUP}> .`,
      `${P} shacl:flags "i" .`,
      `${P} shacl:uniqueLang "true"^^xsd:boolean .`,
      `${P} shacl:qualifiedMinCount "1"^^xsd:integer .`,
      `${P} shacl:deactivated "true"^^xsd:boolean .`,
      `${P} shacl:message "Needs a title" .`,
      `${P} shacl:severity shacl:Info .`,
      `${P} shacl:property <${X}nested> .`,
      `${P} shacl:languageIn <https://linked.cm/shape/metamodel-terms-test/Termed/title/languageIn/0> .`,
    ]) {
      expect(insert).toContain(triple);
    }
    // sh:and / sh:xone are blank rdf:Lists of the member shapes.
    expect(insert).toMatch(new RegExp(`${S.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} shacl:and _:b\\d+ \\.`));
    expect(insert).toMatch(/_:b\d+ rdf:first <https:\/\/example\.org\/terms#A> \./);
    expect(insert).toMatch(/shacl:xone _:b\d+ \./);
  });
});

describe('the metamodel declares them', () => {
  test('NodeShape and PropertyShape carry the new property shapes', () => {
    const labels = (s: NodeShapeData) => s.propertyShapes.map((p) => p.label);
    expect(labels(NodeShape.shape)).toEqual(
      expect.arrayContaining([
        'name',
        'targetSubjectsOf',
        'deactivated',
        'message',
        'severity',
        'andShapes',
        'xoneShapes',
        'notShape',
        'sharedTargetClass',
      ]),
    );
    expect(labels(PropertyShape.shape)).toEqual(
      expect.arrayContaining([
        'flags',
        'languageIn',
        'uniqueLang',
        'qualifiedMinCount',
        'deactivated',
        'message',
        'severity',
        'properties',
      ]),
    );
  });

  test('sh:group names a PropertyGroup, a built-in', () => {
    const group = getPropertyShape(PropertyShape.shape, 'group')!;
    expect(group.valueShape).toEqual({id: PropertyGroup.shape.id});
    expect(group.nodeKind).toEqual(shacl.IRI);
    expect(PropertyGroup.targetClass).toEqual(shacl.PropertyGroup);
    expect(PropertyGroup.shape.propertyShapes.map((p) => p.label).sort()).toEqual([
      'description',
      'order',
    ]);
    expect(builtInShapeIris()).toContain(PropertyGroup.shape.id);
  });
});

describe('a data-only shape keeps them across the wire', () => {
  test('toWire / fromWire / registerRuntimeShape', () => {
    const copy = JSON.parse(JSON.stringify(toWire(shape)));
    copy.id = `${X}shape/DataTermed`;
    copy.propertyShapes.forEach((p: {id: string; label: string}) => (p.id = `${copy.id}/${p.label}`));
    expect(registerRuntimeShape(copy)).toBe(true);
    const registered = getNodeShape(copy.id)!;
    expect(registered).toMatchObject({
      sharedTargetClass: true,
      name: 'Termed thing',
      targetSubjectsOf: [{id: `${X}mentions`}],
      message: ['Not a termed thing'],
      severity: shacl.Warning,
      andShapes: [{id: `${X}A`}, {id: `${X}B`}],
      xoneShapes: [{id: `${X}C`}],
      notShape: {id: `${X}D`},
    });
    const title = getPropertyShape(registered, 'title')!;
    expect(title).toMatchObject({
      group: {id: GROUP},
      flags: 'i',
      languageIn: ['en', 'nl'],
      uniqueLang: true,
      qualifiedMinCount: 1,
      deactivated: true,
      message: ['Needs a title'],
      severity: shacl.Info,
      properties: [{id: `${X}nested`}],
    });
    expect(fromWire(toWire(registered))).toEqual(registered);
  });
});
