/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {type PathExpr, parsePropertyPath, PATH_OPERATOR_CHARS} from './PropertyPathExpr.js';
import {assertSafePropertyPath, isBareIri} from './propertyPathSafety.js';

/**
 * Input type for property path decorators.
 * Accepts all forms: string, {id}, array (sequence shorthand), or PathExpr.
 */
export type PropertyPathDecoratorInput =
  | string
  | {id: string}
  | PropertyPathDecoratorInput[]
  | PathExpr;

/** Path expression operator keys used to detect structured PathExpr objects. */
const PATH_EXPR_KEYS = new Set(['seq', 'alt', 'inv', 'zeroOrMore', 'oneOrMore', 'zeroOrOne', 'negatedPropertySet']);

/** Check if an object is a structured PathExpr (not a plain {id} ref). */
const isStructuredPathExpr = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  return Object.keys(value).some((key) => PATH_EXPR_KEYS.has(key));
};

/**
 * Normalize any property path decorator input into a canonical PathExpr.
 *
 * - `string` without path operators → preserved as-is (a PathRef)
 * - `string` with operators → parsed via `parsePropertyPath`
 * - `{id: string}` → preserved as PathRef
 * - `PathExpr` structured object → passed through
 * - `Array` → converted to `{seq: [...]}`
 *
 * Every step of the result is checked (`assertSafePropertyPath`): a step that is neither a
 * prefixed-name token nor an absolute IRI throws `InvalidPropertyPathError`.
 */
export function normalizePropertyPath(input: PropertyPathDecoratorInput): PathExpr {
  const result = normalizeUnchecked(input);
  assertSafePropertyPath(result);
  return result;
}

function normalizeUnchecked(input: PropertyPathDecoratorInput): PathExpr {
  let result: PathExpr;

  // String input
  if (typeof input === 'string') {
    if (isBareIri(input)) {
      // A bare absolute IRI is a PathRef, not an expression — even though it contains `/` and
      // `:`, which `PATH_OPERATOR_CHARS` matches. Without this, `https://schema.org/name` is fed
      // to the parser and dies at the `//` in its scheme.
      //
      // It never showed up while paths arrived as NamedNodes or prefixed names from decorators.
      // It bites whenever a path is a plain IRI string — which a `PathRef` may be, and which
      // the property paths in shape data and its wire form (`NodeShapeWire`, e.g. a project's
      // shape catalog) can be.
      //
      // A genuine sequence of absolute IRIs is written `<a>/<b>` and contains `<`, so the two
      // are unambiguous.
      result = input;
    } else if (PATH_OPERATOR_CHARS.test(input)) {
      result = parsePropertyPath(input);
    } else {
      result = input;
    }
  }
  // Array → sequence shorthand
  else if (Array.isArray(input)) {
    const normalized = input.map((item) => normalizeUnchecked(item));
    result = normalized.length === 1 ? normalized[0] : {seq: normalized};
  }
  // Object
  else if (typeof input === 'object' && input !== null) {
    // Structured PathExpr (has seq, alt, inv, etc.)
    if (isStructuredPathExpr(input)) {
      result = input as PathExpr;
    }
    // Plain {id} ref
    else if ('id' in input) {
      result = input as {id: string};
    } else {
      throw new Error(`Invalid property path input: ${JSON.stringify(input)}`);
    }
  } else {
    throw new Error(`Invalid property path input: ${JSON.stringify(input)}`);
  }

  return result;
}

/**
 * Check whether a PathExpr is a simple single-IRI path (backward-compatible form).
 * Returns the IRI string if simple, or null if complex.
 */
export function getSimplePathId(expr: PathExpr): string | null {
  if (typeof expr === 'string') return expr;
  if (typeof expr === 'object' && expr !== null && 'id' in expr && !isStructuredPathExpr(expr)) {
    return (expr as {id: string}).id;
  }
  return null;
}
