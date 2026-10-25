/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {PathExpr, PathRef} from './PropertyPathExpr.js';
import {isPathRef, PATH_OPERATOR_CHARS} from './PropertyPathExpr.js';
import {assertSafeIri} from '../sparql/sparqlUtils.js';
import {Prefix} from '../utils/Prefix.js';
import {brandLinkedError} from '../utils/linkedError.js';

// ---------------------------------------------------------------------------
// The SPARQL 1.1 prefixed-name grammar (§19.8), PN_PREFIX ':' PN_LOCAL.
//
// A path step written as a string is either an absolute IRI or a prefixed name, and a prefixed
// name is the one form that reaches the query text without angle brackets. So it has to be a
// token the SPARQL grammar reads as ONE name: anything else (`rdf:type?o.?s?p?o.FILTER(true)#`)
// would be read as several tokens, and a stored `sh:path` step would add patterns to the query.
//
// PN_LOCAL_ESC (`\;`, `\/`, …) is left out on purpose. It is rare in a predicate, and the IRI it
// names is not the token minus its backslashes in every reader, so a step that needs it is
// written as an IRI (`{id}` or `<…>`) instead.
// ---------------------------------------------------------------------------

const PN_CHARS_BASE =
  'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF' +
  '\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD' +
  '\\u{10000}-\\u{EFFFF}';
const PN_CHARS_U = `${PN_CHARS_BASE}_`;
const PN_CHARS = `${PN_CHARS_U}\\-0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const PERCENT = '%[0-9A-Fa-f]{2}';

const PN_PREFIX = `[${PN_CHARS_BASE}](?:[${PN_CHARS}.]*[${PN_CHARS}])?`;
const PN_LOCAL =
  `(?:[${PN_CHARS_U}:0-9]|${PERCENT})` +
  `(?:(?:[${PN_CHARS}.:]|${PERCENT})*(?:[${PN_CHARS}:]|${PERCENT}))?`;

const PREFIXED_NAME = new RegExp(`^(${PN_PREFIX})?:(${PN_LOCAL})?$`, 'u');

/** True when `value` is one SPARQL prefixed-name token (`PN_PREFIX? ':' PN_LOCAL?`). */
export function isPrefixedNameToken(value: string): boolean {
  return typeof value === 'string' && PREFIXED_NAME.test(value);
}

/**
 * The full IRI of a string path step that is a prefixed name with a registered prefix, or
 * undefined. Only such a step may be read as a prefixed name: any other string is an IRI, and is
 * written in angle brackets.
 */
export function expandRegisteredPrefixedName(value: string): string | undefined {
  const match = typeof value === 'string' ? PREFIXED_NAME.exec(value) : null;
  if (!match) return undefined;
  const prefix = match[1] ?? '';
  const namespace = Prefix.getFullURI(prefix);
  if (!namespace) return undefined;
  return namespace + (match[2] ?? '');
}

/**
 * The IRI a path step names, as the serializer writes it: a registered prefixed name expands to
 * its full IRI, and every other step is the IRI itself.
 */
export function pathRefIri(ref: PathRef): string {
  if (typeof ref !== 'string') return ref.id;
  return expandRegisteredPrefixedName(ref) ?? ref;
}

/**
 * An absolute IRI written bare, e.g. `https://schema.org/name` or `urn:prop:sku`.
 *
 * Two forms, and the distinction from a PREFIXED-NAME SEQUENCE is the whole difficulty:
 *
 *  - A hierarchical IRI carries `://`, which `ex:friend/ex:name` never does. The `/` inside it
 *    is part of the IRI, not a sequence separator.
 *  - A non-hierarchical IRI (`urn:prop:sku`) has a scheme and NO path operator at all.
 *
 * So `ex:friend/ex:name` is still read as a sequence, and `<a>/<b>` — which starts with `<`,
 * not a scheme — still parses as an expression.
 */
export const isBareIri = (value: string): boolean => {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return !/[|^*+?()!<>\s]/.test(value);
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !PATH_OPERATOR_CHARS.test(value);
};

// ---------------------------------------------------------------------------
// Load-time validation
// ---------------------------------------------------------------------------

/** Thrown when a property path holds a step that is neither an IRI nor a prefixed name. */
export class InvalidPropertyPathError extends Error {
  /** The offending step, as it was given. */
  readonly step: unknown;
  /** The property shape the path belongs to, when known. */
  readonly propertyShape?: string;

  constructor(step: unknown, reason: string, propertyShape?: string) {
    super(
      `Invalid property path step ${JSON.stringify(step)}` +
        (propertyShape ? ` in property shape <${propertyShape}>` : '') +
        `: ${reason}. A step is a prefixed name (\`ex:name\`) or an absolute IRI ` +
        `(\`{id: 'urn:x:name'}\`, \`<urn:x:name>\` or \`https://…\`).`,
    );
    this.name = 'InvalidPropertyPathError';
    this.step = step;
    this.propertyShape = propertyShape;
  }
}
brandLinkedError(InvalidPropertyPathError, '@_linked/core', 'InvalidPropertyPathError');

function assertSafeRef(ref: unknown, propertyShape?: string): void {
  if (typeof ref === 'string') {
    // The two forms the path grammar reads as ONE step; anything else would have been parsed
    // into several, so it cannot be a step a path was written with.
    if (isPrefixedNameToken(ref)) return;
    if (isBareIri(ref) && isSafeIri(ref)) return;
    throw new InvalidPropertyPathError(
      ref,
      'a string step must be a single prefixed-name token or an absolute IRI without path ' +
        'operators',
      propertyShape,
    );
  }
  if (typeof ref === 'object' && ref !== null && typeof (ref as {id?: unknown}).id === 'string') {
    const id = (ref as {id: string}).id;
    if (id !== '' && isSafeIri(id)) return;
    throw new InvalidPropertyPathError(ref, 'its IRI is empty or not safe to write', propertyShape);
  }
  // A reference whose id was never read (`{id: undefined}`): what a simple store reader gives for
  // a complex `sh:path`, which is a blank-node structure. It writes nothing into a query — a read
  // through it fails at `formatUri` — so it is not refused here, where it would fail a whole
  // catalog over one property no caller may ever use.
  if (typeof ref === 'object' && ref !== null && 'id' in ref && ref.id === undefined) return;
  throw new InvalidPropertyPathError(ref, 'it is not a path step', propertyShape);
}

function isSafeIri(iri: string): boolean {
  try {
    assertSafeIri(iri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check every step of a property path, so a path read from data (a stored `sh:path`, a shape's
 * wire form) that could not have come from the path grammar fails here, by name, rather than in
 * the query it would be written into.
 *
 * @throws InvalidPropertyPathError
 */
export function assertSafePropertyPath(expr: PathExpr, propertyShape?: string): void {
  if (expr === null || expr === undefined) {
    throw new InvalidPropertyPathError(expr, 'the path is empty', propertyShape);
  }
  if (isPathRef(expr)) {
    assertSafeRef(expr, propertyShape);
    return;
  }
  if (typeof expr !== 'object') {
    throw new InvalidPropertyPathError(expr, 'it is not a path step', propertyShape);
  }
  const e = expr as Record<string, unknown>;
  for (const key of ['seq', 'alt'] as const) {
    if (key in e) {
      const items = e[key];
      if (!Array.isArray(items) || items.length === 0) {
        throw new InvalidPropertyPathError(expr, `\`${key}\` needs a non-empty list`, propertyShape);
      }
      for (const item of items) assertSafePropertyPath(item as PathExpr, propertyShape);
      return;
    }
  }
  for (const key of ['inv', 'zeroOrMore', 'oneOrMore', 'zeroOrOne'] as const) {
    if (key in e) {
      assertSafePropertyPath(e[key] as PathExpr, propertyShape);
      return;
    }
  }
  if ('negatedPropertySet' in e) {
    const items = e.negatedPropertySet;
    if (!Array.isArray(items) || items.length === 0) {
      throw new InvalidPropertyPathError(
        expr,
        '`negatedPropertySet` needs a non-empty list',
        propertyShape,
      );
    }
    for (const item of items) {
      const isInverse = typeof item === 'object' && item !== null && 'inv' in item;
      assertSafeRef(isInverse ? (item as {inv: unknown}).inv : item, propertyShape);
    }
    return;
  }
  throw new InvalidPropertyPathError(expr, 'it is not a path expression', propertyShape);
}

/**
 * Check the `path` and `sortBy` of every property shape of a shape read as data. Shapes from a
 * store or a wire form never pass through `normalizePropertyPath`, so this is their check.
 *
 * @throws InvalidPropertyPathError
 */
export function assertSafeShapePaths(shape: {
  propertyShapes?: readonly {id?: string; path?: PathExpr; sortBy?: PathExpr}[];
}): void {
  for (const ps of shape.propertyShapes ?? []) {
    if (ps.path !== undefined) assertSafePropertyPath(ps.path, ps.id);
    if (ps.sortBy !== undefined) assertSafePropertyPath(ps.sortBy, ps.id);
  }
}
