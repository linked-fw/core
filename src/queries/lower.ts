/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * `lower(query)` — turn a live query (builder) into its canonical IR algebra.
 *
 * This is the single, **free** lowering entry point, and the *only* place the
 * canonical-IR pipeline (`IRPipeline` / `IRMutation` / `IRLower` / …) is reached
 * from. The builders are deliberately IR-free: they hand `lower()` a plain
 * "lowering spec" (`mutationLowerSpec`) or raw select input, and all IR
 * construction happens here. A client that authors/serializes/forwards queries
 * but never calls `lower()` therefore tree-shakes the entire IR pipeline away.
 * The IR is an implementation detail of stores that want it (e.g. SPARQL) — not
 * the contract.
 */
import {buildSelectQuery} from './IRPipeline.js';
import {MutationQueryFactory} from './MutationQuery.js';
import {isSetModificationValue, type NodeDescriptionValue} from './QueryFactory.js';
import {PendingQueryContext} from './QueryContext.js';
import {resolveContextId} from './ContextRef.js';
import {
  buildCanonicalCreateMutationIR,
  buildCanonicalUpdateMutationIR,
  buildCanonicalUpsertMutationIR,
  buildCanonicalUpdateWhereMutationIR,
  buildCanonicalDeleteMutationIR,
  buildCanonicalDeleteAllMutationIR,
  buildCanonicalDeleteWhereMutationIR,
} from './IRMutation.js';
import {toWhere} from './IRDesugar.js';
import {lowerWhereToIR} from './IRLower.js';
import {
  attachCatalog,
  catalogOf,
  getActiveShapeCatalog,
  withShapeCatalog,
} from '../utils/ShapeClass.js';
import type {WherePath} from './SelectQuery.js';
import type {
  IRAskQuery,
  IRCountQuery,
  IRSelectQuery,
} from './IntermediateRepresentation.js';
import type {RawAskInput} from './AskQuery.js';
import type {RawCountInput} from './CountQuery.js';
import type {IRCreateQuery} from './CreateQuery.js';
import type {IRUpdateQuery} from './UpdateQuery.js';
import type {IRDeleteQuery} from './DeleteQuery.js';
import type {
  CreateLowerSpec,
  UpdateLowerSpec,
  DeleteLowerSpec,
} from './mutationLowerSpec.js';

/** A select query that can be lowered (the select builder). */
export type LowerableSelect = {readonly __queryKind: 'select'; toRawInput(): any};
/** An ask query that can be lowered (the ask builder). */
export type LowerableAsk = {readonly __queryKind: 'ask'; toRawInput(): RawAskInput};
/** A count query that can be lowered (the count builder). */
export type LowerableCount = {readonly __queryKind: 'count'; toRawInput(): RawCountInput};
/** A mutation query that can be lowered (the mutation builders). */
export type LowerableCreate = {readonly __queryKind: 'create'; _lowerSpec(): CreateLowerSpec};
export type LowerableUpdate = {readonly __queryKind: 'update'; _lowerSpec(): UpdateLowerSpec};
export type LowerableDelete = {readonly __queryKind: 'delete'; _lowerSpec(): DeleteLowerSpec};
export type LowerableQuery =
  | LowerableSelect
  | LowerableAsk
  | LowerableCount
  | LowerableCreate
  | LowerableUpdate
  | LowerableDelete;

/** Lower a pre-evaluated where path to its canonical IR fragment. */
function lowerWherePath(where: WherePath) {
  return lowerWhereToIR(toWhere(where));
}

/**
 * Resolve any query-context reference carried as a mutation field value. The
 * builder preserves a live `PendingQueryContext` through normalization (so it can
 * serialize as `{@ctx}`); at lowering a mutation must hit a concrete node, so the
 * context is resolved here and an unset one throws `UnresolvedContextError`.
 */
function resolveValueContexts(val: unknown): unknown {
  if (val instanceof PendingQueryContext) {
    return {id: resolveContextId(val.contextName, true)!};
  }
  if (Array.isArray(val)) {
    return val.map(resolveValueContexts);
  }
  if (val && typeof val === 'object') {
    if (isSetModificationValue(val)) {
      const mod = val as {$add?: unknown[]; $remove?: unknown[]};
      const out: {$add?: unknown[]; $remove?: unknown[]} = {};
      if (mod.$add) out.$add = mod.$add.map(resolveValueContexts);
      if (mod.$remove) out.$remove = mod.$remove.map(resolveValueContexts);
      return out;
    }
    if ('fields' in val) {
      return resolveDescriptionContexts(val as NodeDescriptionValue);
    }
  }
  return val;
}

/** Deep-resolve context references in a normalized node description (returns a new copy). */
function resolveDescriptionContexts(desc: NodeDescriptionValue): NodeDescriptionValue {
  return {
    ...desc,
    fields: desc.fields.map((f) => ({...f, val: resolveValueContexts(f.val) as typeof f.val})),
  };
}

function lowerCreate(spec: CreateLowerSpec): IRCreateQuery {
  const description = resolveDescriptionContexts(
    new MutationQueryFactory().describe(spec.shapeClass.shape, spec.data, {
      allowTopLevelId: true,
      validate: 'complete',
    }),
  );
  return buildCanonicalCreateMutationIR({shape: spec.shapeClass.shape, description});
}

function lowerUpdate(spec: UpdateLowerSpec): IRUpdateQuery {
  const shape = spec.shapeClass.shape;
  const updates = resolveDescriptionContexts(
    new MutationQueryFactory().describe(shape, spec.data, {validate: 'partial'}),
  );
  if (spec.mode === 'for') {
    return spec.upsert
      ? buildCanonicalUpsertMutationIR({id: spec.targetId!, shape, updates})
      : buildCanonicalUpdateMutationIR({id: spec.targetId!, shape, updates});
  }
  // forAll / where
  const lowered = spec.wherePath ? lowerWherePath(spec.wherePath) : undefined;
  return buildCanonicalUpdateWhereMutationIR({
    shape,
    updates,
    where: lowered?.where,
    wherePatterns: lowered?.wherePatterns,
  });
}

function lowerDelete(spec: DeleteLowerSpec): IRDeleteQuery {
  const shape = spec.shapeClass.shape;
  if (spec.mode === 'all') {
    return buildCanonicalDeleteAllMutationIR({shape});
  }
  if (spec.mode === 'where') {
    const {where, wherePatterns} = lowerWherePath(spec.wherePath!);
    return buildCanonicalDeleteWhereMutationIR({shape, where, wherePatterns});
  }
  // Resolve any context-ref ids ({@ctx}) against the live map — a delete must hit
  // a concrete node, so an unresolved one throws (never a silent `{id: undefined}`).
  const resolvedIds = spec.ids!.map((id) =>
    id instanceof PendingQueryContext
      ? {id: resolveContextId(id.contextName, true)!}
      : id,
  );
  const ids = new MutationQueryFactory().normalizeNodeRefs(resolvedIds);
  return buildCanonicalDeleteMutationIR({shape, ids});
}

/**
 * Lower an ask to its canonical IR.
 *
 * The shaped case reuses the select pipeline to build the pattern — one
 * implementation of shape scans, traversals, filters and minus — and then keeps
 * only the pattern-bearing part. The rootless (shapeless) case has no pattern to
 * build: it is a bare subject.
 */
function lowerAsk(input: RawAskInput): IRAskQuery {
  if (input.nullSubject) {
    // "Does the node with no id exist?" is answered `false` without querying —
    // `AskBuilder.exec` does that before dispatching. Reaching lowering means a
    // store took the builder off the normal path; a subject-less pattern would
    // match every instance of the shape and answer `true`, so refuse it loudly.
    throw new Error(
      'Cannot lower an ask query with no subject (`.for(null)`). It resolves to ' +
      '`false` without querying — execute it through `exec()` rather than lowering it.',
    );
  }
  const subject = input.subject;
  if (!input.shape) {
    // Shapeless: no rdf:type constraint, so no shape scan and no property refs.
    const id =
      subject instanceof PendingQueryContext
        ? resolveContextId(subject.contextName, true)!
        : (subject as {id?: string} | undefined)?.id;
    return attachCatalog<IRAskQuery>({kind: 'ask', patterns: [], subjectId: id});
  }
  const selected = buildSelectQuery({
    entries: [],
    shape: input.shape,
    subject,
    subjects: input.subjects,
    where: input.where,
    minusEntries: input.minusEntries,
  });
  return attachCatalog<IRAskQuery>({
    kind: 'ask',
    root: selected.root,
    patterns: selected.patterns,
    where: selected.where,
    subjectId: selected.subjectId,
    subjectIds: selected.subjectIds,
  });
}

/**
 * The variable a root count binds its `COUNT` to.
 *
 * Chosen not to collide with the `a<N>` alias scheme the pipeline generates for
 * the root and every traversal, so it never needs the collision rename
 * `selectToAlgebra` applies to aggregate aliases.
 */
export const COUNT_ALIAS = 'count';

/**
 * Lower a count to its canonical IR.
 *
 * Reuses the select pipeline to build the pattern — one implementation of shape
 * scans, traversals, filters and minus — and then keeps only the pattern-bearing
 * part, exactly as {@link lowerAsk} does. The `entries: []` is why nothing is
 * projected: a count has no projection to build.
 */
function lowerCount(input: RawCountInput): IRCountQuery {
  if (input.nullSubject) {
    // "How many nodes with no id match?" is answered `0` without querying —
    // `CountBuilder.exec` does that before dispatching. Reaching lowering means a
    // store took the builder off the normal path; a subject-less pattern would
    // count every instance of the shape and report it as the count of one node.
    throw new Error(
      'Cannot lower a count query with no subject (`.for(null)`). It resolves to ' +
      '`0` without querying — execute it through `exec()` rather than lowering it.',
    );
  }
  if (!input.shape) {
    throw new Error(
      'Cannot lower a count query with no shape. A shapeless count would count ' +
      'every node in the store, under any type or none.',
    );
  }
  // A `{"@ctx": name}` subject arrives here as a live PendingQueryContext, and
  // `buildSelectQuery` narrows a subject with `'id' in subject` — so an UNRESOLVED
  // one would quietly yield `subjectId: undefined` and the count would be of every
  // instance of the shape, reported as the count of one node. `CountBuilder.exec`
  // answers `0` for that case before dispatching, but this path is reached without
  // it: a receiver that rehydrates an envelope with `fromJSON` and hands the builder
  // straight to a store. Resolve it here, which throws `UnresolvedContextError` when
  // the context is unset — the same "not ready" a where-clause reference raises, and
  // never a plausible number.
  const subject =
    input.subject instanceof PendingQueryContext
      ? {id: resolveContextId(input.subject.contextName, true)!}
      : input.subject;
  const selected = buildSelectQuery({
    entries: [],
    shape: input.shape,
    subject,
    subjects: input.subjects,
    where: input.where,
    minusEntries: input.minusEntries,
  });
  return attachCatalog<IRCountQuery>({
    kind: 'count',
    root: selected.root,
    patterns: selected.patterns,
    where: selected.where,
    subjectId: selected.subjectId,
    subjectIds: selected.subjectIds,
    alias: COUNT_ALIAS,
  });
}

export function lower(query: LowerableSelect): IRSelectQuery;
export function lower(query: LowerableAsk): IRAskQuery;
export function lower(query: LowerableCount): IRCountQuery;
export function lower(query: LowerableCreate): IRCreateQuery;
export function lower(query: LowerableUpdate): IRUpdateQuery;
export function lower(query: LowerableDelete): IRDeleteQuery;
export function lower(
  query: LowerableQuery,
):
  | IRSelectQuery
  | IRAskQuery
  | IRCountQuery
  | IRCreateQuery
  | IRUpdateQuery
  | IRDeleteQuery {
  // Lower in the catalog the query captured; the IR it returns records it (non-enumerable
  // `catalog`) for the compile that may run after an await.
  const catalog = catalogOf(query);
  if (catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => lower(query as LowerableSelect));
  }
  switch (query.__queryKind) {
    case 'select':
      return buildSelectQuery(query.toRawInput());
    case 'ask':
      return lowerAsk(query.toRawInput());
    case 'count':
      return lowerCount(query.toRawInput());
    case 'create':
      return lowerCreate(query._lowerSpec());
    case 'update':
      return lowerUpdate(query._lowerSpec());
    case 'delete':
      return lowerDelete(query._lowerSpec());
  }
}
