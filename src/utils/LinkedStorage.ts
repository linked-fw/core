import {CoreSet} from '../collections/CoreSet.js';
import type {IDataset} from '../interfaces/IDataset.js';
import type {SelectQuery} from '../queries/SelectQuery.js';
import type {AskQuery} from '../queries/AskQuery.js';
import type {CountQuery} from '../queries/CountQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery.js';
import {setQueryDispatch, resolveExistence} from '../queries/queryDispatch.js';
import {getShapeClass} from './ShapeClass.js';
import type {NodeShapeData} from '../shapes/SHACL.js';

// plan-011 — count physical evaluations of THIS module on the one shared
// global object. With the single-loader fix there should be exactly one copy;
// the single-instance guard in backend.ts reports this count if storage config
// ever lands on a different copy. Deliberately avoids Date/Math.random
// (unavailable / non-deterministic per repo constraints).
const linkedStorageGlobal: any =
  typeof globalThis !== 'undefined' ? globalThis : ({} as any);
linkedStorageGlobal.__linkedStorageInstanceCount =
  (linkedStorageGlobal.__linkedStorageInstanceCount ?? 0) + 1;

/**
 * Primary routing layer (arch-04 §The IDataset abstraction).
 *
 * Resolves an incoming Linked Query to the IDataset that should handle it,
 * based on the query's target shape. Composite IDatasets (gateways, routers,
 * forwarders, resolvers) plug in here just like storage IDatasets do.
 *
 * The "Dataset" naming aligns with the IDataset contract. Earlier "Store"
 * names were renamed in phase-1 — see docs/plans/002-phase-1-create-user-project-flow.md.
 */
/**
 * The routing table lives on the shared global, beside the shape registries.
 *
 * It has to, for the same reason they do: a module can evaluate more than once in a
 * process, and a class static then exists once per copy. Leaving these two here while
 * the registries were shared was worse than either extreme — a second copy answered
 * `isInitialised()` with false and `getDatasetForShapeClass()` with the default, while
 * reporting a fully populated shape registry.
 */
const routingState: {
  defaultDataset?: IDataset;
  shapeToDataset: Map<Function, IDataset>;
} = (linkedStorageGlobal.__linkedStorageRouting ??= {
  defaultDataset: undefined,
  shapeToDataset: new Map(),
});

/** A shape class's IRI, or undefined for anything that is not a registered shape. */
const shapeUriOf = (shapeClass?: Function | null): string | undefined => {
  const uri = (shapeClass as {shape?: {id?: unknown}} | null | undefined)?.shape?.id;
  return typeof uri === 'string' && uri ? uri : undefined;
};

export abstract class LinkedStorage {

  /** plan-011 — how many physical copies of this module have evaluated. */
  static getLoadedInstanceCount(): number {
    return linkedStorageGlobal.__linkedStorageInstanceCount ?? 0;
  }

  static isInitialised() {
    return !!routingState.defaultDataset;
  }

  /** The catch-all IDataset for shapes with no explicit mapping. */
  static getDefaultDataset() {
    return routingState.defaultDataset;
  }

  /** Set the default IDataset (catch-all for shapes with no explicit mapping). */
  static setDefaultDataset(dataset: IDataset) {
    routingState.defaultDataset = dataset;
    if (routingState.defaultDataset?.init) {
      routingState.defaultDataset.init();
    }
    setQueryDispatch({
      selectQuery: (q) => this.selectQuery(q),
      askQuery: (q) => this.askQuery(q),
      createQuery: (q) => this.createQuery(q),
      updateQuery: (q) => this.updateQuery(q),
      deleteQuery: (q) => this.deleteQuery(q),
    });
  }

  /** Pin one or more shape classes to a specific IDataset implementer. */
  static setDatasetForShapes(dataset: IDataset, ...shapeClasses: Function[]) {
    shapeClasses.forEach((shapeClass) => {
      // A shape's IRI is its identity, so two classes claiming the same IRI are the
      // same shape and must not route to different datasets. That situation is a
      // duplicate-registration bug elsewhere; say so here rather than resolving it by
      // Map insertion order, which is silent and arbitrary.
      const uri = shapeUriOf(shapeClass);
      if (uri) {
        for (const [pinned, existing] of routingState.shapeToDataset) {
          if (pinned !== shapeClass && shapeUriOf(pinned) === uri && existing !== dataset) {
            console.warn(
              `[linked] Two different classes are pinned to '${uri}' with different ` +
                `datasets. They are the same shape by identity, so one of these pins ` +
                `will be ignored. This usually means the shape class was registered twice.`,
            );
          }
        }
      }
      routingState.shapeToDataset.set(shapeClass, dataset);
    });
  }

  /**
   * Remove the pin for a shape, by class or by IRI.
   *
   * Removes **every** entry sharing that IRI, not just the one class object handed in.
   * Deleting by class identity alone is not enough: resolution falls back to matching
   * on IRI, so another class claiming the same shape would silently resurrect the pin
   * the caller believed they had removed.
   */
  static unsetDatasetForShape(shape: Function | string): void {
    const uri = typeof shape === 'string' ? shape : shapeUriOf(shape);
    routingState.shapeToDataset.delete(shape as Function);
    if (!uri) return;
    for (const pinned of [...routingState.shapeToDataset.keys()]) {
      if (shapeUriOf(pinned) === uri) {
        routingState.shapeToDataset.delete(pinned);
      }
    }
  }

  /** Every IDataset known to the primary router (default + all pinned). */
  static getDatasets(): CoreSet<IDataset> {
    const datasets = new CoreSet<IDataset>();
    if (routingState.defaultDataset) {
      datasets.add(routingState.defaultDataset);
    }
    routingState.shapeToDataset.forEach((dataset) => datasets.add(dataset));
    return datasets;
  }

  /**
   * The live shape→IDataset map — not a copy.
   *
   * Mutating it works but is not the supported way to remove a pin: deleting a key
   * here removes one class object, and resolution falls back to matching on shape IRI,
   * so another class claiming the same shape resurrects the pin. Use
   * `unsetDatasetForShape`, which removes every entry for that identity.
   */
  static getShapeToDatasetMap(): Map<Function, IDataset> {
    return routingState.shapeToDataset;
  }

  /** Resolve the IDataset for a given shape class. Walks the prototype chain. */
  static getDatasetForShapeClass(shapeClass?: Function | null): IDataset | undefined {
    let current: Function | null = shapeClass ?? null;
    while (typeof current === 'function') {
      const dataset = routingState.shapeToDataset.get(current);
      if (dataset) {
        return dataset;
      }
      const parent = Object.getPrototypeOf(current);
      if (parent === Function.prototype || parent === null) break;
      current = parent;
    }
    // Only once the identity walk has failed. `static shape` is inherited, so running
    // this at every level of the chain repeated the same scan for the same IRI.
    return this.findPinByShapeUri(shapeClass) ?? routingState.defaultDataset;
  }

  /**
   * The same pins, matched on shape IRI rather than on class identity.
   *
   * A class object is only a usable key while exactly one copy of the module
   * that declares it has evaluated, and in a built app there is not: the
   * backend runs from `lib/`, while `linked.backend.storage` is loaded from the
   * app root and imports the app's shapes from `src/`. The pin lands on one
   * copy of a shape class and the query resolves the other. The two are `!==`,
   * the lookup misses, and the query silently falls through to the default
   * dataset — which is how a shape that IS pinned reaches the app-data router
   * and fails there. Dev loads both halves from `src`, so it only breaks in
   * production.
   *
   * A shape's IRI does not have that problem: it is the shape's identity, it is
   * what the query already carries on the wire, and every copy derives the same
   * one. So it is the key that survives duplication.
   *
   * Deliberately a scan of the one map rather than a second map kept alongside it:
   * one source of truth, over a map holding a few dozen entries, on a path only
   * reached after an identity lookup has already failed.
   */
  private static findPinByShapeUri(shapeClass?: Function | null): IDataset | undefined {
    const uri = shapeUriOf(shapeClass);
    if (!uri) return undefined;
    for (const [pinned, dataset] of routingState.shapeToDataset) {
      if (shapeUriOf(pinned) === uri) {
        return dataset;
      }
    }
    return undefined;
  }

  private static resolveDatasetForQueryShape(
    shape?: string | Function | NodeShapeData | null,
  ): IDataset | undefined {
    if (!shape) {
      return routingState.defaultDataset;
    }
    if (typeof shape === 'function') {
      return this.getDatasetForShapeClass(shape);
    }
    if (typeof shape === 'string') {
      const shapeClass = getShapeClass(shape);
      return this.getDatasetForShapeClass(shapeClass);
    }
    // NodeShapeData (the closed query's `shape` accessor) — resolve via its IRI.
    if (typeof shape === 'object' && 'id' in shape) {
      const shapeClass = getShapeClass((shape as {id: string}).id);
      return this.getDatasetForShapeClass(shapeClass);
    }
    return routingState.defaultDataset;
  }

  /**
   * Route a select query — **and a count**, which is a select.
   *
   * A count is not a separate query form (an ask is: `ASK WHERE { … }`); it is
   * `SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { … }`, routed by the same shape to
   * the same dataset and answered over the same channel. So it needs no arm of its
   * own here — which is the point: when it had one, this router was missing it, and
   * `.count()` failed on every path that went through the router while passing
   * against a store held directly.
   *
   * The count contract — a real, non-negative integer, a failure never flattened
   * into `0` — belongs to `resolveCount`, which the builder goes through. None of it
   * is re-implemented here, exactly as none of `resolveExistence` is.
   */
  static selectQuery<ResultType>(
    query: SelectQuery | CountQuery,
  ): Promise<ResultType> {
    if (!query?.shape) {
      return Promise.reject(
        new Error(
          'Invalid select query passed to LinkedStorage.selectQuery(): missing shape.',
        ),
      );
    }
    const dataset = this.resolveDatasetForQueryShape(query.shape);
    if (!dataset?.selectQuery) {
      return Promise.reject(
        new Error('No query dataset configured. Call LinkedStorage.setDefaultDataset().'),
      );
    }
    return dataset.selectQuery(query) as Promise<ResultType>;
  }

  /**
   * Route an ask query.
   *
   * A **shaped** ask routes like every other query — by its shape, to one dataset.
   *
   * A **shapeless** ask ("does a node with this IRI exist at all") has no shape,
   * and therefore no routing key. Asking only the default dataset would answer
   * `false` for a node that exists in a pinned one — a wrong answer, quietly. So a
   * router must ask every dataset it knows and OR the results. That is cheap
   * precisely because the answers are booleans: the fan-out short-circuits on the
   * first `true`, where the same sweep for rows could not.
   *
   * Any other router implementing `IDataset` inherits this obligation: a shapeless
   * ask means "anywhere I can reach", not "in my default store".
   *
   * The contract itself — a real boolean, errors never flattened to `false` —
   * belongs to `resolveExistence`, which the builder also goes through. None of it
   * is re-implemented here.
   */
  static async askQuery(query: AskQuery): Promise<boolean> {
    if (!query?.shape) {
      return this.askAnyDataset(query);
    }
    const dataset = this.resolveDatasetForQueryShape(query.shape);
    if (!dataset) {
      throw new Error(
        'No query dataset configured. Call LinkedStorage.setDefaultDataset().',
      );
    }
    return resolveExistence(dataset, query);
  }

  /**
   * Fan a shapeless ask out across every known dataset, resolving `true` as soon
   * as one answers `true`.
   *
   * Sequential rather than parallel: the common case is a single dataset, and an
   * early `true` should not have already cost a query against every other store.
   * A failure from any dataset propagates — an unreachable store makes the answer
   * unknown, and "unknown" is not `false`.
   */
  private static async askAnyDataset(query: AskQuery): Promise<boolean> {
    const datasets = this.getDatasets();
    if (datasets.size === 0) {
      throw new Error(
        'No query dataset configured. Call LinkedStorage.setDefaultDataset().',
      );
    }
    for (const dataset of datasets) {
      if (await resolveExistence(dataset, query)) return true;
    }
    return false;
  }

  static updateQuery<ResponseType>(query: UpdateQuery): Promise<ResponseType> {
    if (!query?.shape) {
      return Promise.reject(
        new Error(
          'Invalid update query passed to LinkedStorage.updateQuery(): missing shape.',
        ),
      );
    }
    const dataset = this.resolveDatasetForQueryShape(query.shape);
    if (!dataset?.updateQuery) {
      return Promise.reject(
        new Error('No update handler configured on the query dataset.'),
      );
    }
    return dataset.updateQuery(query) as Promise<ResponseType>;
  }

  static createQuery<ResponseType>(query: CreateQuery): Promise<ResponseType> {
    if (!query?.shape) {
      return Promise.reject(
        new Error(
          'Invalid create query passed to LinkedStorage.createQuery(): missing shape.',
        ),
      );
    }
    const dataset = this.resolveDatasetForQueryShape(query.shape);
    if (!dataset?.createQuery) {
      return Promise.reject(
        new Error('No create handler configured on the query dataset.'),
      );
    }
    return dataset.createQuery(query) as Promise<ResponseType>;
  }

  static deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
    if (!query?.shape) {
      return Promise.reject(
        new Error(
          'Invalid delete query passed to LinkedStorage.deleteQuery(): missing shape.',
        ),
      );
    }
    const dataset = this.resolveDatasetForQueryShape(query.shape);
    if (!dataset?.deleteQuery) {
      return Promise.reject(
        new Error('No delete handler configured on the query dataset.'),
      );
    }
    return dataset.deleteQuery(query);
  }
}
