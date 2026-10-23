import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {captureCatalog, getActiveShapeCatalog, withShapeCatalog} from '../utils/ShapeClass.js';
import type {ShapeCatalog} from '../utils/ShapeCatalog.js';
import {resolveShape} from './resolveShape.js';
import {type AddId, type UpdatePartial, NodeReferenceValue} from './QueryFactory.js';
import {MutationQueryFactory} from './MutationQuery.js';
import {MutationThenable} from './MutationThenable.js';
import {resolveMutationDispatch} from './queryDispatch.js';
import type {IDataset} from '../interfaces/IDataset.js';
import {WIRE_VERSION, assertWireVersion} from './wireVersion.js';
import {PendingQueryContext, getQueryContext, UnresolvedContextError} from './QueryContext.js';
import {encodeContextRef, isContextRefJSON} from './ContextRef.js';
import type {NodeShapeData} from '../shapes/SHACL.js';
import {type WhereClause, type WherePath, processWhereClause} from './SelectQuery.js';
import type {ExpressionUpdateProxy, ExpressionUpdateResult} from '../expressions/ExpressionMethods.js';
import {
  encodeNodeData,
  decodeNodeDataToRaw,
  type UpdateMutationJSON,
  type UpsertMutationJSON,
} from './MutationSerialization.js';
import {serializeWherePath, deserializeWherePath} from './QueryBuilderSerialization.js';
import type {UpdateLowerSpec} from './mutationLowerSpec.js';
import {brandLinkedClass, isLinkedInstance} from '../utils/linkedError.js';

type UpdateMode = 'for' | 'forAll' | 'where';

/**
 * Internal state bag for UpdateBuilder.
 */
interface UpdateBuilderInit<S extends Shape> {
  shape: ShapeConstructor<S>;
  /** The catalog the builder resolves in; absent = captured from the active one. */
  catalog?: ShapeCatalog;
  data?: UpdatePartial<S>;
  targetId?: string;
  mode?: UpdateMode;
  whereFn?: WhereClause<S>;
  /** A pre-resolved where path (used by fromJSON; no live callback). */
  where?: WherePath;
  /** A query-context name used as the target subject (resolved at lowering). */
  targetContextName?: string;
  /**
   * Upsert mode — create-or-replace against a known id. Set by `Shape.upsert()`.
   * The builder is otherwise identical to an update, which is why it reuses this class;
   * only the lowered IR kind and the `.where()`/`.forAll()` guards differ.
   */
  upsert?: boolean;
  /** The graph `.into()` names; never serialized. */
  into?: string;
}

/**
 * An immutable, fluent builder for update mutations.
 *
 * Every mutation method returns a new UpdateBuilder — the original is never modified.
 *
 * Implements PromiseLike so mutations execute on `await`:
 * ```ts
 * const result = await UpdateBuilder.from(Person).for({id: '...'}).set({name: 'Bob'});
 * await UpdateBuilder.from(Person).set({hobby: 'x'}).forAll();  // returns void
 * ```
 *
 * R is the resolved type: AddId<U> for ID-based, void for bulk operations.
 */
export class UpdateBuilder<S extends Shape = Shape, U extends UpdatePartial<S> = UpdatePartial<S>, R = AddId<U>>
  extends MutationThenable<R>
{
  protected readonly _tag = 'UpdateBuilder';
  private readonly _shape: ShapeConstructor<S>;
  private readonly _data?: UpdatePartial<S>;
  private readonly _targetId?: string;
  private readonly _mode?: UpdateMode;
  private readonly _whereFn?: WhereClause<S>;
  private readonly _where?: WherePath;
  private readonly _targetContextName?: string;
  private readonly _upsert: boolean;
  private readonly _into?: string;

  private readonly _catalog: ShapeCatalog | undefined;

  private constructor(init: UpdateBuilderInit<S>) {
    super();
    this._shape = init.shape;
    this._catalog = 'catalog' in init ? init.catalog : captureCatalog(init.shape);
    this._data = init.data;
    this._targetId = init.targetId;
    this._mode = init.mode;
    this._whereFn = init.whereFn;
    this._where = init.where;
    this._targetContextName = init.targetContextName;
    this._upsert = init.upsert ?? false;
    this._into = init.into;
  }

  private clone(overrides: Partial<UpdateBuilderInit<S>> = {}): UpdateBuilder<S, any, any> {
    return new UpdateBuilder<S, any>({
      shape: this._shape,
      data: this._data,
      targetId: this._targetId,
      mode: this._mode,
      whereFn: this._whereFn,
      where: this._where,
      targetContextName: this._targetContextName,
      upsert: this._upsert,
      into: this._into,
      catalog: this._catalog,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Static constructors
  // ---------------------------------------------------------------------------

  static from<S extends Shape>(shape: ShapeConstructor<S> | string): UpdateBuilder<S> {
    const resolved = resolveShape<S>(shape);
    return new UpdateBuilder<S>({shape: resolved});
  }

  /** Builder for a create-or-replace against a known id. See `Shape.upsert()`. */
  static upsertFrom<S extends Shape>(shape: ShapeConstructor<S> | string): UpdateBuilder<S> {
    const resolved = resolveShape<S>(shape);
    return new UpdateBuilder<S>({shape: resolved, upsert: true});
  }

  /** Reconstruct an UpdateBuilder from its DSL-JSON (inverse of `toJSON`). */
  static fromJSON(json: UpdateMutationJSON | UpsertMutationJSON): UpdateBuilder {
    assertWireVersion(json.v);
    const resolved = resolveShape(json.shape);
    const data = decodeNodeDataToRaw(json.data, resolved.shape) as any;

    // Branch on `op` first so each envelope keeps its own narrowed type; an upsert has
    // only the `for` form, so its modes are not the update modes.
    if (json.op === 'upsert') {
      // The type says `mode: 'for'`, but an inbound envelope is untrusted data — the
      // cast keeps the runtime check that the type alone cannot enforce.
      if ((json.mode as string) !== 'for') {
        throw new Error(
          `upsert mode "${String(json.mode)}" is invalid — an upsert targets one known id.`,
        );
      }
      if (isContextRefJSON(json.targetId)) {
        return new UpdateBuilder({
          shape: resolved, data, targetContextName: json.targetId['@ctx'], mode: 'for', upsert: true,
        });
      }
      return new UpdateBuilder({shape: resolved, data, targetId: json.targetId, mode: 'for', upsert: true});
    }

    if (json.mode === 'for') {
      if (isContextRefJSON(json.targetId)) {
        return new UpdateBuilder({shape: resolved, data, targetContextName: json.targetId['@ctx'], mode: 'for'});
      }
      return new UpdateBuilder({shape: resolved, data, targetId: json.targetId, mode: 'for'});
    }
    if (json.mode === 'forAll') {
      return new UpdateBuilder({shape: resolved, data, mode: 'forAll'});
    }
    const where = deserializeWherePath(resolved.shape, json.where!);
    return new UpdateBuilder({shape: resolved, data, mode: 'where', where});
  }

  // ---------------------------------------------------------------------------
  // Fluent API
  // ---------------------------------------------------------------------------

  /** Target a specific entity by ID. */
  for(id: string | NodeReferenceValue | PendingQueryContext): UpdateBuilder<S, U, AddId<U>> {
    if (isLinkedInstance(id, PendingQueryContext)) {
      return this.clone({targetContextName: id.contextName, targetId: undefined, mode: 'for'}) as unknown as UpdateBuilder<S, U, AddId<U>>;
    }
    const resolvedId = typeof id === 'string' ? id : id.id;
    return this.clone({targetId: resolvedId, targetContextName: undefined, mode: 'for'}) as unknown as UpdateBuilder<S, U, AddId<U>>;
  }

  /** Update all instances of this shape type. Returns void. */
  forAll(): UpdateBuilder<S, U, void> {
    this._assertNotUpsert('forAll()');
    return this.clone({mode: 'forAll', targetId: undefined, whereFn: undefined}) as unknown as UpdateBuilder<S, U, void>;
  }

  /** Update instances matching a condition. Returns void. */
  where(fn: WhereClause<S>): UpdateBuilder<S, U, void> {
    this._assertNotUpsert('where()');
    return this.clone({mode: 'where', whereFn: fn, targetId: undefined}) as unknown as UpdateBuilder<S, U, void>;
  }

  /**
   * An upsert has to know which node to create, so it only makes sense against a single
   * known id. `forAll()` and `where()` select existing nodes — there is nothing to create
   * when they match nothing, and no single id to create it under.
   */
  private _assertNotUpsert(method: string): void {
    if (this._upsert) {
      throw new Error(
        `upsert does not support .${method} — an upsert targets one known id, ` +
          `so use .for(id). (.${method} selects existing nodes, which is what update does.)`,
      );
    }
  }

  /** Replace the update data. */
  set(fn: (p: ExpressionUpdateProxy<S>) => ExpressionUpdateResult<S>): UpdateBuilder<S, any, R>;
  set<NewU extends UpdatePartial<S>>(data: NewU): UpdateBuilder<S, NewU, R>;
  set(data: any): any {
    return this.clone({data}) as any;
  }

  // ---------------------------------------------------------------------------
  // Build & execute
  // ---------------------------------------------------------------------------

  /** Discriminator for the free `lower()` function and dataset routing. */
  readonly __queryKind = 'update' as const;

  /** The shape this query targets — the routing key datasets/`LinkedStorage` use. */
  get shape(): NodeShapeData {
    return this._shape.shape;
  }

  /** The catalog this builder resolves shapes in (undefined = the global registry). */
  get catalog(): ShapeCatalog | undefined {
    return this._catalog;
  }

  /**
   * Write into `graph` instead of the graph the store's routing picks for this shape. Server-side
   * only: the graph is never carried in DSL-JSON (a receiving process derives the graph itself),
   * and the store refuses a graph its routing does not allow for the shape (its routed read set:
   * the shape's graph and its sub-shapes' graphs) with `GraphQueryError('graph-not-routed')`.
   */
  into(graph: string): UpdateBuilder<S, U, R> {
    if (typeof graph !== 'string' || !graph) {
      throw new Error('.into() takes a graph IRI.');
    }
    return this.clone({into: graph}) as unknown as UpdateBuilder<S, U, R>;
  }

  /** @internal The IR-free lowering spec consumed by `lower()`. Validates inputs. */
  _lowerSpec(): UpdateLowerSpec<S> {
    const spec = this._lowerSpecWithoutGraph();
    return this._into === undefined ? spec : {...spec, into: this._into};
  }

  private _lowerSpecWithoutGraph(): UpdateLowerSpec<S> {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this._lowerSpecWithoutGraph());
    }
    if (!this._data) {
      throw new Error(
        'UpdateBuilder requires .set(data) before it can be lowered. Specify what to update.',
      );
    }

    const mode = this._mode || (this._targetId ? 'for' : undefined);

    if (mode === 'forAll') {
      return {shapeClass: this._shape, data: this._data, mode: 'forAll'};
    }

    if (mode === 'where') {
      if (!this._whereFn && !this._where) {
        throw new Error('UpdateBuilder.where() requires a condition callback.');
      }
      const wherePath =
        this._where ?? processWhereClause(this._whereFn!, this._shape);
      return {shapeClass: this._shape, data: this._data, mode: 'where', wherePath};
    }

    // Default: ID-based update (target id may come from a query context)
    const targetId = this._resolveTargetId();
    if (!targetId) {
      if (this._targetContextName) {
        throw new UnresolvedContextError(this._targetContextName);
      }
      // A caller arriving from `create({__id: id, ...values})` — which upsert is meant to
      // replace — naturally writes the id into the data object. That form is rejected
      // further down ("cannot use id in the top level"), but only once a target exists;
      // without one they would otherwise get a bare "requires .for(id)" that never
      // mentions the id they did pass. Name it here instead.
      const strayId = this._strayTopLevelId();
      if (strayId) {
        throw new Error(
          `${this._upsert ? 'upsert' : 'update'} takes the target id in .for(id), not in the data: ` +
            `move "${strayId}" out of the data object — ` +
            `${this._upsert ? 'upsert' : 'update'}(values).for({id}). ` +
            `(create() is the one that takes an id in its data, because there it names the node being created.)`,
        );
      }
      throw new Error(
        this._upsert
          ? 'upsert requires .for(id) before it can be lowered — an upsert targets one known id.'
          : 'UpdateBuilder requires .for(id), .forAll(), or .where() before it can be lowered.',
      );
    }
    return {
      shapeClass: this._shape,
      data: this._data,
      mode: 'for',
      targetId,
      ...(this._upsert ? {upsert: true} : {}),
    };
  }

  /**
   * The key name of a top-level `id`/`__id` in the update data, if present. Used only to
   * improve the missing-target error; the data object itself is validated downstream.
   */
  private _strayTopLevelId(): string | undefined {
    const data = this._data as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') return undefined;
    return ['id', '__id'].find((k) => k in data);
  }

  /** Resolve the target id from an explicit id or a query-context reference. */
  private _resolveTargetId(): string | undefined {
    if (this._targetId) return this._targetId;
    if (this._targetContextName) return getQueryContext(this._targetContextName)?.id;
    return undefined;
  }

  /**
   * Serialize this update mutation to lightweight DSL-JSON. Normalizes the update
   * data through the IR-free factory base (handles the expression-callback form
   * of `.set()`), and serializes the where clause for `where`-mode updates.
   */
  toJSON(): UpdateMutationJSON | UpsertMutationJSON {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this.toJSON());
    }
    if (!this._data) {
      throw new Error('UpdateBuilder requires .set(data) before .toJSON().');
    }
    const mode = this._mode || (this._targetId ? 'for' : undefined);
    if (!mode) {
      throw new Error(
        'UpdateBuilder requires .for(id), .forAll(), or .where() before .toJSON().',
      );
    }
    const fields = new MutationQueryFactory().describe(
      this._shape.shape,
      this._data,
      {validate: 'partial'},
    );
    if (this._upsert && mode !== 'for') {
      throw new Error('upsert requires .for(id) before it can be serialized.');
    }
    const json = {
      v: WIRE_VERSION,
      op: this._upsert ? 'upsert' : 'update',
      shape: this._shape.shape.id,
      mode,
      data: encodeNodeData(fields, this._shape.shape),
    } as UpdateMutationJSON | UpsertMutationJSON;
    if (mode === 'for') {
      if (this._targetContextName) json.targetId = encodeContextRef(this._targetContextName);
      else json.targetId = this._targetId;
    }
    if (mode === 'where') {
      const wherePath = this._where ?? (this._whereFn ? processWhereClause(this._whereFn, this._shape) : undefined);
      if (!wherePath) {
        throw new Error('UpdateBuilder.where() requires a condition callback.');
      }
      // `mode === 'where'` is unreachable for an upsert (guarded in `.where()` and again
      // above), so this branch is always the update envelope.
      (json as UpdateMutationJSON).where = serializeWherePath(wherePath, this._shape.shape);
    }
    return json;
  }

  /**
   * Execute the mutation.
   *
   * @param target Optional explicit dataset (a store or a router) to run against. Omitted →
   *   the global query dispatch. A `target` runs on that dataset only; the global router is
   *   untouched. Rejects if the target dataset doesn't implement update.
   */
  async exec(target?: IDataset): Promise<R> {
    const mode = this._mode || (this._targetId ? 'for' : undefined);
    const result = resolveMutationDispatch('update', target).updateQuery(this);
    // Bulk (forAll/where) resolves to void; id-based resolves to the updated node.
    if (mode === 'forAll' || mode === 'where') {
      return result.then(() => undefined) as Promise<R>;
    }
    return result as Promise<R>;
  }

}
brandLinkedClass(UpdateBuilder, '@_linked/core', 'UpdateBuilder');

