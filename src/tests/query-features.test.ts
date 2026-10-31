/**
 * Query features beyond the baseline (`queries/queryFeatures.ts`): a store declares what it
 * answers in `supports`, a query that needs more is refused before it is sent, and a wire
 * envelope that requires a feature this build does not know is refused when read.
 */
import {describe, expect, test} from '@jest/globals';
import {
  ALL_QUERY_FEATURES,
  featuresOfExpressions,
  parseRequires,
} from '../queries/queryFeatures';
import {assertQuerySupported} from '../queries/queryDispatch';
import {fromJSON} from '../queries/fromJSON';
import {WIRE_VERSION} from '../queries/wireVersion';
import type {IRExpression} from '../queries/IntermediateRepresentation';
import {Person} from '../test-helpers/query-fixtures';
import '../ontologies/rdf';
import '../ontologies/xsd';

const grouped = {requiredFeatures: () => ['groupBy' as const]};

describe('assertQuerySupported', () => {
  test('a baseline query passes any target, even one without `supports`', () => {
    expect(() => assertQuerySupported({}, {requiredFeatures: () => []})).not.toThrow();
    expect(() => assertQuerySupported(undefined, {})).not.toThrow();
  });

  test('a target without `supports` is refused a grouped query, naming the feature', () => {
    class LegacyStore {}
    expect(() => assertQuerySupported(new LegacyStore(), grouped)).toThrow(
      /uses 'groupBy', which the dataset it was sent to \(LegacyStore\) does not declare in `supports`/,
    );
  });

  test('a target that declares the feature passes', () => {
    expect(() => assertQuerySupported({supports: ['groupBy']}, grouped)).not.toThrow();
    expect(() => assertQuerySupported({supports: ALL_QUERY_FEATURES}, grouped)).not.toThrow();
  });

  test('only the missing features are named', () => {
    expect(() =>
      assertQuerySupported({supports: ['groupBy']}, {requiredFeatures: () => ['groupBy', 'max']}),
    ).toThrow(/uses 'max', which/);
  });
});

describe('featuresOfExpressions', () => {
  test('min and max are features; a count is baseline', () => {
    const max: IRExpression = {kind: 'aggregate_expr', name: 'max', args: []};
    const count: IRExpression = {kind: 'aggregate_expr', name: 'count', args: []};
    expect(featuresOfExpressions([max, count])).toEqual(['max']);
    expect(featuresOfExpressions([count])).toEqual([]);
    expect(featuresOfExpressions([], true)).toEqual(['groupBy']);
  });

  test('an aggregate nested in a comparison is found', () => {
    const having: IRExpression = {
      kind: 'binary_expr',
      operator: '>',
      left: {kind: 'aggregate_expr', name: 'min', args: []},
      right: {kind: 'literal_expr', value: 1},
    };
    expect(featuresOfExpressions([having])).toEqual(['min']);
  });
});

describe('requires on the wire', () => {
  test('known features parse, unknown ones throw', () => {
    expect(parseRequires(undefined)).toEqual([]);
    expect(parseRequires(['groupBy', 'max'])).toEqual(['groupBy', 'max']);
    expect(() => parseRequires(['windowFunctions'])).toThrow(
      /requires the feature "windowFunctions", which this build of @_linked\/core does not know/,
    );
    expect(() => parseRequires('groupBy')).toThrow(/must be an array/);
  });

  test("fromJSON reads `op: 'select'` as a select and refuses an unknown requirement", () => {
    const base = {v: WIRE_VERSION, shape: Person.shape.id, fields: ['name']};
    expect(fromJSON({...base, op: 'select', requires: []} as never).__queryKind).toBe('select');
    expect(() => fromJSON({...base, op: 'select', requires: ['pivot']} as never)).toThrow(
      /does not know/,
    );
  });
});
