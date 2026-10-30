import {type ExpressionInput, ExpressionNode} from './ExpressionNode.js';
import {Shape} from '../shapes/Shape.js';
import {ShapeSet} from '../collections/ShapeSet.js';

// Shared base — methods available on ALL expression types
export interface BaseExpressionMethods {
  eq(v: ExpressionInput): ExpressionNode;
  equals(v: ExpressionInput): ExpressionNode;
  neq(v: ExpressionInput): ExpressionNode;
  notEquals(v: ExpressionInput): ExpressionNode;
  /** Membership: this value is one of `values` (SPARQL `IN`). */
  oneOf(values: ExpressionInput[]): ExpressionNode;
  /** Membership: this value is not one of `values` (SPARQL `NOT IN`). */
  notOneOf(values: ExpressionInput[]): ExpressionNode;
  isDefined(): ExpressionNode;
  isNotDefined(): ExpressionNode;
  defaultTo(fallback: ExpressionInput): ExpressionNode;
  str(): ExpressionNode;
  lang(): ExpressionNode;
  datatype(): ExpressionNode;
  iri(): ExpressionNode;
  isIri(): ExpressionNode;
  isLiteral(): ExpressionNode;
  isBlank(): ExpressionNode;
  isNumeric(): ExpressionNode;
  md5(): ExpressionNode;
  sha256(): ExpressionNode;
  sha512(): ExpressionNode;
}

export interface NumericExpressionMethods extends BaseExpressionMethods {
  plus(n: ExpressionInput): ExpressionNode;
  minus(n: ExpressionInput): ExpressionNode;
  times(n: ExpressionInput): ExpressionNode;
  divide(n: ExpressionInput): ExpressionNode;
  abs(): ExpressionNode;
  round(): ExpressionNode;
  ceil(): ExpressionNode;
  floor(): ExpressionNode;
  power(n: number): ExpressionNode;
  gt(v: ExpressionInput): ExpressionNode;
  greaterThan(v: ExpressionInput): ExpressionNode;
  gte(v: ExpressionInput): ExpressionNode;
  greaterThanOrEqual(v: ExpressionInput): ExpressionNode;
  lt(v: ExpressionInput): ExpressionNode;
  lessThan(v: ExpressionInput): ExpressionNode;
  lte(v: ExpressionInput): ExpressionNode;
  lessThanOrEqual(v: ExpressionInput): ExpressionNode;
}

export interface StringExpressionMethods extends BaseExpressionMethods {
  concat(...parts: ExpressionInput[]): ExpressionNode;
  contains(s: ExpressionInput): ExpressionNode;
  startsWith(s: ExpressionInput): ExpressionNode;
  endsWith(s: ExpressionInput): ExpressionNode;
  substr(start: number, len?: number): ExpressionNode;
  before(s: ExpressionInput): ExpressionNode;
  after(s: ExpressionInput): ExpressionNode;
  replace(pat: string, rep: string, flags?: string): ExpressionNode;
  ucase(): ExpressionNode;
  lcase(): ExpressionNode;
  strlen(): ExpressionNode;
  encodeForUri(): ExpressionNode;
  matches(pat: string, flags?: string): ExpressionNode;
  gt(v: ExpressionInput): ExpressionNode;
  lt(v: ExpressionInput): ExpressionNode;
  gte(v: ExpressionInput): ExpressionNode;
  lte(v: ExpressionInput): ExpressionNode;
}

export interface DateExpressionMethods extends BaseExpressionMethods {
  year(): ExpressionNode;
  month(): ExpressionNode;
  day(): ExpressionNode;
  hours(): ExpressionNode;
  minutes(): ExpressionNode;
  seconds(): ExpressionNode;
  timezone(): ExpressionNode;
  tz(): ExpressionNode;
  gt(v: ExpressionInput): ExpressionNode;
  lt(v: ExpressionInput): ExpressionNode;
  gte(v: ExpressionInput): ExpressionNode;
  lte(v: ExpressionInput): ExpressionNode;
}

export interface BooleanExpressionMethods extends BaseExpressionMethods {
  and(expr: ExpressionInput): ExpressionNode;
  or(expr: ExpressionInput): ExpressionNode;
  not(): ExpressionNode;
}

// Filter helper to remove Shape's internal keys
type DataKeys<S> = {
  [K in keyof S]: K extends 'node' | 'nodeShape' | 'namedNode' | 'targetClass' | 'toString' | 'id' | 'uri' | '__queryContextId'
    ? never
    : S[K] extends (...args: any[]) => any ? never
    : K;
}[keyof S];

type ToExpressionProxy<T> =
  T extends number ? number & NumericExpressionMethods :
  T extends string ? string & StringExpressionMethods :
  T extends Date ? Date & DateExpressionMethods :
  T extends boolean ? boolean & BooleanExpressionMethods :
  T extends Shape ? ExpressionUpdateProxy<T> :
  T;

export type ExpressionUpdateProxy<S> = {
  readonly [P in DataKeys<S>]: S[P] extends ShapeSet<any>
    ? never
    : ToExpressionProxy<S[P]>;
};

export type ExpressionUpdateResult<S> = {
  [P in DataKeys<S>]?: S[P] extends Shape ? never
    : S[P] extends ShapeSet<any> ? never
    : S[P] | ExpressionNode;
};
