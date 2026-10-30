import type {SelectQuery} from './SelectQuery.js';
import type {CreateQuery} from './CreateQuery.js';
import type {UpdateQuery} from './UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from './DeleteQuery.js';
import type {IDataset} from '../interfaces/IDataset.js';
import type {AskQuery} from './AskQuery.js';
import type {CountQuery} from './CountQuery.js';
import type {GraphQuery, GraphResult} from './IntermediateRepresentation.js';
import type {Triple, TriplesQuery} from './triplesQuery.js';
import {unsupportedGraphQuery} from './graphQuery.js';
import {catalogOf, withShapeCatalog} from '../utils/ShapeClass.js';

/**
 * Abstraction boundary between the DSL layer (Shape) and the storage layer
 * (LinkedStorage / IDataset). Both sides import this module; neither imports
 * the other. (Its own imports are used only inside functions: the shape-catalog
 * helpers, and the select builder, loaded on demand for the ask fallback.)
 *
 * Return types are intentionally `any` — the DSL layer threads precise
 * result types through its own generics; the dispatch is a runtime bridge.
 */
export interface QueryDispatch {
  /**
   * Answer a select query — **and a count**, which travels this channel too: a
   * count is a select with an aggregate projection, not a query form of its own, so
   * it needs no method here and no router has to grow an arm for it. It arrives as a
   * {@link CountQuery} and resolves to a `number`; see {@link resolveCount}.
   */
  selectQuery<R = any>(query: SelectQuery | CountQuery): Promise<R>;
  /** Answer an ask query — a boolean, not a result set. */
  askQuery(query: AskQuery): Promise<boolean>;
  createQuery<R = any>(query: CreateQuery): Promise<R>;
  updateQuery<R = any>(query: UpdateQuery): Promise<R>;
  deleteQuery(query: DeleteQuery): Promise<DeleteResponse>;
  /**
   * Run a graph query (`IDataset.graphQuery`). Optional here because a dispatch installed by an
   * older copy of core has no such method; {@link resolveGraphQuery} treats a missing one as a
   * dataset without graph support.
   */
  graphQuery?(query: GraphQuery): Promise<GraphResult>;
  /**
   * Answer a triples read (`IDataset.triplesQuery`). Optional, as on `IDataset`;
   * {@link resolveTriples} refuses a target without it.
   */
  triplesQuery?(query: TriplesQuery): Promise<Triple[]>;
}

/** A target that can answer an ask query, or a select (the fallback). */
type ExistenceTarget = {
  askQuery?(query: AskQuery): Promise<boolean>;
  selectQuery?(query: any): Promise<any>;
};

/**
 * Answer an ask query against `target` — the single entry point for every
 * boolean-answered query in the library. `AskBuilder.exec()` and
 * `LinkedStorage.askQuery` both come here rather than calling `askQuery`
 * directly, so the contract below is enforced once for every store.
 *
 * An ask goes to `IDataset.askQuery`, and a SPARQL-backed store turns it into
 * `ASK`. `askQuery` is the one optional dataset method: when `target` has none,
 * the same pattern is sent to `selectQuery` as a select with `LIMIT 1`, and the
 * answer is `true` when a row comes back. A shapeless ask has no select to send,
 * so on such a target it is refused.
 *
 * `askQuery` must resolve to a real boolean: anything else rejects rather than
 * being coerced, since a truthy non-boolean would read as "exists". Errors
 * propagate for the same reason — "could not ask" is never `false`.
 */
export async function resolveExistence(
  target: ExistenceTarget,
  query: AskQuery,
): Promise<boolean> {
  if (typeof target?.askQuery !== 'function') {
    return existenceBySelect(target, query);
  }
  const answer = await target.askQuery(query);
  if (typeof answer !== 'boolean') {
    throw new Error(
      `askQuery must resolve to a boolean; got ${answer === null ? 'null' : typeof answer}. ` +
      'An ask query will not coerce a non-boolean into an answer — a truthy ' +
      'value would silently read as "exists".',
    );
  }
  return answer;
}

/**
 * Answer an ask on a dataset without `askQuery`: the ask's pattern as a select of ids with
 * `LIMIT 1`. The select builder is imported on demand (it imports this module).
 */
async function existenceBySelect(target: ExistenceTarget, query: AskQuery): Promise<boolean> {
  if (typeof target?.selectQuery !== 'function') {
    throw new Error(
      'This dataset implements neither IDataset.askQuery nor IDataset.selectQuery, so an ' +
      'ask query cannot be answered.',
    );
  }
  const {op: _op, nullSubject, ...pattern} = query.toJSON();
  // `.for(null)`: no subject to ask about. AskBuilder.exec answers false before this, but a
  // rehydrated ask can arrive here directly, and without a subject the select would match any
  // instance.
  if (nullSubject) return false;
  if (!pattern.shape) {
    throw new Error(
      'This dataset does not implement IDataset.askQuery, and a shapeless ask ' +
      '("does a node with this IRI exist at all") has no shape to select by. ' +
      'Implement askQuery on the dataset, or ask through a shape.',
    );
  }
  const {SelectBuilder} = await import('./QueryBuilder.js');
  const select = withShapeCatalog(catalogOf(query), () =>
    SelectBuilder.fromJSON({...pattern, shape: pattern.shape as string, limit: 1}),
  );
  const answer = await target.selectQuery(select);
  // A select with one subject is a single-result query: a row or null. Otherwise rows.
  if (answer === null || answer === undefined) return false;
  if (Array.isArray(answer)) return answer.length > 0;
  if (typeof answer === 'object') return true;
  throw new Error(
    `Answering an ask with a select LIMIT 1 expected rows, a row or null; got ${typeof answer}.`,
  );
}

/** A target that may answer a graph query. */
type GraphTarget = {graphQuery?(query: GraphQuery): Promise<GraphResult>};

/**
 * Run a graph query against `target` — the entry point every graph static and router goes
 * through. A target without a `graphQuery` function (a dataset class built against an older
 * core, or a dispatch set by one) is treated exactly like a dataset that throws
 * `unsupported-query-kind`, so callers have one refusal to handle.
 */
export async function resolveGraphQuery(
  target: GraphTarget | undefined,
  query: GraphQuery,
): Promise<GraphResult> {
  if (typeof target?.graphQuery !== 'function') {
    throw unsupportedGraphQuery(query, 'it has no graphQuery method');
  }
  return target.graphQuery(query);
}

/** A target that may answer a triples read. */
type TriplesTarget = {triplesQuery?(query: TriplesQuery): Promise<Triple[]>};

/**
 * Answer a triples read against `target` — the entry point `TriplesBuilder.exec()` and
 * `LinkedStorage.triplesQuery` go through. A target without `triplesQuery` is refused: there is no
 * shape to answer it with a select instead, and "could not read" is never an empty answer. The
 * answer must be an array; anything else rejects.
 */
export async function resolveTriples(
  target: TriplesTarget | undefined,
  query: TriplesQuery,
): Promise<Triple[]> {
  if (typeof target?.triplesQuery !== 'function') {
    throw new Error(
      'This dataset does not implement IDataset.triplesQuery, so a triples read (a graph read ' +
        'or a subject read) cannot be answered. SparqlDataset implements it; a router forwards it ' +
        'to the dataset that holds the data.',
    );
  }
  const answer = await target.triplesQuery(query);
  if (!Array.isArray(answer)) {
    throw new Error(
      `triplesQuery must resolve to an array of triples; got ${answer === null ? 'null' : typeof answer}.`,
    );
  }
  return answer;
}

/**
 * A target that can answer a count query — which is to say, any target that can
 * answer a select. There is no count-specific member to look for.
 */
type CountTarget = {selectQuery?(query: any): Promise<any>};

/**
 * Answer a count query against `target` — the single entry point for every
 * number-answered query in the library, as {@link resolveExistence} is for boolean
 * ones. `CountBuilder.exec()` comes here rather than calling the store directly, so
 * the contract below is enforced once for every store.
 *
 * **A count is dispatched over the SELECT channel.** It is not a separate query
 * form: `SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { … }` is a select with an
 * aggregate projection, run over the same transport and answered with the same
 * result-set response — which is exactly why an ask, which really is a different
 * form (`ASK WHERE { … }`), has its own `IDataset.askQuery` and a count does not.
 * Riding `selectQuery` is what lets a count reach a store through every router that
 * already forwards a select, rather than needing a new arm in each of them (the
 * arm `LinkedStorage` never grew, which is how a count came to fail on every
 * application path while passing against a store held directly).
 *
 * There is still deliberately **no translation to a row query anywhere in this
 * package.** A store receives the count query itself and decides how to answer it;
 * one extending `SparqlDataset` branches on the lowered IR and emits the aggregate.
 * Nothing here fetches every row and measures the array — that would hide an
 * unbounded read behind a call that looks cheap.
 *
 * The answer must be a **finite, non-negative integer**: anything else rejects
 * rather than being coerced. That validation lives here, at the dispatch, because
 * this is where the count result is read — and it is load-bearing. Errors propagate
 * for the same reason a failed ask is never `false`, and more sharply, because `0`
 * is a *plausible* count: a count that reported an unreachable store as `0` would
 * render an empty table that looks exactly like real data. A store that ignored the
 * count and answered with rows is caught by the same check.
 */
export async function resolveCount(
  target: CountTarget,
  query: CountQuery,
): Promise<number> {
  if (typeof target?.selectQuery !== 'function') {
    throw new Error(
      'This dataset does not implement IDataset.selectQuery(query), which is how a ' +
      'count query is dispatched: a count is a select with an aggregate projection ' +
      '(a SPARQL store emits SELECT (COUNT(DISTINCT ?s) AS ?count)), not a query ' +
      'form of its own.',
    );
  }
  const answer = await target.selectQuery(query);
  if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0) {
    throw new Error(
      `A count query must be answered with a non-negative integer; got ${
        answer === null
          ? 'null'
          : typeof answer === 'number'
            ? String(answer)
            : Array.isArray(answer)
              ? 'an array of rows'
              : typeof answer
      }. It is not coerced — a NaN or a missing value that fell through as 0 would ` +
      'silently read as "no matches". A store that answered with rows ran the ' +
      'pattern as a row query instead of counting it: it must branch on the lowered ' +
      "IR's `kind === 'count'` and emit an aggregate.",
    );
  }
  return answer;
}

// Global-backed so it is SHARED across duplicate copies of this module. In dev,
// `@_linked/core` can be evaluated twice (Vite/`src` + Node/`lib` — an accepted
// 2-instance state, see report-011). The module REGISTRY already lives on the
// shared global; the query dispatch must too, or `setDefaultDataset()` on one
// copy is invisible to queries on the other ("No query dispatch configured").
// Whichever copy runs the storage config sets it; every copy reads it.
const dispatchGlobal: any =
  typeof globalThis !== 'undefined' ? globalThis : ({} as any);
if (!('__linkedQueryDispatch' in dispatchGlobal)) {
  dispatchGlobal.__linkedQueryDispatch = {
    current: null as QueryDispatch | null,
    listeners: new Set<QueryDispatchListener>(),
  };
} else if (!dispatchGlobal.__linkedQueryDispatch.listeners) {
  // An older copy of this module created the record before listeners existed.
  dispatchGlobal.__linkedQueryDispatch.listeners = new Set<QueryDispatchListener>();
}

/**
 * One query passing through the dispatch, reported to {@link subscribeQueryDispatch}
 * listeners. `query` is the very builder handed to the store (same identity), and
 * `result` is the store's answer as a promise — not yet settled when the event fires.
 */
export type QueryDispatchEvent = (
  | {kind: 'select'; query: SelectQuery | CountQuery; result: Promise<unknown>}
  | {kind: 'ask'; query: AskQuery; result: Promise<boolean>}
  | {kind: 'create'; query: CreateQuery; result: Promise<unknown>}
  | {kind: 'update'; query: UpdateQuery; result: Promise<unknown>}
  | {kind: 'delete'; query: DeleteQuery; result: Promise<DeleteResponse>}
  | {kind: 'graph'; query: GraphQuery; result: Promise<GraphResult>}
  | {kind: 'triples'; query: TriplesQuery; result: Promise<Triple[]>}
) & {
  /** The explicit dataset of an `exec(target)` call; absent for the global dispatch. */
  target?: IDataset;
};

/** Listener notified for every query that runs through the dispatch. */
export type QueryDispatchListener = (event: QueryDispatchEvent) => void;

/**
 * Observe every query that runs through the dispatch. Returns an unsubscribe function.
 *
 * Listeners are notified **synchronously at call time**, as soon as the store has
 * been handed the query, with the result promise attached — so an observer can both
 * see what was asked and await what came back. Listeners never alter the result:
 * the promise the caller receives is the store's own, whatever any listener does
 * with it. A listener that throws is logged (`console.error`) and isolated — it
 * neither rejects the query nor stops later listeners.
 *
 * The listener set lives on `globalThis`, beside `current`, for the same reason the
 * dispatch itself does: core can be evaluated twice in dev, and a subscription made
 * through one copy must see queries dispatched through the other.
 */
export function subscribeQueryDispatch(listener: QueryDispatchListener): () => void {
  const listeners = dispatchGlobal.__linkedQueryDispatch.listeners as Set<QueryDispatchListener>;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyDispatch(event: QueryDispatchEvent): void {
  const listeners = dispatchGlobal.__linkedQueryDispatch.listeners as Set<QueryDispatchListener>;
  // Snapshot so a listener that (un)subscribes during notification can't mutate
  // the set mid-iteration.
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error('[linked] query dispatch listener failed', err);
    }
  }
}

/** Marker on a dispatch object that is already wrapped by {@link instrumentDispatch}. */
const INSTRUMENTED = '__instrumented';

/**
 * Wrap a dispatch so every method call is reported to the listeners. Each method
 * forwards to `d`, normalises the return to a promise, notifies, and returns that same
 * promise. Idempotent: an already-instrumented dispatch is returned as is, so re-setting
 * the current dispatch with itself never double-reports.
 */
function instrumentDispatch(d: QueryDispatch, target?: IDataset): QueryDispatch {
  if ((d as any)?.[INSTRUMENTED]) return d;
  // `target` is only set for an explicit `exec(target)`: the wrapper is created
  // per call and the user's dataset object is never marked or mutated.
  const wrapped: QueryDispatch = {
    selectQuery<R = any>(query: SelectQuery | CountQuery): Promise<R> {
      const result = Promise.resolve(d.selectQuery<R>(query));
      notifyDispatch({kind: 'select', query, result, target});
      return result;
    },
    askQuery(query: AskQuery): Promise<boolean> {
      const result = Promise.resolve(d.askQuery(query));
      notifyDispatch({kind: 'ask', query, result, target});
      return result;
    },
    createQuery<R = any>(query: CreateQuery): Promise<R> {
      const result = Promise.resolve(d.createQuery<R>(query));
      notifyDispatch({kind: 'create', query, result, target});
      return result;
    },
    updateQuery<R = any>(query: UpdateQuery): Promise<R> {
      const result = Promise.resolve(d.updateQuery<R>(query));
      notifyDispatch({kind: 'update', query, result, target});
      return result;
    },
    deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
      const result = Promise.resolve(d.deleteQuery(query));
      notifyDispatch({kind: 'delete', query, result, target});
      return result;
    },
    graphQuery(query: GraphQuery): Promise<GraphResult> {
      const result = resolveGraphQuery(d, query);
      notifyDispatch({kind: 'graph', query, result, target});
      return result;
    },
    triplesQuery(query: TriplesQuery): Promise<Triple[]> {
      const result = resolveTriples(d, query);
      notifyDispatch({kind: 'triples', query, result, target});
      return result;
    },
  };
  Object.defineProperty(wrapped, INSTRUMENTED, {value: true, enumerable: false});
  return wrapped;
}

/**
 * Send a graph query through the explicit `target` dataset (observed like the global path), or
 * through the global dispatch. Either way a missing `graphQuery` is refused with
 * `unsupported-query-kind` (see {@link resolveGraphQuery}).
 */
export function dispatchGraphQuery(query: GraphQuery, target?: IDataset): Promise<GraphResult> {
  const dispatch = target
    ? instrumentDispatch(target as unknown as QueryDispatch, target)
    : getQueryDispatch();
  return resolveGraphQuery(dispatch, query);
}

/**
 * Send a triples read through the explicit `target` dataset (observed like the global path), or
 * through the global dispatch. Either way a missing `triplesQuery` is refused (see
 * {@link resolveTriples}).
 */
export function dispatchTriplesQuery(query: TriplesQuery, target?: IDataset): Promise<Triple[]> {
  const dispatch = target
    ? instrumentDispatch(target as unknown as QueryDispatch, target)
    : getQueryDispatch();
  return resolveTriples(dispatch, query);
}

export function setQueryDispatch(d: QueryDispatch): void {
  dispatchGlobal.__linkedQueryDispatch.current = instrumentDispatch(d);
}

export function getQueryDispatch(): QueryDispatch {
  const dispatch = dispatchGlobal.__linkedQueryDispatch.current as QueryDispatch | null;
  if (!dispatch) {
    throw new Error(
      'No query dispatch configured. Call LinkedStorage.setDefaultDataset() first.',
    );
  }
  return dispatch;
}

/**
 * The mutating query kinds. Required on `IDataset`, but a dataset class built against an older
 * core may still lack one, so an explicit target is checked.
 */
export type MutationKind = 'create' | 'update' | 'delete';

/**
 * Pick the object a mutation `exec(target?)` dispatches through: the explicit `target`
 * dataset (validated to implement the op) when a target is given, otherwise the global
 * dispatch. A target that can't perform `kind` (a dataset class built against an older core,
 * when these methods were optional) is a caller error.
 *
 * Throws synchronously if the target lacks the method — callers invoke this from within an
 * `async exec`, so the throw surfaces as a rejected promise rather than a synchronous throw.
 */
export function resolveMutationDispatch(
  kind: MutationKind,
  target?: IDataset,
): QueryDispatch {
  if (!target) return getQueryDispatch();
  if (typeof target[`${kind}Query`] !== 'function') {
    throw new Error(`The target dataset does not support ${kind} queries.`);
  }
  // Instrumented so `builder.exec(target)` is observed like the global path.
  return instrumentDispatch(target as unknown as QueryDispatch, target);
}
