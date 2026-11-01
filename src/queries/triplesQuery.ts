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
 * {@link parseTriplesQuery} before handing it to `IDataset.triplesQuery`. The builders are
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
 * - A **terms read** gives one position a list (`objects` or `predicates`) and asks which of its
 *   terms occur: `IDataset.triplesTermsQuery` answers the IRIs of the list that some triple of the
 *   read has in that position. A list of objects is a node read (graphs optional, as for
 *   `object`); a list of predicates needs `graphs`. Only `triplesTermsQuery` answers a read with a
 *   list, and it answers only such a read; `limit` is not part of it.
 *
 * A read that fixes the `predicate` or the `object` needs the `triplesPattern` query feature
 * ({@link triplesQueryFeatures}): a dataset built before them would drop the fields and answer a
 * wider read.
 */
export interface TriplesQuery {
  kind: 'triples';
  /** The subject IRI; absent for a read that does not fix the subject. */
  subject?: string;
  /** The predicate IRI; absent for any predicate. */
  predicate?: string;
  /** The object node IRI (a node, never a literal); absent for any object. */
  object?: string;
  /**
   * A list of predicate IRIs instead of one (`withPredicate([…])`): a **terms read**, answered by
   * `IDataset.triplesTermsQuery` with the ones some triple of the read has. Not with `predicate`
   * or `objects`.
   */
  predicates?: string[];
  /**
   * A list of object node IRIs instead of one (`toNode([…])`): a terms read, answered with the ones
   * some triple of the read points at. Not with `object` or `predicates`.
   */
  objects?: string[];
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
 * The query features a triples read needs (`IDataset.supports`): `triplesPattern` when it fixes the
 * predicate or the object. A subject read and a graph read are the baseline.
 */
export function triplesQueryFeatures(
  query: Pick<TriplesQuery, 'predicate' | 'object' | 'predicates' | 'objects'>,
): QueryFeature[] {
  return query.predicate !== undefined ||
    query.object !== undefined ||
    query.predicates !== undefined ||
    query.objects !== undefined
    ? ['triplesPattern']
    : [];
}

/** The list position of a terms read, or undefined for a read without a list. */
export function triplesTermsPosition(query: Pick<TriplesQuery, 'predicates' | 'objects'>): 'predicate' | 'object' | undefined {
  return query.objects !== undefined ? 'object' : query.predicates !== undefined ? 'predicate' : undefined;
}

/** The terms of a terms read's list (its `objects` or `predicates`); `[]` for a read without one. */
export function triplesTermsOf(query: Pick<TriplesQuery, 'predicates' | 'objects'>): readonly string[] {
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

/** The parts of a triples read, as the builders and the wire check pass them. */
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

/**
 * Build a checked triples read from its parts (the builders' path). Throws on a malformed part and
 * on a read that names no node and no graphs (see {@link triplesQueryPartsOf} for the parts alone).
 */
export function triplesQueryOf(parts: TriplesQueryParts): TriplesQuery {
  const query = triplesQueryPartsOf(parts);
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
  if (triplesTermsPosition(query) !== undefined && query.recordClass !== undefined) {
    fail('a terms read (a list of objects or predicates) is not a graph read; it has no recordClass.');
  }
  return query;
}

/**
 * Check each part of a triples read without requiring a whole read (a builder holds
 * `withPredicate(p)` before its `.from()`). Throws on a malformed part.
 */
export function triplesQueryPartsOf(parts: TriplesQueryParts): TriplesQuery {
  const query: TriplesQuery = {kind: 'triples'};
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

/**
 * Check a triples read that arrived as JSON and return it as a {@link TriplesQuery} (only the
 * known fields are kept). Throws on a malformed query.
 */
export function parseTriplesQuery(json: unknown): TriplesQuery {
  if (!json || typeof json !== 'object' || Array.isArray(json)) fail('expected an object.');
  const input = json as Record<string, unknown>;
  assertWireVersion(input.v);
  if (input.kind !== 'triples') fail(`kind must be "triples"; got ${JSON.stringify(input.kind)}.`);
  return triplesQueryOf({
    ...(input.subject !== undefined ? {subject: input.subject as string} : {}),
    ...(input.predicate !== undefined ? {predicate: input.predicate as string} : {}),
    ...(input.object !== undefined ? {object: input.object as string} : {}),
    ...(input.predicates !== undefined ? {predicates: input.predicates as string[]} : {}),
    ...(input.objects !== undefined ? {objects: input.objects as string[]} : {}),
    ...(input.graphs !== undefined ? {graphs: parseReadGraphsJSON(input.graphs, 'triples')} : {}),
    ...(input.limit !== undefined ? {limit: input.limit as number} : {}),
    ...(input.recordClass !== undefined ? {recordClass: input.recordClass as string} : {}),
  });
}
