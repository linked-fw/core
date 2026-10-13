/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * `__blank` nested node-data: written as an untyped blank node by a create, carried over the
 * DSL-JSON wire, rejected where a blank node cannot be written correctly, and removed by the
 * blank-node block of the containment cascade.
 */
import {beforeAll, describe, expect, test} from '@jest/globals';
import {
  createTestDataset,
  clearAllData,
  executeSparqlQuery,
  executeSparqlUpdate,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {objectProperty, NodeShape} from '../shapes/SHACL';
import {PathNode} from '../shapes/PathNode';
import {serializePathToNodeData} from '../shapes/serializePathToNodeData';
import {createToSparql, deleteToSparql, updateToSparql} from '../sparql/irToAlgebra';
import {lower} from '../queries/lower';
import {lowerMutationJSON} from '../queries/lowerMutationJSON';
import {fromJSON} from '../queries/fromJSON';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import type {
  IRCreateMutation,
  IRDeleteMutation,
  IRUpdateMutation,
} from '../queries/IntermediateRepresentation';
import '../ontologies/rdf';
import '../ontologies/shacl';

const {linkedShape} = linkedPackage('blank-nested-nodes-test');
const X = 'https://example.org/bn#';

// A polymorphic owned slot, like `PropertyShape.path`.
@linkedShape
class BHolder extends Shape {
  static targetClass = {id: `${X}Holder`};

  @objectProperty({path: {id: `${X}slot`}, maxCount: 1, contains: true})
  get slot(): unknown {
    return null;
  }
}

// Plain JSON, as the wire carries it (drops `undefined` keys).
const sanitize = (v: unknown) => JSON.parse(JSON.stringify(v));

@linkedShape
class BTyped extends Shape {
  static targetClass = {id: `${X}Typed`};

  @objectProperty({path: {id: `${X}op`}, maxCount: 1, shape: PathNode, contains: true})
  get op(): PathNode {
    return null;
  }
}

@linkedShape
class BLoose extends Shape {
  static targetClass = {id: `${X}Loose`};

  @objectProperty({path: {id: `${X}loose`}, maxCount: 1})
  get slot(): unknown {
    return null;
  }
}

const inverse = (predicate: string) => ({shape: PathNode, __blank: true, inversePath: {id: predicate}});
const createOf = (data: Record<string, unknown>) =>
  (BHolder.create(data as never) as any).withId(`${X}h1`);

describe('__blank nested node-data', () => {
  test('a create writes an untyped blank node with only its field triples', () => {
    const sparql = createToSparql(lower(createOf({slot: inverse(`${X}parent`)})) as unknown as IRCreateMutation);
    expect(sparql).toContain(`<${X}h1> <${X}slot> _:b0 .`);
    expect(sparql).toContain(`_:b0 shacl:inversePath <${X}parent> .`);
    expect(sparql).not.toContain('PathNode');
    expect(sparql.match(/^\s*_:b0 /gm)).toHaveLength(1);
  });

  test('each blank node of one create gets its own label', () => {
    const sparql = createToSparql(
      lower(createOf({slot: serializePathToNodeData({seq: [{id: `${X}a`}, {inv: {id: `${X}b`}}]})})) as unknown as IRCreateMutation,
    );
    expect(new Set(sparql.match(/_:b\d+/g))).toEqual(new Set(['_:b0', '_:b1', '_:b2']));
  });

  test('the IR carries `blank`, never an id', () => {
    const ir = lower(createOf({slot: inverse(`${X}parent`)})) as unknown as IRCreateMutation;
    const slot = ir.data.fields[0].value as {blank?: true; id?: string};
    expect(slot.blank).toBe(true);
    expect(slot.id).toBeUndefined();
  });

  test('round-trips over the DSL-JSON wire', () => {
    // A slot that declares its value shape. The polymorphic-slot (`sh:path`) round trip is
    // covered in mutation-decode-concrete-shape.test.ts.
    const builder = (BTyped.create({
      op: serializePathToNodeData({inv: {id: `${X}b`}}),
    } as never) as any).withId(`${X}t1`);
    const wire = JSON.parse(JSON.stringify(builder.toJSON()));
    expect(JSON.stringify(wire)).toContain('"__blank":true');
    expect(sanitize(lowerMutationJSON(wire))).toEqual(sanitize(lower(builder)));
    expect(sanitize(lower(fromJSON(wire) as any))).toEqual(sanitize(lower(builder)));
  });

  test('rejects __blank together with an id', () => {
    expect(() => lower(createOf({slot: {...inverse(`${X}p`), __id: `${X}n1`}}))).toThrow(
      /both __blank and carry an id/,
    );
    expect(() => lower(createOf({slot: {...inverse(`${X}p`), id: `${X}n1`}}))).toThrow(
      /both __blank and carry an id/,
    );
  });

  test('rejects a __blank value other than true', () => {
    expect(() => lower(createOf({slot: {...inverse(`${X}p`), __blank: 'yes'}}))).toThrow(
      /__blank must be true/,
    );
  });

  test('rejects a blank node under a property that is not `contains` (nothing would delete it)', () => {
    const ir = lower(
      (BLoose.create({slot: inverse(`${X}p`)} as never) as any).withId(`${X}l1`),
    ) as unknown as IRCreateMutation;
    expect(() => createToSparql(ir)).toThrow(/must be the value of a `contains` property/);
  });

  test('the lowering rejects blank + id however the IR was built (e.g. over the wire)', () => {
    const ir = lower(createOf({slot: inverse(`${X}p`)})) as unknown as IRCreateMutation;
    (ir.data.fields[0].value as {id?: string}).id = `${X}n1`;
    expect(() => createToSparql(ir)).toThrow(/cannot carry an id/);
  });

  test('the wire rejects a __blank value other than true', () => {
    const wire = JSON.parse(JSON.stringify(
      (BTyped.create({op: inverse(`${X}b`)} as never) as any).withId(`${X}t1`).toJSON(),
    ));
    wire.data.op.__blank = 'true';
    expect(() => lowerMutationJSON(wire)).toThrow(/__blank must be true/);
  });

  test('rejects a blank root', () => {
    const ir = lower(BHolder.create({slot: {id: `${X}p`}, __blank: true} as never) as any) as unknown as IRCreateMutation;
    expect(() => createToSparql(ir)).toThrow(/root node of a create cannot be blank/);
  });

  test('rejects a blank node in an update (minted once per WHERE solution)', () => {
    const ir = lower(
      UpdateBuilder.from(BHolder).for(`${X}h1`).set({slot: inverse(`${X}p`)} as never) as any,
    ) as unknown as IRUpdateMutation;
    expect(() => updateToSparql(ir)).toThrow(/can only be written by a create/);
  });
});

describe('blank-node block of the containment cascade', () => {
  const sparqlOf = () =>
    deleteToSparql(lower(DeleteBuilder.from(NodeShape, {id: `${X}Shape`})) as unknown as IRDeleteMutation);

  test('a NodeShape delete removes the blank path structure it owns', () => {
    const sparql = sparqlOf();
    // Reached through `contains` edges from the shape…
    expect(sparql).toMatch(/<https:\/\/example\.org\/bn#Shape> \([^)]*shacl:path[^)]*\)\* \?c_bn0 \./);
    // …then inside the blank structure, through the list / path syntax only (rdf:first too: a
    // sequence member).
    expect(sparql).toContain(
      '?c_bn0 (rdf:first|rdf:rest|shacl:inversePath|shacl:alternativePath|shacl:zeroOrMorePath|' +
        'shacl:oneOrMorePath|shacl:zeroOrOnePath)* ?c_bn .',
    );
    expect(sparql).toContain('FILTER(isBlank(?c_bn0))');
    expect(sparql).toContain('FILTER(isBlank(?c_bn))');
    // The wildcard delete of each reached blank node.
    expect(sparql.slice(0, sparql.indexOf('WHERE'))).toContain('?c_bn ?c_bnp ?c_bno .');
  });

  test('rdf:first is not followed before a blank node is reached', () => {
    const first = sparqlOf().match(/<https:\/\/example\.org\/bn#Shape> \(([^)]*)\)\* \?c_bn0/)![1];
    expect(first).not.toContain('rdf:first');
  });

  test('a shape that reaches no dependent type gets no blank-node block either', () => {
    @linkedShape
    class BPlain extends Shape {
      static targetClass = {id: `${X}Plain`};
    }
    const sparql = deleteToSparql(lower(DeleteBuilder.from(BPlain, {id: `${X}p1`})) as unknown as IRDeleteMutation);
    expect(sparql).not.toContain('isBlank');
  });
});

describeFuseki('blank-node block on a live store', () => {
  beforeAll(async () => {
    await createTestDataset();
    await clearAllData();
  });
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const ask = async (where: string) =>
    (await executeSparqlQuery(`SELECT (COUNT(*) AS ?c) WHERE { ${where} }`)).results.bindings[0].c.value !== '0';

  test("a blank list's rdf:first does not lead the cascade into the entity it lists", async () => {
    // h1 owns a blank list cell that lists the entity e1; e1 owns a blank child of its own.
    await executeSparqlUpdate(`INSERT DATA {
      <${X}h1> a <${X}Holder> ; <${X}slot> _:cell .
      _:cell <${RDF}first> <${X}e1> ; <${RDF}rest> <${RDF}nil> .
      <${X}e1> <${X}slot> _:child .
      _:child <${X}v> "owned by e1" .
    }`);
    await executeSparqlUpdate(
      deleteToSparql(lower(DeleteBuilder.from(BHolder, {id: `${X}h1`})) as unknown as IRDeleteMutation),
    );
    expect(await ask(`<${X}h1> ?p ?o`)).toBe(false);
    expect(await ask(`?cell <${RDF}first> <${X}e1>`)).toBe(false);
    expect(await ask(`<${X}e1> <${X}slot> ?c . ?c <${X}v> "owned by e1"`)).toBe(true);
  });
});
