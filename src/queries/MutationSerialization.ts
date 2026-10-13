/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Lossless JSON (de)serialization for mutations (create / update / delete) — the
 * **IR-free wire codec**. The companion IR side (`decodeNodeData` / `lowerMutationJSON`)
 * lives in `lowerMutationJSON.ts` so this module never pulls the canonical-IR pipeline.
 *
 * The serialization unit is the normalized `NodeDescriptionValue` produced by the
 * IR-free factory base (`MutationQueryFactory.describe()`) — i.e. after `.set()` and
 * after any update-expression callback has been evaluated, but before canonical IR.
 * Property keys are serialized as **labels** (shape-relative, lightweight); decoding
 * resolves them back via the registered shape.
 *
 * Values use the DSL-JSON grammar (documentation/dsl-json.md): a bare scalar is a
 * literal; objects tag the kinds `JSON.stringify` can't represent natively
 * (`{@date}`, `{@id}`, `{@ctx}`, `{@list}`, `{@add,@remove}`, `{@unset}`); and a
 * computed value is an S-expr array via the shared `DslJsonExpression` codec —
 * so the wire carries no IR.
 */
import {
  type NodeDescriptionValue,
  type NodeReferenceValue,
  type PropUpdateValue,
  type SetModificationValue,
  type SinglePropertyUpdateValue,
  isSetModificationValue,
} from './QueryFactory.js';
import {getPropertyShape} from '../shapes/nodeShapeData.js';
import {ExpressionNode, isExpressionNode} from '../expressions/ExpressionNode.js';
import type {WherePathJSON} from './QueryBuilderSerialization.js';
import type {ContextRefJSON} from './ContextRef.js';
import {PendingQueryContext} from './QueryContext.js';
import {getShapeClass} from '../utils/ShapeClass.js';
import type {NodeShapeData, PropertyShapeData} from '../shapes/SHACL.js';
import {
  encodeValueExpr,
  decodeValueExpr,
  type DslJsonValue,
} from './DslJsonExpression.js';

// =============================================================================
// JSON types
// =============================================================================

/**
 * A mutation field value in the DSL-JSON grammar. A bare scalar is a literal; objects
 * tag the non-JSON-native kinds (`@`-sigiled); a computed value is an S-expr array (no IR); a
 * nested-node create is a bare path-keyed object ({@link MutationNodeDataJSON}),
 * disambiguated from the tagged forms by having no reserved value-key.
 */
export type MutationValueJSON =
  | string
  | number
  | boolean
  | null
  | {'@date': string}
  | {'@id': string}
  | {'@ctx': string}
  | {'@list': MutationValueJSON[]}
  | {'@add'?: MutationValueJSON[]; '@remove'?: string[]}
  | {'@unset': true}
  | MutationNodeDataJSON // nested-node create (bare, path-keyed)
  | DslJsonValue; // computed expression (S-expr) / {@path}

/**
 * A node description in **path-keyed** form: `label → value`, plus three reserved
 * keys — `__id` (a fixed/predefined id), `__blank` (`true`: a nested node written as
 * a blank node) and `__shape` (the concrete shape IRI, emitted only when it differs
 * from the shape inferred from context, e.g. a subclass instance under a
 * superclass-typed relation).
 */
export type MutationNodeDataJSON = {
  [key: string]: MutationValueJSON | undefined;
};

/** Reserved node-data keys (not property labels). */
const NODE_ID_KEY = '__id';
const NODE_SHAPE_KEY = '__shape';
/** Marks a nested node written as a blank node (`NodeDescriptionValue.__blank`). */
const NODE_BLANK_KEY = '__blank';

export type CreateMutationJSON = {
  v?: string;
  op: 'create';
  shape: string;
  data: MutationNodeDataJSON;
};

export type UpdateMutationJSON = {
  v?: string;
  op: 'update';
  shape: string;
  mode: 'for' | 'forAll' | 'where';
  /** A node id, or a `{@ctx: name}` context reference resolved at lowering. */
  targetId?: string | ContextRefJSON;
  where?: WherePathJSON;
  data: MutationNodeDataJSON;
};

/**
 * Create-or-replace against a known id.
 *
 * A distinct `op` rather than `op: 'update'` with a new `mode`. An unaware consumer that
 * received `{op: 'update', mode: 'upsert'}` would fall past its `mode === 'for'` and
 * `mode === 'where'` branches into the update-where path with no where clause — an update
 * applied to *every instance of the shape*. A distinct op instead hits `fromJSON`'s
 * existing `default:` and throws "Unknown query op": loud, and safe.
 */
export type UpsertMutationJSON = {
  v?: string;
  op: 'upsert';
  shape: string;
  /** Upsert targets one known id; there is no `forAll`/`where` form. */
  mode: 'for';
  /** A node id, or a `{@ctx: name}` context reference resolved at lowering. */
  targetId?: string | ContextRefJSON;
  data: MutationNodeDataJSON;
};

export type DeleteMutationJSON =
  | {v?: string; op: 'delete'; shape: string; mode: 'ids'; ids: (string | ContextRefJSON)[]}
  | {v?: string; op: 'delete'; shape: string; mode: 'all'}
  | {v?: string; op: 'delete'; shape: string; mode: 'where'; where: WherePathJSON};

export type MutationJSON =
  | CreateMutationJSON
  | UpdateMutationJSON
  | UpsertMutationJSON
  | DeleteMutationJSON;

// =============================================================================
// Value codec
// =============================================================================

/** The shape a nested node is expected to have (a property's value shape), if resolvable. */
export function valueShapeOf(prop?: PropertyShapeData): NodeShapeData | undefined {
  const id = (prop as unknown as {valueShape?: {id: string}})?.valueShape?.id;
  return id ? getShapeClass(id)?.shape : undefined;
}

/** Encode a single (non-array, non-setMod) property value. `prop` gives the nested-node shape. */
function encodeSingleValue(
  value: SinglePropertyUpdateValue,
  prop?: PropertyShapeData,
): MutationValueJSON {
  if (value === undefined) return {'@unset': true};
  if (isExpressionNode(value)) {
    // A computed value is an S-expr (or {@path}) via the shared codec — no IR.
    return encodeValueExpr(value.ir, value._refs) as MutationValueJSON;
  }
  if (value instanceof Date) return {'@date': value.toISOString()};
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value && typeof value === 'object') {
    // Query-context reference — carry the name, resolve at lowering (checked
    // before the generic `.id` branch since a PendingQueryContext has an `.id` getter).
    if (value instanceof PendingQueryContext) {
      return {'@ctx': value.contextName};
    }
    if ('fields' in value) {
      // Nested-node create — bare path-keyed; expected shape = the relation's value shape.
      return encodeNodeData(value as NodeDescriptionValue, valueShapeOf(prop));
    }
    if ('id' in value) return {'@id': (value as NodeReferenceValue).id};
  }
  throw new Error(`Cannot serialize mutation value: ${JSON.stringify(value)}`);
}

/** Encode any property value, including arrays and set modifications. */
export function encodeValue(
  value: PropUpdateValue,
  prop?: PropertyShapeData,
): MutationValueJSON {
  if (value === undefined) return {'@unset': true};
  if (Array.isArray(value)) {
    return {'@list': value.map((v) => encodeSingleValue(v, prop))};
  }
  if (isSetModificationValue(value)) {
    const mod = value as SetModificationValue;
    const json: {'@add'?: MutationValueJSON[]; '@remove'?: string[]} = {};
    if (mod.$add) json['@add'] = mod.$add.map((v) => encodeValue(v as PropUpdateValue, prop));
    if (mod.$remove) json['@remove'] = mod.$remove.map((r) => r.id);
    return json;
  }
  return encodeSingleValue(value as SinglePropertyUpdateValue, prop);
}

/**
 * Encode a normalized node description to path-keyed form. `expectedShape` is the
 * shape inferable from context (the envelope, or the parent relation's value shape);
 * `__shape` is emitted only when the concrete shape differs (a subclass instance).
 */
export function encodeNodeData(
  desc: NodeDescriptionValue,
  expectedShape?: NodeShapeData,
): MutationNodeDataJSON {
  const json: MutationNodeDataJSON = {};
  if (desc.__id) json[NODE_ID_KEY] = desc.__id;
  if (desc.__blank) json[NODE_BLANK_KEY] = true;
  if (!expectedShape || desc.shape.id !== expectedShape.id) {
    json[NODE_SHAPE_KEY] = desc.shape.id;
  }
  for (const f of desc.fields) {
    json[f.prop.label] = encodeValue(f.val, f.prop);
  }
  return json;
}

// =============================================================================
// JSON → raw UpdatePartial (for builder rehydration / fromJSON)
// =============================================================================

// Bound the DSL-JSON decode recursion (rehydration path) against a deeply-nested
// payload exhausting the stack. Mirrors the cap in lowerMutationJSON.
const MAX_DECODE_DEPTH = 128;
let _decodeDepth = 0;

/**
 * Decode a DSL-JSON value back to a raw DSL value (the form `.set()` accepts).
 * `currentShape` resolves computed `{@path}`/S-expr; `prop` gives a nested node's shape.
 * Depth-guarded wrapper around {@link decodeValueToRawInner}.
 */
function decodeValueToRaw(
  json: MutationValueJSON,
  currentShape: NodeShapeData | undefined,
  prop?: PropertyShapeData,
): unknown {
  if (++_decodeDepth > MAX_DECODE_DEPTH) {
    _decodeDepth = 0;
    throw new Error('DSL-JSON value nested too deeply');
  }
  try {
    return decodeValueToRawInner(json, currentShape, prop);
  } finally {
    _decodeDepth--;
  }
}

function decodeValueToRawInner(
  json: MutationValueJSON,
  currentShape: NodeShapeData | undefined,
  prop?: PropertyShapeData,
): unknown {
  // S-expr computed value
  if (Array.isArray(json)) {
    const {ir, refs} = decodeValueExpr(json as DslJsonValue, requireShapeForExpr(currentShape));
    return new ExpressionNode(ir, refs);
  }
  if (json === null) return null;
  if (typeof json !== 'object') return json; // bare scalar literal
  const o = json as Record<string, unknown>;
  if ('@unset' in o) return undefined;
  if ('@date' in o) return new Date(o['@date'] as string);
  // Rehydration path: preserve the live reference so it re-serializes as a
  // `{@ctx}` marker and resolves at the rebuilt builder's own lowering.
  if ('@ctx' in o) return new PendingQueryContext(o['@ctx'] as string);
  if ('@id' in o) return {id: o['@id']};
  if ('@list' in o) {
    return (o['@list'] as MutationValueJSON[]).map((i) => decodeValueToRaw(i, currentShape, prop));
  }
  if ('@add' in o || '@remove' in o) {
    // Raw DSL set-modifications use `@add`/`@remove` on the wire.
    const mod: {add?: unknown[]; remove?: {id: string}[]} = {};
    if (o['@add']) mod.add = (o['@add'] as MutationValueJSON[]).map((i) => decodeValueToRaw(i, currentShape, prop));
    if (o['@remove']) mod.remove = (o['@remove'] as string[]).map((id) => ({id}));
    return mod;
  }
  // A computed-path value (`{@path}`) used as a value.
  if ('@path' in o) {
    const {ir, refs} = decodeValueExpr(json as DslJsonValue, requireShapeForExpr(currentShape));
    return new ExpressionNode(ir, refs);
  }
  // Otherwise: a bare path-keyed nested-node create.
  return decodeNodeDataToRaw(o as MutationNodeDataJSON, valueShapeOf(prop) ?? currentShape);
}

function requireShapeForExpr(shape: NodeShapeData | undefined): NodeShapeData {
  if (!shape) {
    throw new Error('A shape is required to decode a computed mutation value');
  }
  return shape;
}

/**
 * Decode path-keyed node data into a raw object the mutation builders' `.set()` accepts.
 * `__id` becomes `id`; `__shape` (if present) overrides the inferred `shape`. Mirrors
 * {@link encodeNodeData}.
 */
export function decodeNodeDataToRaw(
  json: MutationNodeDataJSON,
  shape?: NodeShapeData,
): Record<string, unknown> {
  const nodeShape =
    typeof json[NODE_SHAPE_KEY] === 'string'
      ? getShapeClass(json[NODE_SHAPE_KEY] as string)?.shape ?? shape
      : shape;
  const obj: Record<string, unknown> = {};
  if (typeof json[NODE_ID_KEY] === 'string') obj.id = json[NODE_ID_KEY];
  if (json[NODE_BLANK_KEY] === true) obj.__blank = true;
  for (const [key, val] of Object.entries(json)) {
    if (key === NODE_ID_KEY || key === NODE_SHAPE_KEY || key === NODE_BLANK_KEY) continue;
    if (val === undefined) continue;
    // Skip prototype-polluting keys from untrusted DSL-JSON input.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const prop = nodeShape ? getPropertyShape(nodeShape, key) : undefined;
    obj[key] = decodeValueToRaw(val as MutationValueJSON, nodeShape, prop);
  }
  return obj;
}
