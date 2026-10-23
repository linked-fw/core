import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {captureCatalog, getActiveShapeCatalog, withShapeCatalog} from '../utils/ShapeClass.js';
import type {ShapeCatalog} from '../utils/ShapeCatalog.js';
import {resolveShape} from './resolveShape.js';
import type {UpdatePartial} from './QueryFactory.js';
import type {CreateResponse} from './CreateQuery.js';
import {MutationQueryFactory} from './MutationQuery.js';
import {MutationThenable} from './MutationThenable.js';
import {resolveMutationDispatch} from './queryDispatch.js';
import type {IDataset} from '../interfaces/IDataset.js';
import {WIRE_VERSION, assertWireVersion} from './wireVersion.js';
import type {NodeShapeData} from '../shapes/SHACL.js';
import {encodeNodeData, decodeNodeDataToRaw, type CreateMutationJSON} from './MutationSerialization.js';
import type {CreateLowerSpec} from './mutationLowerSpec.js';
import {brandLinkedClass} from '../utils/linkedError.js';

/**
 * Internal state bag for CreateBuilder.
 */
interface CreateBuilderInit<S extends Shape> {
  shape: ShapeConstructor<S>;
  /** The catalog the builder resolves in; absent = captured from the active one. */
  catalog?: ShapeCatalog;
  data?: UpdatePartial<S>;
  fixedId?: string;
  /** The graph `.into()` names; never serialized. */
  into?: string;
}

/**
 * An immutable, fluent builder for create mutations.
 *
 * Every mutation method returns a new CreateBuilder — the original is never modified.
 *
 * Implements PromiseLike so mutations execute on `await`:
 * ```ts
 * const result = await CreateBuilder.from(Person).set({name: 'Alice'});
 * ```
 *
 * Serialization normalizes through the IR-free factory base; IR is produced by
 * the free `lower()` function (the builder itself imports no IR).
 */
export class CreateBuilder<S extends Shape = Shape, U extends UpdatePartial<S> = UpdatePartial<S>>
  extends MutationThenable<CreateResponse<U>>
{
  protected readonly _tag = 'CreateBuilder';
  private readonly _shape: ShapeConstructor<S>;
  private readonly _data?: UpdatePartial<S>;
  private readonly _fixedId?: string;
  private readonly _into?: string;

  private readonly _catalog: ShapeCatalog | undefined;

  private constructor(init: CreateBuilderInit<S>) {
    super();
    this._shape = init.shape;
    this._catalog = 'catalog' in init ? init.catalog : captureCatalog(init.shape);
    this._data = init.data;
    this._fixedId = init.fixedId;
    this._into = init.into;
  }

  private clone(overrides: Partial<CreateBuilderInit<S>> = {}): CreateBuilder<S, any> {
    return new CreateBuilder<S, any>({
      shape: this._shape,
      data: this._data,
      fixedId: this._fixedId,
      into: this._into,
      catalog: this._catalog,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Static constructors
  // ---------------------------------------------------------------------------

  /**
   * Create a CreateBuilder for the given shape.
   */
  static from<S extends Shape>(shape: ShapeConstructor<S> | string): CreateBuilder<S> {
    const resolved = resolveShape<S>(shape);
    return new CreateBuilder<S>({shape: resolved});
  }

  /** Reconstruct a CreateBuilder from its DSL-JSON (inverse of `toJSON`). */
  static fromJSON(json: CreateMutationJSON): CreateBuilder {
    assertWireVersion(json.v);
    const builder = CreateBuilder.from(json.shape);
    return builder.set(decodeNodeDataToRaw(json.data, builder._shape.shape) as any);
  }

  // ---------------------------------------------------------------------------
  // Fluent API
  // ---------------------------------------------------------------------------

  /** Set the data for the entity to create. */
  set<NewU extends UpdatePartial<S>>(data: NewU): CreateBuilder<S, NewU> {
    return this.clone({data}) as unknown as CreateBuilder<S, NewU>;
  }

  /** Pre-assign a node ID for the created entity. */
  withId(id: string): CreateBuilder<S, U> {
    return this.clone({fixedId: id}) as unknown as CreateBuilder<S, U>;
  }

  /**
   * Write into `graph` instead of the graph the store's routing picks for this shape. Server-side
   * only: the graph is never carried in DSL-JSON (a receiving process derives the graph itself),
   * and the store refuses a graph its routing does not allow for the shape (its routed read set:
   * the shape's graph and its sub-shapes' graphs) with `GraphQueryError('graph-not-routed')`.
   */
  into(graph: string): CreateBuilder<S, U> {
    if (typeof graph !== 'string' || !graph) {
      throw new Error('.into() takes a graph IRI.');
    }
    return this.clone({into: graph}) as unknown as CreateBuilder<S, U>;
  }

  // ---------------------------------------------------------------------------
  // Build & execute
  // ---------------------------------------------------------------------------

  /** Discriminator for the free `lower()` function and dataset routing. */
  readonly __queryKind = 'create' as const;

  /** The shape this query targets — the routing key datasets/`LinkedStorage` use. */
  get shape(): NodeShapeData {
    return this._shape.shape;
  }

  /** The catalog this builder resolves shapes in (undefined = the global registry). */
  get catalog(): ShapeCatalog | undefined {
    return this._catalog;
  }

  /** @internal The IR-free lowering spec consumed by `lower()`. Validates inputs. */
  _lowerSpec(): CreateLowerSpec<S> {
    const spec = this._lowerSpecWithoutGraph();
    return this._into === undefined ? spec : {...spec, into: this._into};
  }

  private _lowerSpecWithoutGraph(): CreateLowerSpec<S> {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this._lowerSpecWithoutGraph());
    }
    if (!this._data) {
      throw new Error(
        'CreateBuilder requires .set(data) before it can be lowered. Specify what to create.',
      );
    }
    const data = this._data;

    // No validation here: `describe()` is the single gate, so lowering and
    // `toJSON()` reject exactly the same input. See `shapes/validation`.

    // Inject __id if fixedId is set
    const dataWithId = this._fixedId
      ? {...(data as any), __id: this._fixedId}
      : data;
    return {shapeClass: this._shape, data: dataWithId as UpdatePartial<S>};
  }

  /**
   * Serialize this create mutation to lightweight DSL-JSON. Normalizes the create
   * data through the IR-free factory base (the same normalization `lower()` runs)
   * so the result is concrete and JSON-safe, then encodes the node description.
   */
  toJSON(): CreateMutationJSON {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this.toJSON());
    }
    if (!this._data) {
      throw new Error('CreateBuilder requires .set(data) before .toJSON().');
    }
    const dataWithId = this._fixedId
      ? {...(this._data as any), __id: this._fixedId}
      : this._data;
    const description = new MutationQueryFactory().describe(
      this._shape.shape,
      dataWithId,
      {allowTopLevelId: true, validate: 'complete'},
    );
    return {
      v: WIRE_VERSION,
      op: 'create',
      shape: this._shape.shape.id,
      data: encodeNodeData(description, this._shape.shape),
    };
  }

  /**
   * Execute the mutation.
   *
   * @param target Optional explicit dataset (a store or a router) to run against. Omitted →
   *   the global query dispatch. A `target` runs on that dataset only; the global router is
   *   untouched. Rejects if the target dataset doesn't implement create.
   */
  async exec(target?: IDataset): Promise<CreateResponse<U>> {
    return resolveMutationDispatch('create', target).createQuery(this) as Promise<CreateResponse<U>>;
  }
}
brandLinkedClass(CreateBuilder, '@_linked/core', 'CreateBuilder');

