/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * `AskBuilder` — a query whose answer is a boolean.
 *
 * A small sibling of `SelectBuilder` rather than a mode of it. It can only hold a
 * pattern (shape, subject(s), where, minus), so the normalisation an existence
 * check needs is a property of the *type*: there is no projection, sorting or
 * pagination to drop, because none can be set.
 */
import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {resolveShape} from './resolveShape.js';
import type {WherePath, WhereClause} from './SelectQuery.js';
import {processWhereClause} from './SelectQuery.js';
import type {RawMinusEntry} from './IRDesugar.js';
import type {NodeShapeData} from '../shapes/SHACL.js';
import type {NodeReferenceValue} from './QueryFactory.js';
import type {IDataset} from '../interfaces/IDataset.js';
import {PendingQueryContext} from './QueryContext.js';
import {encodeContextRef, isContextRefJSON} from './ContextRef.js';
import {WIRE_VERSION, assertWireVersion} from './wireVersion.js';
import {getQueryDispatch, resolveExistence} from './queryDispatch.js';
import {resolveUriOrThrow} from '../utils/NodeReference.js';
import {
  serializeWherePath,
  serializeRawMinusEntry,
  deserializeWherePath,
  deserializeRawMinusEntry,
} from './QueryBuilderSerialization.js';
import type {AskQuery, AskQueryJSON, RawAskInput} from './AskQuery.js';
import {requireLiveQueryStore} from '../live/registry.js';
import type {LiveListener, LiveQuery, LiveQueryOptions} from '../live/LiveQueryStore.js';

/** Everything an ask can carry. Assembled by `.exists()` or by `Shape.exists()`. */
export type AskSpec = {
  /** The shape class whose instances are asked about; omitted = shapeless. */
  shapeClass?: ShapeConstructor<any>;
  subject?: NodeReferenceValue | PendingQueryContext;
  subjects?: NodeReferenceValue[];
  where?: WherePath;
  minusEntries?: RawMinusEntry[];
  /** `.for(null)` was called — there is no subject to ask about. */
  nullSubject?: boolean;
};

export class AskBuilder implements PromiseLike<boolean>, Promise<boolean> {
  private readonly _spec: AskSpec;

  private constructor(spec: AskSpec) {
    this._spec = spec;
  }

  /** Build from an assembled spec — used by `.exists()` and `Shape.exists()`. */
  static of(spec: AskSpec): AskBuilder {
    return new AskBuilder(spec);
  }

  /**
   * A shapeless ask: does a node with this IRI exist at all, under any type or
   * none? Lowers to `ASK { <iri> ?p ?o }`.
   */
  static forNode(
    id: string | NodeReferenceValue | PendingQueryContext | null | undefined,
  ): AskBuilder {
    if (id === null || id === undefined) {
      return new AskBuilder({nullSubject: true});
    }
    if (id instanceof PendingQueryContext) {
      return new AskBuilder({subject: id});
    }
    const ref =
      typeof id === 'string' ? {id: resolveUriOrThrow(id)} : id;
    return new AskBuilder({subject: ref});
  }

  /** Discriminator for the free `lower()` function and dataset routing. */
  readonly __queryKind = 'ask' as const;

  /** The shape asked about — `undefined` for a shapeless ask. */
  get shape(): NodeShapeData | undefined {
    return this._spec.shapeClass?.shape;
  }

  toRawInput(): RawAskInput {
    const {shapeClass, subject, subjects, where, minusEntries, nullSubject} =
      this._spec;
    const input: RawAskInput = {};
    // Carried so lowering can reject it. `exec()` answers `false` before
    // dispatching, but a store handed the builder directly (e.g. after
    // `fromJSON`) would otherwise lower a subject-less query that matches every
    // instance of the shape and answer `true`.
    if (nullSubject) input.nullSubject = true;
    if (shapeClass) input.shape = shapeClass as any;
    if (subject) input.subject = subject;
    if (subjects && subjects.length > 0) input.subjects = subjects;
    if (where) input.where = where;
    if (minusEntries && minusEntries.length > 0) input.minusEntries = minusEntries;
    return input;
  }

  toJSON(): AskQueryJSON {
    const {shapeClass, subject, subjects, where, minusEntries, nullSubject} =
      this._spec;
    const json: AskQueryJSON = {v: WIRE_VERSION, op: 'ask'};

    if (shapeClass) {
      json.shape = shapeClass.shape?.id || '';
    }
    if (subject instanceof PendingQueryContext) {
      // Carry the reference, not its (possibly unresolved) id, so the receiver
      // resolves it against its own context map at lowering time.
      json.subject = encodeContextRef(subject.contextName);
    } else if (subject && typeof subject === 'object' && 'id' in subject) {
      json.subject = (subject as NodeReferenceValue).id;
    }
    if (subjects && subjects.length > 0) {
      json.subjects = subjects.map((s) => s.id);
    }
    // A shapeless ask carries neither — both name properties, which only a shape
    // can resolve — so `shapeClass` is present whenever these are.
    if (where && shapeClass) {
      json.where = serializeWherePath(where, shapeClass.shape);
    }
    if (minusEntries && minusEntries.length > 0 && shapeClass) {
      json.minusEntries = minusEntries.map((e) =>
        serializeRawMinusEntry(e, shapeClass.shape),
      );
    }
    if (nullSubject) {
      json.nullSubject = true;
    }
    return json;
  }

  static fromJSON(json: AskQueryJSON): AskBuilder {
    assertWireVersion(json.v);
    const shapeClass = json.shape
      ? (resolveShape(json.shape as any) as ShapeConstructor<any>)
      : undefined;
    const spec: AskSpec = {};
    if (shapeClass) spec.shapeClass = shapeClass;

    if (json.subject !== undefined) {
      spec.subject = isContextRefJSON(json.subject)
        ? new PendingQueryContext(json.subject['@ctx'])
        : {id: json.subject as string};
    }
    if (json.subjects && json.subjects.length > 0) {
      spec.subjects = json.subjects.map((id) => ({id}));
    }
    if (json.where || json.minusEntries?.length) {
      // A where clause or minus entry names properties, and a property is only
      // resolvable through a shape. A shapeless ask cannot carry either.
      if (!shapeClass) {
        throw new Error(
          'An ask envelope with a `where` or `minusEntries` must name a `shape`: ' +
          'the clause references properties, which are resolved through the shape.',
        );
      }
      if (json.where) {
        spec.where = deserializeWherePath(shapeClass.shape, json.where);
      }
      if (json.minusEntries?.length) {
        spec.minusEntries = json.minusEntries.map((e) =>
          deserializeRawMinusEntry(shapeClass.shape, e),
        );
      }
    }
    if (json.nullSubject) spec.nullSubject = true;
    return new AskBuilder(spec);
  }

  /**
   * Execute and resolve to a real boolean.
   *
   * Never `null`, never a row. A store, transport or lowering failure **rejects**;
   * it is never reported as `false`. The one case that resolves `false` without
   * querying is a query with no subject to ask about — `.for(null)`, or a
   * `PendingQueryContext` as the subject that has not landed: "does the node with
   * no id exist?" has a correct total answer, and it is `false`.
   */
  async exec(target?: IDataset): Promise<boolean> {
    const {nullSubject, subject} = this._spec;
    if (nullSubject) return false;
    if (subject instanceof PendingQueryContext && !subject.id) return false;
    // `async` ensures a missing global dispatch rejects rather than throwing
    // synchronously past the caller's `.catch()`.
    const dispatch = target ?? getQueryDispatch();
    return resolveExistence(dispatch as any, this);
  }


  /**
   * Go live: subscribe to this query and keep its result current.
   *
   * Returns a {@link LiveQuery} handle. `await` it for the first result,
   * `subscribe()` for every later one, `close()` when done. A listener may be
   * passed directly as the first argument. Requires the live-query store to be
   * loaded, which importing `@_linked/core` (the package root) does.
   */
  live<R = boolean>(listenerOrOptions?: LiveListener<R> | LiveQueryOptions, options?: LiveQueryOptions): LiveQuery<R> {
    const listener = typeof listenerOrOptions === 'function' ? listenerOrOptions : undefined;
    const opts = typeof listenerOrOptions === 'function' ? options : listenerOrOptions;
    return requireLiveQueryStore().subscribe<R>(this as any, listener, opts);
  }

  /** `await` triggers execution. */
  then<TResult1 = boolean, TResult2 = never>(
    onfulfilled?: ((value: boolean) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<boolean | TResult> {
    return this.then().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<boolean> {
    return this.then().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return 'AskBuilder';
  }
}

/** Narrow an unknown query object to an ask. */
export function isAskQuery(query: unknown): query is AskQuery {
  return (
    !!query && (query as {__queryKind?: string}).__queryKind === 'ask'
  );
}
