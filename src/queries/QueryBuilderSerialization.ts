/**
 * Serialization helpers for QueryBuilder fields that contain live object
 * references (where-clauses, sort paths, minus entries).
 *
 * Where-clauses serialize through the DSL-JSON expression codec
 * (`DslJsonExpression.ts`) — the wire form carries no IR. This module wires that
 * codec into the select/mutation envelopes and handles sort + minus.
 */

import type {NodeShapeData} from '../shapes/SHACL.js';
import {PropertyPath, walkPropertyPath} from './PropertyPath.js';
import type {WherePath, SortByPath} from './SelectQuery.js';
import type {RawMinusEntry, PropertyPathSegment} from './IRDesugar.js';
import {
  encodeCondition,
  decodeCondition,
  type DslJsonCondition,
} from './DslJsonExpression.js';
import type {ExpressionNode, ExistsCondition} from '../expressions/ExpressionNode.js';

// =============================================================================
// JSON types
// =============================================================================

/** A where-clause on the wire is a DSL-JSON condition (see documentation/dsl-json.md). */
export type WherePathJSON = DslJsonCondition;

/** An ordered list of `{path: direction}` — element order is sort precedence. */
export type SortByPathJSON = Array<{[path: string]: 'ASC' | 'DESC'}>;

export type RawMinusEntryJSON = {
  shapeId?: string;
  where?: WherePathJSON;
  propertyPaths?: string[][];
};

// =============================================================================
// Serialization
// =============================================================================

/** Serialize a runtime where-clause to its DSL-JSON condition form. */
export function serializeWherePath(
  where: WherePath,
  shape: NodeShapeData,
): WherePathJSON {
  const node: ExpressionNode | ExistsCondition =
    'existsCondition' in (where as object)
      ? (where as {existsCondition: ExistsCondition}).existsCondition
      : (where as {expressionNode: ExpressionNode}).expressionNode;
  return encodeCondition(node, shape);
}

export function serializeSortByPath(sort: SortByPath): SortByPathJSON {
  return sort.paths.map((p, i) => ({[p.toString()]: sort.directions[i]}));
}

export function serializeRawMinusEntry(
  entry: RawMinusEntry,
  shape: NodeShapeData,
): RawMinusEntryJSON {
  const json: RawMinusEntryJSON = {};
  if (entry.shapeId) json.shapeId = entry.shapeId;
  if (entry.where) json.where = serializeWherePath(entry.where, shape);
  if (entry.propertyPaths) {
    json.propertyPaths = entry.propertyPaths.map((pp) =>
      pp.map((seg) => seg.propertyShapeId),
    );
  }
  return json;
}

// =============================================================================
// Deserialization
// =============================================================================

/** Rebuild a runtime where-clause from its DSL-JSON condition form. */
export function deserializeWherePath(
  shape: NodeShapeData,
  json: WherePathJSON,
): WherePath {
  return decodeCondition(json, shape);
}

export function deserializeSortByPath(
  shape: NodeShapeData,
  json: SortByPathJSON,
): SortByPath {
  // Per-path directions: each `{path: dir}` entry keeps its own direction. The empty
  // path is the subject itself (`orderBy((p) => p)` serializes to `{"": dir}`).
  return {
    paths: json.map((e) => {
      const path = Object.keys(e)[0];
      return path === '' ? new PropertyPath(shape, []) : walkPropertyPath(shape, path);
    }),
    directions: json.map((e) => Object.values(e)[0]) as ('ASC' | 'DESC')[],
  };
}

export function deserializeRawMinusEntry(
  shape: NodeShapeData,
  json: RawMinusEntryJSON,
): RawMinusEntry {
  const entry: RawMinusEntry = {};
  if (json.shapeId) entry.shapeId = json.shapeId;
  if (json.where) entry.where = deserializeWherePath(shape, json.where);
  if (json.propertyPaths) {
    entry.propertyPaths = json.propertyPaths.map((pp) =>
      pp.map((id): PropertyPathSegment => ({propertyShapeId: id})),
    );
  }
  return entry;
}
