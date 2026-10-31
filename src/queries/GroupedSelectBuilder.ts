/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {Shape} from '../shapes/Shape.js';
import type {NodeShapeData} from '../shapes/SHACL.js';
import type {IDataset} from '../interfaces/IDataset.js';
import type {ShapeCatalog} from '../utils/ShapeCatalog.js';
import {getActiveShapeCatalog, withShapeCatalog} from '../utils/ShapeClass.js';
import {brandLinkedClass, isLinkedError, isLinkedInstance} from '../utils/linkedError.js';
import {
  AggregateExpression,
  ExpressionNode,
  tracedAliasExpression,
  tracedPropertyExpression,
  type ExpressionInput,
} from '../expressions/ExpressionNode.js';
import type {FieldSet, FieldSetEntry} from './FieldSet.js';
import type {QueryBuilderJSON, SelectBuilder} from './QueryBuilder.js';
import type {RawSelectInput} from './IRDesugar.js';
import type {
  ObjectToPlainResult,
  SetSize,
  WherePath,
} from './SelectQuery.js';
import type {IRExpression} from './IntermediateRepresentation.js';
import {featuresOfExpressions, type QueryFeature} from './queryFeatures.js';
import {assertQuerySupported, getQueryDispatch} from './queryDispatch.js';
import {UnresolvedContextError} from './QueryContext.js';
import {
  deserializeWherePath,
  serializeWherePath,
  type WherePathJSON,
} from './QueryBuilderSerialization.js';
import type {ReadGraphsInput} from './readGraphs.js';

// =============================================================================
// Types
// =============================================================================

/**
 * One result field of a grouped select, as a `having` condition sees it:
 * `.having('n', (n) => n.gt(1))`. `Name` is the field's key in the select's object, `V` its
 * value type in the row.
 */
export class GroupField<Name extends string = string, V = unknown> {
  /** Type-level only: the field's value type. Never set. */
  declare readonly __value: V;

  constructor(
    readonly name: Name,
    /** The field's expression: its path for a key, the aggregate for an aggregate. */
    readonly expression: ExpressionNode,
  ) {}

  equals(v: ExpressionInput): ExpressionNode { return this.expression.eq(v); }
  eq(v: ExpressionInput): ExpressionNode { return this.expression.eq(v); }
  notEquals(v: ExpressionInput): ExpressionNode { return this.expression.neq(v); }
  neq(v: ExpressionInput): ExpressionNode { return this.expression.neq(v); }
  gt(v: ExpressionInput): ExpressionNode { return this.expression.gt(v); }
  greaterThan(v: ExpressionInput): ExpressionNode { return this.expression.gt(v); }
  gte(v: ExpressionInput): ExpressionNode { return this.expression.gte(v); }
  greaterThanOrEqual(v: ExpressionInput): ExpressionNode { return this.expression.gte(v); }
  lt(v: ExpressionInput): ExpressionNode { return this.expression.lt(v); }
  lessThan(v: ExpressionInput): ExpressionNode { return this.expression.lt(v); }
  lte(v: ExpressionInput): ExpressionNode { return this.expression.lte(v); }
  lessThanOrEqual(v: ExpressionInput): ExpressionNode { return this.expression.lte(v); }
}
brandLinkedClass(GroupField, '@_linked/core', 'GroupField');

/** The names of a select's fields that are aggregates (`Expr.count()`, `.max()`, `.size()`). */
export type AggregateFieldNames<R> = {
  [P in keyof R & string]: R[P] extends AggregateExpression<any> | SetSize<any> ? P : never;
}[keyof R & string];

/** The names of a select's fields that are not aggregates: each must be a group key. */
export type PlainFieldNames<R> = Exclude<keyof R & string, AggregateFieldNames<R>>;

/**
 * A grouped select's row: each field's value as a plain select would give it, except that a key
 * over a multi-valued path is one of its values (each value is its own group).
 */
export type GroupedRow<R, Keys extends string> = {
  [P in keyof ObjectToPlainResult<R>]: P extends Keys
    ? GroupKeyValue<ObjectToPlainResult<R>[P] extends readonly (infer E)[] ? E : ObjectToPlainResult<R>[P]>
    : ObjectToPlainResult<R>[P];
};

/** A key's value in a row: a node is its `{id}` (the object form of select types it as the shape). */
type GroupKeyValue<V> = V extends Shape ? {id: string} : V;

/**
 * What `groupBy` returns when the grouping cannot be built: no builder methods, so the next
 * call (or using the awaited value as rows) does not compile, and `__error` says why.
 */
export type GroupByError<Message extends string> = {readonly __error: Message};

/** `SelectBuilder.groupBy`'s return type: the grouped builder, or the reason it is refused. */
export type GroupByResult<S extends Shape, R, Result, K extends string> =
  Result extends readonly unknown[]
    ? R extends readonly unknown[]
      ? GroupByError<'groupBy needs the object form of select: select((s) => ({key: s.path, n: Expr.count()}))'>
      : [Exclude<PlainFieldNames<R>, K>] extends [never]
        ? [Extract<K, AggregateFieldNames<R>>] extends [never]
          ? GroupedSelectBuilder<S, GroupedRow<R, K>>
          : GroupByError<`an aggregate field cannot be a group key: ${Extract<K, AggregateFieldNames<R>>}`>
        : GroupByError<`every field that is not an aggregate must be a group key; missing: ${Exclude<PlainFieldNames<R>, K>}`>
    : GroupByError<'groupBy groups many rows: it cannot follow .for(id) or .one()'>;

/** The grouping part of a select's raw input (see `RawSelectInput.group`). */
export type RawGroupInput = {
  /** The key fields, by result key. */
  keys: string[];
  having?: WherePath;
  orderBy?: {key: string; direction: 'ASC' | 'DESC'}[];
};

/** A grouped select's wire fields, beside the select's own (`QueryBuilderJSON`). */
export type GroupedSelectJSON = {
  groupBy: string[];
  having?: WherePathJSON;
  groupOrderBy?: {field: string; direction: 'ASC' | 'DESC'}[];
};

// =============================================================================
// Field classification
// =============================================================================

function containsAggregate(ir: IRExpression | undefined): boolean {
  if (!ir || typeof ir !== 'object') return false;
  if (ir.kind === 'aggregate_expr') return true;
  return Object.values(ir).some((v) =>
    Array.isArray(v)
      ? v.some((x) => containsAggregate(x as IRExpression))
      : v && typeof v === 'object' && 'kind' in v && containsAggregate(v as IRExpression),
  );
}

/** Whether a select field is an aggregate (`.size()`, or an expression holding an aggregate). */
export function isAggregateEntry(entry: FieldSetEntry): boolean {
  return entry.aggregation === 'count' || containsAggregate(entry.expressionNode?.ir);
}

/** A select field's expression: its aggregate, or the value at the end of its path. */
function fieldExpression(entry: FieldSetEntry): ExpressionNode {
  if (entry.expressionNode) return entry.expressionNode;
  const ids = entry.path.segments.map((s) => s.id);
  if (entry.aggregation === 'count') {
    return tracedPropertyExpression(ids).countDistinct();
  }
  return ids.length === 0 ? tracedAliasExpression([]) : tracedPropertyExpression(ids);
}

/**
 * Check that a select's fields can be grouped by `keys`, and throw naming the first problem.
 * The type of `groupBy` refuses the same cases at compile time; this guards a select built
 * from JSON, a `FieldSet`, or code that sidesteps the types.
 */
export function assertGroupable(entries: readonly FieldSetEntry[], keys: readonly string[]): void {
  if (entries.length === 0 || !entries.every((e) => e.customKey)) {
    throw new Error(
      'groupBy needs the object form of select, so that every field has a name: ' +
      '`select((s) => ({type: s.type, n: Expr.count()}))`.',
    );
  }
  const names = new Set(entries.map((e) => e.customKey!));
  for (const key of keys) {
    if (!names.has(key)) throw new Error(`groupBy: "${key}" is not a field of the select.`);
  }
  if (keys.length === 0) throw new Error('groupBy needs at least one key field.');
  for (const entry of entries) {
    const name = entry.customKey!;
    if (entry.subSelect || entry.preloadSubSelect) {
      throw new Error(`groupBy: the field "${name}" is a nested select; a grouped row holds keys and aggregates only.`);
    }
    if (entry.scopedFilter) {
      throw new Error(`groupBy: the field "${name}" filters its path inline (\`.where\`); filter the members with .where() before .groupBy().`);
    }
    const aggregate = isAggregateEntry(entry);
    if (keys.includes(name)) {
      if (aggregate) throw new Error(`groupBy: the field "${name}" is an aggregate and cannot be a group key.`);
      if (entry.expressionNode) {
        throw new Error(`groupBy: the field "${name}" is a computed expression; group keys are paths.`);
      }
    } else if (!aggregate) {
      throw new Error(
        `groupBy: the field "${name}" is neither a group key nor an aggregate. Every field of a ` +
        'grouped select is one or the other: add it to the keys, or aggregate it (`.max()`, …).',
      );
    }
  }
}

/** A select field's `GroupField`, by its name; throws when the select has no such field. */
function groupField(entries: readonly FieldSetEntry[], name: string, method: string): GroupField {
  const entry = entries.find((e) => e.customKey === name);
  if (!entry) throw new Error(`${method}: "${name}" is not a field of the select.`);
  return new GroupField(name, fieldExpression(entry));
}

/** Check that every name is a field of the select. */
function assertFieldNames(entries: readonly FieldSetEntry[], names: readonly string[], method: string): void {
  const known = new Set(entries.map((e) => e.customKey));
  for (const name of names) {
    if (typeof name !== 'string' || !known.has(name)) {
      throw new Error(`${method}: ${JSON.stringify(name)} is not a field of the select.`);
    }
  }
}

// =============================================================================
// Builder
// =============================================================================

type GroupedInit = {
  base: SelectBuilder<any, any, any>;
  keys: string[];
  having?: WherePath;
  orderBy?: {key: string; direction: 'ASC' | 'DESC'}[];
};

/**
 * A grouped select: `Shape.select((s) => ({…keys, …aggregates})).where(…).groupBy('key', …)`.
 * Its rows are groups, not entities: each holds the key fields and the aggregates, and no `id`.
 *
 * Built by `SelectBuilder.groupBy`. It has what a grouped query can do, and no more: `having`
 * (the group filter), `orderBy` over the result fields, `limit`, `offset`, `from`, `exec` and
 * the wire form. There is no `where` (filter the members before grouping), no `.for` or `.one`
 * (a group is not a subject), and no nested selects or live patching of entities.
 *
 * It is still a select (`__queryKind: 'select'`): a dataset receives it through
 * `IDataset.selectQuery` and lowers it to an `IRSelectQuery` with `groupBy`. It needs the
 * `'groupBy'` feature, so a dataset that does not declare it (`IDataset.supports`) is never
 * sent it.
 */
export class GroupedSelectBuilder<S extends Shape = Shape, Row = any>
  implements PromiseLike<Row[]>, Promise<Row[]>
{
  private readonly _base: SelectBuilder<S, any, any>;
  private readonly _keys: string[];
  private readonly _having?: WherePath;
  private readonly _orderBy?: {key: string; direction: 'ASC' | 'DESC'}[];

  /** Built by `SelectBuilder.groupBy` and `SelectBuilder.fromJSON`; not public API. */
  constructor(init: GroupedInit) {
    this._base = init.base;
    this._keys = init.keys;
    this._having = init.having;
    this._orderBy = init.orderBy;
  }

  private clone(overrides: Partial<GroupedInit>): GroupedSelectBuilder<S, Row> {
    return new GroupedSelectBuilder<S, Row>({
      base: this._base,
      keys: this._keys,
      having: this._having,
      orderBy: this._orderBy,
      ...overrides,
    });
  }

  private inCatalog<T>(fn: () => T): T {
    const catalog = this._base.catalog;
    return catalog !== getActiveShapeCatalog() ? withShapeCatalog(catalog, fn) : fn();
  }

  private entries(): readonly FieldSetEntry[] {
    return this.inCatalog(() => (this._base.fields() as FieldSet | undefined)?.entries ?? []);
  }

  /** The group keys, by result field name. */
  get keys(): readonly string[] {
    return this._keys;
  }

  /**
   * Keep only the groups for which a condition on one result field holds (SPARQL `HAVING`):
   * `.having('n', (n) => n.gt(1))`. The field is a key or an aggregate. Several calls must all
   * hold (they are combined with AND).
   */
  having<K extends keyof Row & string>(
    field: K,
    condition: (value: GroupField<K, Row[K]>) => ExpressionNode,
  ): GroupedSelectBuilder<S, Row> {
    const value = this.inCatalog(() => groupField(this.entries(), field, 'having'));
    const result = condition(value as GroupField<K, Row[K]>);
    if (!isLinkedInstance(result, ExpressionNode)) {
      throw new Error("having() takes a field and a condition on it: `having('n', (n) => n.gt(1))`.");
    }
    const previous = this._having && 'expressionNode' in this._having ? this._having.expressionNode : undefined;
    return this.clone({having: {expressionNode: previous ? previous.and(result) : result}});
  }

  /**
   * Sort the groups by result fields (keys or aggregates): `.orderBy('n', 'DESC')`, or several
   * at once (`.orderBy(['type', 'n'])`), all in `direction`. Calling it again replaces it.
   */
  orderBy<K extends keyof Row & string>(
    fields: K | readonly K[],
    direction: 'ASC' | 'DESC' = 'ASC',
  ): GroupedSelectBuilder<S, Row> {
    const names: string[] = Array.isArray(fields) ? [...fields] : [fields as string];
    if (names.length === 0) throw new Error('orderBy needs at least one field.');
    assertFieldNames(this.entries(), names, 'orderBy');
    return this.clone({orderBy: names.map((key) => ({key, direction}))});
  }

  /** At most `n` groups. */
  limit(n: number): GroupedSelectBuilder<S, Row> {
    return this.clone({base: this._base.limit(n)});
  }

  /** Skip the first `n` groups. */
  offset(n: number): GroupedSelectBuilder<S, Row> {
    return this.clone({base: this._base.offset(n)});
  }

  /** Read only these graphs (as `SelectBuilder.from`). */
  from(graphs: ReadGraphsInput): GroupedSelectBuilder<S, Row> {
    return this.clone({base: this._base.from(graphs)});
  }

  /** Discriminator for the free `lower()` function and dataset routing. */
  readonly __queryKind = 'select' as const;

  /** The shape the members are selected from: the routing key datasets and `LinkedStorage` use. */
  get shape(): NodeShapeData {
    return this._base.shape;
  }

  /** The catalog the select resolves shapes in (see `SelectBuilder.catalog`). */
  get catalog(): ShapeCatalog | undefined {
    return this._base.catalog;
  }

  /** The features this query needs: `groupBy`, plus `min`/`max` when it uses them. */
  requiredFeatures(): QueryFeature[] {
    return featuresOfExpressions(
      [...this._base.expressionTrees(), this._having && 'expressionNode' in this._having ? this._having.expressionNode.ir : undefined],
      true,
    );
  }

  /** The raw pipeline input: the select's, plus its grouping. */
  toRawInput(): RawSelectInput {
    return {
      ...this._base.toRawInput(),
      group: {
        keys: [...this._keys],
        ...(this._having ? {having: this._having} : {}),
        ...(this._orderBy ? {orderBy: this._orderBy.map((o) => ({...o}))} : {}),
      },
    };
  }

  /** The wire form: the select's envelope with `op: 'select'`, `requires` and the grouping. */
  toJSON(): QueryBuilderJSON & GroupedSelectJSON {
    return this.inCatalog(() => {
      const json: QueryBuilderJSON & GroupedSelectJSON = {
        ...this._base.toJSON(),
        op: 'select',
        requires: this.requiredFeatures(),
        groupBy: [...this._keys],
      };
      if (this._having) json.having = serializeWherePath(this._having, this._base.shape);
      if (this._orderBy) {
        json.groupOrderBy = this._orderBy.map(({key, direction}) => ({field: key, direction}));
      }
      return json;
    });
  }

  /**
   * Rebuild the grouping of a select read from the wire (`SelectBuilder.fromJSON` calls this
   * with the select it rebuilt from the same envelope).
   */
  static fromJSON<S extends Shape>(
    base: SelectBuilder<S, any, any>,
    json: GroupedSelectJSON,
  ): GroupedSelectBuilder<S, any> {
    if (!Array.isArray(json.groupBy) || !json.groupBy.every((k) => typeof k === 'string')) {
      throw new Error('DSL-JSON "groupBy" must be an array of result field names.');
    }
    const entries = (base.fields() as FieldSet | undefined)?.entries ?? [];
    assertGroupable(entries, json.groupBy);
    const names = new Set(entries.map((e) => e.customKey));
    const orderBy = json.groupOrderBy?.map(({field, direction}) => {
      if (!names.has(field)) throw new Error(`DSL-JSON "groupOrderBy": "${field}" is not a field of the select.`);
      if (direction !== 'ASC' && direction !== 'DESC') {
        throw new Error(`DSL-JSON "groupOrderBy": direction must be ASC or DESC, got ${JSON.stringify(direction)}.`);
      }
      return {key: field, direction};
    });
    return new GroupedSelectBuilder<S, any>({
      base,
      keys: [...json.groupBy],
      ...(json.having !== undefined ? {having: deserializeWherePath(base.shape, json.having)} : {}),
      ...(orderBy ? {orderBy} : {}),
    });
  }

  /**
   * Run the query: on `target`, or through the global dispatch. Refused before it is sent when
   * the dataset does not declare the features it needs (`IDataset.supports`).
   */
  async exec(target?: IDataset): Promise<Row[]> {
    const dispatch = target ?? getQueryDispatch();
    assertQuerySupported(dispatch, this);
    try {
      return (await dispatch.selectQuery(this)) as Row[];
    } catch (err) {
      // As a select: a where-clause context that has not resolved yet means "not ready".
      if (isLinkedError(err, UnresolvedContextError)) return null as unknown as Row[];
      const wrapped = Error(`Error while executing query: ${(err as Error).stack}.\n\nQuery related to this error: ${JSON.stringify(this.toJSON())}`);
      Object.defineProperty(wrapped, 'cause', {value: err, writable: true, configurable: true, enumerable: false});
      throw wrapped;
    }
  }

  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<Row[] | TResult> {
    return this.then().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<Row[]> {
    return this.then().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return 'GroupedSelectBuilder';
  }
}
brandLinkedClass(GroupedSelectBuilder, '@_linked/core', 'GroupedSelectBuilder');
