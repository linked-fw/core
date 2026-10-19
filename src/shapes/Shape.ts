/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {NodeShapeData, PropertyShapeData} from './nodeShapeData.js';
import type {
  QueryBuildFn,
  QueryResponseToResultType,
  SelectAllQueryResponse,
  WhereClause,
} from '../queries/SelectQuery.js';
import type {NodeReferenceValue, UpdatePartial} from '../queries/QueryFactory.js';
import type {NodeId} from '../queries/MutationQuery.js';
import {QueryBuilder} from '../queries/QueryBuilder.js';
import {AskBuilder} from '../queries/AskBuilder.js';
import {CountBuilder} from '../queries/CountBuilder.js';
import {resolveShape} from '../queries/resolveShape.js';
import type {PendingQueryContext} from '../queries/QueryContext.js';
import type {IDataset} from '../interfaces/IDataset.js';
import {CreateBuilder} from '../queries/CreateBuilder.js';
import {UpdateBuilder} from '../queries/UpdateBuilder.js';
import {DeleteBuilder, type DeleteId} from '../queries/DeleteBuilder.js';
import type {ExpressionUpdateProxy, ExpressionUpdateResult} from '../expressions/ExpressionMethods.js';
import {getPropertyShapeByLabel} from '../utils/ShapeClass.js';
import {ShapeSet} from '../collections/ShapeSet.js';
import {sharedState} from '../utils/sharedState.js';
import {brandLinkedClass, isLinkedInstance} from '../utils/linkedError.js';

/** Shape classes by target class, shared so a class registered through any copy of core is listed. */
const shapeTypeState = sharedState('@_linked/core', 'Shape', () => ({
  typesToShapes: new Map<string, Set<typeof Shape>>(),
}));

//shape that returns property shapes for its keys
type AccessPropertiesShape<T extends Shape> = {
  [P in keyof T]: PropertyShapeData;
};
type PropertyShapeMapFunction<T extends Shape, ResponseType> = (
  p: AccessPropertiesShape<T>,
) => ResponseType;

/**
 * Concrete constructor type for Shape subclasses — used at runtime boundaries
 * (Builder `from()` methods, Shape static `this` parameters, mutation factories).
 *
 * Uses concrete `new` (not `abstract new`) so TypeScript accepts the class as a
 * value and reads its static `.shape`/`.targetClass` without casts. NOTE: `new
 * shape()` is only a *type-level* capability — at runtime the `Shape` constructor
 * throws (shapes are metadata, not data). The framework builds proxy targets via
 * `createShapeTarget()` (Object.create), never `new`.
 */
export type ShapeConstructor<S extends Shape = Shape> = (new (
  ...args: any[]
) => S) & {
  shape: NodeShapeData;
  targetClass?: NodeReferenceValue;
};

/**
 * @internal
 * Build a constructor-less, prototype-linked Shape used ONLY as a proxy /
 * metadata-carrier target inside the query DSL (never handed to consumers and
 * never persisted). It is a genuine `Shape` on the prototype chain — so
 * `.constructor`, the `nodeShape` getter, `ShapeSet`, and `getLeastSpecificShape`
 * all work — but it deliberately bypasses the `Shape` constructor, which is
 * guarded to reject direct instantiation. Not exported from the package index.
 */
export function createShapeTarget<S extends Shape>(
  shapeClass: ShapeConstructor<S> | typeof Shape,
  id?: string,
): S {
  const target = Object.create(shapeClass.prototype) as S;
  if (id !== undefined) {
    target.id = id;
  }
  return target;
}

export abstract class Shape {
  static targetClass: NodeReferenceValue = null;
  static shape: NodeShapeData;
  static get typesToShapes(): Map<string, Set<typeof Shape>> {
    return shapeTypeState.typesToShapes;
  }

  __queryContextId?: string;
  /** The query-context name this shape was registered under (for `{@ctx}` refs). */
  __queryContextName?: string;
  id?: string;

  // Instantiation guard DEFERRED on the `lego-demo` branch (per René): some
  // framework shapes (e.g. server `LocalFileStore`) legitimately `extends Shape`
  // and are constructed as runtime service objects, which the upstream guard
  // (core report 026) rejects at backend boot. The `validate()`/`assertValid()`
  // work from the same dev merge is KEPT; only the constructor throw is relaxed —
  // restoring pre-guard behaviour: accept an optional node ref and set `id`
  // (mirrors `createShapeTarget`). Re-enable the guard once those shapes migrate.
  constructor(node?: string | {id?: string}) {
    if (node !== undefined) {
      this.id = typeof node === 'string' ? node : node.id;
    }
  }

  get nodeShape(): NodeShapeData {
    return (this.constructor as typeof Shape).shape;
  }

  get uri(): string {
    return this.id;
  }

  set uri(value: string) {
    this.id = value;
  }

  /**
   * @internal
   * @param shapeClass
   * @param type
   */
  static registerByType(shapeClass: typeof Shape, type?: NodeReferenceValue) {
    if (!type) {
      if (shapeClass === Shape) {
        return;
      }
      const shapeType = shapeClass.targetClass;
      if (shapeType) {
        type = shapeType;
      }
    }
    if (!type) {
      return;
    }
    const typeId = type.id;
    if (!this.typesToShapes.has(typeId)) {
      this.typesToShapes.set(typeId, new Set());
    }
    this.typesToShapes.get(typeId).add(shapeClass);
  }

  /**
   * Select properties of instances of this shape.
   * Chain `.for(id)` to target a single entity, or `.forAll(ids)` for multiple.
   * The select callback receives a proxy of the shape for type-safe property access.
   */
  static select<
    S extends Shape,
    R = unknown,
    ResultType = QueryResponseToResultType<R, S>[],
  >(
    this: ShapeConstructor<S>,
    selectFn: QueryBuildFn<S, R>,
  ): QueryBuilder<S, R, ResultType>;
  static select<
    S extends Shape,
    R = unknown,
    ResultType = QueryResponseToResultType<R, S>[],
  >(
    this: ShapeConstructor<S>,
  ): QueryBuilder<S, R, ResultType>;
  static select<
    S extends Shape,
    R = unknown,
    ResultType = QueryResponseToResultType<R, S>[],
  >(
    this: ShapeConstructor<S>,
    selectFn?: QueryBuildFn<S, R>,
  ): QueryBuilder<S, R, ResultType> {
    let builder = QueryBuilder.from(this) as QueryBuilder<S, any, any>;
    if (selectFn) {
      builder = builder.select(selectFn as any);
    }
    return builder as QueryBuilder<S, R, ResultType>;
  }

  /**
   * Select all decorated properties of this shape.
   * Chain `.for(id)` to target a single entity.
   */
  static selectAll<
    S extends Shape,
    ResultType = QueryResponseToResultType<
      SelectAllQueryResponse<S>,
      S
    >[],
  >(
    this: ShapeConstructor<S>,
  ): QueryBuilder<S, any, ResultType> {
    return QueryBuilder.from(this).selectAll() as QueryBuilder<S, any, ResultType>;
  }

  /**
   * Whether a node with this id exists as an instance of this shape.
   *
   * On the base class — `Shape.exists(uri)` — it means something different and
   * weaker: does a node with this IRI exist **at all**, under any type or none.
   * There is no shape to constrain by, so no `rdf:type` triple is emitted and the
   * query is `ASK { <uri> ?p ?o }`. (`Shape` is free to mean this because the
   * shapes themselves are described by `NodeShape` and `PropertyShape`, so
   * `Shape.exists` is not needed for "is this a shape?".) Because a shapeless ask
   * has no shape to route on, a router asks every dataset it knows — see
   * `LinkedStorage.askQuery`.
   *
   * ```typescript
   * if (await SourceDocument.exists({id})) {
   *   await SourceDocument.update(values).for({id});
   * } else {
   *   await SourceDocument.create({id, ...values});
   * }
   * ```
   *
   * Resolves to a real `boolean` — unlike `select().where(…).one()`, which resolves
   * to a row or `null` and leaves the conversion (and the failure modes) to the
   * caller. Runs the cheapest correct query: against a SPARQL store, an
   * `ASK WHERE { ?a0 rdf:type <ShapeClass> . FILTER(?a0 = <id>) }` — the shape's
   * type triple and an equality filter on the subject, nothing else.
   *
   * Note the type triple: this asks whether the node exists **as an instance of
   * this shape**. A node with that IRI and a different type answers `false`.
   *
   * A `null`/`undefined` id resolves to `false` without touching the store — as does
   * a `PendingQueryContext` whose value has not landed yet, since there is no subject
   * to ask about. (An unresolved context inside a *where clause* rejects instead; see
   * {@link QueryBuilder.exists}.)
   *
   * **Errors reject — they are never reported as `false`.** Do not wrap this in a
   * `.catch(() => false)`: that is exactly how a broken existence check hides,
   * turning every `exists ? update : create` into an unconditional `create`.
   *
   * For "does *anything* match?", compose on the builder instead:
   * `await Person.select().where(p => p.name.equals('Semmy')).exists()`.
   *
   * @param id The node id: a string IRI, a `{id}` reference, or a `PendingQueryContext`.
   *   A malformed string IRI rejects (it does not throw synchronously).
   * @param target Optional explicit dataset to run against; omitted uses the
   *   global query dispatch.
   */
  static async exists<S extends Shape>(
    this: ShapeConstructor<S> | typeof Shape,
    id: string | NodeReferenceValue | PendingQueryContext | null | undefined,
    target?: IDataset,
  ): Promise<boolean> {
    // `async`, so that a bad string IRI (resolveUriOrThrow) rejects rather than
    // throwing synchronously past the caller's .catch().
    if ((this as unknown) === Shape) {
      // Called on the base class: no shape to constrain by, so no rdf:type triple.
      // `ASK { <iri> ?p ?o }` — does this node exist at all?
      return AskBuilder.forNode(id).exec(target);
    }
    return QueryBuilder.from(this as ShapeConstructor<S>).for(id).exists(target);
  }

  /**
   * How many instances of this shape exist — a real `number`.
   *
   * ```typescript
   * const total = await Person.count();
   * ```
   *
   * This is the unfiltered total. For a filtered one, compose on the builder, which
   * is the form a paging table wants:
   *
   * ```typescript
   * await Person.select().where(p => p.name.equals('Semmy')).count();
   * ```
   *
   * Runs the cheapest correct query: against a SPARQL store,
   * `SELECT (COUNT(DISTINCT ?a0) AS ?count) WHERE { ?a0 rdf:type <ShapeClass> }` —
   * the shape's type triple and nothing else. Note the type triple: this counts
   * instances **of this shape**, not nodes in general.
   *
   * **On the base class — `Shape.count()` — this throws.** Unlike
   * {@link Shape.exists}, whose shapeless reading ("does this node exist at all?")
   * is useful and cheap, a shapeless count would count every node in every dataset
   * the router knows. No caller means that, so it is refused rather than answered.
   *
   * **Errors reject — they are never reported as `0`.** Do not wrap this in a
   * `.catch(() => 0)`: `0` is a plausible count, so a broken one renders an empty
   * table that looks exactly like real data.
   *
   * @param target Optional explicit dataset to run against; omitted uses the
   *   global query dispatch.
   */
  static async count<S extends Shape>(
    this: ShapeConstructor<S> | typeof Shape,
    target?: IDataset,
  ): Promise<number> {
    // `async`, so the base-class refusal rejects rather than throwing synchronously
    // past the caller's `.catch()`.
    if ((this as unknown) === Shape) {
      throw new Error(
        'Shape.count() has no meaning on the base class: there is no shape to ' +
        'constrain by, so it would count every node in the store, under any type or ' +
        'none. Call it on a shape subclass (`Person.count()`), or compose a filter ' +
        'on the builder (`Person.select().where(…).count()`).',
      );
    }
    return CountBuilder.of({
      shapeClass: resolveShape(this as ShapeConstructor<S>),
    }).exec(target);
  }

  /**
   * Update properties of an instance of this shape.
   * Chain `.for(id)` to target a specific entity.
   *
   * ```typescript
   * await Person.update({name: 'Alice'}).for({id: '...'});
   * ```
   *
   * **`__id` is for *new* nodes only** — a fixed id for a nested node being
   * created (here, when **adding** to a relation: `update({friends: {add: {__id, name}}})`).
   * Do NOT put `__id` on a plain single-valued *replace* (`update({image: {__id, contentUrl}})`):
   * it re-targets that same node and *adds* another value instead of replacing
   * (breaks `sh:maxCount 1`). For a replace, **omit `__id`** — the engine drops the
   * old edge and writes a fresh node, so the value replaces cleanly. (Use `Shape.create`
   * for `__id` at creation; use `.delete()` or `{remove: […]}` for full owned-node cleanup.)
   *
   * **On a node that does not exist, this still writes — untyped.** `update`'s WHERE is a
   * bare `OPTIONAL`, so it matches whether or not the subject exists, and the INSERT fires
   * either way. What it never writes is `rdf:type`, so the result is an id carrying
   * properties that no shape-scoped select can find, and the call reports success. If the
   * node may be absent, use {@link Shape.upsert} instead, which asserts the type. (Whether
   * `update` should instead no-op on an absent node is an open semantic question — core
   * backlog 039.)
   */
  static update<S extends Shape>(
    this: ShapeConstructor<S>,
    data: (p: ExpressionUpdateProxy<S>) => ExpressionUpdateResult<S>,
  ): UpdateBuilder<S, any>;
  static update<S extends Shape, U extends UpdatePartial<S>>(
    this: ShapeConstructor<S>,
    data: U,
  ): UpdateBuilder<S, U>;
  static update<S extends Shape>(
    this: ShapeConstructor<S>,
    data: any,
  ): UpdateBuilder<S, any> {
    return UpdateBuilder.from(this).set(data) as unknown as UpdateBuilder<S, any>;
  }

  /**
   * Create the node if it is absent, replace the named properties if it is present —
   * in one request.
   *
   * ```ts
   * await SourceDocument.upsert(values).for({id});
   * ```
   *
   * This replaces the branch callers otherwise hand-roll:
   *
   * ```ts
   * if (await S.exists({id})) await S.update(values).for({id});
   * else                      await S.create({id, ...values});
   * ```
   *
   * which costs two round-trips, races between them, and — if the check is wrong in the
   * `false` direction — takes the `create` branch silently, duplicating single-valued
   * properties rather than erroring.
   *
   * Semantics:
   * - Replaces **only the properties named**; others on an existing node are untouched.
   *   It is not a whole-node replace.
   * - Always asserts the node's type, which `update().for({id})` does not — an update
   *   against an absent id writes its properties onto an untyped node.
   * - Returns what `update` returns. It deliberately does **not** report whether it
   *   created or replaced: knowing that needs the extra read this avoids.
   * - `.where()` / `.forAll()` are rejected — an upsert targets one known id.
   * - **The id goes in `.for(id)`, not in the data object** — unlike `create`, where an
   *   `id`/`__id` in the data names the node being created. Here the data object is
   *   properties only; an `id` in it is rejected.
   * - Expression-valued fields are rejected: an expression reads the node's current
   *   value, which does not exist when upsert creates it, and the property would be
   *   silently skipped.
   */
  static upsert<S extends Shape, U extends UpdatePartial<S>>(
    this: ShapeConstructor<S>,
    data: U,
  ): UpdateBuilder<S, U> {
    return UpdateBuilder.upsertFrom(this).set(data) as unknown as UpdateBuilder<S, U>;
  }

  static create<S extends Shape, U extends UpdatePartial<S>>(
    this: ShapeConstructor<S>,
    updateObjectOrFn?: U,
  ): CreateBuilder<S, U> {
    let builder = CreateBuilder.from(this) as CreateBuilder<S, any>;
    if (updateObjectOrFn) {
      builder = builder.set(updateObjectOrFn);
    }
    return builder as unknown as CreateBuilder<S, U>;
  }

  static delete<S extends Shape>(
    this: ShapeConstructor<S>,
    id: DeleteId | DeleteId[] | NodeReferenceValue[],
  ): DeleteBuilder<S> {
    return DeleteBuilder.from(this, id) as DeleteBuilder<S>;
  }

  /** Delete all instances of this shape type. Returns void. */
  static deleteAll<S extends Shape>(
    this: ShapeConstructor<S>,
  ): DeleteBuilder<S, void> {
    return (DeleteBuilder.from(this) as DeleteBuilder<S>).all();
  }

  /** Delete instances matching a condition. Sugar for `.delete().where(fn)`. Returns void. */
  static deleteWhere<S extends Shape>(
    this: ShapeConstructor<S>,
    fn: WhereClause<S>,
  ): DeleteBuilder<S, void> {
    return (DeleteBuilder.from(this) as DeleteBuilder<S>).where(fn);
  }

  /**
   * @deprecated Unused; the DSL reads property shapes via `nodeShapeData` free
   * functions and static metadata. Scheduled for removal.
   */
  static mapPropertyShapes<S extends Shape, ResponseType = unknown>(
    this: ShapeConstructor<S>,
    mapFunction?: PropertyShapeMapFunction<S, ResponseType>,
  ): ResponseType {
    // SAFETY: dummyShape is used as a dynamic proxy target — we assign .proxy and
    // access arbitrary property names on it, which S doesn't declare.
    let dummyShape: any = createShapeTarget(this);
    dummyShape.proxy = new Proxy(dummyShape, {
      get(target, key, receiver) {
        if (typeof key === 'string') {
          if (key in dummyShape) {
            if (typeof dummyShape[key] === 'function') {
              return target[key].bind(target);
            }
            let propertyShape = getPropertyShapeByLabel(
              dummyShape.constructor,
              key.toString(),
            );
            if (propertyShape) {
              return propertyShape;
            }
            throw new Error(
              `${this.name}.${key.toString()} is missing a @linkedProperty decorator. This method can only access decorated get/set methods.`,
            );
          }
        }
      },
    });
    return mapFunction(dummyShape.proxy);
  }

  /**
   * @deprecated Unused; shapes are metadata and no longer materialized into
   * `ShapeSet`s of instances. Scheduled for removal.
   */
  static getSetOf<T extends Shape>(
    this: ShapeConstructor<T>,
    values: Iterable<T | NodeReferenceValue | string>,
  ): ShapeSet<T> {
    const set = new ShapeSet<T>();
    for (const value of values) {
      if (isLinkedInstance(value, Shape)) {
        set.add(value as T);
      } else {
        const instance = createShapeTarget(
          this,
          typeof value === 'string' ? value : value.id,
        );
        set.add(instance);
      }
    }
    return set;
  }
}
brandLinkedClass(Shape, '@_linked/core', 'Shape');

