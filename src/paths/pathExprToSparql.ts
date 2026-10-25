/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {PathExpr, PathRef} from './PropertyPathExpr.js';
import {isPathRef} from './PropertyPathExpr.js';
import {formatUri} from '../sparql/sparqlUtils.js';
import {Prefix} from '../utils/Prefix.js';
import {pathRefIri} from './propertyPathSafety.js';

// ---------------------------------------------------------------------------
// Precedence levels (higher = tighter binding)
// ---------------------------------------------------------------------------
const PREC_ALT = 1;
const PREC_SEQ = 2;
const PREC_UNARY = 3;
const PREC_PRIMARY = 4;

/**
 * Write one path step. Every step goes through `formatUri` (angle brackets, `assertSafeIri`,
 * prefix shortening): a string step is read as a prefixed name only when it is one SPARQL
 * prefixed-name token with a registered prefix, and is expanded first. Any other string is an
 * IRI — `urn:prop:a` included, which is not a prefixed name unless `urn` is registered. Nothing
 * from a step reaches the query text verbatim, so a stored `sh:path` step cannot add patterns.
 */
function refToSparql(ref: PathRef): string {
  return formatUri(pathRefIri(ref));
}

/**
 * Collect every IRI a PathExpr AST names, as `pathExprToSparql` writes it: string and `{id}`
 * steps alike, with a registered prefixed name expanded to its full IRI. The PREFIX block of a
 * query is built from these, so a step written in its short form gets its declaration.
 */
export function collectPathUris(expr: PathExpr): string[] {
  const uris: string[] = [];
  walkPathExpr(expr, uris);
  return uris;
}

function collectRef(ref: PathRef, uris: string[]): void {
  uris.push(pathRefIri(ref));
}

function walkPathExpr(expr: PathExpr, uris: string[]): void {
  if (isPathRef(expr)) {
    collectRef(expr, uris);
    return;
  }
  if ('seq' in expr) { for (const e of expr.seq) walkPathExpr(e, uris); return; }
  if ('alt' in expr) { for (const e of expr.alt) walkPathExpr(e, uris); return; }
  if ('inv' in expr) { walkPathExpr(expr.inv, uris); return; }
  if ('zeroOrMore' in expr) { walkPathExpr(expr.zeroOrMore, uris); return; }
  if ('oneOrMore' in expr) { walkPathExpr(expr.oneOrMore, uris); return; }
  if ('zeroOrOne' in expr) { walkPathExpr(expr.zeroOrOne, uris); return; }
  if ('negatedPropertySet' in expr) {
    for (const item of expr.negatedPropertySet) {
      if (typeof item === 'string' || (typeof item === 'object' && 'id' in item && !('inv' in item))) {
        collectRef(item as PathRef, uris);
      } else {
        collectRef((item as {inv: PathRef}).inv, uris);
      }
    }
  }
}

/**
 * Render a PathExpr to SPARQL property path syntax.
 * Handles all forms including negatedPropertySet.
 * Adds parentheses only when needed for correct precedence.
 */
export function pathExprToSparql(expr: PathExpr): string {
  return renderExpr(expr, 0, refToSparql);
}

type RefFormatter = (ref: PathRef) => string;

/**
 * Absolute, prefix-independent rendering of a single path reference.
 *
 * BOTH spellings are expanded. A `{id}` ref usually carries a full IRI, but not always — the
 * shape catalog and hand-written fixtures both produce `{id: 'schema:name'}`. Expanding only the
 * string form would give one path two different keys depending on how it was spelled, which is
 * the one thing a canonical key may never do.
 */
const absoluteIri = (ref: PathRef): string =>
  Prefix.toFullIfPossible(typeof ref === 'string' ? ref : ref.id);

function refToAbsolute(ref: PathRef): string {
  return `<${absoluteIri(ref)}>`;
}

/**
 * A stable, prefix-INDEPENDENT identity for a property path.
 *
 * `pathExprToSparql` renders for humans and for queries: it shortens IRIs via `formatUri`, so the
 * same path serializes differently depending on which prefixes happen to be registered in the
 * current process. That is fine for a query string and disqualifying for a wire key — the
 * extraction contract uses this value to name a property across process boundaries, and a
 * catalog written in one process must match a result read in another.
 *
 * So: absolute IRIs, always, never prefixed. Round-trips through `parsePropertyPath`.
 *
 * A SIMPLE path returns the bare predicate IRI rather than `<iri>`, because that is what a
 * single-predicate property has always been identified by — widening `propertyIri` to a full
 * path (plan-035 D13) must not change the key of the overwhelmingly common case.
 */
export function canonicalPathKey(expr: PathExpr): string {
  if (isPathRef(expr)) return absoluteIri(expr);
  return renderExpr(expr, 0, refToAbsolute);
}

function renderExpr(expr: PathExpr, parentPrec: number, ref: RefFormatter = refToSparql): string {
  if (isPathRef(expr)) {
    return ref(expr);
  }

  if ('seq' in expr) {
    const inner = expr.seq.map((e) => renderExpr(e, PREC_SEQ, ref)).join('/');
    return parentPrec > PREC_SEQ ? `(${inner})` : inner;
  }

  if ('alt' in expr) {
    const inner = expr.alt.map((e) => renderExpr(e, PREC_ALT, ref)).join('|');
    return parentPrec > PREC_ALT ? `(${inner})` : inner;
  }

  if ('inv' in expr) {
    return `^${renderExpr(expr.inv, PREC_UNARY, ref)}`;
  }

  if ('zeroOrMore' in expr) {
    return `${renderExpr(expr.zeroOrMore, PREC_PRIMARY, ref)}*`;
  }

  if ('oneOrMore' in expr) {
    return `${renderExpr(expr.oneOrMore, PREC_PRIMARY, ref)}+`;
  }

  if ('zeroOrOne' in expr) {
    return `${renderExpr(expr.zeroOrOne, PREC_PRIMARY, ref)}?`;
  }

  if ('negatedPropertySet' in expr) {
    const items = expr.negatedPropertySet.map((item) => {
      if (typeof item === 'string' || (typeof item === 'object' && 'id' in item && !('inv' in item))) {
        return ref(item as PathRef);
      }
      const invItem = item as {inv: PathRef};
      return `^${ref(invItem.inv)}`;
    });
    return items.length === 1 ? `!${items[0]}` : `!(${items.join('|')})`;
  }

  throw new Error(`Unknown PathExpr shape: ${JSON.stringify(expr)}`);
}
