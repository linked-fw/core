import type {
  IRBinaryOperator,
  IRExpression,
} from '../queries/IntermediateRepresentation.js';
import {PendingQueryContext} from '../queries/QueryContext.js';

export type ExpressionInput = ExpressionNode | string | number | boolean | Date | PendingQueryContext;

/**
 * Map from placeholder sourceAlias → PropertyShapeData ID segments.
 * Used to track unresolved property references from proxy tracing
 * that need to be resolved during IR lowering.
 */
export type PropertyRefMap = ReadonlyMap<string, readonly string[]>;

const VALID_REGEX_FLAGS = new Set(['i', 'm', 's']);

function validateRegexFlags(flags: string | undefined): void {
  if (!flags) return;
  for (const ch of flags) {
    if (!VALID_REGEX_FLAGS.has(ch)) {
      throw new Error(
        `Unsupported regex flag "${ch}". Only "i", "m", "s" are supported.`,
      );
    }
  }
}

export function toIRExpression(input: ExpressionInput): IRExpression {
  if (input instanceof ExpressionNode) return input.ir;
  if (typeof input === 'string')
    return {kind: 'literal_expr', value: input};
  if (typeof input === 'number')
    return {kind: 'literal_expr', value: input};
  if (typeof input === 'boolean')
    return {kind: 'literal_expr', value: input};
  // The `Date` is carried through as a Date, NOT flattened to its ISO string.
  // `IRLiteralValue` admits one, and the SPARQL layer needs the JS type to know
  // it must emit a TYPED literal: a plain `"2020-01-01T00:00:00.000Z"` never
  // equals the `^^xsd:dateTime` term the mutation side writes, so flattening
  // here made every date comparison silently match nothing.
  if (input instanceof Date) return {kind: 'literal_expr', value: input};
  // A live query-context reference → carry the name; `lower()` resolves it.
  if (input instanceof PendingQueryContext)
    return {kind: 'reference_expr', contextName: input.contextName};
  if (typeof input === 'object' && input !== null && 'id' in input)
    return {kind: 'reference_expr', value: (input as {id: string}).id};
  throw new Error(`Invalid expression input: ${input}`);
}

function binary(
  op: IRBinaryOperator,
  left: IRExpression,
  right: ExpressionInput,
): IRExpression {
  return {kind: 'binary_expr', operator: op, left, right: toIRExpression(right)};
}

function fnExpr(name: string, ...args: IRExpression[]): IRExpression {
  return {kind: 'function_expr', name, args};
}

export class ExpressionNode {
  /** Property reference map for unresolved proxy-traced property references. */
  readonly _refs: PropertyRefMap;

  constructor(
    public readonly ir: IRExpression,
    refs?: PropertyRefMap,
  ) {
    this._refs = refs ?? new Map();
  }

  /** Create a derived node that merges refs from this and other inputs. */
  private _derive(ir: IRExpression, ...others: ExpressionInput[]): ExpressionNode {
    const merged = new Map(this._refs);
    for (const other of others) {
      if (other instanceof ExpressionNode) {
        for (const [k, v] of other._refs) merged.set(k, v);
      }
    }
    return new ExpressionNode(ir, merged);
  }

  /** Create a derived node with no additional inputs. */
  private _wrap(ir: IRExpression): ExpressionNode {
    return new ExpressionNode(ir, this._refs);
  }

  // ---------------------------------------------------------------------------
  // Arithmetic
  // ---------------------------------------------------------------------------

  plus(n: ExpressionInput): ExpressionNode {
    return this._derive(binary('+', this.ir, n), n);
  }

  minus(n: ExpressionInput): ExpressionNode {
    return this._derive(binary('-', this.ir, n), n);
  }

  times(n: ExpressionInput): ExpressionNode {
    return this._derive(binary('*', this.ir, n), n);
  }

  divide(n: ExpressionInput): ExpressionNode {
    return this._derive(binary('/', this.ir, n), n);
  }

  abs(): ExpressionNode {
    return this._wrap(fnExpr('ABS', this.ir));
  }

  round(): ExpressionNode {
    return this._wrap(fnExpr('ROUND', this.ir));
  }

  ceil(): ExpressionNode {
    return this._wrap(fnExpr('CEIL', this.ir));
  }

  floor(): ExpressionNode {
    return this._wrap(fnExpr('FLOOR', this.ir));
  }

  power(n: number): ExpressionNode {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `power() exponent must be a positive integer, got ${n}`,
      );
    }
    if (n > 20) {
      throw new Error(
        `power() exponent must be ≤ 20 to avoid query bloat, got ${n}`,
      );
    }
    if (n === 1) return new ExpressionNode(this.ir, this._refs);
    let result: IRExpression = this.ir;
    for (let i = 1; i < n; i++) {
      result = {kind: 'binary_expr', operator: '*', left: result, right: this.ir};
    }
    return new ExpressionNode(result, this._refs);
  }

  // ---------------------------------------------------------------------------
  // Comparison (short + long aliases)
  // ---------------------------------------------------------------------------

  eq(v: ExpressionInput): ExpressionNode {
    return this._derive(binary('=', this.ir, v), v);
  }
  equals(v: ExpressionInput): ExpressionNode {
    return this.eq(v);
  }

  neq(v: ExpressionInput): ExpressionNode {
    return this._derive(binary('!=', this.ir, v), v);
  }
  notEquals(v: ExpressionInput): ExpressionNode {
    return this.neq(v);
  }

  gt(v: ExpressionInput): ExpressionNode {
    return this._derive(binary('>', this.ir, v), v);
  }
  greaterThan(v: ExpressionInput): ExpressionNode {
    return this.gt(v);
  }

  gte(v: ExpressionInput): ExpressionNode {
    return this._derive(binary('>=', this.ir, v), v);
  }
  greaterThanOrEqual(v: ExpressionInput): ExpressionNode {
    return this.gte(v);
  }

  lt(v: ExpressionInput): ExpressionNode {
    return this._derive(binary('<', this.ir, v), v);
  }
  lessThan(v: ExpressionInput): ExpressionNode {
    return this.lt(v);
  }

  lte(v: ExpressionInput): ExpressionNode {
    return this._derive(binary('<=', this.ir, v), v);
  }
  lessThanOrEqual(v: ExpressionInput): ExpressionNode {
    return this.lte(v);
  }

  // ---------------------------------------------------------------------------
  // Membership — `value IN (…)` / `NOT IN (…)`
  // ---------------------------------------------------------------------------

  /** True when this value is one of `values` (SPARQL `IN`). Empty list → matches nothing. */
  oneOf(values: ExpressionInput[]): ExpressionNode {
    return this._derive(
      {kind: 'in_expr', negated: false, value: this.ir, source: {list: values.map(toIRExpression)}},
      ...values,
    );
  }
  /** True when this value is NOT one of `values` (SPARQL `NOT IN`). Empty list → matches everything. */
  notOneOf(values: ExpressionInput[]): ExpressionNode {
    return this._derive(
      {kind: 'in_expr', negated: true, value: this.ir, source: {list: values.map(toIRExpression)}},
      ...values,
    );
  }

  // ---------------------------------------------------------------------------
  // String
  // ---------------------------------------------------------------------------

  concat(...parts: ExpressionInput[]): ExpressionNode {
    return this._derive(
      fnExpr('CONCAT', this.ir, ...parts.map(toIRExpression)),
      ...parts,
    );
  }

  contains(s: ExpressionInput): ExpressionNode {
    return this._derive(fnExpr('CONTAINS', this.ir, toIRExpression(s)), s);
  }

  startsWith(s: ExpressionInput): ExpressionNode {
    return this._derive(fnExpr('STRSTARTS', this.ir, toIRExpression(s)), s);
  }

  endsWith(s: ExpressionInput): ExpressionNode {
    return this._derive(fnExpr('STRENDS', this.ir, toIRExpression(s)), s);
  }

  substr(start: number, len?: number): ExpressionNode {
    const args: IRExpression[] = [
      this.ir,
      {kind: 'literal_expr', value: start},
    ];
    if (len !== undefined) {
      args.push({kind: 'literal_expr', value: len});
    }
    return this._wrap(fnExpr('SUBSTR', ...args));
  }

  before(s: ExpressionInput): ExpressionNode {
    return this._derive(fnExpr('STRBEFORE', this.ir, toIRExpression(s)), s);
  }

  after(s: ExpressionInput): ExpressionNode {
    return this._derive(fnExpr('STRAFTER', this.ir, toIRExpression(s)), s);
  }

  replace(pat: string, rep: string, flags?: string): ExpressionNode {
    validateRegexFlags(flags);
    const args: IRExpression[] = [
      this.ir,
      {kind: 'literal_expr', value: pat},
      {kind: 'literal_expr', value: rep},
    ];
    if (flags) {
      args.push({kind: 'literal_expr', value: flags});
    }
    return this._wrap(fnExpr('REPLACE', ...args));
  }

  ucase(): ExpressionNode {
    return this._wrap(fnExpr('UCASE', this.ir));
  }

  lcase(): ExpressionNode {
    return this._wrap(fnExpr('LCASE', this.ir));
  }

  strlen(): ExpressionNode {
    return this._wrap(fnExpr('STRLEN', this.ir));
  }

  encodeForUri(): ExpressionNode {
    return this._wrap(fnExpr('ENCODE_FOR_URI', this.ir));
  }

  matches(pat: string, flags?: string): ExpressionNode {
    validateRegexFlags(flags);
    const args: IRExpression[] = [
      this.ir,
      {kind: 'literal_expr', value: pat},
    ];
    if (flags) {
      args.push({kind: 'literal_expr', value: flags});
    }
    return this._wrap(fnExpr('REGEX', ...args));
  }

  // ---------------------------------------------------------------------------
  // Date/Time
  // ---------------------------------------------------------------------------

  year(): ExpressionNode { return this._wrap(fnExpr('YEAR', this.ir)); }
  month(): ExpressionNode { return this._wrap(fnExpr('MONTH', this.ir)); }
  day(): ExpressionNode { return this._wrap(fnExpr('DAY', this.ir)); }
  hours(): ExpressionNode { return this._wrap(fnExpr('HOURS', this.ir)); }
  minutes(): ExpressionNode { return this._wrap(fnExpr('MINUTES', this.ir)); }
  seconds(): ExpressionNode { return this._wrap(fnExpr('SECONDS', this.ir)); }
  timezone(): ExpressionNode { return this._wrap(fnExpr('TIMEZONE', this.ir)); }
  tz(): ExpressionNode { return this._wrap(fnExpr('TZ', this.ir)); }

  // ---------------------------------------------------------------------------
  // Logical
  // ---------------------------------------------------------------------------

  and(expr: ExpressionInput): ExpressionNode {
    return this._derive({
      kind: 'logical_expr',
      operator: 'and',
      expressions: [this.ir, toIRExpression(expr)],
    }, expr);
  }

  or(expr: ExpressionInput): ExpressionNode {
    return this._derive({
      kind: 'logical_expr',
      operator: 'or',
      expressions: [this.ir, toIRExpression(expr)],
    }, expr);
  }

  not(): ExpressionNode {
    return this._wrap({kind: 'not_expr', expression: this.ir});
  }

  // ---------------------------------------------------------------------------
  // Null-handling
  // ---------------------------------------------------------------------------

  isDefined(): ExpressionNode {
    return this._wrap(fnExpr('BOUND', this.ir));
  }

  isNotDefined(): ExpressionNode {
    return this._wrap({
      kind: 'not_expr',
      expression: fnExpr('BOUND', this.ir),
    });
  }

  defaultTo(fallback: ExpressionInput): ExpressionNode {
    return this._derive(fnExpr('COALESCE', this.ir, toIRExpression(fallback)), fallback);
  }

  // ---------------------------------------------------------------------------
  // RDF introspection
  // ---------------------------------------------------------------------------

  lang(): ExpressionNode { return this._wrap(fnExpr('LANG', this.ir)); }
  datatype(): ExpressionNode { return this._wrap(fnExpr('DATATYPE', this.ir)); }

  // ---------------------------------------------------------------------------
  // Type casting / checking
  // ---------------------------------------------------------------------------

  str(): ExpressionNode { return this._wrap(fnExpr('STR', this.ir)); }
  iri(): ExpressionNode { return this._wrap(fnExpr('IRI', this.ir)); }
  isIri(): ExpressionNode { return this._wrap(fnExpr('isIRI', this.ir)); }
  isLiteral(): ExpressionNode { return this._wrap(fnExpr('isLiteral', this.ir)); }
  isBlank(): ExpressionNode { return this._wrap(fnExpr('isBlank', this.ir)); }
  isNumeric(): ExpressionNode { return this._wrap(fnExpr('isNumeric', this.ir)); }

  // ---------------------------------------------------------------------------
  // Hash
  // ---------------------------------------------------------------------------

  md5(): ExpressionNode { return this._wrap(fnExpr('MD5', this.ir)); }
  sha256(): ExpressionNode { return this._wrap(fnExpr('SHA256', this.ir)); }
  sha512(): ExpressionNode { return this._wrap(fnExpr('SHA512', this.ir)); }
}

// ---------------------------------------------------------------------------
// Proxy tracing helpers
// ---------------------------------------------------------------------------

let _refCounter = 0;

/**
 * Create an ExpressionNode from a proxy-traced property access.
 * Uses a placeholder sourceAlias that gets resolved during IR lowering.
 *
 * The segments array maps to a property path (e.g. ['bestFriend', 'name']).
 * Only the last segment becomes the property_expr's .property; earlier segments
 * are stored in the refs map and resolved as traversals during lowering.
 */
export function tracedPropertyExpression(
  segmentIds: readonly string[],
): ExpressionNode {
  const placeholder = `__ref_${_refCounter++}__`;
  const lastSegment = segmentIds[segmentIds.length - 1];
  const ir: IRExpression = {
    kind: 'property_expr',
    sourceAlias: placeholder,
    property: lastSegment,
  };
  const refs = new Map<string, readonly string[]>([[placeholder, segmentIds]]);
  return new ExpressionNode(ir, refs);
}

/**
 * Create a traced expression that resolves to an alias reference (the entity itself,
 * not a property on it). Used for root shape comparisons like `p.equals(entity)`.
 * The traversalSegmentIds are walked to resolve the alias, then the result is alias_expr.
 */
export function tracedAliasExpression(
  traversalSegmentIds: readonly string[],
): ExpressionNode {
  const placeholder = `__alias_ref_${_refCounter++}__`;
  const ir: IRExpression = {
    kind: 'alias_expr',
    alias: placeholder,
  };
  const refs = new Map<string, readonly string[]>([[placeholder, traversalSegmentIds]]);
  return new ExpressionNode(ir, refs);
}

/**
 * Resolve unresolved property references in an IRExpression tree.
 * Walks the tree and replaces placeholder sourceAlias values with
 * real aliases resolved via pathOptions.
 */
export function resolveExpressionRefs(
  expr: IRExpression,
  refs: PropertyRefMap,
  rootAlias: string,
  resolveTraversal: (fromAlias: string, propertyShapeId: string) => string,
): IRExpression {
  if (refs.size === 0) return expr;

  const resolve = (e: IRExpression): IRExpression => {
    switch (e.kind) {
      case 'property_expr': {
        const segments = refs.get(e.sourceAlias);
        if (!segments) return e;
        // Resolve: first N-1 segments are traversals, last is property
        let currentAlias = rootAlias;
        for (let i = 0; i < segments.length - 1; i++) {
          currentAlias = resolveTraversal(currentAlias, segments[i]);
        }
        return {
          kind: 'property_expr',
          sourceAlias: currentAlias,
          property: segments[segments.length - 1],
        };
      }
      case 'alias_expr': {
        const segments = refs.get(e.alias);
        if (!segments) return e;
        // Resolve all segments as traversals, return alias_expr for the final alias
        let currentAlias = rootAlias;
        for (const seg of segments) {
          currentAlias = resolveTraversal(currentAlias, seg);
        }
        return {kind: 'alias_expr', alias: currentAlias};
      }
      case 'binary_expr':
        return {
          ...e,
          left: resolve(e.left),
          right: resolve(e.right),
        };
      case 'in_expr':
        return {
          ...e,
          value: resolve(e.value),
          source: {list: e.source.list.map(resolve)},
        };
      case 'function_expr':
        return {...e, args: e.args.map(resolve)};
      case 'aggregate_expr':
        return {...e, args: e.args.map(resolve)};
      case 'logical_expr':
        return {...e, expressions: e.expressions.map(resolve)};
      case 'not_expr':
        return {...e, expression: resolve(e.expression)};
      default:
        return e;
    }
  };

  return resolve(expr);
}

/**
 * Represents an EXISTS quantifier condition over a collection path.
 * Used by .some(), .every(), .none() on QueryShapeSet.
 * Supports .and() / .or() / .not() chaining to compose with other conditions.
 *
 * The desugar/lower pipeline recognizes this via isExistsCondition() and builds
 * IRExistsExpression with proper traversal patterns and aliases.
 */
export class ExistsCondition {
  constructor(
    /** PropertyShapeData IDs forming the path from root to the collection. */
    public readonly pathSegmentIds: readonly string[],
    /** The inner predicate ExpressionNode. */
    public readonly predicate: ExpressionNode,
    /** Whether the EXISTS is negated (NOT EXISTS). */
    public readonly negated: boolean = false,
    /** Optional chained and/or conditions. */
    private readonly _chain: Array<{op: 'and' | 'or'; condition: ExpressionNode | ExistsCondition}> = [],
  ) {}

  not(): ExistsCondition {
    return new ExistsCondition(this.pathSegmentIds, this.predicate, !this.negated, this._chain);
  }

  and(other: ExpressionInput | ExistsCondition): ExistsCondition {
    return new ExistsCondition(this.pathSegmentIds, this.predicate, this.negated, [
      ...this._chain,
      {op: 'and', condition: other instanceof ExistsCondition ? other : other instanceof ExpressionNode ? other : new ExpressionNode(toIRExpression(other))},
    ]);
  }

  or(other: ExpressionInput | ExistsCondition): ExistsCondition {
    return new ExistsCondition(this.pathSegmentIds, this.predicate, this.negated, [
      ...this._chain,
      {op: 'or', condition: other instanceof ExistsCondition ? other : other instanceof ExpressionNode ? other : new ExpressionNode(toIRExpression(other))},
    ]);
  }

  get chain(): ReadonlyArray<{op: 'and' | 'or'; condition: ExpressionNode | ExistsCondition}> {
    return this._chain;
  }
}

export function isExistsCondition(value: unknown): value is ExistsCondition {
  return value instanceof ExistsCondition;
}

/** Check if a value is an ExpressionNode. */
export function isExpressionNode(value: unknown): value is ExpressionNode {
  return value instanceof ExpressionNode;
}
