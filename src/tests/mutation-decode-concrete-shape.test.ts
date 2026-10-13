/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * A nested node's concrete shape (`__shape` on the DSL-JSON wire) survives the
 * decode into raw builder data, so a mutation validates and lowers the same over
 * the wire as in-process: a subclass value under a base-typed property, and any
 * value under a polymorphic slot such as `PropertyShape.path`.
 */
import {describe, expect, test} from '@jest/globals';
import {Person, Employee} from '../test-helpers/query-fixtures';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {objectProperty} from '../shapes/SHACL';
import {PathNode} from '../shapes/PathNode';
import {serializePathToNodeData} from '../shapes/serializePathToNodeData';
import {decodeNodeDataToRaw} from '../queries/MutationSerialization';
import {lowerMutationJSON} from '../queries/lowerMutationJSON';
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import type {IRCreateMutation} from '../queries/IntermediateRepresentation';
import {createToSparql} from '../sparql/irToAlgebra';
import '../ontologies/rdf';
import {shacl} from '../ontologies/shacl';

const {linkedShape} = linkedPackage('mutation-decode-concrete-shape-test');
const X = 'https://example.org/dcs#';

// A polymorphic owned slot, like `PropertyShape.path`: no declared value shape, blank-capable.
@linkedShape
class DHolder extends Shape {
  static targetClass = {id: `${X}Holder`};

  @objectProperty({path: {id: `${X}slot`}, maxCount: 1, contains: true, nodeKind: shacl.BlankNodeOrIRI})
  get slot(): unknown {
    return null;
  }
}

/** Plain JSON, as the wire carries it. */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('decoding nested node data keeps its concrete shape', () => {
  test('a subclass value with a subclass-only field under a base-typed property', () => {
    const builder = (Person.create({
      name: 'Alice',
      friends: [{shape: Employee, name: 'Eve', department: 'Research'}],
    } as never) as any).withId('x:alice');
    const json = wire(builder.toJSON());
    expect(json.data.friends['@list'][0].__shape).toBe(Employee.shape.id);

    const raw = decodeNodeDataToRaw(json.data, Person.shape) as any;
    expect(raw.friends[0].shape).toBe(Employee);

    const viaWire = lowerMutationJSON(json) as unknown as IRCreateMutation;
    expect(wire(viaWire)).toEqual(wire(lower(builder)));
    expect(wire(lower(fromJSON(json) as any))).toEqual(wire(lower(builder)));

    const [friend] = viaWire.data.fields[1].value as any[];
    expect(friend.shape).toBe(Employee.shape.id);
    expect(JSON.stringify(friend)).toContain('department');
  });

  test('a complex path value under a polymorphic slot', () => {
    const builder = (DHolder.create({
      slot: serializePathToNodeData({inv: {id: `${X}parent`}}),
    } as never) as any).withId(`${X}h1`);
    const json = wire(builder.toJSON());
    expect(json.data.slot.__shape).toBe(PathNode.shape.id);
    // Nothing on the wire says "blank": the receiving side mints from the slot's sh:nodeKind.
    expect(JSON.stringify(json)).not.toContain('__blank');

    expect(wire(lowerMutationJSON(json))).toEqual(wire(lower(builder)));
    expect(wire(lower(fromJSON(json) as any))).toEqual(wire(lower(builder)));
    const sparql = createToSparql(lowerMutationJSON(json) as unknown as IRCreateMutation);
    expect(sparql).toContain(`<${X}h1> <${X}slot> _:b0 .`);
    expect(sparql).toContain(`_:b0 shacl:inversePath <${X}parent> .`);
  });

  test('a subclass-only field without __shape is still rejected', () => {
    const json = {
      v: 1,
      op: 'create',
      shape: Person.shape.id,
      data: {__id: 'x:bob', name: 'Bob', friends: {'@list': [{name: 'Eve', department: 'Research'}]}},
    };
    const raw = decodeNodeDataToRaw(json.data as any, Person.shape) as any;
    expect(raw.friends[0].shape).toBeUndefined();
    expect(() => lowerMutationJSON(json as any)).toThrow(/department/);
    expect(() => lower(fromJSON(json as any) as any)).toThrow(/department/);
  });

  test('without __shape a nested value decodes as before', () => {
    const builder = (Person.create({name: 'Alice', bestFriend: {name: 'Bea'}} as never) as any).withId(
      'x:alice2',
    );
    const json = wire(builder.toJSON());
    expect(json.data.bestFriend).toEqual({name: 'Bea'});
    expect(decodeNodeDataToRaw(json.data, Person.shape)).toEqual({
      id: 'x:alice2',
      name: 'Alice',
      bestFriend: {name: 'Bea'},
    });
    expect(wire(lowerMutationJSON(json))).toEqual(wire(lower(builder)));
  });

  test('a __shape that does not extend the declared value shape is rejected', () => {
    const json = {
      v: 1,
      op: 'create',
      shape: Person.shape.id,
      data: {__id: 'x:carl', name: 'Carl', bestFriend: {__shape: PathNode.shape.id, inversePath: {'@id': `${X}p`}}},
    };
    expect(() => lowerMutationJSON(json as any)).toThrow();
    expect(() => lower(fromJSON(json as any) as any)).toThrow();
  });
});
