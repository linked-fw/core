import type {
  CanonicalDesugaredSelectQuery,
  CanonicalWhereExpression,
} from './IRCanonicalize.js';
import type {
  DesugaredExpressionSelect,
  DesugaredExpressionWhere,
  DesugaredExistsWhere,
  DesugaredSelection,
  DesugaredSelectionPath,
  DesugaredStep,
  DesugaredWhere,
} from './IRDesugar.js';
import {resolveExpressionRefs, ExistsCondition, type OuterReferenceResolver} from '../expressions/ExpressionNode.js';
import {resolveContextId} from './ContextRef.js';
import type {
  IRExpression,
  IRGraphPattern,
  IROrderByItem,
  IRProjectionItem,
  IRResultMapEntry,
  IRSelectQuery,
  IRShapeScanPattern,
  IRTraversePattern,
} from './IntermediateRepresentation.js';
import {lowerSelectionPathExpression, projectionKeyFromPath} from './IRProjection.js';
import {IRAliasScope} from './IRAliasScope.js';
import {labelOfId} from './castPaths.js';
import {attachCatalog} from '../utils/ShapeClass.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';
import {isLinkedInstance} from '../utils/linkedError.js';
import {featuresOfExpressions, type QueryFeature} from './queryFeatures.js';
import {dedupeProjectionSeeds, type ProjectionSeed, type SeedRow} from './projectionDuplicates.js';
import {containsAggregate} from './irExpressions.js';

/**
 * Creates a memoized traversal resolver that deduplicates (fromAlias, propertyShapeId)
 * pairs, generates unique aliases, and accumulates the resulting patterns.
 * Used by both select-query lowering and mutation expression resolution.
 */
export function createTraversalResolver<P>(
  generateAlias: () => string,
  createPattern: (from: string, to: string, property: string) => P,
): {resolve: (fromAlias: string, propertyShapeId: string) => string; patterns: P[]} {
  const patterns: P[] = [];
  const seen = new Map<string, string>();

  const resolve = (fromAlias: string, propertyShapeId: string): string => {
    const key = `${fromAlias}:${propertyShapeId}`;
    if (seen.has(key)) return seen.get(key)!;
    const toAlias = generateAlias();
    seen.set(key, toAlias);
    patterns.push(createPattern(fromAlias, toAlias, propertyShapeId));
    return toAlias;
  };

  return {resolve, patterns};
}

class LoweringContext {
  private counter = 0;
  private patterns: IRGraphPattern[] = [];
  private traverseMap = new Map<string, string>();
  private filteredTraverseMap = new Map<string, string>();
  private filterMap = new Map<string, IRExpression>();
  private innerPaginationMap = new Map<
    string,
    {limit?: number; offset?: number; orderBy?: import('./IntermediateRepresentation.js').IRInnerOrderBy[]}
  >();
  readonly rootAlias: string;

  constructor() {
    this.rootAlias = this.nextAlias();
  }

  private nextAlias(): string {
    return `a${this.counter++}`;
  }

  getOrCreateTraversal(fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number): string {
    const key = `${fromAlias}:${propertyShapeId}`;
    const existing = this.traverseMap.get(key);
    if (existing) return existing;
    const toAlias = this.createTraversal(fromAlias, propertyShapeId, pathExpr, maxCount);
    this.traverseMap.set(key, toAlias);
    return toAlias;
  }

  /**
   * A filtered step's traversal (`p.friends.where(…)`): shared only with a step under the same
   * filter (`signature`, the lowered filter), never with an unfiltered one or another filter's, so
   * each filter keeps its own members. An undefined signature always gets a traversal of its own.
   */
  getOrCreateFilteredTraversal(
    fromAlias: string,
    propertyShapeId: string,
    signature: string | undefined,
    pathExpr?: PathExpr,
    maxCount?: number,
  ): string {
    if (signature === undefined) return this.createTraversal(fromAlias, propertyShapeId, pathExpr, maxCount);
    const key = `${fromAlias}:${propertyShapeId}#${signature}`;
    const existing = this.filteredTraverseMap.get(key);
    if (existing) return existing;
    const toAlias = this.createTraversal(fromAlias, propertyShapeId, pathExpr, maxCount);
    this.filteredTraverseMap.set(key, toAlias);
    return toAlias;
  }

  /** The traversal `getOrCreateTraversal` would share for this step, if there is one. */
  existingTraversal(fromAlias: string, propertyShapeId: string): string | undefined {
    return this.traverseMap.get(`${fromAlias}:${propertyShapeId}`);
  }

  /** The traversal reaching `toAlias`, if `toAlias` is a traversal's target. */
  traversalTo(toAlias: string): IRTraversePattern | undefined {
    return this.patterns.find((p): p is IRTraversePattern => p.kind === 'traverse' && p.to === toAlias);
  }

  /** Whether an inline filter is attached to the traversal reaching `toAlias`. */
  hasFilter(toAlias: string): boolean {
    return this.filterMap.has(toAlias);
  }

  /** Whether a nested select's LIMIT/OFFSET/ORDER BY is attached to the traversal reaching `toAlias`. */
  hasPagination(toAlias: string): boolean {
    return this.innerPaginationMap.has(toAlias);
  }

  /**
   * A resolver for a where or a sort key: it shares the projection's traversals, except one that
   * holds only some members (a nested select's page, an inline filter's members), for which it
   * makes a traversal of its own (shared among its own reads). Otherwise the condition would test
   * only the page's members, and its triple would bind the paged variable outside the page.
   */
  conditionResolver(): (fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number) => string {
    const own = new Map<string, string>();
    return (fromAlias, propertyShapeId, pathExpr, maxCount) => {
      const shared = this.existingTraversal(fromAlias, propertyShapeId);
      if (shared === undefined || (!this.hasPagination(shared) && !this.hasFilter(shared))) {
        return this.getOrCreateTraversal(fromAlias, propertyShapeId, pathExpr, maxCount);
      }
      const key = `${fromAlias}:${propertyShapeId}`;
      let alias = own.get(key);
      if (alias === undefined) {
        alias = this.createTraversal(fromAlias, propertyShapeId, pathExpr, maxCount);
        own.set(key, alias);
      }
      return alias;
    };
  }

  /** A traversal of its own, never shared through `getOrCreateTraversal`. */
  createTraversal(fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number): string {
    const toAlias = this.nextAlias();
    const pattern: IRTraversePattern = {
      kind: 'traverse',
      from: fromAlias,
      to: toAlias,
      property: propertyShapeId,
    };
    if (pathExpr) {
      pattern.pathExpr = pathExpr;
    }
    if (typeof maxCount === 'number') {
      pattern.maxCount = maxCount;
    }
    this.patterns.push(pattern);
    return toAlias;
  }

  generateAlias(): string {
    return this.nextAlias();
  }

  /**
   * Attaches an inline where filter to the traverse pattern targeting `toAlias`.
   * The filter will be merged into the pattern when `getPatterns()` is called.
   */
  attachFilter(toAlias: string, filter: IRExpression): void {
    this.filterMap.set(toAlias, filter);
  }

  /**
   * Attaches inner LIMIT/OFFSET/ORDER BY (from a nested select) to the traverse
   * pattern targeting `toAlias`. Merged into the pattern in `getPatterns()`.
   */
  attachInnerPagination(
    toAlias: string,
    pagination: {limit?: number; offset?: number; orderBy?: import('./IntermediateRepresentation.js').IRInnerOrderBy[]},
  ): void {
    this.innerPaginationMap.set(toAlias, pagination);
  }

  getPatterns(): IRGraphPattern[] {
    return this.patterns.map((p) => {
      if (p.kind !== 'traverse') return p;
      let pattern = p;
      if (this.filterMap.has(p.to)) {
        pattern = {...pattern, filter: this.filterMap.get(p.to)!};
      }
      const pagination = this.innerPaginationMap.get(p.to);
      if (pagination) {
        pattern = {
          ...pattern,
          ...(typeof pagination.limit === 'number' ? {innerLimit: pagination.limit} : {}),
          ...(typeof pagination.offset === 'number' ? {innerOffset: pagination.offset} : {}),
          ...(pagination.orderBy ? {innerOrderBy: pagination.orderBy} : {}),
        };
      }
      return pattern;
    });
  }
}

/** Minimal interface for alias generation used by lowerWhere and traversal resolvers. */
type AliasGenerator = {
  generateAlias(): string;
};

type PathLoweringOptions = {
  rootAlias: string;
  /** `where`: the step's inline filter (a projection's filtered step), see `getOrCreateFilteredTraversal`. */
  resolveTraversal: (fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number, where?: DesugaredWhere) => string;
  /** An inline filter's or a quantifier's: resolves a path it reads from the outer subject. */
  resolveOuter?: OuterReferenceResolver;
  /**
   * How far a path from the query root (`p.bestFriend.name`) walks along nodes bound where the
   * condition is evaluated: the alias it reaches and the ids it used. A quantifier traverses the
   * rest inside its EXISTS. Absent: the condition is the query's own where (`rootAlias` is the
   * query root, the only node bound).
   */
  boundOuterPrefix?: (segmentIds: readonly string[]) => {alias: string; consumed: number};
  /**
   * The members of the enclosing inline filter and quantifiers, outermost first, innermost (this
   * condition's own member) last: what an enclosing member's path (`f.name` read in a quantifier
   * inside `f`'s) resolves from.
   */
  scopeAliases?: readonly string[];
};

/**
 * An aggregate inside a condition SPARQL evaluates per member (an EXISTS, a filtered OPTIONAL
 * block, a MINUS block) is not allowed there: a FILTER cannot hold one. Answering it needs a
 * sub-SELECT with GROUP BY/HAVING, which this layer cannot emit (backlog 042). Refused, never sent
 * to a store as invalid SPARQL.
 */
const refuseAggregateIn = (construct: string, expr: IRExpression | undefined): void => {
  if (!containsAggregate(expr)) return;
  throw new Error(
    `An aggregate (size, min, max, …) inside ${construct} is not supported: SPARQL tests that ` +
    'condition per member, where an aggregate is not allowed (it would need a sub-select with ' +
    'GROUP BY/HAVING). Compare an aggregate at the top level of a where, over the query\'s own ' +
    'subject (`.where((p) => p.friends.size().equals(1))`), or select it ' +
    '(`p.friends.select((f) => ({friendCount: f.friends.size()}))`) and filter the rows.',
  );
};

/**
 * Resolve any `{@ctx}` context references carried in a lowered expression tree —
 * whether it came from a where-clause filter OR a projected (expression-select)
 * value.
 *
 * A context reference (`.equals(getQueryContext('user'))`) is carried through build +
 * the wire as a *name* (`reference_expr.contextName` / `context_property_expr.contextName`),
 * never a baked id. Here — at lowering — it is resolved against the live context map into
 * the concrete IRI; an unresolved one throws `UnresolvedContextError` (SELECT callers
 * short-circuit to null before lowering, so a query is never lowered with an unresolved
 * context in practice). This must be applied to every expression that can reach the SPARQL
 * algebra, not just where-filters.
 */
const resolveContextRefs = (expr: IRExpression): IRExpression => {
  switch (expr.kind) {
    case 'reference_expr':
      if (expr.contextName) {
        return {kind: 'reference_expr', value: resolveContextId(expr.contextName, true)!};
      }
      return expr;
    case 'context_property_expr':
      if (expr.contextName) {
        return {kind: 'context_property_expr', contextIri: resolveContextId(expr.contextName, true)!, property: expr.property};
      }
      return expr;
    case 'binary_expr':
      return {...expr, left: resolveContextRefs(expr.left), right: resolveContextRefs(expr.right)};
    case 'in_expr':
      return {
        ...expr,
        value: resolveContextRefs(expr.value),
        source: {list: expr.source.list.map(resolveContextRefs)},
      };
    case 'logical_expr':
      return {...expr, expressions: expr.expressions.map(resolveContextRefs)};
    case 'not_expr':
      return {...expr, expression: resolveContextRefs(expr.expression)};
    case 'function_expr':
    case 'aggregate_expr':
      return {...expr, args: expr.args.map(resolveContextRefs)};
    case 'exists_expr':
      return expr.filter ? {...expr, filter: resolveContextRefs(expr.filter)} : expr;
    default:
      return expr;
  }
};

const lowerWhere = (
  where: CanonicalWhereExpression,
  ctx: AliasGenerator,
  options: PathLoweringOptions,
): IRExpression => {
  switch (where.kind) {
    case 'where_expression': {
      // ExpressionNode-based WHERE — resolve refs and return IRExpression directly
      const exprWhere = where as DesugaredExpressionWhere;
      return resolveContextRefs(resolveExpressionRefs(
        exprWhere.expressionNode.ir,
        exprWhere.expressionNode._refs,
        options.rootAlias,
        options.resolveTraversal,
        options.resolveOuter,
      ));
    }
    case 'where_exists_condition': {
      // ExistsCondition-based WHERE (from .some()/.every()/.none())
      const existsWhere = where as DesugaredExistsWhere;
      // Unless an inline filter says otherwise, this is the query's own where (or a mutation's,
      // a minus's, a group filter's): the root is the only node bound where its quantifiers are
      // tested.
      const rootAlias = options.rootAlias;
      return resolveContextRefs(lowerExistsCondition(existsWhere.existsCondition, ctx, {
        ...options,
        boundOuterPrefix: options.boundOuterPrefix ?? (() => ({alias: rootAlias, consumed: 0})),
      }));
    }
    default:
      const _exhaustive: never = where;
      throw new Error(`Unknown canonical where kind: ${(_exhaustive as {kind: string}).kind}`);
  }
};

/**
 * A filter's identity for sharing its traversal: the filter lowered on placeholder aliases (`$m`
 * for the member). Two steps under equal filters share a traversal, as they did when every step
 * shared one; undefined (never shared) when it cannot be lowered here, which the real lowering
 * then reports.
 */
const filterSignature = (where: DesugaredWhere): string | undefined => {
  let counter = 0;
  try {
    return JSON.stringify(lowerWhere(where as CanonicalWhereExpression, {generateAlias: () => `$x${counter++}`}, {
      rootAlias: '$m',
      resolveTraversal: (from, property) => `${from}/${property}`,
      resolveOuter: (segments) => `$outer/${segments.join('/')}`,
    }));
  } catch {
    return undefined;
  }
};

/** The nodes in `hops` an expression reads (a property of, or the node itself); not inside an EXISTS. */
const hopsReadBy = (expr: IRExpression, hops: ReadonlySet<string>, out: Set<string> = new Set()): Set<string> => {
  switch (expr.kind) {
    case 'property_expr':
      if (hops.has(expr.sourceAlias)) out.add(expr.sourceAlias);
      break;
    case 'alias_expr':
      if (hops.has(expr.alias)) out.add(expr.alias);
      break;
    case 'binary_expr':
      hopsReadBy(expr.left, hops, out);
      hopsReadBy(expr.right, hops, out);
      break;
    case 'in_expr':
      hopsReadBy(expr.value, hops, out);
      for (const e of expr.source.list) hopsReadBy(e, hops, out);
      break;
    case 'logical_expr':
      for (const e of expr.expressions) hopsReadBy(e, hops, out);
      break;
    case 'not_expr':
      hopsReadBy(expr.expression, hops, out);
      break;
    case 'function_expr':
    case 'aggregate_expr':
      for (const e of expr.args) hopsReadBy(e, hops, out);
      break;
    default:
      break;
  }
  return out;
};

/**
 * Under a negated quantifier (`every` is `NOT EXISTS(member, NOT P)`; also a filtered `every`,
 * `F AND NOT P`), each `NOT P` that reads a hop of the predicate's own becomes
 * `NOT P || (hop missing && NOT COALESCE(P, false))`: a member without the hop, for which P is not
 * true, is a counterexample (P on an unbound hop is an error, which `NOT P` would let pass). A `NOT`
 * conjunct reading no hop, and a member without a leaf property, are unchanged.
 */
const guardMissingHops = (filter: IRExpression, hops: ReadonlySet<string>): IRExpression => {
  if (hops.size === 0) return filter;
  if (filter.kind === 'logical_expr' && filter.operator === 'and') {
    return {...filter, expressions: filter.expressions.map((e) => guardMissingHops(e, hops))};
  }
  if (filter.kind !== 'not_expr') return filter;
  const read = [...hopsReadBy(filter.expression, hops)];
  if (read.length === 0) return filter;
  const missing: IRExpression[] = read.map((alias) => ({
    kind: 'not_expr',
    expression: {kind: 'function_expr', name: 'BOUND', args: [{kind: 'alias_expr', alias}]},
  }));
  return {
    kind: 'logical_expr',
    operator: 'or',
    expressions: [
      filter,
      {
        kind: 'logical_expr',
        operator: 'and',
        expressions: [
          missing.length === 1 ? missing[0] : {kind: 'logical_expr', operator: 'or', expressions: missing},
          {
            kind: 'not_expr',
            expression: {kind: 'function_expr', name: 'COALESCE', args: [filter.expression, {kind: 'literal_expr', value: false}]},
          },
        ],
      },
    ],
  };
};

/**
 * Lower an ExistsCondition to IRExistsExpression with proper traversal patterns.
 */
const lowerExistsCondition = (
  condition: ExistsCondition,
  ctx: AliasGenerator,
  options: PathLoweringOptions,
): IRExpression => {
  // Build traversal patterns for the collection path
  const {resolve: existsResolve, patterns: traversals} = createTraversalResolver(
    () => ctx.generateAlias(),
    (from, to, property): IRTraversePattern => ({kind: 'traverse', from, to, property}),
  );

  // Walk the path segments to create traversal patterns, from the enclosing callback's subject or,
  // for a relation of the outer subject or an enclosing member (`p.pets.some(…)` inside
  // `p.friends.some((f) => …)`), from that node.
  let currentAlias = options.rootAlias;
  const outerRoot = condition.outerRoot;
  if (outerRoot) {
    if (outerRoot === 'unscoped' || !options.resolveOuter) {
      throw new Error(
        `A quantifier on ${condition.pathSegmentIds.map(labelOfId).join('.')} is written inside another ` +
        'callback, on a node that is not in scope there.',
      );
    }
    currentAlias = 'prefix' in outerRoot
      ? options.resolveOuter(outerRoot.prefix)
      : options.resolveOuter([], outerRoot.up);
  }
  for (const segmentId of condition.pathSegmentIds) {
    currentAlias = existsResolve(currentAlias, segmentId);
  }
  const memberPathLength = traversals.length;

  // A path the predicate reads from outside its member: from the query root, along the nodes
  // bound where the EXISTS is tested, or from an enclosing member (bound there too, as EXISTS
  // substitutes the outer bindings). The rest of the path is traversed inside this EXISTS, by
  // traversals of its own: `p.friends.name` read in `p.friends.some(…)` is any friend's name, never
  // the member's.
  const scopeAliases = [...(options.scopeAliases ?? []), currentAlias];
  const boundOuterPrefix = options.boundOuterPrefix;
  const {resolve: outerResolve, patterns: outerTraversals} = createTraversalResolver(
    () => ctx.generateAlias(),
    (from, to, property): IRTraversePattern => ({kind: 'traverse', from, to, property}),
  );
  const resolveOuter: OuterReferenceResolver = (segmentIds, scopesUp) => {
    let alias: string | undefined;
    let rest: readonly string[] = segmentIds;
    if (scopesUp === undefined) {
      if (!boundOuterPrefix) {
        throw new Error(
          `A quantifier (some/every/none) reads a path of the outer subject ` +
          `(${segmentIds.map(labelOfId).join('.') || 'the subject itself'}) where the subject is not in scope.`,
        );
      }
      const prefix = boundOuterPrefix(segmentIds);
      alias = prefix.alias;
      rest = segmentIds.slice(prefix.consumed);
    } else {
      alias = scopesUp >= 1 ? scopeAliases[scopeAliases.length - 1 - scopesUp] : undefined;
      if (alias === undefined) {
        throw new Error(
          'A quantifier (some/every/none) reads a path of an enclosing member that is not in scope ' +
          `(${segmentIds.map(labelOfId).join('.') || 'the member itself'}).`,
        );
      }
    }
    for (const segmentId of rest) alias = outerResolve(alias, segmentId);
    return alias;
  };
  const predicateOptions: PathLoweringOptions = {
    rootAlias: currentAlias,
    resolveTraversal: existsResolve,
    resolveOuter,
    boundOuterPrefix,
    scopeAliases,
  };

  // Resolve the inner predicate's property refs against the EXISTS scope; an inner quantifier
  // is an EXISTS of its own, rooted at the member.
  let filter = isLinkedInstance(condition.predicate, ExistsCondition)
    ? lowerExistsCondition(condition.predicate, ctx, predicateOptions)
    : resolveExpressionRefs(
      condition.predicate.ir,
      condition.predicate._refs,
      currentAlias,
      existsResolve,
      resolveOuter,
    );
  refuseAggregateIn('a quantifier (some/every/none)', filter);
  // `every` (NOT EXISTS a member where the predicate fails): a member that lacks a hop the
  // predicate reads (`f.bestFriend` in `f.bestFriend.name.equals('Erik')`) does not satisfy it, so
  // it is a counterexample unless the predicate holds anyway (another `||` branch).
  if (condition.negated && filter) {
    filter = guardMissingHops(filter, new Set(traversals.slice(memberPathLength).map((t) => t.to)));
  }

  const existsTraversals = [...traversals, ...outerTraversals];
  let existsExpr: IRExpression = {
    kind: 'exists_expr',
    pattern: existsTraversals.length === 1
      ? existsTraversals[0]
      : {kind: 'join', patterns: existsTraversals},
    filter,
    // The predicate's own traversals and the outer ones are needed only where the filter needs them.
    ...(existsTraversals.length > memberPathLength ? {member: currentAlias} : {}),
  };

  // Wrap in NOT if negated (.none() or outer NOT of .every())
  if (condition.negated) {
    existsExpr = {kind: 'not_expr', expression: existsExpr};
  }

  // Handle .and()/.or() chaining
  if (condition.chain.length > 0) {
    let result: IRExpression = existsExpr;
    for (const link of condition.chain) {
      let rightExpr: IRExpression;
      if (isLinkedInstance(link.condition, ExistsCondition)) {
        rightExpr = lowerExistsCondition(link.condition, ctx, options);
      } else {
        rightExpr = resolveExpressionRefs(
          link.condition.ir,
          link.condition._refs,
          options.rootAlias,
          options.resolveTraversal,
          options.resolveOuter,
        );
      }
      result = {
        kind: 'logical_expr',
        operator: link.op,
        expressions: [result, rightExpr],
      };
    }
    return result;
  }

  return existsExpr;
};

const combineWithParentPath = (
  parentPath: DesugaredStep[],
  path: DesugaredSelectionPath,
): DesugaredSelectionPath => ({
  kind: 'selection_path',
  steps: [...parentPath, ...path.steps],
});

/**
 * Lowers a canonical desugared select query into the final IRSelectQuery.
 * Introduces aliases, graph patterns (shape scans, traversals), and
 * converts selection paths and where-clauses into IR expressions.
 */
export const lowerSelectQuery = (
  canonical: CanonicalDesugaredSelectQuery,
): IRSelectQuery => {
  const ctx = new LoweringContext();
  const pathOptions: PathLoweringOptions = {
    rootAlias: ctx.rootAlias,
    resolveTraversal: (fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number, where?: DesugaredWhere) =>
      where
        ? ctx.getOrCreateFilteredTraversal(fromAlias, propertyShapeId, filterSignature(where), pathExpr, maxCount)
        : ctx.getOrCreateTraversal(fromAlias, propertyShapeId, pathExpr, maxCount),
  };

  const root: IRShapeScanPattern = {
    kind: 'shape_scan',
    shape: canonical.shapeId || '',
    alias: ctx.rootAlias,
  };

  const aliasAfterPath = (steps: DesugaredStep[]): string => {
    let currentAlias = pathOptions.rootAlias;
    for (const step of steps) {
      if (step.kind === 'property_step') {
        currentAlias = pathOptions.resolveTraversal(currentAlias, step.propertyShapeId, step.pathExpr, step.maxCount, step.where);
        // A filtered step (a sub-select of `p.friends.where(…)` whose fields are computed, or
        // paginated): its traversal carries the filter, whichever field lowers it first.
        if (step.where) inlineFilterHandler(currentAlias, step.where);
      }
    }
    return currentAlias;
  };

  // `context` holds the inner pagination of the sub-selects around a field, by the depth of the
  // relation it applies to, so a field is a duplicate of another only when that matches too.
  // `row` is the row the field is selected in: the root, or the member row of the innermost
  // sub-select around it (its steps from the root, and whether some sub-select around it is keyed).
  const collectProjectionSeeds = (
    selection: DesugaredSelection,
    key?: string,
    parentPath: DesugaredStep[] = [],
    context: Record<number, string> = {},
    row: SeedRow = {steps: [], underKey: false, groups: []},
  ): ProjectionSeed[] => {
    if (selection.kind === 'selection_path') {
      return [{
        kind: 'path',
        path: combineWithParentPath(parentPath, selection),
        key,
        context,
        row,
      }];
    }

    if (selection.kind === 'sub_select') {
      const combinedParentPath = [...parentPath, ...selection.parentPath];
      // Nested-select inner LIMIT/OFFSET/ORDER BY → attach to the root→child
      // traverse (the alias reached by walking combinedParentPath). The serializer
      // wraps that traverse in a SPARQL sub-SELECT. Single-subject is enforced in
      // irToAlgebra; here we only record the intent.
      const hasInnerPagination =
        typeof selection.innerLimit === 'number' ||
        typeof selection.innerOffset === 'number' ||
        (selection.innerOrderBy && selection.innerOrderBy.length > 0);
      let innerContext = context;
      if (hasInnerPagination) {
        const childAlias = aliasAfterPath(combinedParentPath);
        const pagination = {
          limit: selection.innerLimit,
          offset: selection.innerOffset,
          orderBy: selection.innerOrderBy?.map((o) => ({
            property: o.propertyShapeId,
            direction: o.direction,
          })),
        };
        ctx.attachInnerPagination(childAlias, pagination);
        innerContext = {...context, [combinedParentPath.length]: JSON.stringify(pagination)};
      }
      // The fields of a sub-select are fields of its member row. A keyed sub-select holds those
      // rows under its key (a `members` seed); an unkeyed one nests them under its relation.
      const memberRow: SeedRow = {
        steps: combinedParentPath,
        underKey: row.underKey || !!key,
        groups: key ? [...row.groups, {key, steps: combinedParentPath, context: innerContext}] : row.groups,
      };
      const members: ProjectionSeed[] = key
        ? [{kind: 'members', key, path: combinedParentPath, context: innerContext, row}]
        : [];
      return [
        ...members,
        // The enclosing key names the sub-select's member rows; the fields inside keep their own
        // keys. This also covers one-element array selections, which desugaring intentionally
        // collapses to a single selection.
        ...collectProjectionSeeds(selection.selections, undefined, combinedParentPath, innerContext, memberRow),
      ];
    }

    if (selection.kind === 'custom_object_select') {
      return selection.entries.flatMap((entry) =>
        collectProjectionSeeds(entry.value, entry.key, parentPath, context, row),
      );
    }

    if (selection.kind === 'multi_selection') {
      return selection.selections.flatMap((nestedSelection) =>
        // A key on the enclosing selection names that selection; it must not
        // replace the individual keys of an array/multi-selection. Each child
        // derives its own key from its terminal property (or carries its own
        // explicit custom key).
        collectProjectionSeeds(nestedSelection, undefined, parentPath, context, row),
      );
    }

    if (selection.kind === 'expression_select') {
      const exprSelect = selection as DesugaredExpressionSelect;
      // Resolve property refs AND any {@ctx} context references — a projected
      // expression (e.g. `select(p => ({flag: p.x.equals(getQueryContext('user'))}))`)
      // reaches the SPARQL algebra just like a where-filter, so its context refs
      // must be resolved here too, not only in lowerWhere.
      const resolved = resolveContextRefs(resolveExpressionRefs(
        exprSelect.expressionNode.ir,
        exprSelect.expressionNode._refs,
        aliasAfterPath(parentPath),
        pathOptions.resolveTraversal,
      ));
      return [{
        kind: 'expression',
        // An unkeyed expression (DSL-JSON without `customKey`/`as`) is the field `expr`.
        key: key || 'expr',
        keyed: !!key,
        expression: resolved,
        groupPath: parentPath,
        context,
        row,
      }];
    }

    return [];
  };

  // An exact duplicate field is dropped; two different fields under one key are refused here,
  // before their paths are lowered (and their inline filters attached).
  const projectionSeeds = dedupeProjectionSeeds(canonical.selections.flatMap((selection) =>
    collectProjectionSeeds(selection),
  ));

  const projectionScope = new IRAliasScope('projection');
  projectionScope.registerAlias(ctx.rootAlias, 'root');
  const projection: IRProjectionItem[] = [];
  const resultMapEntries: IRResultMapEntry[] = [];

  // Inline filter handler: when a property step has `.where()`, canonicalize
  // and lower the where predicate, then attach it to the traverse pattern.
  function inlineFilterHandler(traverseAlias: string, where: DesugaredWhere): void {
    // A filtered traversal is shared only under an equal filter, already lowered and attached.
    if (ctx.hasFilter(traverseAlias)) return;
    const ancestors = ancestorTraversalsOf(traverseAlias);
    // A path the filter reads below its member (`f.bestFriend.name`) is a traversal of the filter's
    // own, never shared with a projection's: it is placed inside the filtered block (OPTIONAL
    // there), and a projected `f.bestFriend` keeps every best friend.
    const own = new Map<string, string>();
    const resolveOwnTraversal = (fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number) => {
      const key = `${fromAlias}:${propertyShapeId}`;
      let alias = own.get(key);
      if (alias === undefined) {
        alias = ctx.createTraversal(fromAlias, propertyShapeId, pathExpr, maxCount);
        own.set(key, alias);
      }
      return alias;
    };
    const filterExpr = lowerWhere(where, ctx, {
      rootAlias: traverseAlias,
      resolveTraversal: resolveOwnTraversal,
      resolveOuter: outerResolverFor(ancestors),
      boundOuterPrefix: (segments) => walkAncestors(ancestors, segments),
      scopeAliases: [traverseAlias],
    });
    refuseAggregateIn('an inline filter (`.where()` on a relation)', filterExpr);
    ctx.attachFilter(traverseAlias, filterExpr);
  }

  // The traversals that lead to a filtered one (from its source up to the root): the aliases
  // bound around the filter's block.
  function ancestorTraversalsOf(filteredAlias: string): IRTraversePattern[] {
    const ancestors: IRTraversePattern[] = [];
    for (let from = ctx.traversalTo(filteredAlias)?.from; from && from !== ctx.rootAlias; ) {
      const pattern = ctx.traversalTo(from);
      if (!pattern) break;
      ancestors.push(pattern);
      from = pattern.from;
    }
    return ancestors;
  }

  // How far a path from the root walks along those traversals.
  function walkAncestors(ancestors: IRTraversePattern[], segments: readonly string[]): {alias: string; consumed: number} {
    let alias = ctx.rootAlias;
    let consumed = 0;
    for (const segment of segments) {
      const next = ancestors.find((p) => p.from === alias && p.property === segment);
      if (!next) break;
      alias = next.to;
      consumed++;
    }
    return {alias, consumed};
  }

  // A path an inline filter reads from the outer subject (`p.name`, `p.bestFriend`) resolves along
  // the traversals that lead to the filtered one, never a traversal of its own: those are the
  // aliases bound around the filter's block. Anything else is refused, never compared with the
  // member itself. (A quantifier inside the filter may traverse further, inside its EXISTS.)
  function outerResolverFor(ancestors: IRTraversePattern[]): OuterReferenceResolver {
    return (segments, scopesUp) => {
      const {alias, consumed} = walkAncestors(ancestors, segments);
      if (scopesUp !== undefined || consumed < segments.length) {
        throw new Error(
          `A filter reads a path from outside its own member (${segments.map(labelOfId).join('.')}) ` +
          'that is not a hop above the filtered relation. An inline filter can read the outer ' +
          'subject and the hops above the filtered relation (`p.bestFriend.friends.where((f) => ' +
          'f.name.equals(p.bestFriend.name))`), not another path.',
        );
      }
      return alias;
    };
  }

  // The alias of a seed's row: the member alias of its innermost sub-select (traversed already by
  // the seed's own path or its members seed, so this shares that traversal), or the root.
  const containerOf = (row: SeedRow): {container: string} => ({
    container: row.steps.length === 0 ? ctx.rootAlias : aliasAfterPath(row.steps),
  });

  // The traversal a members seed holds the rows of, with any inline filter on its steps attached
  // (the filter of `p.friends.where(…).select(…)` belongs to the members whatever fields follow).
  const membersAlias = (steps: DesugaredStep[]): string => {
    let alias = ctx.rootAlias;
    for (const step of steps) {
      if (step.kind !== 'property_step') continue;
      alias = pathOptions.resolveTraversal(alias, step.propertyShapeId, step.pathExpr, step.maxCount, step.where);
      if (step.where) inlineFilterHandler(alias, step.where);
    }
    return alias;
  };

  /**
   * A size() counts the members of its relation, per row. Its members are a traversal another
   * field may read too (`{fn: p.friends.name, c: p.friends.size()}`), and a variable that field
   * projects is a GROUP BY key of the select, which would split the count per value (each group
   * would count one friend). Such a count reads a traversal of its own (filtered like the counted
   * relation): every group of a row then sees all of its members.
   */
  function countOverOwnTraversals(counted: {index: number; steps: DesugaredStep[]}[]): void {
    if (counted.length === 0) return;
    const countIndexes = new Set(counted.map((c) => c.index));
    // The aliases the other fields read (and the traversals leading to them), and the rows.
    const read = new Set<string>();
    const markUp = (alias: string | undefined) => {
      for (let a = alias; a && a !== ctx.rootAlias && !read.has(a); a = ctx.traversalTo(a)?.from) read.add(a);
    };
    const collect = (expr: IRExpression): void => {
      if (expr.kind === 'property_expr') markUp(expr.sourceAlias);
      else if (expr.kind === 'alias_expr') markUp(expr.alias);
      for (const value of Object.values(expr)) {
        if (Array.isArray(value)) value.forEach((v) => v && typeof v === 'object' && 'kind' in v && collect(v as IRExpression));
        else if (value && typeof value === 'object' && 'kind' in value) collect(value as IRExpression);
      }
    };
    projection.forEach((item, i) => {
      if (!countIndexes.has(i)) collect(item.expression);
    });
    for (const entry of resultMapEntries) {
      markUp(entry.container);
      if (entry.members) markUp(entry.alias);
    }
    for (const {index, steps} of counted) {
      const aggregate = projection[index].expression;
      if (aggregate.kind !== 'aggregate_expr' || aggregate.args.length !== 1) continue;
      const arg = aggregate.args[0];
      const countStep = steps[steps.length - 1] as Extract<DesugaredStep, {kind: 'count_step'}>;
      const step = countStep.path[0];
      if (!step) continue;
      const source = arg.kind === 'property_expr' ? arg.sourceAlias : ctx.traversalTo((arg as {alias: string}).alias)?.from;
      const shared = arg.kind === 'property_expr'
        ? ctx.existingTraversal(arg.sourceAlias, arg.property)
        : arg.kind === 'alias_expr' ? arg.alias : undefined;
      if (!source || !shared || !read.has(shared)) continue;
      const own = ctx.createTraversal(source, step.propertyShapeId, step.pathExpr, step.maxCount);
      if (step.where) inlineFilterHandler(own, step.where);
      projection[index] = {...projection[index], expression: {...aggregate, args: [{kind: 'alias_expr', alias: own}]}};
    }
  }

  /**
   * A keyed sub-select's members are a traversal shared with any other read of that relation, so
   * the member alias names the keyed rows. A field placed in a row reached through those members
   * but not selected under that key (a `.preload('friends', c)` beside `{x: p.friends.select(…)}`)
   * would land inside the keyed rows: refused, naming both.
   */
  function fieldName(seed: ProjectionSeed): string {
    return seed.kind === 'path' && !seed.key ? labelOfId(projectionKeyFromPath(seed.path)) : seed.key!;
  }

  function refuseRowsSharedWithAKey(): void {
    const keyOfMembers = new Map<string, {key: string; seed: ProjectionSeed}>();
    for (const {seed, container} of placed) {
      if (seed.kind === 'members') {
        const members = resultMapEntries.find((e) => e.members && e.key === seed.key && e.container === container);
        if (members) keyOfMembers.set(members.alias, {key: seed.key, seed});
      }
    }
    if (keyOfMembers.size === 0) return;
    for (const {seed, container} of placed) {
      for (let alias: string | undefined = container; alias && alias !== ctx.rootAlias; alias = ctx.traversalTo(alias)?.from) {
        const owner = keyOfMembers.get(alias);
        if (!owner || owner.seed === seed) continue;
        const inside = seed.row.groups.some((group) => aliasAfterPath(group.steps) === alias);
        if (!inside) {
          const relation = (owner.seed as Extract<ProjectionSeed, {kind: 'members'}>).path
            .map((step) => (step.kind === 'property_step' ? labelOfId(step.propertyShapeId) : '')).filter(Boolean).join('.');
          throw new Error(
            `Select: "${relation}" is selected under the key "${owner.key}" and, apart from it, nested under ` +
            `its own name (a preload or an unkeyed sub-select of it, for "${fieldName(seed)}"); one select ` +
            `cannot hold both rows of one relation yet. Select it once, or put both under one key.`,
          );
        }
      }
    }
  }

  const placed: {seed: ProjectionSeed; container: string}[] = [];
  const counts: {index: number; steps: DesugaredStep[]}[] = [];
  for (const seed of projectionSeeds) {
    if (seed.kind === 'members') {
      const entry: IRResultMapEntry = {
        key: seed.key,
        alias: membersAlias(seed.path),
        ...containerOf(seed.row),
        keyed: true,
        members: true,
      };
      resultMapEntries.push(entry);
      placed.push({seed, container: entry.container!});
      continue;
    }
    const key = seed.kind === 'path'
      ? (seed.key || projectionKeyFromPath(seed.path))
      : seed.key;
    const alias = projectionScope.generateAlias(key).alias;
    const expression = seed.kind === 'path'
      ? lowerSelectionPathExpression(seed.path, pathOptions, inlineFilterHandler)
      : seed.expression;
    if (seed.kind === 'path' && seed.path.steps[seed.path.steps.length - 1]?.kind === 'count_step') {
      counts.push({index: projection.length, steps: seed.path.steps});
    }
    projection.push({alias, expression});
    // Where the field sits (see `IRResultMapEntry`): a keyed field in the row it is written in; an
    // unkeyed one there only inside a keyed sub-select, or when it is computed per member (an
    // expression or aggregate inside a sub-select); otherwise under its hops from the root.
    const keyed = seed.kind === 'path' ? !!seed.key : seed.keyed;
    const perMember = expression.kind !== 'property_expr' && expression.kind !== 'alias_expr' && seed.row.steps.length > 0;
    const entry: IRResultMapEntry = {
      key,
      alias,
      ...(keyed || seed.row.underKey || perMember ? containerOf(seed.row) : {}),
      ...(keyed ? {keyed: true as const} : {}),
    };
    resultMapEntries.push(entry);
    if (entry.container) placed.push({seed, container: entry.container});
  }
  refuseRowsSharedWithAKey();

  if (!canonical.group) countOverOwnTraversals(counts);

  // The where shares the projection's traversals, except a nested select's page (see
  // `conditionResolver`).
  const conditionOptions: PathLoweringOptions = {...pathOptions, resolveTraversal: ctx.conditionResolver()};
  const where = canonical.where ? lowerWhere(canonical.where, ctx, conditionOptions) : undefined;

  // A grouped select: its keys, group filter and order name result fields; each resolves to
  // the expression that field projects, so GROUP BY, HAVING and ORDER BY bind the same variables.
  const group = canonical.group;
  const projectionOfKey = (key: string, use: string): IRExpression => {
    const entry = resultMapEntries.find((e) => e.key === key);
    const item = entry && projection.find((p) => p.alias === entry.alias);
    if (!item) throw new Error(`${use}: "${key}" is not a field of the select.`);
    return item.expression;
  };
  const groupBy = group ? group.keys.map((key) => projectionOfKey(key, 'groupBy')) : undefined;
  const having = group?.having ? lowerWhere(group.having, ctx, conditionOptions) : undefined;

  // A sort key shares the traversals of the projection and the where, except where the filters
  // differ: a step the key filters (`p.friends.where(…).hobby`), or one whose shared traversal a
  // filtered or paginated projection holds, gets a traversal of its own. Otherwise the key would sort by
  // members another filter chose, or filter the projection by its own.
  const lowerSortKey = (key: DesugaredSelectionPath | DesugaredExpressionSelect): IRExpression => {
    const steps = key.kind === 'selection_path' ? key.steps : [];
    let call = 0;
    const resolveTraversal = (fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number) => {
      const step = steps[call++];
      const filtered = step?.kind === 'property_step' && !!step.where;
      const shared = ctx.existingTraversal(fromAlias, propertyShapeId);
      return filtered || (shared !== undefined && (ctx.hasFilter(shared) || ctx.hasPagination(shared)))
        ? ctx.createTraversal(fromAlias, propertyShapeId, pathExpr, maxCount)
        : ctx.getOrCreateTraversal(fromAlias, propertyShapeId, pathExpr, maxCount);
    };
    if (key.kind === 'expression_select') {
      return resolveContextRefs(resolveExpressionRefs(
        key.expressionNode.ir,
        key.expressionNode._refs,
        ctx.rootAlias,
        resolveTraversal,
      ));
    }
    return lowerSelectionPathExpression(key, {rootAlias: ctx.rootAlias, resolveTraversal}, inlineFilterHandler);
  };
  const orderBy: IROrderByItem[] | undefined = group
    ? group.orderBy?.map((o) => ({expression: projectionOfKey(o.key, 'orderBy'), direction: o.direction}))
    : canonical.sortBy
      ? canonical.sortBy.keys.map((key, i) => ({
          expression: lowerSortKey(key),
          direction: canonical.sortBy!.directions[i],
        }))
      : undefined;

  // Lower MINUS entries → IRMinusPattern objects
  const minusPatterns: IRGraphPattern[] = [];
  if (canonical.minusEntries) {
    for (const entry of canonical.minusEntries) {
      if (entry.shapeId) {
        // Shape exclusion: MINUS { ?a0 a <Shape> }
        minusPatterns.push({
          kind: 'minus',
          pattern: {kind: 'shape_scan', shape: entry.shapeId, alias: ctx.rootAlias},
        });
      } else if (entry.propertyPaths && entry.propertyPaths.length > 0) {
        // Property existence exclusion: MINUS { ?a0 <prop1> ?m0 . ?a0 <prop2> ?m1 . }
        // Supports nested paths: ?a0 <bestFriend> ?m0 . ?m0 <name> ?m1 .
        const traversals: IRTraversePattern[] = [];
        for (const path of entry.propertyPaths) {
          let currentAlias = ctx.rootAlias;
          for (const segment of path) {
            const toAlias = ctx.generateAlias();
            traversals.push({
              kind: 'traverse',
              from: currentAlias,
              to: toAlias,
              property: segment.propertyShapeId,
            });
            currentAlias = toAlias;
          }
        }
        const innerPattern: IRGraphPattern = traversals.length === 1
          ? traversals[0]
          : {kind: 'join', patterns: traversals};
        minusPatterns.push({kind: 'minus', pattern: innerPattern});
      } else if (entry.where) {
        // Condition-based exclusion: MINUS { ?a0 <prop> ?val . FILTER(...) }
        const {resolve: minusResolveTraversal, patterns: minusTraversals} = createTraversalResolver(
          () => ctx.generateAlias(),
          (from, to, property): IRTraversePattern => ({kind: 'traverse', from, to, property}),
        );
        const minusOptions: PathLoweringOptions = {
          rootAlias: ctx.rootAlias,
          resolveTraversal: minusResolveTraversal,
        };
        const filter = lowerWhere(entry.where, ctx, minusOptions);
        refuseAggregateIn('minus()', filter);
        const innerPattern: IRGraphPattern = minusTraversals.length === 1
          ? minusTraversals[0]
          : minusTraversals.length > 1
            ? {kind: 'join', patterns: minusTraversals}
            : {kind: 'shape_scan', shape: canonical.shapeId || '', alias: ctx.rootAlias};
        minusPatterns.push({kind: 'minus', pattern: innerPattern, filter});
      }
    }
  }

  return attachCatalog<IRSelectQuery>({
    kind: 'select',
    root,
    patterns: [...ctx.getPatterns(), ...minusPatterns],
    projection,
    where,
    orderBy,
    limit: canonical.limit,
    offset: canonical.offset,
    subjectId: canonical.subjectId,
    subjectIds: canonical.subjectIds,
    singleResult: canonical.singleResult,
    resultMap: resultMapEntries,
    ...(groupBy ? {groupBy} : {}),
    ...(having ? {having} : {}),
    ...requiresOf([...projection.map((p) => p.expression), where, having], !!groupBy),
  });
};

/** `requires` for a lowered select: present only when it needs a feature beyond the baseline. */
const requiresOf = (
  expressions: (IRExpression | undefined)[],
  grouped: boolean,
): {requires?: QueryFeature[]} => {
  const requires = featuresOfExpressions(expressions, grouped);
  return requires.length > 0 ? {requires} : {};
};

/**
 * Standalone WHERE lowering — converts a CanonicalWhereExpression to IR expression + patterns.
 * Used by mutation builders (DeleteBuilder, UpdateBuilder) that don't go through the select pipeline.
 */
export const lowerWhereToIR = (
  where: CanonicalWhereExpression,
  rootAlias: string = 'a0',
): {where: IRExpression; wherePatterns: IRGraphPattern[]} => {
  let counter = 1; // start at 1 since a0 is the root
  const ctx: AliasGenerator = {
    generateAlias: () => `a${counter++}`,
  };

  const {resolve, patterns: traversals} = createTraversalResolver(
    () => ctx.generateAlias(),
    (from, to, property): IRTraversePattern => ({kind: 'traverse', from, to, property}),
  );

  const expr = lowerWhere(where, ctx, {rootAlias, resolveTraversal: resolve});
  return {where: expr, wherePatterns: traversals};
};
