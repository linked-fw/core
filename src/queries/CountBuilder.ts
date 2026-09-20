/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * `CountBuilder` — a query whose answer is a number.
 *
 * A small sibling of `SelectBuilder` rather than a mode of it, for the same reason
 * {@link AskBuilder} is: it can only hold a pattern (shape, subject(s), where,
 * minus), so the normalisation a count needs is a property of the *type*. There is
 * no projection, ordering or **pagination** to drop, because none can be set — and
 * a count of a windowed query is meaningless, so that is the point.
 *
 * Deliberately **non-generic**. `SelectBuilder<S, R, Result>` is heavily inferred;
 * a count answers `number` no matter what the select's projection was, so this type
 * takes part in none of that inference and cannot perturb it.
 */
import type {ShapeConstructor} from '../shapes/Shape.js';
import {resolveShape} from './resolveShape.js';
import type {WherePath} from './SelectQuery.js';
import type {RawMinusEntry} from './IRDesugar.js';
import type {NodeShapeData} from '../shapes/SHACL.js';
import type {NodeReferenceValue} from './QueryFactory.js';
import type {IDataset} from '../interfaces/IDataset.js';
import {PendingQueryContext} from './QueryContext.js';
import {encodeContextRef, isContextRefJSON} from './ContextRef.js';
import {WIRE_VERSION, assertWireVersion} from './wireVersion.js';
import {getQueryDispatch, resolveCount} from './queryDispatch.js';
import {
  serializeWherePath,
  serializeRawMinusEntry,
  deserializeWherePath,
  deserializeRawMinusEntry,
} from './QueryBuilderSerialization.js';
import type {CountQuery, CountQueryJSON, RawCountInput} from './CountQuery.js';

/**
 * Everything a count can carry. Assembled by `SelectBuilder.toCount()` or
 * `Shape.count()`.
 *
 * `shapeClass` is required — a shapeless count would count every node in the store.
 */
export type CountSpec = {
  shapeClass: ShapeConstructor<any>;
  subject?: NodeReferenceValue | PendingQueryContext;
  subjects?: NodeReferenceValue[];
  where?: WherePath;
  minusEntries?: RawMinusEntry[];
  /** `.for(null)` was called — there is no subject to count. */
  nullSubject?: boolean;
};

export class CountBuilder implements PromiseLike<number>, Promise<number> {
  private readonly _spec: CountSpec;

  private constructor(spec: CountSpec) {
    this._spec = spec;
  }

  /** Build from an assembled spec — used by `.toCount()` and `Shape.count()`. */
  static of(spec: CountSpec): CountBuilder {
    return new CountBuilder(spec);
  }

  /** Discriminator for the free `lower()` function and dataset routing. */
  readonly __queryKind = 'count' as const;

  /** The shape whose matching instances are counted — also the routing key. */
  get shape(): NodeShapeData {
    return this._spec.shapeClass.shape;
  }

  toRawInput(): RawCountInput {
    const {shapeClass, subject, subjects, where, minusEntries, nullSubject} =
      this._spec;
    const input: RawCountInput = {shape: shapeClass as any};
    // Carried so lowering can reject it. `exec()` answers `0` before dispatching,
    // but a store handed the builder directly (e.g. after `fromJSON`) would
    // otherwise lower a subject-less query that matches every instance of the
    // shape and report that as the count of one node.
    if (nullSubject) input.nullSubject = true;
    if (subject) input.subject = subject;
    if (subjects && subjects.length > 0) input.subjects = subjects;
    if (where) input.where = where;
    if (minusEntries && minusEntries.length > 0) input.minusEntries = minusEntries;
    return input;
  }

  toJSON(): CountQueryJSON {
    const {shapeClass, subject, subjects, where, minusEntries, nullSubject} =
      this._spec;
    const shapeId = shapeClass.shape?.id;
    if (!shapeId) {
      // Refuse here rather than emitting `shape: ''` for the receiver's `fromJSON`
      // to reject: the caller who holds the shape can act on this, and a peer
      // across a wire cannot.
      throw new Error(
        'Cannot serialize a count query whose shape has no id. A count envelope must ' +
        'name a shape — a shapeless count would count every node in the store.',
      );
    }
    const json: CountQueryJSON = {
      v: WIRE_VERSION,
      op: 'count',
      shape: shapeId,
    };

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
    if (where) {
      json.where = serializeWherePath(where, shapeClass.shape);
    }
    if (minusEntries && minusEntries.length > 0) {
      json.minusEntries = minusEntries.map((e) =>
        serializeRawMinusEntry(e, shapeClass.shape),
      );
    }
    if (nullSubject) {
      json.nullSubject = true;
    }
    return json;
  }

  static fromJSON(json: CountQueryJSON): CountBuilder {
    assertWireVersion(json.v);
    if (!json.shape) {
      throw new Error(
        'A count envelope must name a `shape`. A shapeless count would count every ' +
        'node in the store, under any type or none.',
      );
    }
    const shapeClass = resolveShape(json.shape as any) as ShapeConstructor<any>;
    const spec: CountSpec = {shapeClass};

    if (json.subject !== undefined) {
      spec.subject = isContextRefJSON(json.subject)
        ? new PendingQueryContext(json.subject['@ctx'])
        : {id: json.subject as string};
    }
    if (json.subjects && json.subjects.length > 0) {
      spec.subjects = json.subjects.map((id) => ({id}));
    }
    if (json.where) {
      spec.where = deserializeWherePath(shapeClass.shape, json.where);
    }
    if (json.minusEntries?.length) {
      spec.minusEntries = json.minusEntries.map((e) =>
        deserializeRawMinusEntry(shapeClass.shape, e),
      );
    }
    if (json.nullSubject) spec.nullSubject = true;
    return new CountBuilder(spec);
  }

  /**
   * Execute and resolve to a real number.
   *
   * **A failure rejects — it is never reported as `0`.** A count of `0` renders an
   * empty table and is indistinguishable from real data, so a broken count that
   * answered `0` would hide rather than fail. Do not wrap this in `.catch(() => 0)`.
   *
   * The one case that resolves `0` without querying is a query with no subject to
   * count — `.for(null)`, or a `PendingQueryContext` as the subject that has not
   * landed: "how many nodes with no id match?" has a correct total answer, and it
   * is `0`.
   */
  async exec(target?: IDataset): Promise<number> {
    const {nullSubject, subject} = this._spec;
    if (nullSubject) return 0;
    if (subject instanceof PendingQueryContext && !subject.id) return 0;
    // `async` ensures a missing global dispatch rejects rather than throwing
    // synchronously past the caller's `.catch()`.
    const dispatch = target ?? getQueryDispatch();
    // `resolveCount` dispatches over the SELECT channel — a count is a select with
    // an aggregate projection, not a query form of its own — and checks the answer
    // is a real non-negative integer before it reaches the caller.
    return resolveCount(dispatch as any, this);
  }

  /** `await` triggers execution. */
  then<TResult1 = number, TResult2 = never>(
    onfulfilled?: ((value: number) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<number | TResult> {
    return this.then().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<number> {
    return this.then().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return 'CountBuilder';
  }
}

/** Narrow an unknown query object to a count. */
export function isCountQuery(query: unknown): query is CountQuery {
  return !!query && (query as {__queryKind?: string}).__queryKind === 'count';
}
