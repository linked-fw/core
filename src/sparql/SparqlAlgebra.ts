// --- Term types ---

export type SparqlTerm =
  | {kind: 'variable'; name: string}
  | {kind: 'iri'; value: string}
  /** A blank node, `_:label`. Only ever written into INSERT DATA (see `generateNodeDataTriples`). */
  | {kind: 'blank'; label: string}
  | {kind: 'literal'; value: string; datatype?: string; language?: string}
  | {kind: 'path'; value: string; uris: string[]};

export type SparqlTriple = {
  subject: SparqlTerm;
  predicate: SparqlTerm;
  object: SparqlTerm;
};

// --- Algebra node types ---

export type SparqlAlgebraNode =
  | SparqlBGP
  | SparqlJoin
  | SparqlLeftJoin
  | SparqlFilter
  | SparqlUnion
  | SparqlMinus
  | SparqlExtend
  | SparqlGraph
  | SparqlValues
  | SparqlSubSelect;

export type SparqlBGP = {
  type: 'bgp';
  triples: SparqlTriple[];
};

export type SparqlJoin = {
  type: 'join';
  left: SparqlAlgebraNode;
  right: SparqlAlgebraNode;
};

export type SparqlLeftJoin = {
  type: 'left_join';
  left: SparqlAlgebraNode;
  right: SparqlAlgebraNode;
  condition?: SparqlExpression;
};

export type SparqlFilter = {
  type: 'filter';
  expression: SparqlExpression;
  inner: SparqlAlgebraNode;
};

export type SparqlUnion = {
  type: 'union';
  left: SparqlAlgebraNode;
  right: SparqlAlgebraNode;
};

export type SparqlMinus = {
  type: 'minus';
  left: SparqlAlgebraNode;
  right: SparqlAlgebraNode;
};

export type SparqlExtend = {
  type: 'extend';
  inner: SparqlAlgebraNode;
  variable: string;
  expression: SparqlExpression;
};

/**
 * `GRAPH <iri> { … }` or `GRAPH ?variable { … }`: the inner pattern matched inside one named
 * graph, fixed or bound to the variable (restricted by the plan's `FROM NAMED` set, see
 * {@link SparqlDatasetClause}).
 */
export type SparqlGraph =
  | {type: 'graph'; iri: string; variable?: never; inner: SparqlAlgebraNode}
  | {type: 'graph'; variable: string; iri?: never; inner: SparqlAlgebraNode};

export type SparqlValues = {
  type: 'values';
  variable: string;
  iris: string[];
};

/**
 * A nested sub-SELECT used as a group graph pattern inside a WHERE block.
 *
 * Emitted for nested-select inner LIMIT/OFFSET: the root→child traverse is
 * wrapped in `{ SELECT <projection> WHERE { <inner> } ORDER BY … LIMIT … OFFSET … }`
 * so the related collection is bounded per parent. Only valid when the outer
 * query targets a single root subject (see irToAlgebra).
 */
export type SparqlSubSelect = {
  type: 'subselect';
  projection: string[];
  inner: SparqlAlgebraNode;
  orderBy?: SparqlOrderCondition[];
  limit?: number;
  offset?: number;
};

// --- Expressions ---

export type SparqlExpression =
  | SparqlVariableExpr
  | SparqlIriExpr
  | SparqlLiteralExpr
  | SparqlBinaryExpr
  | SparqlLogicalExpr
  | SparqlNotExpr
  | SparqlFunctionExpr
  | SparqlAggregateExpr
  | SparqlExistsExpr
  | SparqlBoundExpr
  | SparqlInExpr;

/** Membership test — `value IN (list)` / `value NOT IN (list)`. */
export type SparqlInExpr = {
  kind: 'in_expr';
  negated: boolean;
  value: SparqlExpression;
  list: SparqlExpression[];
};

export type SparqlVariableExpr = {
  kind: 'variable_expr';
  name: string;
};

export type SparqlIriExpr = {
  kind: 'iri_expr';
  value: string;
};

export type SparqlLiteralExpr = {
  kind: 'literal_expr';
  value: string;
  datatype?: string;
};

export type SparqlBinaryExpr = {
  kind: 'binary_expr';
  op: string;
  left: SparqlExpression;
  right: SparqlExpression;
};

export type SparqlLogicalExpr = {
  kind: 'logical_expr';
  op: 'and' | 'or';
  exprs: SparqlExpression[];
};

export type SparqlNotExpr = {
  kind: 'not_expr';
  inner: SparqlExpression;
};

export type SparqlFunctionExpr = {
  kind: 'function_expr';
  name: string;
  args: SparqlExpression[];
};

export type SparqlAggregateExpr = {
  kind: 'aggregate_expr';
  name: string;
  args: SparqlExpression[];
  distinct?: boolean;
};

export type SparqlExistsExpr = {
  kind: 'exists_expr';
  pattern: SparqlAlgebraNode;
  negated: boolean;
};

export type SparqlBoundExpr = {
  kind: 'bound_expr';
  variable: string;
};

// --- Projection and ordering ---

export type SparqlProjectionItem =
  | {kind: 'variable'; name: string}
  | {kind: 'aggregate'; expression: SparqlAggregateExpr; alias: string}
  | {kind: 'expression'; expression: SparqlExpression; alias: string};

export type SparqlOrderCondition = {
  expression: SparqlExpression;
  direction: 'ASC' | 'DESC';
};

export type SparqlAggregateBinding = {
  variable: string;
  aggregate: SparqlAggregateExpr;
};

// --- Top-level query plans ---

/**
 * The query's dataset clause: `FROM NAMED <g>` for each graph a `GRAPH ?g { … }` block may match
 * in. Only ever written with a non-empty list: without `FROM NAMED`, `GRAPH ?g` ranges over
 * every named graph of the store.
 */
export type SparqlDatasetClause = {
  fromNamed: string[];
};

export type SparqlSelectPlan = {
  type: 'select';
  algebra: SparqlAlgebraNode;
  projection: SparqlProjectionItem[];
  distinct?: boolean;
  orderBy?: SparqlOrderCondition[];
  limit?: number;
  offset?: number;
  groupBy?: string[];
  having?: SparqlExpression;
  aggregates?: SparqlAggregateBinding[];
  dataset?: SparqlDatasetClause;
};

/**
 * `ASK WHERE { … }` — a boolean existence check.
 *
 * Deliberately carries nothing but the pattern: `ASK` has no projection, no
 * solution modifiers and no pagination, so there is no field here that could be
 * silently ignored at serialization time.
 */
export type SparqlAskPlan = {
  type: 'ask';
  algebra: SparqlAlgebraNode;
  dataset?: SparqlDatasetClause;
};

/**
 * Triples a mutation writes outside its own graph: the nodes of a nested create that live in
 * another graph under graph routing (a non-owned node is written into its own shape's graph).
 * `graph` is a graph IRI, or `graphs.default` for the default graph, written as plain triples
 * (the compiler never leaves `graphs.default` here for a plan with `WITH <g>`; it names the
 * store's default graph instead).
 */
export type SparqlGraphTriples = {graph: string; triples: SparqlTriple[]};

export type SparqlInsertDataPlan = {
  type: 'insert_data';
  triples: SparqlTriple[];
  graph?: string;
  /** One `GRAPH` block per other graph the create writes (see {@link SparqlGraphTriples}). */
  elsewhere?: SparqlGraphTriples[];
};

export type SparqlDeleteInsertPlan = {
  type: 'delete_insert';
  deletePatterns: SparqlTriple[];
  insertPatterns: SparqlTriple[];
  whereAlgebra: SparqlAlgebraNode;
  /** `WITH <graph>`: the one graph the templates and the WHERE run in. */
  graph?: string;
  /**
   * The templates and the WHERE run in the graph `?variable` binds to, one of `graphs` (store
   * names): the graph holding `subject` (a subject in none of them matches nothing), or, without a
   * subject, every graph of the set in which the WHERE matches. With `fallback` (an upsert), a
   * subject found in none of them is written to `fallback`.
   */
  graphIn?: {variable: string; graphs: string[]; subject?: string; fallback?: string};
  /** INSERT template blocks in other graphs (see {@link SparqlGraphTriples}). */
  insertElsewhere?: SparqlGraphTriples[];
  /**
   * DELETE template blocks in the graph a WHERE variable binds, outside the plan's own graph: the
   * links to a deleted subject held in other graphs (`GRAPH ?g { ?s ?p <id> }`).
   */
  deleteInGraphs?: {variable: string; triples: SparqlTriple[]}[];
};

export type SparqlDeleteWherePlan = {
  type: 'delete_where';
  patterns: SparqlAlgebraNode;
  graph?: string;
};

export type SparqlPlan =
  | SparqlSelectPlan
  | SparqlAskPlan
  | SparqlInsertDataPlan
  | SparqlDeleteInsertPlan
  | SparqlDeleteWherePlan;
