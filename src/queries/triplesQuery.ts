/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Triples reads: the triples of one pattern, `subject predicate object`, without a shape. Each
 * position is fixed or open: one subject's triples, the triples that point at a node, the triples
 * of one predicate, or every triple of a named graph.
 *
 * A {@link TriplesQuery} is plain data, like a graph query: its DSL-JSON form is the object itself
 * (optionally with the wire version `v`), and a receiving process checks wire JSON with
 * {@link parseTriplesQuery} before handing it to `IDataset.readQuery`. A terms read ("which of
 * these terms occur") is a {@link TriplesTermsQuery} of its own kind, `triples_terms`, checked with
 * {@link parseTriplesTermsQuery}. The builders are
 * `NamedGraph.readContent(graph)` (a graph read, routed like the graph queries of its record class),
 * `TriplesBuilder.forNode(node)` (a subject read), `TriplesBuilder.toNode(node)` (an object read)
 * and `TriplesBuilder.withPredicate(p)` (a predicate read), all shapeless.
 *
 * The answer is a list of {@link Triple}s whose terms are core's values: an IRI is `{id}`, a
 * literal is `{value, datatype, language?}` with its lexical form and its datatype as `{id}`
 * (`xsd:string` for a plain literal, `rdf:langString` for a language-tagged one), so a read can be
 * written back unchanged. A blank node is `{id: '_:label'}`, its label valid only within that
 * answer.
 */
import type {NodeReferenceValue} from './QueryFactory.js';
import type {QueryFeature} from './queryFeatures.js';
import {assertWireVersion} from './wireVersion.js';
import {isGraphIri} from './graphQuery.js';
import {normalizeReadGraphs, parseReadGraphsJSON} from './readGraphs.js';

/**
 * A triples read: the triples matching one pattern, each of `subject`, `predicate` and `object`
 * fixed when given and open otherwise.
 *
 * - A **node read** fixes a node, as the `subject` (its triples; triples that point at it are not
 *   read) or as the `object` (the triples that point at it): in `graphs` when given, else where a
 *   shapeless ask of it would look (the default graph, or every graph the store's routing knows).
 * - Without a node the read needs `graphs`: every triple of them (a graph read), or those with the
 *   `predicate` (a predicate read). A read that names no node and no graphs (every triple of a
 *   store, or one predicate wherever it is) is not a query this API sends.
 *
 * A dataset answers it only when it declares the `triples` query feature, and a read that fixes the
 * `predicate` or the `object` only when it also declares `triplesPattern`
 * ({@link triplesQueryFeatures}): a dataset built before them would drop the fields and answer a
 * wider read. A read that asks which of a list of terms occur is a {@link TriplesTermsQuery}.
 */
export interface TriplesQuery {
  kind: 'triples';
  /** The subject IRI; absent for a read that does not fix the subject. */
  subject?: string;
  /** The predicate IRI; absent for any predicate. */
  predicate?: string;
  /** The object node IRI (a node, never a literal); absent for any object. */
  object?: string;
  /** The graphs read, as `.from()` takes them (portable names included); required without `subject`. */
  graphs?: string[];
  /** At most this many triples (no order is implied). */
  limit?: number;
  /**
   * The routing key of a graph read built on a graph-record class (`DraftGraph.readContent(g)` →
   * `core:DraftGraph`): `LinkedStorage` sends it where that class's graph queries go. It does not
   * restrict what is read.
   */
  recordClass?: string;
}

/**
 * A terms read (`TriplesBuilder.toNode([…])` or `withPredicate([…])`, then `.whichExist()`): one
 * position of a triples pattern is a list (`objects` or `predicates`, exactly one of them), and the
 * answer is the IRIs of that list some triple of the read has in that position. The other
 * positions are fixed or open as in a {@link TriplesQuery}. A list of objects is a node read
 * (graphs optional, as for `object`); a list of predicates needs `graphs` unless the subject is
 * fixed. It has no `limit` and no `recordClass`.
 *
 * A dataset answers it only when it declares the `triplesTerms` and `triplesPattern` query
 * features. The answer is a list of IRIs; the dispatch keeps only the list's own.
 */
export interface TriplesTermsQuery {
  kind: 'triples_terms';
  /** The subject IRI; absent for a read that does not fix the subject. */
  subject?: string;
  /** The predicate IRI, with a list of objects; absent for any predicate. */
  predicate?: string;
  /** The object node IRI, with a list of predicates; absent for any object. */
  object?: string;
  /** The predicate IRIs asked about (`withPredicate([…])`). Not with `predicate` or `objects`. */
  predicates?: string[];
  /** The object node IRIs asked about (`toNode([…])`). Not with `object` or `predicates`. */
  objects?: string[];
  /** The graphs read, as `.from()` takes them (portable names included). */
  graphs?: string[];
}

/** A literal: its lexical form, its datatype, and its language tag when it has one. */
export interface LiteralTerm {
  value: string;
  /** `xsd:string` for a plain literal, `rdf:langString` for a language-tagged one. */
  datatype: NodeReferenceValue;
  language?: string;
}

/** The object of a triple: a node (`{id}`, `_:label` for a blank node) or a literal. */
export type TripleObject = NodeReferenceValue | LiteralTerm;

/** One triple of a triples read. */
export interface Triple {
  subject: NodeReferenceValue;
  predicate: NodeReferenceValue;
  object: TripleObject;
  /** The named graph it was read in; absent for a triple of the default graph. */
  graph?: NodeReferenceValue;
}

/** Whether a triple's object is a literal (else it is a node, `{id}`). */
export function isLiteralTerm(term: TripleObject): term is LiteralTerm {
  return 'value' in term;
}

/** Whether `query` is a triples read (plain data or its wire form). */
export function isTriplesQuery(query: unknown): query is TriplesQuery {
  return !!query && typeof query === 'object' && (query as {kind?: unknown}).kind === 'triples';
}

/** Whether `query` is a terms read (plain data or its wire form). */
export function isTriplesTermsQuery(query: unknown): query is TriplesTermsQuery {
  return !!query && typeof query === 'object' && (query as {kind?: unknown}).kind === 'triples_terms';
}

function fail(message: string): never {
  throw new Error(`Invalid triples query: ${message}`);
}

/**
 * A fixed position of a triples read (`subject`, `predicate` or `object`): an absolute IRI. A
 * blank-node label names nothing outside one answer, so it is refused too.
 */
export function checkTriplesTerm(position: 'subject' | 'predicate' | 'object', value: unknown): string {
  if (!isGraphIri(value)) {
    fail(`${position} must be an absolute IRI; got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * The query features a triples or terms read needs (`IDataset.supports`): `triples` for a triples
 * read and `triplesTerms` for a terms read, plus `triplesPattern` when it fixes or lists the
 * predicate or the object (a terms read always does). A subject read and a graph read need only
 * `triples`.
 */
export function triplesQueryFeatures(query: TriplesQuery | TriplesTermsQuery): QueryFeature[] {
  if (query.kind === 'triples_terms') return ['triplesTerms', 'triplesPattern'];
  return query.predicate !== undefined || query.object !== undefined
    ? ['triples', 'triplesPattern']
    : ['triples'];
}

/** The list position of a terms read. */
export function triplesTermsPosition(query: Pick<TriplesTermsQuery, 'objects'>): 'predicate' | 'object' {
  return query.objects !== undefined ? 'object' : 'predicate';
}

/** The terms of a terms read's list (its `objects` or `predicates`). */
export function triplesTermsOf(query: Pick<TriplesTermsQuery, 'predicates' | 'objects'>): readonly string[] {
  return query.objects ?? query.predicates ?? [];
}
/**
 * A list position of a terms read (`predicates`, `objects`): an array of absolute IRIs, each kept
 * once in the order first given. An empty list is a read that finds nothing.
 */
export function checkTriplesTerms(position: 'predicate' | 'object', value: unknown): string[] {
  if (!Array.isArray(value)) {
    fail(`${position}s must be an array of absolute IRIs; got ${JSON.stringify(value)}.`);
  }
  return [...new Set(value.map((term) => checkTriplesTerm(position, term)))];
}

/** A limit: a positive integer. */
export function checkTriplesLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(`limit must be a positive integer; got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** The parts of a triples or terms read, as the builders and the wire checks pass them. */
export type TriplesQueryParts = {
  subject?: string;
  predicate?: string;
  object?: string;
  predicates?: readonly string[];
  objects?: readonly string[];
  graphs?: readonly string[] | string;
  limit?: number;
  recordClass?: string;
};

/** The parts of a read, each checked (see {@link triplesQueryPartsOf}); a whole read or not yet. */
export type CheckedTriplesParts = {
  subject?: string;
  predicate?: string;
  object?: string;
  predicates?: string[];
  objects?: string[];
  graphs?: string[];
  limit?: number;
  recordClass?: string;
};

/** Whether checked parts list terms (a terms read) rather than fix them (a triples read). */
export function isTermsParts(parts: Pick<CheckedTriplesParts, 'objects' | 'predicates'>): boolean {
  return parts.objects !== undefined || parts.predicates !== undefined;
}

/** The checks of a whole read, triples or terms. */
function assertWholeRead(query: CheckedTriplesParts): void {
  const hasObject = query.object !== undefined || query.objects !== undefined;
  const hasPredicate = query.predicate !== undefined || query.predicates !== undefined;
  if (query.subject === undefined && !hasObject && query.graphs === undefined) {
    fail(
      hasPredicate
        ? 'a predicate read needs graphs (.from(graphs)): it names the graphs it reads.'
        : 'it needs a node (a subject or an object), graphs or both; a read of every triple of a store is not sent.',
    );
  }
  if (query.subject !== undefined && hasPredicate && hasObject) {
    fail('subject, predicate and object are all fixed, so there is nothing to read; leave one open.');
  }
}

/**
 * Build a checked triples read from its parts (the builders' path). Throws on a malformed part, on
 * a list of terms (that is a {@link TriplesTermsQuery}, {@link triplesTermsQueryOf}) and on a read
 * that names no node and no graphs (see {@link triplesQueryPartsOf} for the parts alone).
 */
export function triplesQueryOf(parts: TriplesQueryParts): TriplesQuery {
  const checked = triplesQueryPartsOf(parts);
  if (isTermsParts(checked)) {
    fail(
      'a list of objects or predicates is a terms read (kind "triples_terms", ' +
        'TriplesBuilder.whichExist()), not a triples read.',
    );
  }
  assertWholeRead(checked);
  const {objects: _objects, predicates: _predicates, ...fixed} = checked;
  return {kind: 'triples', ...fixed};
}

/**
 * Build a checked terms read from its parts: exactly one list (`objects` or `predicates`), no
 * `limit` (a terms read answers terms, not a number of triples; it is dropped) and no
 * `recordClass` (a terms read is not a graph read). Throws on a malformed part or a read without
 * a list.
 */
export function triplesTermsQueryOf(parts: TriplesQueryParts): TriplesTermsQuery {
  const {limit: _limit, ...checked} = triplesQueryPartsOf(parts);
  if (!isTermsParts(checked)) {
    fail('a terms read lists the terms it asks about (objects or predicates); this one lists none.');
  }
  if (checked.recordClass !== undefined) {
    fail('a terms read (a list of objects or predicates) is not a graph read; it has no recordClass.');
  }
  assertWholeRead(checked);
  const {recordClass: _recordClass, ...rest} = checked;
  return {kind: 'triples_terms', ...rest};
}

/**
 * Check each part of a read without requiring a whole read (a builder holds `withPredicate(p)`
 * before its `.from()`). Throws on a malformed part.
 */
export function triplesQueryPartsOf(parts: TriplesQueryParts): CheckedTriplesParts {
  const query: CheckedTriplesParts = {};
  if (parts.subject !== undefined) query.subject = checkTriplesTerm('subject', parts.subject);
  if (parts.predicate !== undefined) query.predicate = checkTriplesTerm('predicate', parts.predicate);
  if (parts.object !== undefined) query.object = checkTriplesTerm('object', parts.object);
  if (parts.predicates !== undefined) {
    if (parts.predicate !== undefined) fail('predicate and predicates are both given; a read fixes one or lists several.');
    query.predicates = checkTriplesTerms('predicate', parts.predicates);
  }
  if (parts.objects !== undefined) {
    if (parts.object !== undefined) fail('object and objects are both given; a read fixes one or lists several.');
    if (parts.predicates !== undefined) {
      fail('objects and predicates are both lists; a terms read lists the terms of one position.');
    }
    query.objects = checkTriplesTerms('object', parts.objects);
  }
  if (parts.graphs !== undefined) query.graphs = normalizeReadGraphs(parts.graphs);
  if (parts.limit !== undefined) query.limit = checkTriplesLimit(parts.limit);
  if (parts.recordClass !== undefined) {
    if (!isGraphIri(parts.recordClass)) {
      fail(`recordClass must be an absolute IRI; got ${JSON.stringify(parts.recordClass)}.`);
    }
    query.recordClass = parts.recordClass;
  }
  return query;
}

/** The known fields of a read's wire form, unchecked. */
function wireParts(input: Record<string, unknown>, kind: 'triples' | 'triples_terms'): TriplesQueryParts {
  return {
    ...(input.subject !== undefined ? {subject: input.subject as string} : {}),
    ...(input.predicate !== undefined ? {predicate: input.predicate as string} : {}),
    ...(input.object !== undefined ? {object: input.object as string} : {}),
    ...(input.predicates !== undefined ? {predicates: input.predicates as string[]} : {}),
    ...(input.objects !== undefined ? {objects: input.objects as string[]} : {}),
    ...(input.graphs !== undefined ? {graphs: parseReadGraphsJSON(input.graphs, 'triples')} : {}),
    ...(kind === 'triples' && input.limit !== undefined ? {limit: input.limit as number} : {}),
    ...(input.recordClass !== undefined ? {recordClass: input.recordClass as string} : {}),
  };
}

function wireObject(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) fail('expected an object.');
  const input = json as Record<string, unknown>;
  assertWireVersion(input.v);
  return input;
}

/**
 * Check a triples read that arrived as JSON and return it as a {@link TriplesQuery} (only the
 * known fields are kept). Throws on a malformed query, and on a list of `objects` or `predicates`
 * (a terms read is `kind: "triples_terms"`, {@link parseTriplesTermsQuery}).
 */
export function parseTriplesQuery(json: unknown): TriplesQuery {
  const input = wireObject(json);
  if (input.kind !== 'triples') fail(`kind must be "triples"; got ${JSON.stringify(input.kind)}.`);
  if (input.objects !== undefined || input.predicates !== undefined) {
    fail('a list of objects or predicates is a terms read: send it as kind "triples_terms".');
  }
  return triplesQueryOf(wireParts(input, 'triples'));
}

/**
 * Check a terms read that arrived as JSON and return it as a {@link TriplesTermsQuery} (only the
 * known fields are kept). Throws on a malformed query.
 */
export function parseTriplesTermsQuery(json: unknown): TriplesTermsQuery {
  const input = wireObject(json);
  if (input.kind !== 'triples_terms') fail(`kind must be "triples_terms"; got ${JSON.stringify(input.kind)}.`);
  return triplesTermsQueryOf(wireParts(input, 'triples_terms'));
}
