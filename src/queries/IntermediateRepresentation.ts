import {NodeReferenceValue} from './QueryFactory.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';

export type IRDirection = 'ASC' | 'DESC';
export type IRAlias = string;

export type IRValue = string | number | boolean | null;

export type IRQuery =
  | IRSelectQuery
  | IRAskQuery
  | IRCountQuery
  | IRCreateMutation
  | IRUpdateMutation
  | IRUpsertMutation
  | IRDeleteMutation
  | IRDeleteAllMutation
  | IRDeleteWhereMutation
  | IRUpdateWhereMutation;

export type IRSelectQuery = {
  kind: 'select';
  root: IRShapeScanPattern;
  patterns: IRGraphPattern[];
  projection: IRProjectionItem[];
  where?: IRExpression;
  orderBy?: IROrderByItem[];
  limit?: number;
  offset?: number;
  subjectId?: string;
  subjectIds?: string[];
  singleResult?: boolean;
  resultMap?: IRResultMapEntry[];
};

/**
 * A query whose answer is a boolean.
 *
 * Carries a pattern and nothing else. There is no `projection`, `orderBy`,
 * `limit` or `offset`: each of those shapes or windows a *solution sequence*, and
 * an ask has none — so rather than being ignored during conversion, or guarded
 * against, they are unrepresentable.
 *
 * `root` is **optional**. Absent means no `rdf:type` constraint at all — "does a
 * node with this IRI exist", under any shape or none — which lowers to
 * `ASK { <iri> ?p ?o }`. A rootless ask carries no `patterns` or `where`, since
 * both reference properties and a property is only resolvable through a shape.
 */
export type IRAskQuery = {
  kind: 'ask';
  root?: IRShapeScanPattern;
  patterns: IRGraphPattern[];
  where?: IRExpression;
  subjectId?: string;
  subjectIds?: string[];
};

/**
 * A query whose answer is a single number: how many instances of a shape match.
 *
 * Like {@link IRAskQuery}, it carries a **pattern and nothing else**. There is no
 * `projection`, `orderBy`, `limit` or `offset`: each of those shapes or windows a
 * *solution sequence*, and a count has none — the number it answers is a property
 * of the whole match set. So rather than being ignored during conversion, or
 * guarded against, they are unrepresentable.
 *
 * That is the entire reason this is a distinct IR kind and not a flag on
 * {@link IRSelectQuery}: a count of a windowed query is meaningless, and a type
 * that cannot hold the window cannot half-drop it.
 *
 * `root` is **required**, unlike an ask's. A shapeless count would count every
 * node in the store, which is never what a caller means.
 */
export type IRCountQuery = {
  kind: 'count';
  root: IRShapeScanPattern;
  patterns: IRGraphPattern[];
  where?: IRExpression;
  subjectId?: string;
  subjectIds?: string[];
  /**
   * The variable the `COUNT` is bound to (`(COUNT(DISTINCT ?a0) AS ?count)`).
   * Carried in the IR rather than hardcoded in two places so lowering and result
   * mapping cannot disagree about it.
   */
  alias: IRAlias;
};

export type IRProjectionItem = {
  alias: IRAlias;
  expression: IRExpression;
};

export type IROrderByItem = {
  expression: IRExpression;
  direction: IRDirection;
};

export type IRResultMapEntry = {
  key: string;
  alias: IRAlias;
};

export type IRGraphPattern =
  | IRShapeScanPattern
  | IRTraversePattern
  | IRJoinPattern
  | IROptionalPattern
  | IRUnionPattern
  | IRExistsPattern
  | IRMinusPattern;

export type IRShapeScanPattern = {
  kind: 'shape_scan';
  shape: string;
  alias: IRAlias;
};

export type IRTraversePattern = {
  kind: 'traverse';
  from: IRAlias;
  to: IRAlias;
  property: string;
  pathExpr?: PathExpr;
  filter?: IRExpression;
  maxCount?: number;
  /**
   * Inner LIMIT/OFFSET/ORDER BY for a nested select on this traversal's
   * related collection. When set, the root→child traverse is wrapped in a
   * SPARQL sub-SELECT to bound the collection per parent. Only valid when the
   * outer query targets a single root subject (enforced in irToAlgebra).
   */
  innerLimit?: number;
  innerOffset?: number;
  innerOrderBy?: IRInnerOrderBy[];
};

export type IRInnerOrderBy = {
  property: string;
  direction: IRDirection;
};

export type IRJoinPattern = {
  kind: 'join';
  patterns: IRGraphPattern[];
};

export type IROptionalPattern = {
  kind: 'optional';
  pattern: IRGraphPattern;
};

export type IRUnionPattern = {
  kind: 'union';
  branches: IRGraphPattern[];
};

export type IRExistsPattern = {
  kind: 'exists';
  pattern: IRGraphPattern;
};

export type IRMinusPattern = {
  kind: 'minus';
  pattern: IRGraphPattern;
  filter?: IRExpression;
};

export type IRExpression =
  | IRLiteralExpression
  | IRReferenceExpression
  | IRAliasExpression
  | IRPropertyExpression
  | IRContextPropertyExpression
  | IRBinaryExpression
  | IRLogicalExpression
  | IRNotExpression
  | IRFunctionExpression
  | IRAggregateExpression
  | IRExistsExpression
  | IRInExpression;

/**
 * Membership test — `value IN (…)` / `NOT IN (…)`.
 * `source` is forward-shaped: today only the explicit-`list` arm exists (Rung 1);
 * a `{query}` arm (Rung 2 — membership against a subquery, lowering to EXISTS)
 * can be added without changing the node's identity or the `oneOf`/`notOneOf` DSL.
 */
export type IRInExpression = {
  kind: 'in_expr';
  negated: boolean;
  value: IRExpression;
  source: {list: IRExpression[]};
};

export type IRLiteralExpression = {
  kind: 'literal_expr';
  /**
   * `Date` is admitted alongside `IRValue`: a temporal comparison has to reach the
   * SPARQL layer still knowing it is temporal, or the literal is emitted untyped
   * and never equals the `^^xsd:dateTime` term the mutation side writes.
   */
  value: IRValue | Date;
};

export type IRReferenceExpression = {
  kind: 'reference_expr';
  /** The referenced node IRI. Optional only while a `contextName` is unresolved. */
  value?: string;
  /**
   * A query-context reference (`{@ctx}` on the wire). When set, `value` is filled
   * by `lower()` from the live context map — resolved or thrown there, never baked
   * at build time. Absent for a plain node reference.
   */
  contextName?: string;
};

export type IRAliasExpression = {
  kind: 'alias_expr';
  alias: IRAlias;
};

export type IRPropertyExpression = {
  kind: 'property_expr';
  sourceAlias: IRAlias;
  property: string;
  pathExpr?: import('../paths/PropertyPathExpr.js').PathExpr;
  maxCount?: number;
};

export type IRContextPropertyExpression = {
  kind: 'context_property_expr';
  /** The context entity IRI. Optional only while a `contextName` is unresolved. */
  contextIri?: string;
  /** A query-context reference resolved into `contextIri` by `lower()`. */
  contextName?: string;
  property: string;
};

export type IRBinaryOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | '+'
  | '-'
  | '*'
  | '/';

export type IRBinaryExpression = {
  kind: 'binary_expr';
  operator: IRBinaryOperator;
  left: IRExpression;
  right: IRExpression;
};

export type IRLogicalOperator = 'and' | 'or';

export type IRLogicalExpression = {
  kind: 'logical_expr';
  operator: IRLogicalOperator;
  expressions: IRExpression[];
};

export type IRNotExpression = {
  kind: 'not_expr';
  expression: IRExpression;
};

export type IRFunctionExpression = {
  kind: 'function_expr';
  name: string;
  args: IRExpression[];
};

export type IRAggregateExpression = {
  kind: 'aggregate_expr';
  name: 'count' | 'sum' | 'avg' | 'min' | 'max';
  args: IRExpression[];
};

export type IRExistsExpression = {
  kind: 'exists_expr';
  pattern: IRGraphPattern;
  filter?: IRExpression;
};

export type IRCreateMutation = {
  kind: 'create';
  shape: string;
  data: IRNodeData;
};

export type IRTraversalPattern = {
  from: string;       // source alias
  property: string;   // property IRI
  to: string;         // target alias
};

export type IRUpdateMutation = {
  kind: 'update';
  shape: string;
  id: string;
  data: IRNodeData;
  traversalPatterns?: IRTraversalPattern[];
};

/**
 * Create-or-replace against a known id, in one request.
 *
 * Structurally identical to {@link IRUpdateMutation} — it lowers through the same
 * DELETE/INSERT/WHERE body — and differs in exactly one emitted triple: upsert also
 * asserts `?id rdf:type <targetClass>`, which the update path never writes.
 *
 * That single triple is the whole difference between the two, because `update`'s WHERE
 * is a bare `OPTIONAL` and so already matches when the node is absent. It is a distinct
 * IR kind rather than a flag on the update mutation so that a consumer which does not
 * know about upsert fails loudly, instead of quietly writing an untyped node and
 * reporting success.
 */
export type IRUpsertMutation = {
  kind: 'upsert';
  shape: string;
  id: string;
  data: IRNodeData;
  traversalPatterns?: IRTraversalPattern[];
};

export type IRDeleteMutation = {
  kind: 'delete';
  shape: string;
  ids: NodeReferenceValue[];
};

export type IRDeleteAllMutation = {
  kind: 'delete_all';
  shape: string;
};

export type IRDeleteWhereMutation = {
  kind: 'delete_where';
  shape: string;
  where: IRExpression;
  wherePatterns: IRGraphPattern[];
};

export type IRUpdateWhereMutation = {
  kind: 'update_where';
  shape: string;
  data: IRNodeData;
  where?: IRExpression;
  wherePatterns?: IRGraphPattern[];
  traversalPatterns?: IRTraversalPattern[];
};

export type IRNodeData = {
  shape: string;
  fields: IRFieldUpdate[];
  id?: string;
};

export type IRFieldUpdate = {
  property: string;
  value: IRFieldValue;
};

export type IRSetModificationValue = {
  add?: IRFieldValue[];
  remove?: NodeReferenceValue[];
};

export type IRFieldValue =
  | IRValue
  | Date
  | NodeReferenceValue
  | IRNodeData
  | IRSetModificationValue
  | IRFieldValue[]
  | IRExpression
  | undefined;

// ---------------------------------------------------------------------------
// Store result types
// ---------------------------------------------------------------------------
// These types describe what an IDataset implementation should return.
// The calling layer (LinkedStorage via queryDispatch) threads the precise
// DSL-level TypeScript result type back to the caller, so the store
// only needs to produce data that satisfies these structural contracts.
// ---------------------------------------------------------------------------

/**
 * A single result row — an object with a node id and dynamic fields.
 * Used in select and create results.
 */
export type ResultRow = {id: string; [key: string]: ResultFieldValue};

/**
 * Possible field values in a select or create result row.
 */
export type ResultFieldValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | ResultRow
  | ResultRow[]
  | string[]
  | number[]
  | boolean[]
  | Date[];

/**
 * What `selectQuery` should return.
 *
 * - Array of rows for multi-result queries (the default).
 * - A single row when `query.singleResult` is true (`.one()` or subject-targeted query).
 * - `null` when `singleResult` is true and the target node doesn't exist.
 */
export type SelectResult = ResultRow[] | ResultRow | null;

/**
 * What `createQuery` should return.
 *
 * A single row with the generated `id` and the created field values.
 * Nested creates appear as nested `ResultRow` objects (with their own ids).
 * Array fields (e.g. friends) appear as `ResultRow[]`.
 */
export type CreateResult = ResultRow;

/**
 * When a set property is fully overwritten, the result contains `updatedTo`
 * with the new complete set of values.
 */
export type SetOverwriteResult = {updatedTo: ResultRow[]};

/**
 * When a set property is incrementally modified with `{add, remove}`,
 * the result contains the added and removed entries.
 */
export type SetModificationResult = {added: ResultRow[]; removed: ResultRow[]};

/**
 * Possible field values in an update result row.
 * Extends `ResultFieldValue` with set modification shapes.
 */
export type UpdateFieldValue =
  | ResultFieldValue
  | SetOverwriteResult
  | SetModificationResult;

/**
 * What `updateQuery` should return.
 *
 * A single row with the target node's `id` and only the changed fields.
 * Fields not included in the update are omitted (not returned).
 *
 * Field value shapes depend on the type of update:
 * - Literal fields: the new value (string, number, boolean, Date).
 * - Single object fields: a `ResultRow` with the referenced/created node.
 * - Set overwrite (passing an array): `{updatedTo: ResultRow[]}`.
 * - Set add/remove (passing `{add, remove}`): `{added: ResultRow[], removed: ResultRow[]}`.
 * - Unset single field (passing `undefined` or `null`): field is `undefined`.
 * - Unset multi-value field (passing `undefined`): empty array `[]`.
 */
export type UpdateResult = {id: string; [key: string]: UpdateFieldValue};
