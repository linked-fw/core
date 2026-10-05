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
import '../ontologies/shacl';
import {lower} from '../queries/lower';

const {linkedShape} = linkedPackage('path-translator-test');
const B = 'https://example.org/ps';

// Holder with a polymorphic (no valueShape) object property so any path node-data fits.
@linkedShape
class PHolder extends Shape {
  static targetClass = {id: 'https://example.org/p#PHolder'} as any;

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

  test('inverse → PathNode with sh:inversePath', () => {
    const s = sparql({inv: {id: 'http://ex.org/parent'}});
    expect(s).toContain('shacl:inversePath <http://ex.org/parent>');
    expect(s).toContain('core:PathNode');
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
