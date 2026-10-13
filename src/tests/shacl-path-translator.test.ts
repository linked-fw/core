/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {objectProperty} from '../shapes/SHACL';
import {serializePathToNodeData} from '../shapes/serializePathToNodeData';
import {createToSparql} from '../sparql/irToAlgebra';
import '../ontologies/rdf';
import {shacl} from '../ontologies/shacl';
import {lower} from '../queries/lower';
import {PathList} from '../shapes/PathList';
import {PathNode} from '../shapes/PathNode';

const {linkedShape} = linkedPackage('path-translator-test');
const B = 'https://example.org/ps';

// Holder with a polymorphic (no valueShape) blank-capable property, like `PropertyShape.path`,
// so any path node-data fits and is written as blank nodes.
@linkedShape
class PHolder extends Shape {
  static targetClass = {id: 'https://example.org/p#PHolder'} as any;

  @objectProperty({path: {id: 'https://example.org/p#path'}, maxCount: 1, nodeKind: shacl.BlankNodeOrIRI})
  get p(): unknown {
    return null;
  }
}

// The same slot without a blank-capable nodeKind: the property, not the node-data, decides.
@linkedShape
class PIriHolder extends Shape {
  static targetClass = {id: 'https://example.org/p#PIriHolder'} as any;

  @objectProperty({path: {id: 'https://example.org/p#path'}, maxCount: 1})
  get p(): unknown {
    return null;
  }
}

const sparql = (path: any) =>
  createToSparql(
    lower((PHolder.create({p: serializePathToNodeData(path, B)}) as any)
      .withId('https://example.org/h')
      ) as any,
  );

describe('serializePathToNodeData', () => {
  test('simple PathRef → {id}', () => {
    expect(serializePathToNodeData({id: 'http://ex.org/a'}, B)).toEqual({id: 'http://ex.org/a'});
  });

  test('sequence → rdf:List of segments', () => {
    const s = sparql({seq: [{id: 'http://ex.org/a'}, {id: 'http://ex.org/b'}]});
    expect(s).toContain('rdf:first <http://ex.org/a>');
    expect(s).toContain('rdf:first <http://ex.org/b>');
    expect(s).toContain('rdf:rest');
    expect(s).toContain('rdf:nil');
  });

  test('inverse → an untyped blank node with exactly one triple (SHACL §2.3.1.3)', () => {
    const s = sparql({inv: {id: 'http://ex.org/parent'}});
    expect(s).toContain('<https://example.org/h> <https://example.org/p#path> _:b0 .');
    expect(s).toContain('_:b0 shacl:inversePath <http://ex.org/parent> .');
    // Only the triples the SHACL syntax defines: no type, no minted IRI.
    expect(s).not.toContain('core:PathNode');
    expect(s.match(/^\s*_:b0 /gm)).toHaveLength(1);
    expect(s).not.toMatch(/pathnode_|\/inv>/);
  });

  test('sequence → blank list cells with only rdf:first / rdf:rest', () => {
    const s = sparql({seq: [{id: 'http://ex.org/a'}, {inv: {id: 'http://ex.org/b'}}]});
    expect(s).toContain('<https://example.org/h> <https://example.org/p#path> _:b0 .');
    expect(s).toContain('_:b0 rdf:first <http://ex.org/a> .');
    expect(s).toContain('_:b0 rdf:rest _:b1 .');
    expect(s).toContain('_:b1 rdf:first _:b2 .');
    expect(s).toContain('_:b2 shacl:inversePath <http://ex.org/b> .');
    expect(s).toContain('_:b1 rdf:rest rdf:nil .');
    expect(s).not.toContain('rdf:List');
    // The only IRI subject is the holder itself.
    expect(s.match(/^\s*<[^>]+> /gm)).toHaveLength(2);
  });

  test('the serialized node-data carries no ids or markers: PathNode operators, PathList cells', () => {
    const data = serializePathToNodeData({alt: [{id: 'http://ex.org/a'}, {zeroOrMore: {id: 'http://ex.org/b'}}]}) as any;
    expect(data).toMatchObject({shape: PathNode, alternativePath: {shape: PathList, first: {id: 'http://ex.org/a'}}});
    expect(data.alternativePath.rest).toMatchObject({shape: PathList, first: {shape: PathNode, zeroOrMorePath: {id: 'http://ex.org/b'}}});
    expect(JSON.stringify(data)).not.toMatch(/__id|__blank/);
  });

  test('under a property that is not blank-capable the same node-data is written as IRIs', () => {
    const s = createToSparql(
      lower((PIriHolder.create({p: serializePathToNodeData({inv: {id: 'http://ex.org/parent'}})}) as any)
        .withId('https://example.org/h2')) as any,
    );
    expect(s).not.toContain('_:');
    expect(s).toContain('rdf:type core:PathNode');
    // The PathNode slot is blank-capable, but its operand is a predicate reference: an IRI.
    expect(s).toMatch(/> shacl:inversePath <http:\/\/ex\.org\/parent> \./);
  });

  test('alternative → PathNode with sh:alternativePath → rdf:List', () => {
    const s = sparql({alt: [{id: 'http://ex.org/a'}, {id: 'http://ex.org/b'}]});
    expect(s).toContain('shacl:alternativePath');
    expect(s).toContain('rdf:first <http://ex.org/a>');
  });

  test('zeroOrMore → PathNode with sh:zeroOrMorePath', () => {
    const s = sparql({zeroOrMore: {id: 'http://ex.org/a'}});
    expect(s).toContain('shacl:zeroOrMorePath <http://ex.org/a>');
  });

  test('nested inverse-of-sequence → PathNode.inversePath → rdf:List', () => {
    const s = sparql({inv: {seq: [{id: 'http://ex.org/a'}, {id: 'http://ex.org/b'}]}});
    expect(s).toContain('shacl:inversePath');
    expect(s).toContain('rdf:first <http://ex.org/a>');
    expect(s).toContain('rdf:rest');
  });

  test('negatedPropertySet throws', () => {
    expect(() =>
      serializePathToNodeData({negatedPropertySet: [{id: 'http://ex.org/a'}]} as any, B),
    ).toThrow(/negatedPropertySet/);
  });

  // SHACL requires a sequence/alternative to be a list of ≥2 members. A degenerate
  // 1-member path collapses to the bare member (a valid single-predicate path);
  // an empty one is rejected. (Unreachable via normalizePropertyPath, which
  // collapses upstream — this pins the serializer's independent spec-correctness.)
  test('1-member sequence collapses to the bare member (not a 1-element list)', () => {
    expect(serializePathToNodeData({seq: [{id: 'http://ex.org/a'}]} as any, B)).toEqual({
      id: 'http://ex.org/a',
    });
  });

  test('1-member alternative collapses to the bare member', () => {
    expect(serializePathToNodeData({alt: [{id: 'http://ex.org/a'}]} as any, B)).toEqual({
      id: 'http://ex.org/a',
    });
  });

  test('empty sequence / alternative throws', () => {
    expect(() => serializePathToNodeData({seq: []} as any, B)).toThrow(/empty sequence/);
    expect(() => serializePathToNodeData({alt: []} as any, B)).toThrow(/empty alternative/);
  });
});
