import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {captureCatalog, getActiveShapeCatalog, withShapeCatalog} from '../utils/ShapeClass.js';
import type {ShapeCatalog} from '../utils/ShapeCatalog.js';
import {resolveShape} from './resolveShape.js';
import type {DeleteResponse} from './DeleteQuery.js';
import type {NodeId} from './MutationQuery.js';
import {MutationThenable} from './MutationThenable.js';
import {resolveMutationDispatch} from './queryDispatch.js';
import type {IDataset} from '../interfaces/IDataset.js';
import {WIRE_VERSION, assertWireVersion} from './wireVersion.js';
import type {NodeShapeData} from '../shapes/SHACL.js';
import {type WhereClause, type WherePath, processWhereClause} from './SelectQuery.js';
import {type DeleteMutationJSON} from './MutationSerialization.js';
import {serializeWherePath, deserializeWherePath} from './QueryBuilderSerialization.js';
import type {DeleteLowerSpec} from './mutationLowerSpec.js';
import {PendingQueryContext, asContextRef} from './QueryContext.js';
import {encodeContextRef, isContextRefJSON} from './ContextRef.js';
import {brandLinkedClass, isLinkedInstance} from '../utils/linkedError.js';

type DeleteMode = 'ids' | 'all' | 'where';

/** A node to delete: a concrete id, a `{id}` ref, or a live query-context reference. */
export type DeleteId = NodeId | PendingQueryContext;

/**
 * Internal state bag for DeleteBuilder.
 */
interface DeleteBuilderInit<S extends Shape> {
  shape: ShapeConstructor<S>;
  /** The catalog the builder resolves in; absent = captured from the active one. */
  catalog?: ShapeCatalog;
  ids?: DeleteId[];
  mode?: DeleteMode;
  whereFn?: WhereClause<S>;
  /** A pre-resolved where path (used by fromJSON; no live callback). */
  where?: WherePath;
  /** The graph `.into()` names; never serialized. */
  into?: string;
}

/**
 * An immutable, fluent builder for delete mutations.
 *
 * Implements PromiseLike so mutations execute on `await`:
 * ```ts
 * const result = await DeleteBuilder.from(Person, {id: '...'});
 * await DeleteBuilder.from(Person).all();  // returns void
 * ```
 *
 * R is the resolved type: DeleteResponse for ID-based, void for bulk operations.
 */
export class DeleteBuilder<S extends Shape = Shape, R = DeleteResponse>
  extends MutationThenable<R>
{
  protected readonly _tag = 'DeleteBuilder';
  private readonly _shape: ShapeConstructor<S>;
  private readonly _ids?: DeleteId[];
  private readonly _mode?: DeleteMode;
  private readonly _whereFn?: WhereClause<S>;
  private readonly _where?: WherePath;
  private readonly _into?: string;

  private readonly _catalog: ShapeCatalog | undefined;

  private constructor(init: DeleteBuilderInit<S>) {
    super();
    this._shape = init.shape;
    this._catalog = 'catalog' in init ? init.catalog : captureCatalog(init.shape);
    this._ids = init.ids;
    this._mode = init.mode;
    this._whereFn = init.whereFn;
    this._where = init.where;
    this._into = init.into;
  }

  private clone(overrides: Partial<DeleteBuilderInit<S>> = {}): DeleteBuilder<S, any> {
    return new DeleteBuilder<S>({
      shape: this._shape,
      ids: this._ids,
      mode: this._mode,
      whereFn: this._whereFn,
      where: this._where,
      into: this._into,
      catalog: this._catalog,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Static constructors
  // ---------------------------------------------------------------------------

  static from<S extends Shape>(
    shape: ShapeConstructor<S> | string,
    ids?: DeleteId | DeleteId[],
  ): DeleteBuilder<S, DeleteResponse> {
    const resolved = resolveShape<S>(shape);
    if (ids !== undefined) {
      // Normalize any context reference (unset PendingQueryContext or a resolved
      // context shape) to a {@ctx} marker so set/unset behave identically.
      const idsArray = (Array.isArray(ids) ? ids : [ids]).map(
        (id) => asContextRef(id) ?? id,
      );
      return new DeleteBuilder<S>({shape: resolved, ids: idsArray, mode: 'ids'});
    }
    return new DeleteBuilder<S>({shape: resolved});
  }

  /** Reconstruct a DeleteBuilder from its DSL-JSON (inverse of `toJSON`). */
  static fromJSON(json: DeleteMutationJSON): DeleteBuilder {
    assertWireVersion(json.v);
    const resolved = resolveShape(json.shape);
    if (json.mode === 'ids') {
      // A `{@ctx}` id rehydrates as a live context ref (resolved at lower).
      const ids: DeleteId[] = json.ids.map((id) =>
        isContextRefJSON(id) ? new PendingQueryContext(id['@ctx']) : {id},
      );
      return new DeleteBuilder({shape: resolved, ids, mode: 'ids'});
    }
    if (json.mode === 'all') {
      return new DeleteBuilder({shape: resolved, mode: 'all'});
    }
    const where = deserializeWherePath(resolved.shape, json.where);
    return new DeleteBuilder({shape: resolved, mode: 'where', where});
  }

  // ---------------------------------------------------------------------------
  // Fluent API
  // ---------------------------------------------------------------------------

  /** Delete all instances of this shape type. Returns void. */
  all(): DeleteBuilder<S, void> {
    return this.clone({mode: 'all', ids: undefined, whereFn: undefined}) as DeleteBuilder<S, void>;
  }

  /** Delete instances matching a condition. Returns void. */
  where(fn: WhereClause<S>): DeleteBuilder<S, void> {
    return this.clone({mode: 'where', whereFn: fn, ids: undefined}) as DeleteBuilder<S, void>;
  }

  // ---------------------------------------------------------------------------
  // Build & execute
  // ---------------------------------------------------------------------------

  /** Discriminator for the free `lower()` function and dataset routing. */
  readonly __queryKind = 'delete' as const;

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
  into(graph: string): DeleteBuilder<S, R> {
    if (typeof graph !== 'string' || !graph) {
      throw new Error('.into() takes a graph IRI.');
    }
    return this.clone({into: graph}) as unknown as DeleteBuilder<S, R>;
  }

  /** @internal The IR-free lowering spec consumed by `lower()`. Validates inputs. */
  _lowerSpec(): DeleteLowerSpec<S> {
    const spec = this._lowerSpecWithoutGraph();
    return this._into === undefined ? spec : {...spec, into: this._into};
  }

  private _lowerSpecWithoutGraph(): DeleteLowerSpec<S> {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this._lowerSpecWithoutGraph());
    }
    const mode = this._mode || (this._ids ? 'ids' : undefined);

    if (mode === 'all') {
      return {shapeClass: this._shape, mode: 'all'};
    }

    if (mode === 'where') {
      const wherePath =
        this._where ?? (this._whereFn ? processWhereClause(this._whereFn, this._shape) : undefined);
      if (!wherePath) {
        throw new Error('DeleteBuilder.where() requires a condition callback.');
      }
      return {shapeClass: this._shape, mode: 'where', wherePath};
    }

    // Default: ID-based delete
    if (!this._ids || this._ids.length === 0) {
      throw new Error(
        'DeleteBuilder requires at least one ID to delete. Use DeleteBuilder.from(shape, ids), .all(), or .where().',
      );
    }
    return {shapeClass: this._shape, mode: 'ids', ids: this._ids};
  }

  /** Serialize this delete mutation to lightweight DSL-JSON. */
  toJSON(): DeleteMutationJSON {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this.toJSON());
    }
    const shape = this._shape.shape.id;
    const mode = this._mode || (this._ids ? 'ids' : undefined);
    if (mode === 'all') {
      return {v: WIRE_VERSION, op: 'delete', shape, mode: 'all'};
    }
    if (mode === 'where') {
      const wherePath = this._where ?? (this._whereFn ? processWhereClause(this._whereFn, this._shape) : undefined);
      if (!wherePath) {
        throw new Error('DeleteBuilder.where() requires a condition callback.');
      }
      return {
        v: WIRE_VERSION,
        op: 'delete',
        shape,
        mode: 'where',
        where: serializeWherePath(wherePath, this._shape.shape),
      };
    }
    if (!this._ids || this._ids.length === 0) {
      throw new Error(
        'DeleteBuilder requires at least one ID, .all(), or .where() before .toJSON().',
      );
    }
    return {
      v: WIRE_VERSION,
      op: 'delete',
      shape,
      mode: 'ids',
      ids: this._ids.map((id) =>
        // An unresolved context ref travels as a `{@ctx}` marker; a concrete id
        // (string or `{id}`, incl. a resolved context shape) as a plain string.
        isLinkedInstance(id, PendingQueryContext)
          ? encodeContextRef(id.contextName)
          : typeof id === 'string'
            ? id
            : id.id,
      ),
    };
  }

  /**
   * Execute the mutation.
   *
   * @param target Optional explicit dataset (a store or a router) to run against. Omitted →
   *   the global query dispatch. A `target` runs on that dataset only; the global router is
   *   untouched. Rejects if the target dataset doesn't implement delete.
   */
  async exec(target?: IDataset): Promise<R> {
    const mode = this._mode || (this._ids ? 'ids' : undefined);
    const result = resolveMutationDispatch('delete', target).deleteQuery(this);
    // Bulk (all/where) resolves to void; id-based resolves to the DeleteResponse.
    if (mode === 'all' || mode === 'where') {
      return result.then(() => undefined) as Promise<R>;
    }
    return result as Promise<R>;
  }

}
brandLinkedClass(DeleteBuilder, '@_linked/core', 'DeleteBuilder');

