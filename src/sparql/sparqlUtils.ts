import {Prefix} from '../utils/Prefix.js';
import {ulid} from 'ulid';

export interface SparqlOptions {
  dataRoot?: string;
  prefixes?: Record<string, string>;
  /**
   * For reads across several named graphs (`.from()`): put the inferred type check of a subject
   * reached through a link in a second `GRAPH ?g { ?x a C }` block on the same graph variable,
   * after the block that reads one of its stored triples. Same rows; faster on a store that
   * reorders the patterns inside one block (Jena). Set per store, never per query. Default false.
   * See `graphScope.ts`.
   */
  isolateLinkedTypeChecks?: boolean;
  /**
   * Map a portable graph name (`graphs.default`, `graphs.union`) to the store's own name for it
   * (Fuseki: `urn:x-arq:DefaultGraph`, `urn:x-arq:UnionGraph`); `null` refuses the name. Without
   * the hook a read of `graphs.default` alone reads the default graph and every other use of the
   * two names is refused.
   */
  mapGraphName?: (iri: string) => string | null;
}

// Characters that must never appear inside a SPARQL IRIREF (`<...>`) per the
// SPARQL 1.1 grammar: angle brackets, quote, braces, pipe, caret, backtick,
// backslash, and all control chars + space (U+0000–U+0020). Any of these would
// let a crafted `id`/IRI break out of the `<...>` and inject raw SPARQL.
const FORBIDDEN_IRI_CHARS = /[\x00-\x20<>"{}|^`\\]/;

/**
 * Assert that a string is safe to emit as a SPARQL IRI. Throws on any character
 * that could terminate the IRIREF and inject query text. Applied to the raw IRI
 * before prefixing so the prefixed branch can't be used to smuggle a breakout.
 */
export function assertSafeIri(uri: string): void {
  if (typeof uri !== 'string' || FORBIDDEN_IRI_CHARS.test(uri)) {
    throw new Error(
      `Invalid IRI for SPARQL output: ${JSON.stringify(uri)}. IRIs must not contain angle brackets, quotes, braces, whitespace, or control characters.`,
    );
  }
}

// SPARQL 1.1 built-in functions + aggregate names (§17.4, §18.5). Names are
// case-insensitive in SPARQL; we compare upper-cased. Function/aggregate names
// are emitted verbatim into query text, so a name from untrusted `fromJSON`
// input (an S-expr head that isn't a known combinator becomes a "function
// name") could otherwise inject raw SPARQL — this allowlist is the guard.
const SPARQL_CALL_NAMES = new Set([
  // string
  'STR', 'STRLEN', 'SUBSTR', 'UCASE', 'LCASE', 'STRSTARTS', 'STRENDS',
  'CONTAINS', 'STRBEFORE', 'STRAFTER', 'ENCODE_FOR_URI', 'CONCAT', 'LANGMATCHES',
  'REGEX', 'REPLACE',
  // term / type
  'LANG', 'DATATYPE', 'BOUND', 'IRI', 'URI', 'BNODE', 'STRDT', 'STRLANG',
  'UUID', 'STRUUID', 'SAMETERM', 'ISIRI', 'ISURI', 'ISBLANK', 'ISLITERAL',
  'ISNUMERIC',
  // numeric
  'ABS', 'CEIL', 'FLOOR', 'ROUND', 'RAND',
  // date/time
  'YEAR', 'MONTH', 'DAY', 'HOURS', 'MINUTES', 'SECONDS', 'TIMEZONE', 'TZ', 'NOW',
  // hash
  'MD5', 'SHA1', 'SHA256', 'SHA384', 'SHA512',
  // control / conditional
  'IF', 'COALESCE',
  // aggregates
  'COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'SAMPLE', 'GROUP_CONCAT',
]);

/**
 * Sanitize a string for use as a SPARQL variable name (`?name`). Replaces any
 * character outside `[A-Za-z0-9_]` with `_`, so an alias/projection name derived
 * from untrusted input cannot break out of the `?...` variable position. Valid
 * names (already `[A-Za-z0-9_]`) are returned unchanged.
 */
export function sanitizeVarName(name: string): string {
  return String(name).replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Assert that a function or aggregate name is a known SPARQL 1.1 builtin before
 * it is emitted verbatim into query text. Throws on anything else (e.g. an
 * attacker-supplied S-expr head), which is the SPARQL-injection guard for the
 * `function_expr` / `aggregate_expr` serialization paths.
 */
export function assertSafeCallName(name: string): void {
  if (typeof name !== 'string' || !SPARQL_CALL_NAMES.has(name.toUpperCase())) {
    throw new Error(
      `Unsupported SPARQL function/aggregate: ${JSON.stringify(name)}. Only SPARQL 1.1 built-in functions are allowed.`,
    );
  }
}

/**
 * Format a URI for SPARQL output.
 * Returns prefixed form (e.g. `rdf:type`) if a prefix is registered AND the
 * resulting local part is a legal SPARQL `PN_LOCAL`. Otherwise `<full-uri>`.
 * Throws if the IRI contains characters that could break out of the IRIREF.
 */
export function formatUri(uri: string): string {
  assertSafeIri(uri);
  const prefixed = Prefix.toPrefixed(uri);
  if (prefixed) return prefixed;
  return `<${uri}>`;
}

/**
 * Escapes special characters in a string for use inside SPARQL double-quoted literals.
 * Per SPARQL 1.1 §19.7 (Escape sequences in strings).
 */
export function escapeSparqlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Format a literal value for SPARQL output.
 * Returns a quoted string with optional `^^<datatype>` suffix.
 * Special characters in the value are escaped per SPARQL spec.
 */
export function formatLiteral(
  value: string | number | boolean | Date,
  datatype?: string,
): string {
  let lexical: string;
  if (value instanceof Date) {
    lexical = value.toISOString();
  } else {
    lexical = String(value);
  }

  const escaped = escapeSparqlString(lexical);

  if (datatype) {
    return `"${escaped}"^^${formatUri(datatype)}`;
  }
  return `"${escaped}"`;
}

/**
 * Collect the minimal set of prefix→URI mappings needed for a set of URIs.
 * Only includes prefixes that are actually used.
 *
 * The prefixable rule lives in `Prefix.toPrefixed` and is asked here, never
 * re-implemented: this block and the terms it serves must agree, or a query
 * declares a prefix nothing uses — or worse, uses one it never declared.
 */
export function collectPrefixes(usedUris: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const uri of usedUris) {
    if (!Prefix.toPrefixed(uri)) continue;
    const match = Prefix.findMatch(uri);
    if (match.length > 0) {
      const [ontologyUri, prefix] = match;
      result[prefix] = ontologyUri;
    }
  }
  return result;
}

/**
 * Generate a new entity URI for a create mutation.
 * Format: `{dataRoot}/{lowercaseShapeLabel}_{ulid}`
 */
export function generateEntityUri(
  shape: string,
  options?: SparqlOptions,
): string {
  const dataRoot =
    options?.dataRoot || process.env.DATA_ROOT || 'http://example.org/data';

  // Extract the shape label from the full URI (last segment after # or /)
  let label: string;
  const hashIdx = shape.lastIndexOf('#');
  if (hashIdx >= 0) {
    label = shape.substring(hashIdx + 1);
  } else {
    const slashIdx = shape.lastIndexOf('/');
    label = slashIdx >= 0 ? shape.substring(slashIdx + 1) : shape;
  }

  return `${dataRoot}/${label.toLowerCase()}_${ulid()}`;
}
