/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Nested creates minted as blank nodes because the property that holds them declares a
 * blank-capable `sh:nodeKind`: written as untyped blank nodes by a create, nothing on the
 * DSL-JSON wire, clear errors where a blank node cannot be written, and removed by the
 * blank-node cascade.
 */
import {beforeAll, beforeEach, describe, expect, test} from '@jest/globals';
import {
  createTestDataset,
  clearAllData,
  executeSparqlQuery,
  executeSparqlUpdate,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {objectProperty, linkedProperty, NodeShape} from '../shapes/SHACL';
import {PathNode} from '../shapes/PathNode';
import {serializePathToNodeData} from '../shapes/serializePathToNodeData';
import {
  createToSparql,
  deleteToSparql,
  updateToSparql,
  upsertToSparql,
  updateWhereToSparql,
} from '../sparql/irToAlgebra';
import {lower} from '../queries/lower';
import {lowerMutationJSON} from '../queries/lowerMutationJSON';
import {fromJSON} from '../queries/fromJSON';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import type {
  IRCreateMutation,
  IRDeleteMutation,
  IRUpdateMutation,
  IRUpdateWhereMutation,
  IRUpsertMutation,
} from '../queries/IntermediateRepresentation';
import '../ontologies/rdf';
import {shacl} from '../ontologies/shacl';

const {linkedShape} = linkedPackage('blank-nested-nodes-test');
const X = 'https://example.org/bn#';

// A polymorphic blank-capable slot, like `PropertyShape.path`.
@linkedShape
class BHolder extends Shape {
  static targetClass = {id: `${X}Holder`};

  @objectProperty({path: {id: `${X}slot`}, maxCount: 1, nodeKind: shacl.BlankNodeOrIRI})
  get slot(): unknown {
    return null;
  }
}

// Plain JSON, as the wire carries it (drops `undefined` keys).
const sanitize = (v: unknown) => JSON.parse(JSON.stringify(v));

@linkedShape
class BTyped extends Shape {
  static targetClass = {id: `${X}Typed`};

  @objectProperty({path: {id: `${X}op`}, maxCount: 1, shape: PathNode, nodeKind: shacl.BlankNodeOrIRI})
  get op(): PathNode {
    return null;
  }
}

/** One property per `sh:nodeKind`, each holding a polymorphic nested value. */
@linkedShape
class BKinds extends Shape {
  static targetClass = {id: `${X}Kinds`};

  @objectProperty({path: {id: `${X}blankOnly`}, maxCount: 1, nodeKind: shacl.BlankNode})
  get blankOnly(): unknown {
    return null;
  }

  @linkedProperty({path: {id: `${X}blankOrLiteral`}, maxCount: 1, nodeKind: shacl.BlankNodeOrLiteral})
  get blankOrLiteral(): unknown {
    return null;
  }

  @linkedProperty({path: {id: `${X}iriOrLiteral`}, maxCount: 1, nodeKind: shacl.IRIOrLiteral})
  get iriOrLiteral(): unknown {
    return null;
  }

  @linkedProperty({path: {id: `${X}literal`}, maxCount: 1, nodeKind: shacl.Literal})
  get literal(): unknown {
    return null;
  }

  @objectProperty({path: {id: `${X}iri`}, maxCount: 1})
  get iri(): unknown {
    return null;
  }

  @linkedProperty({path: {id: `${X}unset`}, maxCount: 1})
  get unset(): unknown {
    return null;
  }
}

const inverse = (predicate: string) => ({shape: PathNode, inversePath: {id: predicate}});
const createOf = (data: Record<string, unknown>) =>
  (BHolder.create(data as never) as any).withId(`${X}h1`);
const kindsSparql = (data: Record<string, unknown>) =>
  createToSparql(lower((BKinds.create(data as never) as any).withId(`${X}k1`)) as unknown as IRCreateMutation);

describe('nested creates minted from the property sh:nodeKind', () => {
  test('sh:BlankNodeOrIRI without an id: an untyped blank node with only its field triples', () => {
    const sparql = createToSparql(lower(createOf({slot: inverse(`${X}parent`)})) as unknown as IRCreateMutation);
    expect(sparql).toContain(`<${X}h1> <${X}slot> _:b0 .`);
    expect(sparql).toContain(`_:b0 shacl:inversePath <${X}parent> .`);
    expect(sparql).not.toContain('PathNode');
    expect(sparql.match(/^\s*_:b0 /gm)).toHaveLength(1);
  });

  test('sh:BlankNodeOrIRI with an id: an IRI-named, typed node', () => {
    const sparql = createToSparql(
      lower(createOf({slot: {...inverse(`${X}parent`), id: `${X}n1`}})) as unknown as IRCreateMutation,
    );
    expect(sparql).toContain(`<${X}h1> <${X}slot> <${X}n1> .`);
    expect(sparql).toContain(`<${X}n1> rdf:type core:PathNode .`);
    expect(sparql).not.toContain('_:');
  });

  test('each blank node of one create gets its own label', () => {
    const sparql = createToSparql(
      lower(createOf({slot: serializePathToNodeData({seq: [{id: `${X}a`}, {inv: {id: `${X}b`}}]})})) as unknown as IRCreateMutation,
    );
    expect(new Set(sparql.match(/_:b\d+/g))).toEqual(new Set(['_:b0', '_:b1', '_:b2']));
  });

  test('the IR carries no blank marker and no id: the lowering decides', () => {
    const ir = lower(createOf({slot: inverse(`${X}parent`)})) as unknown as IRCreateMutation;
    const slot = ir.data.fields[0].value as Record<string, unknown>;
    expect(slot.id).toBeUndefined();
    expect(Object.keys(slot).sort()).toEqual(['fields', 'shape']);
  });

  test('sh:BlankNode: blank without an id, an error with one', () => {
    expect(kindsSparql({blankOnly: inverse(`${X}p`)})).toContain(`<${X}k1> <${X}blankOnly> _:b0 .`);
    expect(() => kindsSparql({blankOnly: {...inverse(`${X}p`), id: `${X}n1`}})).toThrow(
      /'blankOnly'.*sh:BlankNode.*has no id.*n1/,
    );
  });

  test('sh:BlankNodeOrLiteral: blank without an id, an error with one (no IRIs allowed)', () => {
    expect(kindsSparql({blankOrLiteral: {...inverse(`${X}p`)}})).toContain(`<${X}k1> <${X}blankOrLiteral> _:b0 .`);
    expect(() => kindsSparql({blankOrLiteral: {...inverse(`${X}p`), id: `${X}n1`}})).toThrow(
      /sh:BlankNodeOrLiteral/,
    );
  });

  test('sh:Literal: a nested node is an error', () => {
    expect(() => kindsSparql({literal: inverse(`${X}p`)})).toThrow(/literal/i);
  });

  test('sh:IRIOrLiteral, sh:IRI and an unset nodeKind: IRI-named, typed nodes as before', () => {
    for (const key of ['iriOrLiteral', 'iri', 'unset']) {
      const sparql = kindsSparql({[key]: inverse(`${X}p`)});
      expect(sparql).not.toContain('_:');
      expect(sparql).toContain('rdf:type core:PathNode');
    }
  });

  test('round-trips over the DSL-JSON wire with nothing about blank nodes on it', () => {
    const builder = (BTyped.create({
      op: serializePathToNodeData({inv: {id: `${X}b`}}),
    } as never) as any).withId(`${X}t1`);
    const wire = JSON.parse(JSON.stringify(builder.toJSON()));
    expect(JSON.stringify(wire)).not.toContain('__blank');
    expect(sanitize(lowerMutationJSON(wire))).toEqual(sanitize(lower(builder)));
    expect(sanitize(lower(fromJSON(wire) as any))).toEqual(sanitize(lower(builder)));
    expect(createToSparql(lowerMutationJSON(wire) as unknown as IRCreateMutation)).toContain(
      `<${X}t1> <${X}op> _:b0 .`,
    );
  });

  test('`__blank` is no longer an input key: it is an undeclared property', () => {
    expect(() => lower(createOf({slot: {...inverse(`${X}p`), __blank: true}}))).toThrow(/__blank/);
    const wire = JSON.parse(JSON.stringify(
      (BTyped.create({op: inverse(`${X}b`)} as never) as any).withId(`${X}t1`).toJSON(),
    ));
    wire.data.op.__blank = true;
    expect(() => lowerMutationJSON(wire)).toThrow(/__blank/);
  });

});

describe('where a blank node cannot be written or addressed: clear errors', () => {
  const blankInUpdate = /Cannot write a blank node in an update.*'slot'.*give it an id/;

  test('update, upsert and updateWhere refuse a value that would be minted blank', () => {
    const set = {slot: inverse(`${X}p`)} as never;
    expect(() =>
      updateToSparql(lower(UpdateBuilder.from(BHolder).for(`${X}h1`).set(set) as any) as unknown as IRUpdateMutation),
    ).toThrow(blankInUpdate);
    expect(() =>
      upsertToSparql(lower(UpdateBuilder.upsertFrom(BHolder).for(`${X}h1`).set(set) as any) as unknown as IRUpsertMutation),
    ).toThrow(blankInUpdate);
    expect(() =>
      updateWhereToSparql(lower(UpdateBuilder.from(BHolder).forAll().set(set) as any) as unknown as IRUpdateWhereMutation),
    ).toThrow(blankInUpdate);
  });

  test('a blank value nested deeper in an update is refused too', () => {
    // The nested PathNode gets an id (an IRI), its operand list does not (blank).
    const set = {slot: {...serializePathToNodeData({alt: [{id: `${X}a`}, {id: `${X}b`}]}), id: `${X}n1`}} as never;
    expect(() =>
      updateToSparql(lower(UpdateBuilder.from(BHolder).for(`${X}h1`).set(set) as any) as unknown as IRUpdateMutation),
    ).toThrow(/Cannot write a blank node in an update.*'alternativePath'/);
  });

  test('an update may write a nested value with an id under sh:BlankNodeOrIRI: an IRI', () => {
    const sparql = updateToSparql(
      lower(
        UpdateBuilder.from(BHolder).for(`${X}h1`).set({slot: {...inverse(`${X}p`), id: `${X}n1`}} as never) as any,
      ) as unknown as IRUpdateMutation,
    );
    expect(sparql).toContain(`<${X}h1> <${X}slot> <${X}n1> .`);
    expect(sparql.slice(0, sparql.indexOf('WHERE'))).not.toContain('_:');
  });

  const blankId = /"_:b0" is a blank-node label, not an IRI/;

  test('linking a blank-node id is refused, in a create and in an update', () => {
    expect(() => createToSparql(lower(createOf({slot: {id: '_:b0'}})) as unknown as IRCreateMutation)).toThrow(blankId);
    expect(() =>
      updateToSparql(
        lower(UpdateBuilder.from(BHolder).for(`${X}h1`).set({slot: {id: '_:b0'}} as never) as any) as unknown as IRUpdateMutation,
      ),
    ).toThrow(blankId);
  });

  test('update().for() and a delete by a blank-node id are refused', () => {
    expect(() =>
      updateToSparql(
        lower(UpdateBuilder.from(BHolder).for('_:b0').set({slot: {id: `${X}e1`}} as never) as any) as unknown as IRUpdateMutation,
      ),
    ).toThrow(blankId);
    expect(() =>
      deleteToSparql(lower(DeleteBuilder.from(BHolder, {id: '_:b0'})) as unknown as IRDeleteMutation),
    ).toThrow(blankId);
  });
});

describe('blank-node cascade', () => {
  const nodeShapeDelete = () =>
    deleteToSparql(lower(DeleteBuilder.from(NodeShape, {id: `${X}Shape`})) as unknown as IRDeleteMutation);

  test('a NodeShape delete removes the blank paths of the property shapes it deletes', () => {
    const sparql = nodeShapeDelete();
    // The owner: a property shape the typed cascade reaches and deletes…
    const owner = sparql.match(/\?(c_bo\d+) rdf:type shacl:PropertyShape \./)![1];
    // …its blank value through the blank-capable `sh:path`…
    const bn0 = sparql.match(new RegExp(`\\?${owner} shacl:path \\?(c_b\\d+_bn0) \\.`))![1];
    expect(sparql).toContain(`FILTER(isBlank(?${bn0}))`);
    // …then the blank nodes below it, through the path slots and the list predicates.
    const inner = sparql.match(new RegExp(`\\?${bn0} \\(([^)]*)\\)\\* \\?c_b\\d+_bn \\.`))![1];
    for (const predicate of ['shacl:inversePath', 'shacl:alternativePath', 'shacl:zeroOrMorePath', 'rdf:first', 'rdf:rest']) {
      expect(inner).toContain(predicate);
    }
    expect(sparql).toMatch(/FILTER\(isBlank\(\?c_b\d+_bn\) && NOT EXISTS/);
    expect(sparql.slice(0, sparql.indexOf('WHERE'))).toMatch(/\?c_b\d+_bn \?c_b\d+_bnp \?c_b\d+_bno \./);
  });

  test('blank values are reached through blank-capable properties, never through `contains` edges', () => {
    expect(nodeShapeDelete()).not.toMatch(/\)\* \?c_b\d+_bn0/);
  });

  test('a delete by id removes the subject\'s own blank values', () => {
    const sparql = deleteToSparql(lower(DeleteBuilder.from(BHolder, {id: `${X}h1`})) as unknown as IRDeleteMutation);
    expect(sparql).toContain(`<${X}h1> <${X}slot> ?b_bn0 .`);
    expect(sparql).toContain('FILTER(isBlank(?b_bn0))');
  });

  test('a shape without blank-capable properties or dependent values gets no blank-node block', () => {
    @linkedShape
    class BPlain extends Shape {
      static targetClass = {id: `${X}Plain`};
    }
    const sparql = deleteToSparql(lower(DeleteBuilder.from(BPlain, {id: `${X}p1`})) as unknown as IRDeleteMutation);
    expect(sparql).not.toContain('isBlank');
  });

  test('replacing or unsetting a blank-capable property removes its old blank value', () => {
    for (const value of [{id: `${X}e1`}, undefined]) {
      const sparql = updateToSparql(
        lower(UpdateBuilder.from(BHolder).for(`${X}h1`).set({slot: value} as never) as any) as unknown as IRUpdateMutation,
      );
      expect(sparql).toContain(`<${X}h1> <${X}slot> ?old_slot .`);
      expect(sparql).toContain('FILTER(isBlank(?old_slot))');
      expect(sparql.slice(0, sparql.indexOf('WHERE'))).toMatch(/\?ub_\w+_bn \?ub_\w+_bnp \?ub_\w+_bno \./);
    }
  });
});

describeFuseki('blank-node cascade on a live store', () => {
  beforeAll(async () => {
    await createTestDataset();
  });
  beforeEach(async () => {
    await clearAllData();
  });
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const ask = async (where: string) =>
    (await executeSparqlQuery(`SELECT (COUNT(*) AS ?c) WHERE { ${where} }`)).results.bindings[0].c.value !== '0';
  const blankSubjects = async () =>
    Number((await executeSparqlQuery('SELECT (COUNT(DISTINCT ?b) AS ?c) WHERE { ?b ?p ?o FILTER(isBlank(?b)) }')).results.bindings[0].c.value);
  const createHolder = (slot: unknown) =>
    executeSparqlUpdate(createToSparql(lower(createOf({slot})) as unknown as IRCreateMutation));
  const update = (slot: unknown) =>
    executeSparqlUpdate(
      updateToSparql(lower(UpdateBuilder.from(BHolder).for(`${X}h1`).set({slot} as never) as any) as unknown as IRUpdateMutation),
    );
  // A predicate IRI the path refers to, described by triples of its own: never deleted.
  const describePredicates = () =>
    executeSparqlUpdate(`INSERT DATA {
      <${X}image> <${X}label> "image" .
      <${X}b> <${X}label> "b" .
    }`);
  const predicatesIntact = async () =>
    (await ask(`<${X}image> <${X}label> "image"`)) && (await ask(`<${X}b> <${X}label> "b"`));
  const altWithNestedOperator = () =>
    serializePathToNodeData({alt: [{inv: {id: `${X}image`}}, {zeroOrMore: {id: `${X}b`}}]});

  test("a blank list's rdf:first does not lead the cascade into the entity it lists", async () => {
    // h1 holds a blank list cell that lists the entity e1; e1 holds a blank value of its own
    // through the same blank-capable predicate.
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

  test('a delete by id removes the blank path structure and no IRI', async () => {
    await describePredicates();
    await createHolder(altWithNestedOperator());
    expect(await blankSubjects()).toBe(5); // operator, 2 cells, 2 nested operators
    await executeSparqlUpdate(
      deleteToSparql(lower(DeleteBuilder.from(BHolder, {id: `${X}h1`})) as unknown as IRDeleteMutation),
    );
    expect(await blankSubjects()).toBe(0);
    expect(await predicatesIntact()).toBe(true);
  });

  test('replace and unset remove the old blank structure and no IRI', async () => {
    await describePredicates();
    await createHolder(altWithNestedOperator());
    // Replace with a link to an IRI entity: the old blank structure goes.
    await executeSparqlUpdate(`INSERT DATA { <${X}e1> <${X}label> "e1" . }`);
    await update({id: `${X}e1`});
    expect(await blankSubjects()).toBe(0);
    expect(await ask(`<${X}h1> <${X}slot> <${X}e1>`)).toBe(true);
    // Unset: the old value is an IRI, which stays with its triples.
    await update(undefined);
    expect(await ask(`<${X}h1> <${X}slot> ?v`)).toBe(false);
    expect(await ask(`<${X}e1> <${X}label> "e1"`)).toBe(true);
    expect(await predicatesIntact()).toBe(true);
  });

  test('unsetting a blank value removes it', async () => {
    await createHolder(serializePathToNodeData({inv: {id: `${X}image`}}));
    expect(await blankSubjects()).toBe(1);
    await update(undefined);
    expect(await blankSubjects()).toBe(0);
    expect(await ask(`<${X}h1> ?p ?o`)).toBe(true);
  });
});
