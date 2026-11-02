/**
 * Serialization helpers for QueryBuilder fields that contain live object
 * references (where-clauses, sort paths, minus entries).
 *
 * Where-clauses serialize through the DSL-JSON expression codec
 * (`DslJsonExpression.ts`) — the wire form carries no IR. This module wires that
 * codec into the select/mutation envelopes and handles sort + minus.
 */

import type {NodeShapeData} from '../shapes/SHACL.js';
import {PropertyPath} from './PropertyPath.js';
import {pathToStringWithCasts, walkPathWithCasts} from './castPaths.js';
import {relationMemberShape} from './DslJsonExpression.js';
import type {WherePath, SortByPath, SortKey} from './SelectQuery.js';
import type {RawMinusEntry, PropertyPathSegment} from './IRDesugar.js';
import {
  encodeCondition,
  decodeCondition,
  encodeValueExpr,
  decodeValueExpr,
  type DslJsonCondition,
  type DslJsonValue,
} from './DslJsonExpression.js';
import {ExpressionNode, type ExistsCondition} from '../expressions/ExpressionNode.js';

// =============================================================================
// JSON types
// =============================================================================

/** A where-clause on the wire is a DSL-JSON condition (see documentation/dsl-json.md). */
export type WherePathJSON = DslJsonCondition;

type SortDirection = 'ASC' | 'DESC';

/**
 * An ordered list of sort keys — element order is sort precedence. A key is a path,
 * `{path: direction}`, or a path whose segment `whereIndex` is filtered, `{path: {direction,
 * where, whereIndex}}`, or a computed expression, `{value: <expr>, direction}` (two keys, so
 * never read as a path).
 */
export type SortByPathJSON = Array<
  | {[path: string]: SortDirection | {direction: SortDirection; where?: WherePathJSON; whereIndex?: number}}
  | {value: DslJsonValue; direction: SortDirection}
>;

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
  return sort.keys.map((key, i) => {
    const direction = sort.directions[i];
    if ('expression' in key) {
      return {value: encodeValueExpr(key.expression.ir, key.expression._refs), direction};
    }
    const path = pathToStringWithCasts(key.path.rootShape, key.path.segments);
    if (!key.where) return {[path]: direction};
    const whereIndex = key.whereIndex ?? key.path.segments.length - 1;
    return {
      [path]: {
        direction,
        where: serializeWherePath(key.where, scopedShapeAt(key.path, whereIndex)),
        whereIndex,
      },
    };
  });
}

/**
 * The shape a wire filter on segment `index` of a sort path or a field reads, as the encoder wrote
 * it ({@link scopedShapeAt}): a relation's member shape, else (a filter on a literal,
 * `p.hobby.where(…)`) the path's root. An index that names no segment is refused, never dropped.
 */
export function filteredSegmentShape(path: PropertyPath, index: unknown, pathKey: string): NodeShapeData {
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= path.segments.length) {
    throw new Error(
      `Invalid filter on '${pathKey}': whereIndex ${JSON.stringify(index)} must name a segment of the path ` +
        `(0 to ${path.segments.length - 1}).`,
    );
  }
  return scopedShapeAt(path, index as number);
}

/** The shape an inline filter on segment `index` of `path` reads (that segment's value shape). */
function scopedShapeAt(path: PropertyPath, index: number): NodeShapeData {
  const segment = path.segments[index];
  return (segment && relationMemberShape(segment)) || path.rootShape;
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
  // Per-key directions: each entry keeps its own direction. The empty path is the subject
  // itself (`orderBy((p) => p)` serializes to `{"": dir}`).
  const keys: SortKey[] = [];
  const directions: SortDirection[] = [];
  for (const entry of json) {
    const names = Object.keys(entry);
    if (names.length === 2 && 'value' in entry && 'direction' in entry) {
      const {ir, refs} = decodeValueExpr(entry.value as DslJsonValue, shape);
      keys.push({expression: new ExpressionNode(ir, refs)});
      directions.push(checkDirection(entry.direction));
      continue;
    }
    if (names.length !== 1) {
      throw new Error(`Invalid sortBy entry ${JSON.stringify(entry)}: one {path: direction} or {value, direction}.`);
    }
    const pathKey = names[0];
    const spec = (entry as Record<string, unknown>)[pathKey];
    const path = pathKey === '' ? new PropertyPath(shape, []) : walkPathWithCasts(shape, pathKey);
    if (spec && typeof spec === 'object') {
      const opts = spec as {direction?: unknown; where?: WherePathJSON; whereIndex?: number};
      const key: Extract<SortKey, {path: PropertyPath}> = {path};
      if (opts.where) {
        const whereIndex = opts.whereIndex ?? path.segments.length - 1;
        key.where = deserializeWherePath(filteredSegmentShape(path, whereIndex, pathKey), opts.where);
        key.whereIndex = whereIndex;
      }
      keys.push(key);
      directions.push(checkDirection(opts.direction));
    } else {
      keys.push({path});
      directions.push(checkDirection(spec));
    }
  }
  return {keys, directions};
}

/** A sort direction from the wire, any case (SPARQL reads `asc`/`desc` too). */
function checkDirection(direction: unknown): SortDirection {
  const upper = typeof direction === 'string' ? direction.toUpperCase() : direction;
  if (upper !== 'ASC' && upper !== 'DESC') {
    throw new Error(`Invalid sort direction ${JSON.stringify(direction)}: 'ASC' or 'DESC'.`);
  }
  return upper;
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
