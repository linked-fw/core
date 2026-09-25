import {describe, expect, test} from '@jest/globals';
import {ExpressionNode, toIRExpression} from '../expressions/ExpressionNode';
import type {IRExpression} from '../queries/IntermediateRepresentation';

const prop: IRExpression = {
  kind: 'property_expr',
  sourceAlias: 'a0',
  property: 'age',
};

function node(ir?: IRExpression): ExpressionNode {
  return new ExpressionNode(ir ?? prop);
}

describe('ExpressionNode', () => {
  // -------------------------------------------------------------------------
  // toIRExpression normalization
  // -------------------------------------------------------------------------

  describe('toIRExpression', () => {
    test('string → literal_expr', () => {
      expect(toIRExpression('hello')).toEqual({kind: 'literal_expr', value: 'hello'});
    });

    test('number → literal_expr', () => {
      expect(toIRExpression(42)).toEqual({kind: 'literal_expr', value: 42});
    });

    test('boolean → literal_expr', () => {
      expect(toIRExpression(true)).toEqual({kind: 'literal_expr', value: true});
    });

    /**
     * The Date survives as a Date. It used to be flattened to its ISO string here,
     * which left the SPARQL layer unable to tell a timestamp from any other string
     * — so it emitted an untyped literal that never equalled the `^^xsd:dateTime`
     * term the mutation side writes. See `date-filter-datatype.test.ts`.
     */
    test('Date → literal_expr keeping the Date', () => {
      const d = new Date('2024-01-15T00:00:00.000Z');
      expect(toIRExpression(d)).toEqual({kind: 'literal_expr', value: d});
      expect((toIRExpression(d) as {value: unknown}).value).toBeInstanceOf(Date);
    });

    test('ExpressionNode → extracts .ir', () => {
      const n = node();
      expect(toIRExpression(n)).toBe(prop);
    });
  });

  // -------------------------------------------------------------------------
  // Arithmetic
  // -------------------------------------------------------------------------

  describe('arithmetic', () => {
    test('plus', () => {
      const result = node().plus(1);
      expect(result.ir).toEqual({
        kind: 'binary_expr',
        operator: '+',
        left: prop,
        right: {kind: 'literal_expr', value: 1},
      });
    });

    test('minus', () => {
      expect(node().minus(5).ir.kind).toBe('binary_expr');
      expect((node().minus(5).ir as any).operator).toBe('-');
    });

    test('times', () => {
      expect((node().times(12).ir as any).operator).toBe('*');
    });

    test('divide', () => {
      expect((node().divide(2).ir as any).operator).toBe('/');
    });

    test('abs', () => {
      expect(node().abs().ir).toEqual({
        kind: 'function_expr',
        name: 'ABS',
        args: [prop],
      });
    });

    test('round', () => {
      expect((node().round().ir as any).name).toBe('ROUND');
    });

    test('ceil', () => {
      expect((node().ceil().ir as any).name).toBe('CEIL');
    });

    test('floor', () => {
      expect((node().floor().ir as any).name).toBe('FLOOR');
    });

    test('power(1) returns identity', () => {
      const result = node().power(1);
      expect(result.ir).toBe(prop);
    });

    test('power(3) produces nested multiplication', () => {
      const result = node().power(3);
      // (prop * prop) * prop
      expect(result.ir).toEqual({
        kind: 'binary_expr',
        operator: '*',
        left: {
          kind: 'binary_expr',
          operator: '*',
          left: prop,
          right: prop,
        },
        right: prop,
      });
    });

    test('power(20) succeeds', () => {
      expect(() => node().power(20)).not.toThrow();
    });

    test('power(21) throws', () => {
      expect(() => node().power(21)).toThrow('≤ 20');
    });

    test('power(0) throws', () => {
      expect(() => node().power(0)).toThrow('positive integer');
    });

    test('power(-1) throws', () => {
      expect(() => node().power(-1)).toThrow('positive integer');
    });

    test('power(2.5) throws', () => {
      expect(() => node().power(2.5)).toThrow('positive integer');
    });
  });

  // -------------------------------------------------------------------------
  // Comparison
  // -------------------------------------------------------------------------

  describe('comparison', () => {
    test('eq', () => {
      expect((node().eq(30).ir as any).operator).toBe('=');
    });

    test('equals is alias for eq', () => {
      const a = node().eq(30);
      const b = node().equals(30);
      expect(a.ir).toEqual(b.ir);
    });

    test('neq / notEquals', () => {
      expect((node().neq(0).ir as any).operator).toBe('!=');
      expect(node().neq(0).ir).toEqual(node().notEquals(0).ir);
    });

    test('gt / greaterThan', () => {
      expect((node().gt(18).ir as any).operator).toBe('>');
      expect(node().gt(18).ir).toEqual(node().greaterThan(18).ir);
    });

    test('gte / greaterThanOrEqual', () => {
      expect((node().gte(18).ir as any).operator).toBe('>=');
      expect(node().gte(18).ir).toEqual(node().greaterThanOrEqual(18).ir);
    });

    test('lt / lessThan', () => {
      expect((node().lt(65).ir as any).operator).toBe('<');
      expect(node().lt(65).ir).toEqual(node().lessThan(65).ir);
    });

    test('lte / lessThanOrEqual', () => {
      expect((node().lte(65).ir as any).operator).toBe('<=');
      expect(node().lte(65).ir).toEqual(node().lessThanOrEqual(65).ir);
    });
  });

  // -------------------------------------------------------------------------
  // String
  // -------------------------------------------------------------------------

  describe('string', () => {
    const strProp: IRExpression = {kind: 'property_expr', sourceAlias: 'a0', property: 'name'};
    const strNode = () => node(strProp);

    test('concat', () => {
      const result = strNode().concat(' ', 'suffix');
      expect(result.ir).toEqual({
        kind: 'function_expr',
        name: 'CONCAT',
        args: [strProp, {kind: 'literal_expr', value: ' '}, {kind: 'literal_expr', value: 'suffix'}],
      });
    });

    test('contains', () => {
      expect((strNode().contains('foo').ir as any).name).toBe('CONTAINS');
    });

    test('startsWith', () => {
      expect((strNode().startsWith('A').ir as any).name).toBe('STRSTARTS');
    });

    test('endsWith', () => {
      expect((strNode().endsWith('z').ir as any).name).toBe('STRENDS');
    });

    test('substr without length', () => {
      const result = strNode().substr(1);
      expect(result.ir).toEqual({
        kind: 'function_expr',
        name: 'SUBSTR',
        args: [strProp, {kind: 'literal_expr', value: 1}],
      });
    });

    test('substr with length', () => {
      const result = strNode().substr(1, 5);
      expect((result.ir as any).args).toHaveLength(3);
    });

    test('before', () => {
      expect((strNode().before('@').ir as any).name).toBe('STRBEFORE');
    });

    test('after', () => {
      expect((strNode().after('@').ir as any).name).toBe('STRAFTER');
    });

    test('replace without flags', () => {
      const result = strNode().replace('old', 'new');
      expect((result.ir as any).name).toBe('REPLACE');
      expect((result.ir as any).args).toHaveLength(3);
    });

    test('replace with flags', () => {
      const result = strNode().replace('old', 'new', 'i');
      expect((result.ir as any).args).toHaveLength(4);
    });

    test('replace with invalid flag throws', () => {
      expect(() => strNode().replace('a', 'b', 'x')).toThrow('Unsupported regex flag');
    });

    test('ucase', () => {
      expect((strNode().ucase().ir as any).name).toBe('UCASE');
    });

    test('lcase', () => {
      expect((strNode().lcase().ir as any).name).toBe('LCASE');
    });

    test('strlen', () => {
      expect((strNode().strlen().ir as any).name).toBe('STRLEN');
    });

    test('encodeForUri', () => {
      expect((strNode().encodeForUri().ir as any).name).toBe('ENCODE_FOR_URI');
    });

    test('matches without flags', () => {
      const result = strNode().matches('^A.*');
      expect(result.ir).toEqual({
        kind: 'function_expr',
        name: 'REGEX',
        args: [strProp, {kind: 'literal_expr', value: '^A.*'}],
      });
    });

    test('matches with flags', () => {
      const result = strNode().matches('^A', 'ims');
      expect((result.ir as any).args).toHaveLength(3);
    });

    test('matches with invalid flag throws', () => {
      expect(() => strNode().matches('a', 'g')).toThrow('Unsupported regex flag');
    });
  });

  // -------------------------------------------------------------------------
  // Date/Time
  // -------------------------------------------------------------------------

  describe('date/time', () => {
    const dateProp: IRExpression = {kind: 'property_expr', sourceAlias: 'a0', property: 'created'};
    const dateNode = () => node(dateProp);

    test.each([
      ['year', 'YEAR'],
      ['month', 'MONTH'],
      ['day', 'DAY'],
      ['hours', 'HOURS'],
      ['minutes', 'MINUTES'],
      ['seconds', 'SECONDS'],
      ['timezone', 'TIMEZONE'],
      ['tz', 'TZ'],
    ] as [string, string][])('%s → %s', (method, sparqlName) => {
      const result = (dateNode() as any)[method]();
      expect(result.ir).toEqual({
        kind: 'function_expr',
        name: sparqlName,
        args: [dateProp],
      });
    });
  });

  // -------------------------------------------------------------------------
  // Logical
  // -------------------------------------------------------------------------

  describe('logical', () => {
    test('and', () => {
      const a = node().gt(10);
      const result = a.and(node().lt(20));
      expect(result.ir.kind).toBe('logical_expr');
      expect((result.ir as any).operator).toBe('and');
    });

    test('or', () => {
      const result = node().eq(1).or(node().eq(2));
      expect((result.ir as any).operator).toBe('or');
    });

    test('not', () => {
      const result = node().gt(10).not();
      expect(result.ir.kind).toBe('not_expr');
    });
  });

  // -------------------------------------------------------------------------
  // Null-handling
  // -------------------------------------------------------------------------

  describe('null-handling', () => {
    test('isDefined', () => {
      expect(node().isDefined().ir).toEqual({
        kind: 'function_expr',
        name: 'BOUND',
        args: [prop],
      });
    });

    test('isNotDefined', () => {
      const result = node().isNotDefined();
      expect(result.ir).toEqual({
        kind: 'not_expr',
        expression: {kind: 'function_expr', name: 'BOUND', args: [prop]},
      });
    });

    test('defaultTo', () => {
      const result = node().defaultTo(0);
      expect(result.ir).toEqual({
        kind: 'function_expr',
        name: 'COALESCE',
        args: [prop, {kind: 'literal_expr', value: 0}],
      });
    });
  });

  // -------------------------------------------------------------------------
  // RDF introspection / type casting / hash
  // -------------------------------------------------------------------------

  describe('rdf/type/hash', () => {
    test.each([
      ['lang', 'LANG'],
      ['datatype', 'DATATYPE'],
      ['str', 'STR'],
      ['iri', 'IRI'],
      ['isIri', 'isIRI'],
      ['isLiteral', 'isLiteral'],
      ['isBlank', 'isBlank'],
      ['isNumeric', 'isNumeric'],
      ['md5', 'MD5'],
      ['sha256', 'SHA256'],
      ['sha512', 'SHA512'],
    ] as [string, string][])('%s → %s', (method, sparqlName) => {
      const result = (node() as any)[method]();
      expect(result.ir).toEqual({
        kind: 'function_expr',
        name: sparqlName,
        args: [prop],
      });
    });
  });

  // -------------------------------------------------------------------------
  // Chaining
  // -------------------------------------------------------------------------

  describe('chaining', () => {
    test('plus then times (left-to-right)', () => {
      const result = node().plus(1).times(2);
      expect(result.ir).toEqual({
        kind: 'binary_expr',
        operator: '*',
        left: {
          kind: 'binary_expr',
          operator: '+',
          left: prop,
          right: {kind: 'literal_expr', value: 1},
        },
        right: {kind: 'literal_expr', value: 2},
      });
    });

    test('strlen then gt (string → numeric → boolean)', () => {
      const strProp: IRExpression = {kind: 'property_expr', sourceAlias: 'a0', property: 'name'};
      const result = node(strProp).strlen().gt(5);
      expect(result.ir).toEqual({
        kind: 'binary_expr',
        operator: '>',
        left: {kind: 'function_expr', name: 'STRLEN', args: [strProp]},
        right: {kind: 'literal_expr', value: 5},
      });
    });

    test('immutability — each call returns new instance', () => {
      const a = node();
      const b = a.plus(1);
      const c = a.plus(2);
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(a.ir).toBe(prop);
    });
  });
});
