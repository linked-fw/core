/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Graph queries at the boundary: the kinds, the typed refusals and the wire check.
 *
 * A {@link GraphQuery} is plain data, so its DSL-JSON form is the object itself (optionally with
 * the wire version `v`). A receiving process (a gateway, a remote dataset's server) turns wire
 * JSON back into a checked query with {@link parseGraphQuery} and hands it to
 * `IDataset.graphQuery`.
 */
import type {
  GraphContent,
  GraphQuery,
  GraphQueryKind,
} from './IntermediateRepresentation.js';
import {assertWireVersion} from './wireVersion.js';
import {brandLinkedError, isLinkedError} from '../utils/linkedError.js';
import {graphs, PORTABLE_GRAPH_NAMES} from '../ontologies/graphs.js';

export type {GraphContent, GraphQuery, GraphQueryKind, GraphResult} from './IntermediateRepresentation.js';

/** Every graph query kind. */
export const GRAPH_QUERY_KINDS: readonly GraphQueryKind[] = [
  'graph_create',
  'graph_replace',
  'graph_patch',
  'graph_drop',
];

const GRAPH_CONTENT_TYPES = ['text/turtle', 'application/n-triples'] as const;

/** Whether `kind` names a graph query. */
export function isGraphQueryKind(kind: unknown): kind is GraphQueryKind {
  return typeof kind === 'string' && (GRAPH_QUERY_KINDS as readonly string[]).includes(kind);
}

/**
 * Why a graph query was refused:
 * - `unsupported-query-kind`: the dataset has no graph support (or not for this graph or kind);
 * - `graph-not-registered`: a replace or patch of a graph with no registry record;
 * - `graph-name-read-only`: a write to a portable graph name or to the registry itself;
 * - `graph-exists`: a create of a graph that is already registered.
 */
export type GraphQueryErrorCode =
  | 'unsupported-query-kind'
  | 'graph-not-registered'
  | 'graph-name-read-only'
  | 'graph-exists';

/** A refused graph query. Recognised across copies of core with {@link isGraphQueryError}. */
export class GraphQueryError extends Error {
  readonly code: GraphQueryErrorCode;
  /** The graph the query named, when it named one. */
  readonly graph?: string;

  constructor(code: GraphQueryErrorCode, message: string, graph?: string) {
    super(message);
    this.name = 'GraphQueryError';
    this.code = code;
    if (graph !== undefined) this.graph = graph;
  }
}
brandLinkedError(GraphQueryError, '@_linked/core', 'GraphQueryError');

/** Whether `err` is a {@link GraphQueryError} (from any copy of core), optionally with `code`. */
export function isGraphQueryError(
  err: unknown,
  code?: GraphQueryErrorCode,
): err is GraphQueryError {
  return isLinkedError(err, GraphQueryError) && (code === undefined || err.code === code);
}

/** The refusal a dataset without graph support answers every graph query with. */
export function unsupportedGraphQuery(query: {kind?: unknown; graph?: unknown}, reason?: string): GraphQueryError {
  const graph = typeof query?.graph === 'string' ? query.graph : undefined;
  return new GraphQueryError(
    'unsupported-query-kind',
    `This dataset does not support graph queries (${String(query?.kind)}${graph ? ` on <${graph}>` : ''})` +
      (reason ? `: ${reason}` : '.'),
    graph,
  );
}

/** Absolute IRI with a scheme and none of the characters that end an IRIREF. */
const IRI_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]*$/;

/** Whether `value` is an absolute IRI usable as a graph name. */
export function isGraphIri(value: unknown): value is string {
  return typeof value === 'string' && IRI_PATTERN.test(value);
}

/**
 * Refuse a graph name that is not an absolute IRI, and a write to a portable graph name (`graphs.default`, `graphs.union`, `graphs.allOntologies`,
 * `graphs.allShapes`) or to the registry itself: names are read-only, and the registry is written
 * only as part of a graph query on another graph.
 */
export function assertGraphWritable(graph: string): void {
  if (typeof graph !== 'string' || !IRI_PATTERN.test(graph)) {
    throw new Error(`A graph name must be an absolute IRI; got ${JSON.stringify(graph)}.`);
  }
  if (PORTABLE_GRAPH_NAMES.has(graph)) {
    throw new GraphQueryError(
      'graph-name-read-only',
      graph === graphs.registry
        ? `The graph registry <${graph}> is written only as part of a graph query on another graph.`
        : `<${graph}> is a portable graph name; it can be read, never written.`,
      graph,
    );
  }
}


function fail(message: string): never {
  throw new Error(`Invalid graph query: ${message}`);
}

function checkIri(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IRI_PATTERN.test(value)) {
    fail(`${field} must be an absolute IRI; got ${JSON.stringify(value)}.`);
  }
  return value;
}

function checkContent(value: unknown, field: string): GraphContent {
  if (!value || typeof value !== 'object') fail(`${field} must be {mediaType, text}.`);
  const {mediaType, text} = value as {mediaType?: unknown; text?: unknown};
  if (!(GRAPH_CONTENT_TYPES as readonly unknown[]).includes(mediaType)) {
    fail(`${field}.mediaType must be one of ${GRAPH_CONTENT_TYPES.join(', ')}; got ${JSON.stringify(mediaType)}.`);
  }
  if (typeof text !== 'string') fail(`${field}.text must be a string.`);
  return {mediaType: mediaType as GraphContent['mediaType'], text};
}

/**
 * Check a graph query that arrived as JSON and return it as a {@link GraphQuery} (only the known
 * fields are kept). Throws on a malformed query; refusals that need the store (registered or not)
 * are the store's.
 */
export function parseGraphQuery(json: unknown): GraphQuery {
  if (!json || typeof json !== 'object' || Array.isArray(json)) fail('expected an object.');
  const input = json as Record<string, unknown>;
  assertWireVersion(input.v);
  if (!isGraphQueryKind(input.kind)) {
    fail(`kind must be one of ${GRAPH_QUERY_KINDS.join(', ')}; got ${JSON.stringify(input.kind)}.`);
  }
  const query: GraphQuery = {
    kind: input.kind,
    graph: checkIri(input.graph, 'graph'),
    recordClass: checkIri(input.recordClass, 'recordClass'),
  };
  if (input.record !== undefined) {
    if (!input.record || typeof input.record !== 'object' || Array.isArray(input.record)) {
      fail('record must be an object of field values.');
    }
    query.record = {...(input.record as Record<string, unknown>)};
  }
  if (input.content !== undefined) {
    if (query.kind !== 'graph_create' && query.kind !== 'graph_replace') {
      fail(`content is only for graph_create and graph_replace, not ${query.kind}.`);
    }
    query.content = checkContent(input.content, 'content');
  }
  if (query.kind === 'graph_replace' && !query.content) fail('graph_replace needs content.');
  if (input.patch !== undefined) {
    if (query.kind !== 'graph_patch') fail(`patch is only for graph_patch, not ${query.kind}.`);
    if (!input.patch || typeof input.patch !== 'object') fail('patch must be {insert?, delete?}.');
    const patch = input.patch as {insert?: unknown; delete?: unknown};
    query.patch = {};
    if (patch.insert !== undefined) query.patch.insert = checkContent(patch.insert, 'patch.insert');
    if (patch.delete !== undefined) query.patch.delete = checkContent(patch.delete, 'patch.delete');
    if (!query.patch.insert && !query.patch.delete) fail('patch needs insert, delete or both.');
  }
  if (input.contentHash !== undefined) {
    if (typeof input.contentHash !== 'string' || !input.contentHash) {
      fail('contentHash must be a non-empty string.');
    }
    query.contentHash = input.contentHash;
  }
  return query;
}
