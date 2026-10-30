/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Triples reads: the triples of one named graph, or of one subject, without a shape.
 *
 * A {@link TriplesQuery} is plain data, like a graph query: its DSL-JSON form is the object itself
 * (optionally with the wire version `v`), and a receiving process checks wire JSON with
 * {@link parseTriplesQuery} before handing it to `IDataset.triplesQuery`. The builders are
 * `NamedGraph.readContent(graph)` (a graph read, routed like the graph queries of its record class)
 * and `TriplesBuilder.forNode(id)` (a subject read, shapeless).
 *
 * The answer is a list of {@link Triple}s whose terms are core's values: an IRI is `{id}`, a
 * literal is `{value, datatype, language?}` with its lexical form and its datatype as `{id}`
 * (`xsd:string` for a plain literal, `rdf:langString` for a language-tagged one), so a read can be
 * written back unchanged. A blank node is `{id: '_:label'}`, its label valid only within that
 * answer.
 */
import type {NodeReferenceValue} from './QueryFactory.js';
import {assertWireVersion} from './wireVersion.js';
import {isGraphIri} from './graphQuery.js';
import {normalizeReadGraphs, parseReadGraphsJSON} from './readGraphs.js';

/**
 * A triples read.
 *
 * - With `subject`: the subject's triples (as a subject; triples that point at it are not read),
 *   in `graphs` when given, else where a shapeless ask of it would look (the default graph, or
 *   every graph the store's routing knows).
 * - Without `subject`: every triple of `graphs` (a graph read). One of the two is required: a read
 *   of every triple of a store is not a query this API sends.
 */
export interface TriplesQuery {
  kind: 'triples';
  /** The subject IRI; absent for a graph read. */
  subject?: string;
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

/** The subject of a subject read: an absolute IRI (a blank-node label names nothing outside one answer). */
export function checkTriplesSubject(value: unknown): string {
  if (!isGraphIri(value)) {
    fail(`subject must be an absolute IRI; got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** A limit: a positive integer. */
export function checkTriplesLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(`limit must be a positive integer; got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Build a checked triples read from its parts (the builders' path). Throws on a malformed part and
 * on a read that names neither a subject nor graphs.
 */
export function triplesQueryOf(parts: {
  subject?: string;
  graphs?: readonly string[] | string;
  limit?: number;
  recordClass?: string;
}): TriplesQuery {
  const query: TriplesQuery = {kind: 'triples'};
  if (parts.subject !== undefined) query.subject = checkTriplesSubject(parts.subject);
  if (parts.graphs !== undefined) query.graphs = normalizeReadGraphs(parts.graphs);
  if (query.subject === undefined && query.graphs === undefined) {
    fail('it needs a subject, graphs or both; a read of every triple of a store is not sent.');
  }
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
    ...(input.graphs !== undefined ? {graphs: parseReadGraphsJSON(input.graphs, 'triples')} : {}),
    ...(input.limit !== undefined ? {limit: input.limit as number} : {}),
    ...(input.recordClass !== undefined ? {recordClass: input.recordClass as string} : {}),
  });
}
