import type {SelectQuery} from './SelectQuery.js';
import type {CreateQuery} from './CreateQuery.js';
import type {UpdateQuery} from './UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from './DeleteQuery.js';
import type {IDataset} from '../interfaces/IDataset.js';
import type {AskQuery} from './AskQuery.js';
import type {CountQuery} from './CountQuery.js';

/**
 * Abstraction boundary between the DSL layer (Shape) and the storage layer
 * (LinkedStorage / IDataset). Both sides import this leaf module; neither
 * imports the other.
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
}

/** A target that can answer an ask query. */
type ExistenceTarget = {askQuery(query: AskQuery): Promise<boolean>};

/**
 * Answer an ask query against `target` — the single entry point for every
 * boolean-answered query in the library. `AskBuilder.exec()` and
 * `LinkedStorage.askQuery` both come here rather than calling `askQuery`
 * directly, so the contract below is enforced once for every store.
 *
 * There is deliberately **no translation to a select query anywhere in this
 * package.** An ask goes to `IDataset.askQuery` and a SPARQL-backed store turns
 * it into `ASK`. A store that lacks a boolean primitive implements `askQuery`
 * itself, in whatever way its backend allows — that decision belongs to the
 * store, and making it here would hide it.
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
    throw new Error(
      'This dataset does not implement the required IDataset.askQuery(query). ' +
      'An ask query is answered with a boolean — a SPARQL store emits ASK — and is ' +
      'never rewritten as a select on its behalf.',
    );
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
  };
  Object.defineProperty(wrapped, INSTRUMENTED, {value: true, enumerable: false});
  return wrapped;
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

/** The mutating query kinds — the `IDataset` methods that are optional per-store. */
export type MutationKind = 'create' | 'update' | 'delete';

/**
 * Pick the object a mutation `exec(target?)` dispatches through: the explicit `target`
 * dataset (validated to implement the op) when a target is given, otherwise the global
 * dispatch. Unlike `selectQuery`, a store's mutation methods are optional on `IDataset`,
 * so a target that can't perform `kind` is a caller error.
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
