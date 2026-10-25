/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import '../utils/Package';
import '../ontologies/rdf';
import {Prefix} from '../utils/Prefix';
import {pathExprToSparql, collectPathUris} from '../paths/pathExprToSparql';
import {parsePropertyPath, type PathExpr} from '../paths/PropertyPathExpr';
import {normalizePropertyPath} from '../paths/normalizePropertyPath';
import {
  assertSafePropertyPath,
  InvalidPropertyPathError,
  isPrefixedNameToken,
} from '../paths/propertyPathSafety';
import {fromWire, type NodeShapeWire} from '../shapes/nodeShapeWire';
import {ShapeCatalog} from '../utils/ShapeCatalog';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';
import type {NodeShapeData} from '../shapes/nodeShapeData';
import {isLinkedError} from '../utils/linkedError';

// Backlog 008 (SEC4): a string path step that is not one prefixed-name token used to reach the
// query text verbatim, so a stored `sh:path` step could add patterns to a query.

Prefix.add('ex', 'http://ex.test/');

/** Payloads from the investigation: each one, written verbatim, changes the query. */
const INJECTIONS = [
  'rdf:type?o.?s?p?o.FILTER(true)#',
  'rdf:type ?o . ?s ?p ?o . FILTER(true) #',
  'foo ; DROP',
  'ex:a} ; DROP ALL ; INSERT DATA { <http://x/s> <http://x/p> 1 } #',
  'ex:a>/<http://x/b',
  'ex:a.FILTER(1)',
  '?s',
  'ex:name\n?s ?p ?o',
];

describe('SEC4 — path steps are never written verbatim', () => {
  test.each(INJECTIONS)('%j is written inside angle brackets or refused', (payload) => {
    for (const expr of [
      payload,
      {seq: ['ex:a', payload]},
      {alt: [payload, 'ex:b']},
      {inv: payload},
      {zeroOrMore: payload},
      {negatedPropertySet: [payload]},
      {negatedPropertySet: [{inv: payload}]},
    ] as PathExpr[]) {
      let sparql: string;
      try {
        sparql = pathExprToSparql(expr);
      } catch (error) {
        expect(String(error)).toMatch(/Invalid IRI/);
        continue;
      }
      expect(sparql).toContain(`<${payload}>`);
    }
  });

  test('the investigation payload becomes one IRI, not extra patterns', () => {
    expect(pathExprToSparql({seq: ['rdf:type?o.?s?p?o.FILTER(true)#', 'ex:b']})).toBe(
      '<rdf:type?o.?s?p?o.FILTER(true)#>/ex:b',
    );
  });

  test('a registered prefixed name is still written short', () => {
    expect(pathExprToSparql({seq: ['rdf:type', 'ex:b']})).toBe('rdf:type/ex:b');
    expect(pathExprToSparql('ex:')).toBe('ex:');
  });

  test('a prefixed name whose prefix is not registered is written as an IRI', () => {
    expect(pathExprToSparql({seq: ['nope:a', 'ex:b']})).toBe('<nope:a>/ex:b');
  });

  test('a short form with a registered prefix declares its PREFIX', () => {
    expect(collectPathUris({seq: ['ex:a', 'rdf:type']})).toEqual([
      'http://ex.test/a',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    ]);
  });
});

describe('SEC4 — a urn: step in a complex path', () => {
  test('a string urn: step is an IRI, not a prefixed name', () => {
    expect(pathExprToSparql({seq: ['urn:prop:a', 'ex:b']})).toBe('<urn:prop:a>/ex:b');
    expect(collectPathUris({seq: ['urn:prop:a', 'ex:b']})).toEqual(['urn:prop:a', 'http://ex.test/b']);
  });

  test('the parser keeps the brackets of <urn:…> as an {id} step', () => {
    expect(parsePropertyPath('<urn:prop:a>/ex:b')).toEqual({seq: [{id: 'urn:prop:a'}, 'ex:b']});
    expect(pathExprToSparql(parsePropertyPath('<urn:prop:a>/ex:b'))).toBe('<urn:prop:a>/ex:b');
    expect(pathExprToSparql(normalizePropertyPath('^<urn:prop:a>'))).toBe('^<urn:prop:a>');
  });

  test('a hierarchical bracketed IRI is still a string step', () => {
    expect(parsePropertyPath('<http://x.test/a>/ex:b')).toEqual({seq: ['http://x.test/a', 'ex:b']});
  });
});

describe('SEC4 — the prefixed-name grammar', () => {
  test.each(['ex:name', 'ex:', ':name', 'ex:a.b', 'ex:a:b', 'ex:1', 'ex:a%20b', 'ex-1.x:é'])(
    '%j is one token',
    (value) => expect(isPrefixedNameToken(value)).toBe(true),
  );
  test.each([...INJECTIONS, 'ex:a.', '1ex:a', 'ex:a\\;b', 'ex:a%2', 'http://x/a', 'name', ''])(
    '%j is not one token',
    (value) => expect(isPrefixedNameToken(value)).toBe(false),
  );
});

const badPath = (): PathExpr => ({seq: ['ex:a', 'rdf:type?o.?s?p?o.FILTER(true)#']});

const shapeWith = (path: PathExpr, id = 'http://ex.test/shape/Bad'): NodeShapeData =>
  ({
    id,
    label: 'Bad',
    propertyShapes: [{id: `${id}/p`, label: 'p', path}],
  }) as unknown as NodeShapeData;

describe('SEC4 — a bad stored path fails when the shape is loaded', () => {
  test.each(INJECTIONS)('assertSafePropertyPath refuses %j', (payload) => {
    expect(() => assertSafePropertyPath({seq: ['ex:a', payload]})).toThrow(InvalidPropertyPathError);
  });

  test('a structured decorator path is checked', () => {
    expect(() => normalizePropertyPath(badPath())).toThrow(InvalidPropertyPathError);
    expect(() => normalizePropertyPath(['ex:a', 'foo ; DROP'])).toThrow(InvalidPropertyPathError);
  });

  test('a parsed step that is not a prefixed name is an IRI, written in brackets', () => {
    // `ex:a;DROP` is an absolute IRI with the scheme `ex`, so it loads, and is never verbatim.
    expect(pathExprToSparql(normalizePropertyPath('ex:a;DROP/ex:b'))).toBe('<ex:a;DROP>/ex:b');
  });

  test('fromWire refuses it, naming the property shape', () => {
    const wire = shapeWith(badPath()) as unknown as NodeShapeWire;
    let caught: unknown;
    try {
      fromWire(wire);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidPropertyPathError);
    expect(isLinkedError(caught, InvalidPropertyPathError)).toBe(true);
    expect((caught as InvalidPropertyPathError).propertyShape).toBe('http://ex.test/shape/Bad/p');
    expect((caught as InvalidPropertyPathError).step).toBe('rdf:type?o.?s?p?o.FILTER(true)#');
  });

  test('ShapeCatalog.from refuses it, as wire and as shape data', () => {
    expect(() => ShapeCatalog.from([shapeWith(badPath()) as unknown as NodeShapeWire])).toThrow(
      InvalidPropertyPathError,
    );
    const data = shapeWith(badPath());
    data.propertyShapes[0].parentNodeShape = data;
    expect(() => ShapeCatalog.from([data])).toThrow(InvalidPropertyPathError);
  });

  test('registerRuntimeShape refuses it', () => {
    expect(() =>
      registerRuntimeShape(shapeWith(badPath(), 'http://ex.test/shape/Bad2') as unknown as NodeShapeWire),
    ).toThrow(InvalidPropertyPathError);
  });

  test('a bad sortBy is refused too', () => {
    const wire = shapeWith('ex:a');
    (wire.propertyShapes[0] as {sortBy?: PathExpr}).sortBy = {inv: '?s'};
    expect(() => fromWire(wire as unknown as NodeShapeWire)).toThrow(InvalidPropertyPathError);
  });

  test('good paths load', () => {
    for (const path of [
      'ex:a',
      'https://schema.org/name',
      'urn:prop:a',
      {id: 'urn:prop:a'},
      {id: 'mailto:a@b.test'},
      {seq: ['ex:a', {id: 'urn:prop:a'}, 'https://schema.org/name']},
      {negatedPropertySet: ['ex:a', {inv: {id: 'urn:x:b'}}]},
      {id: undefined} as unknown as PathExpr,
    ] as PathExpr[]) {
      expect(() => fromWire(shapeWith(path) as unknown as NodeShapeWire)).not.toThrow();
    }
    expect(() => normalizePropertyPath('<mailto:a@b.test>/ex:a')).not.toThrow();
  });
});
