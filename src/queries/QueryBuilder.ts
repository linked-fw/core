import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {getUniquePropertyShapes} from '../shapes/nodeShapeData.js';
import {resolveShape} from './resolveShape.js';
import {
  type QueryBuildFn,
  type WhereClause,
  type QResult,
  type QueryResponseToResultType,
  type SelectAllQueryResponse,
  type QueryComponentLike,
  processWhereClause,
  evaluateSortCallback,
} from './SelectQuery.js';
import type {SortByPath, WherePath} from './SelectQuery.js';
import type {PropertyPathSegment, RawMinusEntry, RawSelectInput} from './IRDesugar.js';
import {WIRE_VERSION, assertWireVersion} from './wireVersion.js';
import {getQueryDispatch} from './queryDispatch.js';
import {AskBuilder} from './AskBuilder.js';
import {CountBuilder} from './CountBuilder.js';
import type {IDataset} from '../interfaces/IDataset.js';
import type {NodeShapeData} from '../shapes/SHACL.js';
import type {NodeReferenceValue} from './QueryFactory.js';
import {resolveUriOrThrow} from '../utils/NodeReference.js';
import {FieldSet, type FieldSetFieldJSON, type FieldSetEntry} from './FieldSet.js';
import {PendingQueryContext, UnresolvedContextError} from './QueryContext.js';
import {encodeContextRef, isContextRefJSON, type ContextRefJSON} from './ContextRef.js';
import {createProxiedPathBuilder} from './ProxiedPathBuilder.js';
import {
  serializeWherePath,
  serializeSortByPath,
  serializeRawMinusEntry,
  deserializeWherePath,
  deserializeSortByPath,
  deserializeRawMinusEntry,
  type WherePathJSON,
  type SortByPathJSON,
  type RawMinusEntryJSON,
} from './QueryBuilderSerialization.js';

/** JSON representation of a SelectBuilder. */
export type QueryBuilderJSON = {
  /** DSL-JSON wire-format version. */
  v?: string;
  shape: string;
  fields?: FieldSetFieldJSON[];
  limit?: number;
  offset?: number;
  /** A node id, or a `{@ctx: name}` context reference resolved at lowering. */
  subject?: string | ContextRefJSON;
  subjects?: string[];
  /** `.one()` — unwrap a single result. */
  one?: boolean;
  where?: WherePathJSON;
  sortBy?: SortByPathJSON;
  minusEntries?: RawMinusEntryJSON[];
  nullSubject?: boolean;
};

/** A preload entry binding a property path to a component's query. */
interface PreloadEntry {
  path: string;
  component: QueryComponentLike<any, any>;
}

/** A MINUS entry — either a shape type exclusion or a WHERE-clause condition. */
interface MinusEntry<S extends Shape> {
  shapeId?: string;
  whereFn?: WhereClause<S>;
}

/** Internal state bag for SelectBuilder. */
interface QueryBuilderInit<S extends Shape, R> {
  shape: ShapeConstructor<S>;
  selectFn?: QueryBuildFn<S, R>;
  whereFn?: WhereClause<S>;
  sortByFn?: QueryBuildFn<S, any>;
  sortDirection?: 'ASC' | 'DESC';
  limit?: number;
  offset?: number;
  subject?: S | QResult<S> | NodeReferenceValue;
  subjects?: NodeReferenceValue[];
  singleResult?: boolean;
  selectAllLabels?: string[];
  fieldSet?: FieldSet;
  preloads?: PreloadEntry[];
  minusEntries?: MinusEntry<S>[];
  _nullSubject?: boolean;
  _pendingContextName?: string;
  // Pre-evaluated data (restored from JSON; used when callbacks are not available)
  _where?: WherePath;
  _sortBy?: SortByPath;
  _rawMinusEntries?: RawMinusEntry[];
}

/**
 * An immutable, fluent query builder for select queries.
 *
 * Every mutation method (`.select()`, `.where()`, `.limit()`, etc.) returns
 * a **new** SelectBuilder instance — the original is never modified.
 *
 * Implements `PromiseLike` so queries execute on `await`:
 * ```ts
 * const results = await SelectBuilder.from(Person).select(p => p.name);
 * ```
 *
 * Produces a raw select input (`toRawInput()`) that the free `lower()` function
 * turns into IR; the builder itself carries no dependency on the IR pipeline.
 */
export class SelectBuilder<S extends Shape = Shape, R = any, Result = any>
  implements PromiseLike<Result>, Promise<Result>
{
  private readonly _shape: ShapeConstructor<S>;
  private readonly _selectFn?: QueryBuildFn<S, R>;
  private readonly _whereFn?: WhereClause<S>;
  private readonly _sortByFn?: QueryBuildFn<S, any>;
  private readonly _sortDirection?: 'ASC' | 'DESC';
  private readonly _limit?: number;
  private readonly _offset?: number;
  private readonly _subject?: S | QResult<S> | NodeReferenceValue;
  private readonly _subjects?: NodeReferenceValue[];
  private readonly _singleResult?: boolean;
  private readonly _selectAllLabels?: string[];
  private readonly _fieldSet?: FieldSet;
  private readonly _preloads?: PreloadEntry[];
  private readonly _minusEntries?: MinusEntry<S>[];
  private readonly _nullSubject?: boolean;
  private readonly _pendingContextName?: string;
  // Pre-evaluated data (restored from JSON; used when callbacks are not available)
  private readonly _where?: WherePath;
  private readonly _sortBy?: SortByPath;
  private readonly _rawMinusEntries?: RawMinusEntry[];

  private constructor(init: QueryBuilderInit<S, R>) {
    this._shape = init.shape;
    this._selectFn = init.selectFn;
    this._whereFn = init.whereFn;
    this._sortByFn = init.sortByFn;
    this._sortDirection = init.sortDirection;
    this._limit = init.limit;
    this._offset = init.offset;
    this._subject = init.subject;
    this._subjects = init.subjects;
    this._singleResult = init.singleResult;
    this._selectAllLabels = init.selectAllLabels;
    this._fieldSet = init.fieldSet;
    this._preloads = init.preloads;
    this._minusEntries = init.minusEntries;
    this._nullSubject = init._nullSubject;
    this._pendingContextName = init._pendingContextName;
    this._where = init._where;
    this._sortBy = init._sortBy;
    this._rawMinusEntries = init._rawMinusEntries;
  }

  /** Create a shallow clone with overrides. */
  private clone<NR = R, NResult = Result>(overrides: Partial<QueryBuilderInit<S, any>> = {}): SelectBuilder<S, NR, NResult> {
    return new SelectBuilder<S, NR, NResult>({
      shape: this._shape,
      selectFn: this._selectFn as any,
      whereFn: this._whereFn,
      sortByFn: this._sortByFn,
      sortDirection: this._sortDirection,
      limit: this._limit,
      offset: this._offset,
      subject: this._subject,
      subjects: this._subjects,
      singleResult: this._singleResult,
      selectAllLabels: this._selectAllLabels,
      fieldSet: this._fieldSet,
      preloads: this._preloads,
      minusEntries: this._minusEntries,
      _nullSubject: this._nullSubject,
      _pendingContextName: this._pendingContextName,
      _where: this._where,
      _sortBy: this._sortBy,
      _rawMinusEntries: this._rawMinusEntries,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Static constructors
  // ---------------------------------------------------------------------------

  /**
   * Create a SelectBuilder for the given shape.
   *
   * Accepts a shape class (e.g. `Person`), a NodeShapeData instance,
   * or a shape IRI string (resolved via the shape registry).
   */
  static from<S extends Shape>(
    shape: ShapeConstructor<S> | string,
  ): SelectBuilder<S> {
    const resolved = resolveShape<S>(shape);
    return new SelectBuilder<S>({shape: resolved});
  }

  // ---------------------------------------------------------------------------
  // Fluent API — each returns a new instance
  // ---------------------------------------------------------------------------

  /** Set the select projection via a callback, labels, or FieldSet. */
  select<NewR>(fn: QueryBuildFn<S, NewR>): SelectBuilder<S, NewR, QueryResponseToResultType<NewR, S>[]>;
  select(labels: string[]): SelectBuilder<S>;
  select<NewR>(fieldSet: FieldSet<NewR>): SelectBuilder<S, NewR, QueryResponseToResultType<NewR, S>[]>;
  select<NewR = R>(fnOrLabelsOrFieldSet: QueryBuildFn<S, NewR> | string[] | FieldSet<any>): SelectBuilder<S, NewR, any> {
    if (fnOrLabelsOrFieldSet instanceof FieldSet) {
      const labels = fnOrLabelsOrFieldSet.labels();
      const selectFn = ((p: any) =>
        labels.map((label) => p[label])) as unknown as QueryBuildFn<S, any>;
      return this.clone<NewR, any>({selectFn, selectAllLabels: undefined, fieldSet: fnOrLabelsOrFieldSet});
    }
    if (Array.isArray(fnOrLabelsOrFieldSet)) {
      const labels = fnOrLabelsOrFieldSet;
      const selectFn = ((p: any) =>
        labels.map((label) => p[label])) as unknown as QueryBuildFn<S, any>;
      return this.clone<NewR, any>({selectFn, selectAllLabels: undefined, fieldSet: undefined});
    }
    return this.clone<NewR, any>({selectFn: fnOrLabelsOrFieldSet as any, selectAllLabels: undefined, fieldSet: undefined});
  }

  /** Select all decorated properties of the shape. */
  selectAll(): SelectBuilder<S, any, QueryResponseToResultType<SelectAllQueryResponse<S>, S>[]> {
    const propertyLabels = getUniquePropertyShapes(this._shape.shape)
      .map((ps) => ps.label);
    const selectFn = ((p: any) =>
      propertyLabels.map((label) => p[label])) as unknown as QueryBuildFn<S, any>;
    return this.clone({selectFn, selectAllLabels: propertyLabels});
  }

  /** Add a where clause. */
  where(fn: WhereClause<S>): SelectBuilder<S, R, Result> {
    return this.clone({whereFn: fn});
  }

  /**
   * Exclude results matching a MINUS pattern.
   *
   * Accepts:
   * - A shape constructor to exclude by type: `.minus(Employee)`
   * - A WHERE callback to exclude by condition: `.minus(p => p.hobby.equals('Chess'))`
   * - A callback returning a property or array of properties for existence exclusion:
   *   `.minus(p => p.hobby)` or `.minus(p => [p.hobby, p.bestFriend.name])`
   *
   * Chainable: `.minus(A).minus(B)` produces two separate `MINUS { }` blocks.
   */
  minus(shapeOrFn: ShapeConstructor<any> | WhereClause<S> | ((s: any) => any)): SelectBuilder<S, R, Result> {
    const entry: MinusEntry<S> = {};
    if (typeof shapeOrFn === 'function' && 'shape' in shapeOrFn) {
      // ShapeConstructor — has a static .shape property
      entry.shapeId = (shapeOrFn as ShapeConstructor<any>).shape?.id;
    } else {
      // WhereClause callback
      entry.whereFn = shapeOrFn as WhereClause<S>;
    }
    const existing = this._minusEntries || [];
    return this.clone({minusEntries: [...existing, entry]});
  }

  /** Set sort order. */
  orderBy<OR>(fn: QueryBuildFn<S, OR>, direction: 'ASC' | 'DESC' = 'ASC'): SelectBuilder<S, R, Result> {
    return this.clone({sortByFn: fn as any, sortDirection: direction});
  }

  /**
   * @deprecated Use `orderBy()` instead.
   */
  sortBy<OR>(fn: QueryBuildFn<S, OR>, direction: 'ASC' | 'DESC' = 'ASC'): SelectBuilder<S, R, Result> {
    return this.orderBy(fn, direction);
  }

  /** Set result limit. */
  limit(n: number): SelectBuilder<S, R, Result> {
    return this.clone({limit: n});
  }

  /** Set result offset. */
  offset(n: number): SelectBuilder<S, R, Result> {
    return this.clone({offset: n});
  }

  /** Target a single entity by ID. Implies singleResult; unwraps array Result type. */
  for(id: string | NodeReferenceValue | PendingQueryContext | null | undefined): SelectBuilder<S, R, Result extends (infer E)[] ? E : Result> {
    if (id instanceof PendingQueryContext) {
      // Store the pending context as subject — its .id getter resolves lazily
      // from the global context map when the query is lowered/serialized.
      return this.clone({subject: id as any, subjects: undefined, singleResult: true, _nullSubject: false, _pendingContextName: id.contextName}) as any;
    }
    if (id == null) {
      // Return a builder that resolves to null when executed (no subject = no query).
      // This commonly happens when getQueryContext() returns null before the user is authenticated.
      return this.clone({subject: undefined, subjects: undefined, singleResult: true, _nullSubject: true, _pendingContextName: undefined}) as any;
    }
    const subject: NodeReferenceValue = typeof id === 'string' ? {id: resolveUriOrThrow(id)} : id;
    return this.clone({subject, subjects: undefined, singleResult: true, _pendingContextName: undefined}) as any;
  }

  /**
   * Whether the query has a pending (lazy) context that hasn't resolved yet.
   * Returns true when .for() received a PendingQueryContext whose value isn't available yet.
   */
  hasPendingContext(): boolean {
    return !!(this._pendingContextName && !this._subject?.id);
  }

  /** Target multiple entities by ID, or all if no ids given. */
  forAll(ids?: (string | NodeReferenceValue)[]): SelectBuilder<S, R, Result> {
    if (!ids) {
      return this.clone({subject: undefined, subjects: undefined, singleResult: false, _pendingContextName: undefined});
    }
    const subjects = ids.map((id) => typeof id === 'string' ? {id: resolveUriOrThrow(id)} : id);
    return this.clone({subject: undefined, subjects, singleResult: false, _pendingContextName: undefined});
  }

  /** Limit to one result. Unwraps array Result type to single element. */
  one(): SelectBuilder<S, R, Result extends (infer E)[] ? E : Result> {
    return this.clone<R, Result extends (infer E)[] ? E : Result>({limit: 1, singleResult: true});
  }

  /**
   * Whether **any** row matches this query. Executes immediately and resolves to a
   * real `boolean` — never a row, never `null`, never an array the caller has to
   * interpret.
   *
   * ```ts
   * await Person.select().where(p => p.name.equals('Semmy')).exists(); // boolean
   * await Person.exists({id});                                        // the common case
   * ```
   *
   * ### The query is normalised to its cheapest correct form first
   *
   * **Dropped** — the projection, preloads, sorting *and pagination* (`limit`/`offset`).
   * **Kept** — filters, `minus` entries and the subject: those decide whether a match
   * exists. `LIMIT 1` is then applied.
   *
   * So `.select(…).orderBy(…).offset(10).exists()` costs, and answers, exactly the
   * same as a bare `.exists()`. Against a SPARQL store that goes out as:
   *
   * ```sparql
   * ASK WHERE { ?a0 rdf:type <…> . FILTER(?a0 = <…>) }
   * ```
   *
   * Pagination does not survive, and cannot: `OFFSET` skips rows of a *solution
   * sequence*, and an ask has none. (Nor is it merely dropped — an
   * {@link AskBuilder} has nowhere to hold it.) `exists()` answers a question about
   * the **match set**, not about a page of it.
   *
   * ### Errors are not swallowed
   *
   * A store, transport or lowering failure rejects the returned promise; it is never
   * reported as `false`. That includes an unresolved query-context reference in a
   * where clause, which `exec()` deliberately reports as `null` ("not ready") but
   * which `exists()` must not flatten into a boolean — and a store whose `askQuery`
   * resolves to something that is not a boolean, which rejects rather than being
   * coerced into one.
   *
   * The one case that does resolve `false` without querying is a query with **no
   * subject to ask about** — `.for(null)`, `.for(undefined)`, or an unresolved
   * `PendingQueryContext` *as the subject*. "Does the node with no id exist?" has a
   * correct total answer, and it is `false`.
   *
   * @param target Optional explicit dataset, as for {@link exec}.
   */
  async exists(target?: IDataset): Promise<boolean> {
    return this._toAsk().exec(target);
  }

  /**
   * **How many** rows match this query — the total of the match set, as a real
   * `number`.
   *
   * ```ts
   * await Person.select().where(p => p.name.equals('Semmy')).count(); // number
   * await SelectBuilder.from(shapeIri).where(…).count();              // from an IRI alone
   * ```
   *
   * ### The query is normalised to its cheapest correct form first
   *
   * **Dropped** — the projection, preloads, sorting *and pagination*
   * (`limit`/`offset`). **Kept** — filters, `minus` entries and the subject: those
   * decide membership of the match set. Against a SPARQL store that goes out as:
   *
   * ```sparql
   * SELECT (COUNT(DISTINCT ?a0) AS ?count)
   * WHERE { ?a0 rdf:type <…> . ?a0 <…name> ?a0_name . FILTER(?a0_name = "Semmy") }
   * ```
   *
   * ### `limit`/`offset` are dropped, not rejected
   *
   * A count of a windowed query is meaningless — `OFFSET` skips rows of a *solution
   * sequence*, and the number a count answers is a property of the whole match set,
   * not of a page of it. So `.limit(20).offset(40).count()` costs, and answers,
   * exactly the same as a bare `.count()`.
   *
   * Dropping rather than throwing is deliberate: the paging caller holds **one**
   * builder and wants the page *and* its total from the same filter, so rejecting
   * the combination would force it to rebuild the builder by hand for no
   * correctness gain. There is exactly one sensible reading, and it is this one.
   * `.exists()` already made the same call, so the DSL has one rule — *a
   * scalar-answering query drops the solution-sequence modifiers* — not two.
   *
   * Nor is the drop merely a convention: a {@link CountBuilder} has nowhere to hold
   * a window, so it cannot be forgotten or half-applied downstream.
   *
   * `DISTINCT` is likewise not optional. A filter on a multi-valued property yields
   * several rows per subject, so the count is of distinct subjects — "how many
   * instances match", which is the question asked.
   *
   * ### Errors are not swallowed
   *
   * A store, transport or lowering failure **rejects**; it is never reported as `0`.
   * `0` is a plausible count: it renders an empty table and looks like data. Do not
   * wrap this in `.catch(() => 0)`.
   *
   * The one case that resolves `0` without querying is a query with no subject to
   * count — `.for(null)`, `.for(undefined)`, or an unresolved `PendingQueryContext`
   * *as the subject*.
   *
   * @param target Optional explicit dataset, as for {@link exec}.
   */
  async count(target?: IDataset): Promise<number> {
    return this.toCount().exec(target);
  }

  /**
   * Reduce this select to the count query that answers "how many match?".
   *
   * Public, unlike the ask equivalent, because a caller may want to **forward**
   * rather than execute: `builder.toCount().toJSON()` is the `{op: 'count'}` wire
   * envelope a router or RPC boundary sends on, and `fromJSON` turns it back into a
   * `CountBuilder` on the other side.
   *
   * Only the pattern survives — shape, subject(s), filters, `minus`. The projection,
   * preloads, sorting and pagination are not so much "dropped" as unrepresentable:
   * {@link CountBuilder} has nowhere to put them. That is the point of it being a
   * separate builder rather than a mode of this one.
   */
  toCount(): CountBuilder {
    return CountBuilder.of({
      shapeClass: this._shape,
      // `.for(null)` rides along in the spec. An unresolved pending context is
      // handled by CountBuilder.exec, which answers `0` without querying.
      ...this._patternSpec(),
    });
  }

  /**
   * The pattern-bearing part of this select: shape-membership, subject(s), filters
   * and `minus` — everything that decides which nodes are in the match set, and
   * nothing that shapes or windows the rows describing them.
   *
   * Shared by {@link _toAsk} and {@link toCount} rather than written twice. That is
   * not only about duplication: if the two normalisations drifted, `.exists()` and
   * `.count()` would disagree about what the match set *is* — a count of 0 next to
   * an `exists` of `true`, from the same builder.
   */
  private _patternSpec(): {
    subject?: NodeReferenceValue | PendingQueryContext;
    subjects?: NodeReferenceValue[];
    where?: WherePath;
    minusEntries?: RawMinusEntry[];
    nullSubject?: boolean;
  } {
    let where: WherePath | undefined;
    if (this._whereFn) {
      where = processWhereClause(this._whereFn, this._shape);
    } else if (this._where) {
      where = this._where;
    }

    let minusEntries: RawMinusEntry[] | undefined;
    if (this._minusEntries && this._minusEntries.length > 0) {
      minusEntries = this._evaluateMinusEntries();
    } else if (this._rawMinusEntries && this._rawMinusEntries.length > 0) {
      minusEntries = this._rawMinusEntries;
    }

    // A PendingQueryContext must survive as itself. It has an `id` *getter*, so
    // narrowing it to `{id}` here would silently resolve it against THIS process's
    // context map — and the query would then travel as a concrete IRI where the
    // equivalent select travels as `{"@ctx": name}` for the receiver to resolve.
    const subject =
      this._subject instanceof PendingQueryContext
        ? this._subject
        : this._subject && typeof this._subject === 'object' && 'id' in this._subject
          ? {id: (this._subject as NodeReferenceValue).id}
          : undefined;

    return {
      subject,
      subjects: this._subjects,
      where,
      minusEntries,
      nullSubject: this._nullSubject,
    };
  }

  /**
   * Reduce this select to the ask query that answers the same existence question.
   *
   * Only the pattern survives — shape, subject(s), filters, `minus`. The
   * projection, preloads, sorting and pagination are not "dropped" so much as
   * unrepresentable: {@link AskBuilder} has nowhere to put them. That is the point
   * of it being a separate builder rather than a mode of this one — the
   * normalisation cannot be forgotten or half-applied.
   */
  private _toAsk(): AskBuilder {
    return AskBuilder.of({
      shapeClass: this._shape,
      // `.for(null)` rides along in the spec. An unresolved pending context is
      // handled by AskBuilder.exec, which sees the live context and answers `false`
      // without querying.
      ...this._patternSpec(),
    });
  }

  /**
   * Preload a component's query fields at the given property path.
   *
   * This merges the component's query paths into this query's selection,
   * wrapping them in an OPTIONAL block (handled by the IR pipeline).
   *
   * Equivalent to the DSL's `.preloadFor()`:
   * ```ts
   * // DSL style
   * Person.select(p => p.bestFriend.preloadFor(PersonCard))
   * // SelectBuilder style
   * SelectBuilder.from(Person).select(p => [p.name]).preload('bestFriend', PersonCard)
   * ```
   *
   * NOTE: Preloads hold live component references and are not serializable.
   * They are merged into the selection when the field set is evaluated
   * (`_fieldsWithPreloads()`), so changes to preload handling must account for
   * the selectFn wrapping logic.
   */
  preload<CS extends Shape, CR>(
    path: string,
    component: QueryComponentLike<CS, CR>,
  ): SelectBuilder<S, R, Result> {
    const newPreloads = [...(this._preloads || []), {path, component}];
    return this.clone({preloads: newPreloads});
  }

  /**
   * Returns the current selection as a FieldSet.
   * If the selection was set via a FieldSet, returns that directly.
   * If set via selectAll labels, constructs a FieldSet from them.
   * If set via a callback, eagerly evaluates it through the proxy to produce a FieldSet.
   */
  fields(): FieldSet | undefined {
    if (this._fieldSet) {
      return this._fieldSet;
    }
    if (this._selectAllLabels) {
      return FieldSet.for(this._shape.shape, this._selectAllLabels);
    }
    if (this._selectFn) {
      // Eagerly evaluate the callback through FieldSet.for(ShapeClass, callback)
      // The callback is pure — same proxy always produces same paths.
      return FieldSet.for(this._shape, this._selectFn as unknown as (p: any) => any[]);
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Return the FieldSet with preload entries merged in (if any). */
  private _fieldsWithPreloads(): FieldSet | undefined {
    let fs = this.fields();
    if (this._preloads && this._preloads.length > 0) {
      const preloadFn = (p: any) => {
        return this._preloads!.map((entry) => p[entry.path].preloadFor(entry.component));
      };
      const preloadFs = FieldSet.for(this._shape, preloadFn);
      if (fs) {
        fs = FieldSet.createFromEntries(fs.shape, [
          ...(fs.entries as FieldSetEntry[]),
          ...(preloadFs.entries as FieldSetEntry[]),
        ]);
      } else {
        fs = preloadFs;
      }
    }
    return fs;
  }

  /** Evaluate minus entry callbacks into RawMinusEntry[] (plain data). */
  private _evaluateMinusEntries(): RawMinusEntry[] {
    const proxy = createProxiedPathBuilder(this._shape);
    return this._minusEntries!.map((entry) => {
      if (entry.shapeId) {
        return {shapeId: entry.shapeId};
      }
      if (entry.whereFn) {
        const result = (entry.whereFn as Function)(proxy);

        if (Array.isArray(result)) {
          const propertyPaths = result.map((item: any) => {
            const segments = FieldSet.collectPropertySegments(item);
            return segments.map((seg): PropertyPathSegment => ({propertyShapeId: seg.id}));
          });
          return {propertyPaths};
        }

        if (result && typeof result === 'object' && 'property' in result && 'subject' in result) {
          const segments = FieldSet.collectPropertySegments(result);
          return {propertyPaths: [segments.map((seg): PropertyPathSegment => ({propertyShapeId: seg.id}))]};
        }

        // WHERE-based exclusion
        return {where: processWhereClause(entry.whereFn, this._shape)};
      }
      return {};
    });
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Serialize this SelectBuilder to a plain JSON object.
   *
   * Selections are serializable regardless of how they were set (FieldSet,
   * string[], selectAll, or callback). Callback-based selections are eagerly
   * evaluated through the proxy to produce a FieldSet.
   *
   * Where, orderBy, and minus clauses are evaluated through the proxy and
   * serialized as plain data structures. Preloads are merged into the FieldSet
   * as subSelect entries, producing identical IR on deserialization.
   */
  toJSON(): QueryBuilderJSON {
    const shapeId = this._shape.shape?.id || '';
    const json: QueryBuilderJSON = {
      v: WIRE_VERSION,
      shape: shapeId,
    };

    const fs = this._fieldsWithPreloads();
    if (fs) {
      json.fields = fs.toJSON().fields;
    }

    if (this._limit !== undefined) {
      json.limit = this._limit;
    }
    if (this._offset !== undefined) {
      json.offset = this._offset;
    }
    if (this._pendingContextName) {
      // Carry the context reference, not its (possibly unresolved) id, so the
      // receiver resolves it against its own context map at lowering time.
      json.subject = encodeContextRef(this._pendingContextName);
    } else if (this._subject && typeof this._subject === 'object' && 'id' in this._subject) {
      json.subject = (this._subject as NodeReferenceValue).id;
    }
    if (this._subjects && this._subjects.length > 0) {
      json.subjects = this._subjects.map((s) => s.id);
    }
    if (this._singleResult) {
      json.one = true;
    }

    if (this._whereFn) {
      json.where = serializeWherePath(processWhereClause(this._whereFn, this._shape), this._shape.shape);
    } else if (this._where) {
      json.where = serializeWherePath(this._where, this._shape.shape);
    }

    if (this._sortByFn) {
      json.sortBy = serializeSortByPath(
        evaluateSortCallback(this._shape, this._sortByFn as unknown as (p: any) => any, this._sortDirection || 'ASC'),
      );
    } else if (this._sortBy) {
      json.sortBy = serializeSortByPath(this._sortBy);
    }

    if (this._minusEntries && this._minusEntries.length > 0) {
      json.minusEntries = this._evaluateMinusEntries().map((e) =>
        serializeRawMinusEntry(e, this._shape.shape),
      );
    } else if (this._rawMinusEntries && this._rawMinusEntries.length > 0) {
      json.minusEntries = this._rawMinusEntries.map((e) =>
        serializeRawMinusEntry(e, this._shape.shape),
      );
    }

    if (this._nullSubject) {
      json.nullSubject = true;
    }

    return json;
  }

  /**
   * Reconstruct a SelectBuilder from a JSON object.
   * Resolves shape IRI via getShapeClass() and field paths as label selections.
   */
  static fromJSON<S extends Shape = Shape>(json: QueryBuilderJSON): SelectBuilder<S> {
    assertWireVersion(json.v);
    let builder = SelectBuilder.from<S>(json.shape as any);

    if (json.fields && json.fields.length > 0) {
      const fieldSet = FieldSet.fromJSON({
        shape: json.shape,
        fields: json.fields,
      });
      builder = builder.select(fieldSet) as SelectBuilder<S>;
    }

    if (json.limit !== undefined) {
      builder = builder.limit(json.limit) as SelectBuilder<S>;
    }
    if (json.offset !== undefined) {
      builder = builder.offset(json.offset) as SelectBuilder<S>;
    }
    if (json.subject) {
      // A `{@ctx}` subject rehydrates as a pending context (preserving the name
      // so it re-serializes as a context reference and resolves live).
      const subject = isContextRefJSON(json.subject)
        ? new PendingQueryContext(json.subject['@ctx'])
        : json.subject;
      builder = builder.for(subject) as SelectBuilder<S>;
    }
    if (json.subjects && json.subjects.length > 0) {
      builder = builder.forAll(json.subjects) as SelectBuilder<S>;
    }
    if (json.one && !json.subject) {
      builder = builder.one() as SelectBuilder<S>;
    }

    // Restore pre-evaluated data via clone — safe because fromJSON is in the same class.
    const overrides: Partial<QueryBuilderInit<S, any>> = {};
    const nodeShape = builder._shape.shape;

    // Restore where clause
    if (json.where && nodeShape) {
      overrides._where = deserializeWherePath(nodeShape, json.where);
    }

    // Restore sort key + direction (direction rides on the ordered sortBy array)
    if (json.sortBy && json.sortBy.length > 0 && nodeShape) {
      const sortBy = deserializeSortByPath(nodeShape, json.sortBy);
      overrides._sortBy = sortBy;
      overrides.sortDirection = sortBy.directions[0];
    }

    // Restore minus entries
    if (json.minusEntries && json.minusEntries.length > 0 && nodeShape) {
      overrides._rawMinusEntries = json.minusEntries.map((e) =>
        deserializeRawMinusEntry(nodeShape, e),
      );
    }

    // Restore nullSubject flag
    if (json.nullSubject) {
      overrides._nullSubject = true;
    }

    if (Object.keys(overrides).length > 0) {
      builder = (builder as any).clone(overrides) as SelectBuilder<S>;
    }

    return builder;
  }

  // ---------------------------------------------------------------------------
  // Build & execute
  // ---------------------------------------------------------------------------

  /**
   * Get the raw pipeline input.
   *
   * Constructs RawSelectInput directly from FieldSet entries.
   */
  toRawInput(): RawSelectInput {
    return this._buildDirectRawInput();
  }

  /** Build RawSelectInput directly from FieldSet entries. */
  private _buildDirectRawInput(): RawSelectInput {
    const fs = this._fieldsWithPreloads();
    const entries = fs ? fs.entries : [];

    let where: WherePath | undefined;
    if (this._whereFn) {
      where = processWhereClause(this._whereFn, this._shape);
    } else if (this._where) {
      where = this._where;
    }

    let sortBy: SortByPath | undefined;
    if (this._sortByFn) {
      sortBy = evaluateSortCallback(
        this._shape,
        this._sortByFn as unknown as (p: any) => any,
        this._sortDirection || 'ASC',
      );
    } else if (this._sortBy) {
      sortBy = this._sortBy;
    }

    const input: RawSelectInput = {
      entries,
      subject: this._subject,
      limit: this._limit,
      offset: this._offset,
      shape: this._shape,
      sortBy,
      singleResult:
        this._singleResult ||
        !!(
          this._subject &&
          typeof this._subject === 'object' &&
          'id' in this._subject
        ),
    };

    if (where) {
      input.where = where;
    }
    if (this._subjects && this._subjects.length > 0) {
      input.subjects = this._subjects;
    }
    if (this._minusEntries && this._minusEntries.length > 0) {
      input.minusEntries = this._evaluateMinusEntries();
    } else if (this._rawMinusEntries && this._rawMinusEntries.length > 0) {
      input.minusEntries = this._rawMinusEntries;
    }

    return input;
  }

  /** Discriminator for the free `lower()` function and dataset routing. */
  readonly __queryKind = 'select' as const;

  /** The shape this query targets — the routing key datasets/`LinkedStorage` use. */
  get shape(): NodeShapeData {
    return this._shape.shape;
  }

  /**
   * Execute the query and return results.
   *
   * @param target Optional explicit dataset (a store or a router — a router *is* an
   *   `IDataset`) to run against. Omitted → the global query dispatch (the router's
   *   shape-based default). A `target` runs on that dataset only; the global router is
   *   untouched. `await`ing the builder (the PromiseLike path) always uses the global
   *   dispatch — only `.exec(target)` overrides.
   */
  async exec(target?: IDataset): Promise<Result> {
    return this._run(target, true) as Promise<Result>;
  }

  /**
   * Shared execution path for {@link exec} and {@link exists}.
   *
   * @param swallowUnresolvedContext When true (the `exec` path), a where-clause
   *   context reference that has not resolved yet surfaces as `null` — "not ready",
   *   which a reactive layer re-runs once the context lands. `exists()` passes
   *   false: it must not turn "could not ask" into a boolean.
   */
  private async _run(
    target: IDataset | undefined,
    swallowUnresolvedContext: boolean,
  ): Promise<unknown> {
    if (this._nullSubject) {
      // .for(null/undefined) was called — return null instead of executing a broken query.
      return null;
    }
    if (this._pendingContextName && !this._subject?.id) {
      // Pending context hasn't resolved yet — return null rather than querying without a subject.
      return null;
    }
    // Dispatch the live (closed) query; the dataset decides whether to lower it.
    // `async` ensures a missing global dispatch surfaces as a rejected promise, not a sync throw.
    const dispatch = target ?? getQueryDispatch();
    try {
      return await dispatch.selectQuery(this);
    } catch (err) {
      // A where-clause context reference that hasn't resolved yet surfaces as
      // UnresolvedContextError when the dataset lowers the query. For SELECT this
      // means "not ready" — return null (a reactive layer re-runs once it lands),
      // mirroring the pending-subject behavior. Mutations still throw.
      if (swallowUnresolvedContext && err instanceof UnresolvedContextError) {
        return null;
      }
      // The message names the query, which is what a human needs. `cause` keeps
      // the ORIGINAL error reachable as an object, which is what code needs: a
      // store error's status/endpoint/class is how a caller tells "this dataset
      // does not exist" from "this query is wrong", and without the chain the
      // only way left is to pattern-match this string. Written with
      // defineProperty rather than `new Error(msg, {cause})` because this
      // package targets es6, where that overload is not typed; the property
      // shape (own, non-enumerable) is identical.
      const wrapped = Error(`Error while executing query: ${(err as Error).stack}.\n\nQuery related to this error: ${JSON.stringify(this.toJSON())}`);
      Object.defineProperty(wrapped, 'cause', {
        value: err,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      throw wrapped;
    }
  }

  // ---------------------------------------------------------------------------
  // Promise-compatible interface
  // ---------------------------------------------------------------------------

  /** `await` triggers execution. */
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  /** Catch errors from execution. Chain off then() to avoid re-executing. */
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<Result | TResult> {
    return this.then().catch(onrejected);
  }

  /** Finally handler after execution. Chain off then() to avoid re-executing. */
  finally(onfinally?: (() => void) | null): Promise<Result> {
    return this.then().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return 'SelectBuilder';
  }
}

/** @deprecated Renamed to `SelectBuilder`. This alias will be removed in a future major. */
export {SelectBuilder as QueryBuilder};
