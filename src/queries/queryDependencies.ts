/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Dependency helpers for live queries.
 *
 * Two pure functions that describe, in terms of **predicate IRIs**, what a query
 * reads ({@link queryDependencies}) and what a mutation writes
 * ({@link mutationEffects}). A live-query store feeds both into its change matcher:
 * a query is re-run when a mutation writes a predicate the query depends on, on a
 * node the query can see.
 *
 * Both work on the canonical IR (`lower(query)`), where every property is a
 * property-SHAPE id. Each one is resolved to the predicate(s) it is declared with
 * (`sh:path`), so two shapes that share a predicate — `Person.name` and `Team.name`
 * both on `schema:name` — describe the same dependency, and a structured path
 * (`^member`, `knows/name`) contributes every predicate it touches.
 */
import {lower} from './lower.js';
import type {
  LowerableAsk,
  LowerableCount,
  LowerableCreate,
  LowerableDelete,
  LowerableSelect,
  LowerableUpdate,
} from './lower.js';
import type {
  IRAskQuery,
  IRCountQuery,
  IRExpression,
  IRFieldValue,
  IRGraphPattern,
  IRNodeData,
  IRPropertyExpression,
  IRSelectQuery,
  IRTraversePattern,
} from './IntermediateRepresentation.js';
import type {IRCreateQuery} from './CreateQuery.js';
import type {IRUpdateQuery} from './UpdateQuery.js';
import type {IRDeleteQuery} from './DeleteQuery.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';
import {getSimplePathId} from '../paths/normalizePropertyPath.js';
import {collectPathUris} from '../paths/pathExprToSparql.js';
import {
  findPropertyShapeById,
  getPropertyShapes,
  type NodeShapeData,
} from '../shapes/nodeShapeData.js';
import {
  getAllNodeShapes,
  getNodeShape,
  getRegistryVersion,
  getShapeClass,
} from '../utils/ShapeClass.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type QueryDependencies = {
  /** Predicates read on nodes whose ids appear in the result (root row + projected relation rows). */
  narrow: Set<string>;
  /** Predicates deciding membership/order: where, scoped where, minus, exists, sortBy, inner orderBy. */
  filter: Set<string>;
  /**
   * Predicates read on nodes whose ids are NOT projected: `size()` / aggregates over
   * relations, computed values over traversals, traversals with no projected id.
   */
  hidden: Set<string>;
  /**
   * Shape IRIs the query is pinned to: the root scan, nested shape scans (minus by
   * shape), and — for every property read — the shape declaring it and the value
   * shape it points at.
   */
  shapes: Set<string>;
  /** `false` when the query is bound to subjects (`.for` / `.forAll` / a resolved context). */
  unbound: boolean;
};

export type MutationEffects = {
  op: 'create' | 'update' | 'upsert' | 'delete';
  /** Routing shape IRI. */
  shape: string;
  /** Predicates written (nested node descriptions and add/remove relations included); for delete: every predicate of the shape. */
  props: Set<string>;
  /**
   * Affected node ids: the target id(s), nested created nodes, removed references, and every
   * `id` found anywhere in `result` (conservative: a reference echoed in the result counts).
   * `undefined` = unknown (`update_where`, `delete_all`, `delete_where`).
   */
  ids?: Set<string>;
  /** Shapes whose instance set may have changed: the target shape for create/upsert/delete + shapes of nested created nodes; empty for a plain update. */
  membership: Set<string>;
};

// ---------------------------------------------------------------------------
// Predicate resolution
// ---------------------------------------------------------------------------

/**
 * The predicate IRI(s) a property-shape id reads or writes.
 *
 * An inline `pathExpr` wins (it IS the path). Otherwise the registered property
 * shape's `sh:path`: a simple path is one predicate, a structured path every IRI
 * it mentions. An unknown id falls back to the id itself — never empty, so a
 * dependency is never silently dropped.
 */
function predicatesOf(propertyShapeId: string, pathExpr?: PathExpr): string[] {
  if (pathExpr) {
    const uris = collectPathUris(pathExpr);
    return uris.length ? uris : [propertyShapeId];
  }
  const propertyShape = findPropertyShapeById(propertyShapeId);
  if (!propertyShape) return [propertyShapeId];
  const simple = getSimplePathId(propertyShape.path);
  if (simple !== null) return [simple];
  const uris = collectPathUris(propertyShape.path);
  return uris.length ? uris : [propertyShapeId];
}

/** The value shape a property-shape id points at, if it is an object property. */
function valueShapeOf(propertyShapeId: string): string | undefined {
  return findPropertyShapeById(propertyShapeId)?.valueShape?.id;
}

// Owner lookups, cached on the same terms as `findPropertyShapeById`: successful
// resolutions only, invalidated by the registry version.
const declaringShapeCache = new Map<string, string>();
let declaringShapeCacheVersion = -1;

/**
 * The node shape that declares a property shape as its own.
 *
 * Reading a property pins the query to the shape it is declared on, even when the
 * IR carries no scan for it: `p.friends.as(Employee).employeeId` lowers to a plain
 * traversal plus a property read — the cast is type-level only — and the only
 * trace of `Employee` left is that `employeeId` is declared there.
 */
function declaringShapeOf(propertyShapeId: string): string | undefined {
  const version = getRegistryVersion();
  if (version !== declaringShapeCacheVersion) {
    declaringShapeCache.clear();
    declaringShapeCacheVersion = version;
  }
  const cached = declaringShapeCache.get(propertyShapeId);
  if (cached) return cached;
  for (const nodeShape of getAllNodeShapes().values()) {
    if (getPropertyShapes(nodeShape, false).some((ps) => ps.id === propertyShapeId)) {
      declaringShapeCache.set(propertyShapeId, nodeShape.id);
      return nodeShape.id;
    }
  }
  return undefined;
}

const addAll = (target: Set<string>, values: Iterable<string>): void => {
  for (const v of values) target.add(v);
};

// ---------------------------------------------------------------------------
// queryDependencies
// ---------------------------------------------------------------------------

type TraverseInfo = {
  pattern: IRTraversePattern;
  /** Sits under a `minus` / `exists` pattern: its predicates decide membership. */
  inFilter: boolean;
};

class DependencyCollector {
  readonly deps: QueryDependencies = {
    narrow: new Set(),
    filter: new Set(),
    hidden: new Set(),
    shapes: new Set(),
    unbound: true,
  };
  /** Every traverse, keyed by the alias it binds. */
  private readonly traverseByTo = new Map<string, TraverseInfo>();
  /** Traverses whose predicates were attributed to a set by a projection or a filter. */
  private readonly reached = new Set<IRTraversePattern>();
  /** Filter expressions found while walking patterns, with the alias their scope starts at. */
  private readonly scopedFilters: {expr: IRExpression; scope?: string}[] = [];

  // --- pass 1: patterns -------------------------------------------------------

  walkPattern(pattern: IRGraphPattern, inFilter: boolean): void {
    switch (pattern.kind) {
      case 'shape_scan':
        this.deps.shapes.add(pattern.shape);
        return;
      case 'traverse': {
        this.traverseByTo.set(pattern.to, {pattern, inFilter});
        this.recordShapesOf(pattern.property);
        if (pattern.filter) {
          // A scoped where (`t.members.where(m => …)`) decides which related rows
          // take part; its chain stops at the traversal it scopes, whose own
          // predicate is attributed wherever that traversal lands.
          this.scopedFilters.push({expr: pattern.filter, scope: pattern.to});
        }
        for (const order of pattern.innerOrderBy ?? []) {
          addAll(this.deps.filter, predicatesOf(order.property));
        }
        return;
      }
      case 'join':
        for (const p of pattern.patterns) this.walkPattern(p, inFilter);
        return;
      case 'optional':
        this.walkPattern(pattern.pattern, inFilter);
        return;
      case 'union':
        for (const p of pattern.branches) this.walkPattern(p, inFilter);
        return;
      case 'exists':
        this.walkPattern(pattern.pattern, true);
        return;
      case 'minus':
        this.walkPattern(pattern.pattern, true);
        if (pattern.filter) this.scopedFilters.push({expr: pattern.filter});
        return;
    }
  }

  // --- pass 2: attribution -----------------------------------------------------

  /**
   * The predicates of every traversal from `alias` back towards the root, stopping
   * before `stopAt` when given. Marks each traversal as reached.
   */
  chain(alias: string, stopAt?: string): string[] {
    const preds: string[] = [];
    const visited = new Set<string>();
    let current = alias;
    while (current !== stopAt && !visited.has(current)) {
      visited.add(current);
      const info = this.traverseByTo.get(current);
      if (!info) break;
      this.reached.add(info.pattern);
      preds.push(...predicatesOf(info.pattern.property, info.pattern.pathExpr));
      current = info.pattern.from;
    }
    return preds;
  }

  /** The shapes a property read pins the query to: its declaring shape and its value shape. */
  private recordShapesOf(propertyShapeId: string): void {
    const declaring = declaringShapeOf(propertyShapeId);
    if (declaring) this.deps.shapes.add(declaring);
    const valueShape = valueShapeOf(propertyShapeId);
    if (valueShape) this.deps.shapes.add(valueShape);
  }

  private propertyExprPredicates(expr: IRPropertyExpression, scope?: string): string[] {
    this.recordShapesOf(expr.property);
    return [...predicatesOf(expr.property, expr.pathExpr), ...this.chain(expr.sourceAlias, scope)];
  }

  /** Every predicate an expression decides membership or order by. */
  collectFilter(expr: IRExpression, scope?: string): void {
    switch (expr.kind) {
      case 'property_expr':
        addAll(this.deps.filter, this.propertyExprPredicates(expr, scope));
        return;
      case 'context_property_expr':
        addAll(this.deps.filter, predicatesOf(expr.property));
        return;
      case 'alias_expr':
        addAll(this.deps.filter, this.chain(expr.alias, scope));
        return;
      case 'exists_expr':
        this.walkPattern(expr.pattern, true);
        if (expr.filter) this.collectFilter(expr.filter, scope);
        return;
      default:
        for (const child of childExpressions(expr)) this.collectFilter(child, scope);
    }
  }

  /** A projected expression: plain paths are narrow, computed values hidden. */
  collectProjection(expr: IRExpression): void {
    switch (expr.kind) {
      case 'property_expr':
        addAll(this.deps.narrow, this.propertyExprPredicates(expr));
        return;
      case 'alias_expr':
        addAll(this.deps.narrow, this.chain(expr.alias));
        return;
      default:
        this.collectHidden(expr);
    }
  }

  private collectHidden(expr: IRExpression): void {
    switch (expr.kind) {
      case 'property_expr':
        addAll(this.deps.hidden, this.propertyExprPredicates(expr));
        return;
      case 'alias_expr':
        addAll(this.deps.hidden, this.chain(expr.alias));
        return;
      case 'context_property_expr':
        addAll(this.deps.filter, predicatesOf(expr.property));
        return;
      case 'exists_expr':
        this.collectFilter(expr);
        return;
      default:
        for (const child of childExpressions(expr)) this.collectHidden(child);
    }
  }

  /** Filters gathered while walking patterns (scoped where, minus filter). */
  flushScopedFilters(): void {
    // `collectFilter` on an exists expression may walk new patterns and push new
    // scoped filters, so drain until stable.
    while (this.scopedFilters.length) {
      const {expr, scope} = this.scopedFilters.shift()!;
      this.collectFilter(expr, scope);
    }
  }

  /** Traversals no projection or filter attributed: read, but their ids never surface. */
  attributeUnreached(): void {
    for (const {pattern, inFilter} of this.traverseByTo.values()) {
      if (this.reached.has(pattern)) continue;
      const target = inFilter ? this.deps.filter : this.deps.hidden;
      addAll(target, predicatesOf(pattern.property, pattern.pathExpr));
      // The traversal leading up to it is read on the same terms.
      addAll(target, this.chain(pattern.from));
    }
  }
}

/** The immediate sub-expressions of a compound expression (none for leaves). */
function childExpressions(expr: IRExpression): IRExpression[] {
  switch (expr.kind) {
    case 'binary_expr':
      return [expr.left, expr.right];
    case 'logical_expr':
      return expr.expressions;
    case 'not_expr':
      return [expr.expression];
    case 'function_expr':
    case 'aggregate_expr':
      return expr.args;
    case 'in_expr':
      return [expr.value, ...expr.source.list];
    default:
      return [];
  }
}

/** `lower()` is overloaded per builder kind; dispatch on the discriminator. */
function lowerQuery(
  query: LowerableSelect | LowerableCount | LowerableAsk,
): IRSelectQuery | IRCountQuery | IRAskQuery {
  switch (query.__queryKind) {
    case 'select':
      return lower(query);
    case 'count':
      return lower(query);
    case 'ask':
      return lower(query);
  }
}

function isBound(ir: {subjectId?: string; subjectIds?: string[]}): boolean {
  return !!(ir.subjectId || (ir.subjectIds && ir.subjectIds.length));
}

/**
 * What a query reads, as predicate IRIs and shape IRIs.
 *
 * - `narrow`: read on nodes whose ids are in the result (root rows and projected
 *   relation rows) — a change to one of these on a visible node changes the result.
 * - `filter`: decide which nodes are in the result and in what order.
 * - `hidden`: read on nodes the result does not identify (counted relations,
 *   computed values over traversals), so a change there can only be matched by
 *   predicate, not by id.
 * - `shapes`: every shape whose instance set the query scans or traverses into.
 * - `unbound`: `true` unless the query is pinned to known subjects.
 */
export function queryDependencies(
  query: LowerableSelect | LowerableCount | LowerableAsk,
): QueryDependencies {
  const ir = lowerQuery(query);
  const collector = new DependencyCollector();
  const deps = collector.deps;

  if (!ir.root) {
    // Shapeless ask: no rdf:type constraint, no properties — nothing is read but
    // the subject itself.
    deps.unbound = !ir.subjectId;
    return deps;
  }

  collector.walkPattern(ir.root, false);
  for (const pattern of ir.patterns) collector.walkPattern(pattern, false);

  if (ir.kind === 'select') {
    for (const item of ir.projection) collector.collectProjection(item.expression);
  }
  if (ir.where) collector.collectFilter(ir.where);
  if (ir.kind === 'select') {
    for (const order of ir.orderBy ?? []) collector.collectFilter(order.expression);
  }
  collector.flushScopedFilters();
  collector.attributeUnreached();

  deps.unbound = !isBound(ir);
  return deps;
}

// ---------------------------------------------------------------------------
// mutationEffects
// ---------------------------------------------------------------------------

const isNodeData = (value: unknown): value is IRNodeData =>
  !!value && typeof value === 'object' && 'fields' in value && 'shape' in value;

const isSetModification = (value: unknown): value is {add?: IRFieldValue[]; remove?: {id: string}[]} =>
  !!value && typeof value === 'object' && ('add' in value || 'remove' in value) && !('kind' in value);

class EffectCollector {
  readonly props = new Set<string>();
  readonly ids = new Set<string>();
  readonly membership = new Set<string>();

  /** Every field at every depth writes its predicate; nested nodes may be created. */
  walkNodeData(data: IRNodeData, nested: boolean): void {
    if (nested) {
      this.membership.add(data.shape);
      if (data.id) this.ids.add(data.id);
    } else if (data.id) {
      this.ids.add(data.id);
    }
    for (const field of data.fields) {
      addAll(this.props, predicatesOf(field.property));
      this.walkValue(field.value);
    }
  }

  private walkValue(value: IRFieldValue): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) this.walkValue(item);
      return;
    }
    if (typeof value !== 'object' || value instanceof Date) return;
    if (isNodeData(value)) {
      this.walkNodeData(value, true);
      return;
    }
    if (isSetModification(value)) {
      for (const item of value.add ?? []) this.walkValue(item);
      for (const ref of value.remove ?? []) {
        if (ref?.id) this.ids.add(ref.id);
      }
      return;
    }
    // A `{id}` reference or an expression: neither writes a predicate of its own,
    // and a referenced node is not itself modified.
  }

  /** Every string under a key named `id`, anywhere in a store result. */
  walkResult(value: unknown, seen = new Set<object>()): void {
    if (!value || typeof value !== 'object' || value instanceof Date) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) this.walkResult(item, seen);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'id' && typeof child === 'string') this.ids.add(child);
      else this.walkResult(child, seen);
    }
  }
}

/** `lower()` is overloaded per builder kind; dispatch on the discriminator. */
function lowerMutation(
  mutation: LowerableCreate | LowerableUpdate | LowerableDelete,
): IRCreateQuery | IRUpdateQuery | IRDeleteQuery {
  switch (mutation.__queryKind) {
    case 'create':
      return lower(mutation);
    case 'update':
      return lower(mutation);
    case 'delete':
      return lower(mutation);
  }
}

/** The shape metadata for a shape IRI, class-backed or data-only. */
function resolveShapeData(shapeId: string): NodeShapeData | undefined {
  return getShapeClass(shapeId)?.shape ?? getNodeShape(shapeId);
}

/**
 * What a mutation writes, as predicate IRIs, affected node ids and the shapes
 * whose instance sets may have changed.
 *
 * `result` — what the store returned — is optional and only widens `ids`: a create
 * learns its generated id from it, and an add/remove learns the ids of nested
 * creates. It is never consulted for an op whose target set is unknown
 * (`update_where`, `delete_all`, `delete_where`), where `ids` stays `undefined`.
 */
export function mutationEffects(
  mutation: LowerableCreate | LowerableUpdate | LowerableDelete,
  result?: unknown,
): MutationEffects {
  const ir = lowerMutation(mutation);
  const collector = new EffectCollector();

  switch (ir.kind) {
    case 'create': {
      collector.membership.add(ir.shape);
      collector.walkNodeData(ir.data, false);
      collector.walkResult(result);
      return {
        op: 'create',
        shape: ir.shape,
        props: collector.props,
        ids: collector.ids,
        membership: collector.membership,
      };
    }
    case 'update':
    case 'upsert': {
      if (ir.kind === 'upsert') collector.membership.add(ir.shape);
      collector.ids.add(ir.id);
      collector.walkNodeData(ir.data, false);
      collector.walkResult(result);
      return {
        op: ir.kind,
        shape: ir.shape,
        props: collector.props,
        ids: collector.ids,
        membership: collector.membership,
      };
    }
    case 'update_where': {
      collector.walkNodeData(ir.data, false);
      return {
        op: 'update',
        shape: ir.shape,
        props: collector.props,
        ids: undefined,
        membership: collector.membership,
      };
    }
    case 'delete':
    case 'delete_all':
    case 'delete_where': {
      collector.membership.add(ir.shape);
      const shapeData = resolveShapeData(ir.shape);
      if (shapeData) {
        for (const ps of getPropertyShapes(shapeData, true)) {
          addAll(collector.props, predicatesOf(ps.id));
        }
      }
      if (ir.kind === 'delete') {
        for (const ref of ir.ids) {
          if (ref?.id) collector.ids.add(ref.id);
        }
        collector.walkResult(result);
      }
      return {
        op: 'delete',
        shape: ir.shape,
        props: collector.props,
        ids: ir.kind === 'delete' ? collector.ids : undefined,
        membership: collector.membership,
      };
    }
  }
}
