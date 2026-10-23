/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Shapes as deterministic Turtle (`shapes.ttl`): the form, byte-identical output, core's own
 * shapes against a golden file, blank nodes only for paths, and the triples equal to what the
 * create pipeline writes.
 *
 * To regenerate the golden after a deliberate change to core's shapes or to the writer:
 * `LINKED_UPDATE_GOLDEN=1 npx jest … src/tests/shapes-to-turtle.test.ts`, and review the diff.
 */
import {describe, expect, test} from '@jest/globals';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty, NodeShape} from '../shapes/SHACL';
import type {NodeShapeData} from '../shapes/nodeShapeData';
import {
  packageShapes,
  packageShapesTurtle,
  packagesWithShapes,
  shapesToTurtle,
  singleOwnerShapesTurtle,
  SHAPES_TURTLE_PREFIXES,
} from '../shapes/shapesToTurtle';
import {buildNodeShapeData} from '../shapes/syncShapes';
import {lower, type LowerableCreate} from '../queries/lower';
import {createToAlgebra} from '../sparql/irToAlgebra';
import {builtInShapeIris} from '../utils/ShapeCatalog';
import '../shapes/index';

const {linkedShape} = linkedPackage('ttl-fixture');
const X = 'https://example.org/fx#';
const S = 'https://linked.cm/shape/ttl-fixture/';

@linkedShape
class Img extends Shape {
  static targetClass = {id: `${X}Img`};
}

@linkedShape
class Fixture extends Shape {
  static targetClass = {id: `${X}Fixture`};

  @literalProperty({path: {id: `${X}name`}, maxCount: 1})
  get name(): string {
    return null;
  }

  @objectProperty({path: {id: `${X}image`}, shape: Img, maxCount: 1, contains: true})
  get image(): Img {
    return null;
  }

  @objectProperty({path: {inv: {id: `${X}parent`}}})
  get children(): unknown {
    return null;
  }

  @objectProperty({path: {alt: [{id: `${X}a`}, {zeroOrMore: {id: `${X}b`}}, {inv: {id: `${X}c`}}]}})
  get alts(): unknown {
    return null;
  }

  @objectProperty({path: {seq: [{id: `${X}worksAt`}, {inv: {id: `${X}locatedIn`}}, {id: `${X}d`}]}})
  get seq(): unknown {
    return null;
  }

  @literalProperty({path: {id: `${X}status`}, in: ['open', 'closed', {id: `${X}Other`}]})
  get status(): string {
    return null;
  }
}

@linkedShape
class Sub extends Fixture {
  static targetClass = {id: `${X}Sub`};

  @literalProperty({path: {id: `${X}extra`}, description: 'a "quoted"\nline'})
  get extra(): string {
    return null;
  }
}

const EXPECTED = `@prefix core: <https://linked.cm/ont/core/> .
@prefix fx: <https://example.org/fx#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${S}Fixture>
  a sh:NodeShape ;
  sh:property <${S}Fixture/alts> ;
  sh:property <${S}Fixture/children> ;
  sh:property <${S}Fixture/image> ;
  sh:property <${S}Fixture/name> ;
  sh:property <${S}Fixture/seq> ;
  sh:property <${S}Fixture/status> ;
  sh:targetClass fx:Fixture .

<${S}Fixture/alts>
  a sh:PropertyShape ;
  rdfs:label "alts" ;
  sh:nodeKind sh:IRI ;
  sh:path [ sh:alternativePath ( fx:a [ sh:zeroOrMorePath fx:b ] [ sh:inversePath fx:c ] ) ] .

<${S}Fixture/children>
  a sh:PropertyShape ;
  rdfs:label "children" ;
  sh:nodeKind sh:IRI ;
  sh:path [ sh:inversePath fx:parent ] .

<${S}Fixture/image>
  a sh:PropertyShape ;
  rdfs:label "image" ;
  sh:maxCount "1"^^xsd:integer ;
  sh:node <${S}Img> ;
  sh:nodeKind sh:IRI ;
  sh:path fx:image ;
  core:contains "true"^^xsd:boolean .

<${S}Fixture/name>
  a sh:PropertyShape ;
  rdfs:label "name" ;
  sh:maxCount "1"^^xsd:integer ;
  sh:nodeKind sh:Literal ;
  sh:path fx:name .

<${S}Fixture/seq>
  a sh:PropertyShape ;
  rdfs:label "seq" ;
  sh:nodeKind sh:IRI ;
  sh:path ( fx:worksAt [ sh:inversePath fx:locatedIn ] fx:d ) .

<${S}Fixture/status>
  a sh:PropertyShape ;
  rdfs:label "status" ;
  sh:in <${S}Fixture/status/in/0> ;
  sh:nodeKind sh:Literal ;
  sh:path fx:status .

<${S}Fixture/status/in/0>
  a rdf:List ;
  rdf:first "open" ;
  rdf:rest <${S}Fixture/status/in/1> .

<${S}Fixture/status/in/1>
  a rdf:List ;
  rdf:first "closed" ;
  rdf:rest <${S}Fixture/status/in/2> .

<${S}Fixture/status/in/2>
  a rdf:List ;
  rdf:first fx:Other ;
  rdf:rest rdf:nil .

<${S}Img>
  a sh:NodeShape ;
  sh:targetClass fx:Img .

<${S}Sub>
  a sh:NodeShape ;
  sh:property <${S}Sub/extra> ;
  sh:targetClass fx:Sub ;
  core:isExtending <${S}Fixture> .

<${S}Sub/extra>
  a sh:PropertyShape ;
  rdfs:label "extra" ;
  sh:description "a \\"quoted\\"\\nline" ;
  sh:nodeKind sh:Literal ;
  sh:path fx:extra .
`;

type N3Term = {termType: string; value: string; datatype?: {value: string}; language?: string};
type N3Quad = {subject: N3Term; predicate: N3Term; object: N3Term};

async function parseTurtle(text: string): Promise<N3Quad[]> {
  const n3 = (await import('n3')) as unknown as {
    default?: {Parser: new () => {parse(t: string): N3Quad[]}};
    Parser: new () => {parse(t: string): N3Quad[]};
  };
  const Parser = n3.Parser ?? n3.default!.Parser;
  return new Parser().parse(text);
}

const SH_PATH = 'http://www.w3.org/ns/shacl#path';

/** Every blank node hangs off one IRI subject through `sh:path` (nested blank nodes below it). */
function assertBlankNodesOnlyForPaths(quads: N3Quad[]): number {
  const parents = new Map<string, N3Quad[]>();
  for (const q of quads) {
    if (q.object.termType === 'BlankNode') {
      parents.set(q.object.value, [...(parents.get(q.object.value) ?? []), q]);
    }
  }
  let roots = 0;
  for (const q of quads) {
    for (const t of [q.subject, q.object]) {
      if (t.termType !== 'BlankNode') continue;
      expect(parents.get(t.value)).toHaveLength(1);
    }
    if (q.object.termType === 'BlankNode' && q.subject.termType === 'NamedNode') {
      expect(q.predicate.value).toBe(SH_PATH);
      roots++;
    }
  }
  return roots;
}

const termKey = (t: N3Term | {kind: string; value?: string; datatype?: string; language?: string}): string => {
  if ('termType' in t) {
    if (t.termType === 'Literal') {
      const dt = t.datatype?.value ?? '';
      return JSON.stringify(['lit', t.value, t.language ? '' : dt === 'http://www.w3.org/2001/XMLSchema#string' ? '' : dt, t.language ?? '']);
    }
    return t.termType === 'BlankNode' ? '_' : `<${t.value}>`;
  }
  if (t.kind === 'literal') {
    const dt = t.datatype ?? '';
    return JSON.stringify(['lit', t.value, t.language ? '' : dt === 'http://www.w3.org/2001/XMLSchema#string' ? '' : dt, t.language ?? '']);
  }
  return t.kind === 'blank' ? '_' : `<${t.value}>`;
};

describe('shapesToTurtle', () => {
  test('writes the shapes as declared, in the fixed form', () => {
    expect(shapesToTurtle([Fixture, Sub, Img], {prefixes: {fx: X}})).toBe(EXPECTED);
  });

  test('gives the same bytes for the same shapes, in any input order', () => {
    const a = shapesToTurtle([Fixture, Sub, Img], {prefixes: {fx: X}});
    const b = shapesToTurtle([Img, Sub.shape, Fixture], {prefixes: {fx: X}});
    expect(b).toBe(a);
    expect(shapesToTurtle([Fixture, Sub, Img], {prefixes: {fx: X}})).toBe(a);
  });

  test('parses back to the triples the create pipeline writes, without the generated shapes', async () => {
    const quads = await parseTurtle(shapesToTurtle([Fixture, Sub, Img]));
    const expected: string[] = [];
    for (const shape of [Fixture.shape, Sub.shape, Img.shape]) {
      const data = buildNodeShapeData(shape, shape.id, {generated: false});
      const builder = NodeShape.create(data as never).withId(shape.id) as unknown as LowerableCreate;
      for (const t of createToAlgebra(lower(builder)).triples) {
        expected.push(`${termKey(t.subject)} ${termKey(t.predicate)} ${termKey(t.object)}`);
      }
    }
    const actual = quads.map((q) => `${termKey(q.subject)} ${termKey(q.predicate)} ${termKey(q.object)}`);
    expect(actual.sort()).toEqual(expected.sort());
    expect(actual.join('\n')).not.toContain('singleOwner');
    expect(actual.join('\n')).not.toContain('shapeHash');
  });

  test('keeps the blank nodes of two shapes apart', async () => {
    const other: NodeShapeData = {
      id: `${S}Other`,
      propertyShapes: [{id: `${S}Other/up`, label: 'up', path: {inv: {id: `${X}up`}}} as never],
    };
    const quads = await parseTurtle(shapesToTurtle([Fixture, other]));
    expect(assertBlankNodesOnlyForPaths(quads)).toBe(4);
  });

  test('uses blank nodes only for complex paths, each hanging off one IRI subject', async () => {
    const quads = await parseTurtle(shapesToTurtle([Fixture, Sub, Img]));
    expect(assertBlankNodesOnlyForPaths(quads)).toBe(3);
  });

  test('writes sh:and and sh:xone lists with IRI cells', async () => {
    const shape: NodeShapeData = {
      id: `${S}Both`,
      targetClass: {id: `${X}Both`},
      andShapes: [{id: `${S}Fixture`}, {id: `${S}Img`}],
      xoneShapes: [{id: `${S}Img`}],
      propertyShapes: [],
    };
    const text = shapesToTurtle([shape]);
    expect(text).toContain(`sh:and <${S}Both/and/0>`);
    expect(text).toContain(`<${S}Both/and/1>\n  a rdf:List ;\n  rdf:first <${S}Img> ;\n  rdf:rest rdf:nil .`);
    expect(text).toContain(`sh:xone <${S}Both/xone/0>`);
    expect((await parseTurtle(text)).some((q) => q.subject.termType === 'BlankNode')).toBe(false);
  });

  test('declares the fixed prefix block, refuses rebinding a fixed prefix and bad names', () => {
    const text = shapesToTurtle([Img]);
    for (const [name, ns] of Object.entries(SHAPES_TURTLE_PREFIXES)) {
      expect(text).toContain(`@prefix ${name}: <${ns}> .`);
    }
    expect(() => shapesToTurtle([Img], {prefixes: {sh: X}})).toThrow(/fixed/);
    expect(() => shapesToTurtle([Img], {prefixes: {'1x': X}})).toThrow(/prefix name/);
    expect(() => shapesToTurtle([Img], {prefixes: {fx: 'not an iri'}})).toThrow(/absolute IRI/);
    expect(shapesToTurtle([Img], {prefixes: {sh: SHAPES_TURTLE_PREFIXES.sh}})).toBe(text);
  });

  test('an empty list of shapes is the prefix block alone', () => {
    expect(shapesToTurtle([])).toBe(
      Object.entries(SHAPES_TURTLE_PREFIXES)
        .map(([n, ns]) => `@prefix ${n}: <${ns}> .`)
        .join('\n') + '\n',
    );
  });
});

describe('singleOwnerShapesTurtle', () => {
  test('writes the generated single-owner shapes with their owners’ links', async () => {
    const text = singleOwnerShapesTurtle([Fixture, Sub, Img])!;
    expect(text).toContain(`<${S}Fixture>\n  core:generatedShape <${S}Fixture/image.singleOwner> .`);
    expect(text).toContain('sh:qualifiedValueShape [ sh:class <https://example.org/fx#Fixture> ]');
    // A sub-shape inherits the property but generates no constraint of its own.
    expect(text).not.toContain(`${S}Sub/`);
    const quads = await parseTurtle(text);
    expect(quads.filter((q) => q.subject.termType === 'BlankNode')).toHaveLength(2);
  });

  test('is undefined for shapes without contains properties', () => {
    expect(singleOwnerShapesTurtle([Img])).toBeUndefined();
  });
});

describe("a package's shapes.ttl", () => {
  test('packageShapes selects the package’s registered shapes, sorted', () => {
    expect(packageShapes('ttl-fixture').map((s) => s.id)).toEqual([`${S}Fixture`, `${S}Img`, `${S}Sub`]);
    expect(packageShapes('@_linked/core').map((s) => s.id).sort()).toEqual([...builtInShapeIris()].sort());
    expect(packagesWithShapes()).toEqual(expect.arrayContaining(['@_linked/core', 'ttl-fixture']));
    expect(packageShapesTurtle('no-such-package')).toBeUndefined();
  });

  test("core's own shapes equal the golden file, byte for byte, across runs", async () => {
    const golden = resolve(process.cwd(), 'src/tests/fixtures/core-shapes.ttl');
    const first = packageShapesTurtle('@_linked/core')!;
    expect(packageShapesTurtle('@_linked/core')).toBe(first);
    if (process.env.LINKED_UPDATE_GOLDEN === '1' || !existsSync(golden)) {
      writeFileSync(golden, first);
    }
    expect(first).toBe(readFileSync(golden, 'utf8'));
    assertBlankNodesOnlyForPaths(await parseTurtle(first));
  });
});
