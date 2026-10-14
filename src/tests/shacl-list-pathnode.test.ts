/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import {getPropertyShape} from '../shapes/SHACL';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {objectProperty} from '../shapes/SHACL';
import {List, rdfList} from '../shapes/List';
import {PathNode} from '../shapes/PathNode';
import {shacl} from '../ontologies/shacl';
import {createToSparql} from '../sparql/irToAlgebra';
import '../ontologies/rdf';
import {lower} from '../queries/lower';

const {linkedShape} = linkedPackage('list-test');
const prop = (n: string) => ({id: `https://example.org/list#${n}`});

@linkedShape
class Holder extends Shape {
  static targetClass = {id: 'https://example.org/list#Holder'} as any;

  @objectProperty({path: prop('items'), shape: List, maxCount: 1})
  get items(): List {
    return null;
  }
}

const sparqlFor = (items: unknown[], opts?: {base?: string}) =>
  createToSparql(
    lower((Holder.create({items: rdfList(items, opts)}) as any).withId('https://example.org/h')) as any,
  );

describe('List / PathNode / rdfList', () => {
  test('rdfList two items → ordered first/rest/nil chain', () => {
    const sparql = sparqlFor(['a', 'b']);
    expect(sparql).toContain('rdf:first "a"');
    expect(sparql).toContain('rdf:first "b"');
    expect(sparql).toContain('rdf:rest');
    expect(sparql).toContain('rdf:nil');
    // each cell typed as rdf:List (plus Holder's own type) → 3 rdf:type triples
    expect((sparql.match(/rdf:type/g) || []).length).toBe(3);
  });

  test('rdfList deterministic ids when base given', () => {
    const sparql = sparqlFor(['a', 'b'], {base: 'https://example.org/h/in'});
    expect(sparql).toContain('<https://example.org/h/in/0>');
    expect(sparql).toContain('<https://example.org/h/in/1>');
    expect(sparql).toContain('<https://example.org/h/in/0> rdf:rest <https://example.org/h/in/1>');
  });

  test('rdfList IRIs serialize as IRI terms, not literals', () => {
    const sparql = sparqlFor([{id: 'http://ex.org/A'}, {id: 'http://ex.org/B'}]);
    expect(sparql).toContain('rdf:first <http://ex.org/A>');
    expect(sparql).toContain('rdf:first <http://ex.org/B>');
  });

  test('empty rdfList is rdf:nil', () => {
    const sparql = sparqlFor([]);
    expect(sparql).toContain('rdf:nil');
    expect(sparql).not.toContain('rdf:first');
  });

  test('List: rest is contains; first is not', () => {
    expect(getPropertyShape(List.shape, 'rest', false).contains).toBe(true);
    expect(getPropertyShape(List.shape, 'first', false).contains).toBeFalsy();
  });

  test('PathNode: only alternativePath (value shape PathList) is contains; every slot is blank-capable', () => {
    expect(getPropertyShape(PathNode.shape, 'alternativePath', false).contains).toBe(true);
    for (const op of ['inversePath', 'zeroOrMorePath', 'oneOrMorePath', 'zeroOrOnePath']) {
      expect(getPropertyShape(PathNode.shape, op, false).contains).toBeFalsy();
    }
    for (const op of ['inversePath', 'alternativePath', 'zeroOrMorePath', 'oneOrMorePath', 'zeroOrOnePath']) {
      expect(getPropertyShape(PathNode.shape, op, false).nodeKind?.id).toBe(shacl.BlankNodeOrIRI.id);
    }
  });
});
