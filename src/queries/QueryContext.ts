import {type QShape, QueryShape} from './SelectQuery.js';
import {Shape, createShapeTarget} from '../shapes/Shape.js';

const queryContext = new Map<string, QShape<any, any, any>>();

/**
 * A live reference returned by getQueryContext when the context hasn't been set yet.
 * Its `id` getter resolves lazily from the global context map, so queries built with
 * a PendingQueryContext will pick up the value once it's set (e.g. after auth completes).
 */
export class PendingQueryContext {
  constructor(public readonly contextName: string) {}

  get id(): string | undefined {
    return queryContext.get(this.contextName)?.id;
  }
}

/**
 * Thrown when a query carrying a context reference is lowered but the context
 * isn't set in the current process. A context ref is carried in DSL-JSON and
 * resolves at lowering time against whatever context map is available (e.g.
 * server-side auth); if it can't resolve, lowering throws this rather than
 * silently producing a subject-less query.
 */
export class UnresolvedContextError extends Error {
  constructor(public readonly contextName: string) {
    super(
      `Query context "${contextName}" is not set and could not be resolved at lowering time.`,
    );
    this.name = 'UnresolvedContextError';
  }
}

/** Listener notified (with the changed context name) whenever a context is set or cleared. */
export type QueryContextListener = (name: string) => void;
const contextListeners = new Set<QueryContextListener>();

/**
 * Subscribe to query-context changes. Returns an unsubscribe function.
 *
 * This is the primitive that makes context resolution reactive: a consuming layer
 * (e.g. React components) subscribes and re-runs affected queries when the context
 * lands — so a query that resolved to `null` while the context was unset simply
 * re-runs and resolves once it's available ("waiting"), and re-runs again on any
 * later change ("auto re-resolve"). Core only emits the change; re-execution is the
 * consumer's responsibility.
 */
export function subscribeQueryContext(listener: QueryContextListener): () => void {
  contextListeners.add(listener);
  return () => contextListeners.delete(listener);
}

function notifyContextChange(name: string): void {
  // Snapshot so a listener that (un)subscribes or re-sets a context during
  // notification can't mutate the set mid-iteration.
  for (const listener of [...contextListeners]) {
    try {
      listener(name);
    } catch (err) {
      // A listener must never break setQueryContext for the others.
      console.error('[linked] query context listener failed', err);
    }
  }
}

/**
 * Normalize any query-context value to a {@link PendingQueryContext} carrying its name,
 * or return `undefined` if the value is not a context reference.
 *
 * A context appears in two runtime forms: a `PendingQueryContext` (the context was unset
 * when `getQueryContext()` was called) or a resolved `QueryShape` stamped with
 * `__queryContextName` (it was already set). Both must be treated as the same `{@ctx}`
 * reference wherever a node value/id is accepted (mutation field values, delete ids), so
 * that context-bound mutations behave identically whether the context is set or unset at
 * build time — resolution always happens at lowering.
 */
export function asContextRef(value: unknown): PendingQueryContext | undefined {
  if (value instanceof PendingQueryContext) return value;
  if (!value || typeof value !== 'object') return undefined;
  // A resolved context is a QueryShape proxy wrapping a Shape stamped with
  // `__queryContextName`. Read it via `originalValue` (a known QueryShape field)
  // so we don't trip the proxy's "undecorated property" guard (it now throws);
  // a bare Shape
  // carries the stamp directly.
  const v = value as {originalValue?: {__queryContextName?: unknown}; __queryContextName?: unknown};
  const source = v.originalValue ?? v;
  const name = (source as {__queryContextName?: unknown}).__queryContextName;
  if (typeof name === 'string') return new PendingQueryContext(name);
  return undefined;
}

export function getQueryContext<T extends Shape>(name: string): QShape<T> {
  if (queryContext.has(name)) {
    return queryContext.get(name);
  }
  // Return a live reference that resolves lazily when the context is set.
  // This avoids the timing issue where module-level queries capture null
  // because the context hasn't been set yet (e.g. useEffect hasn't fired).
  return new PendingQueryContext(name) as any;
}

export function setQueryContext(name: string, value: any, shapeType?) {
  // Clearing a context entry
  if (!value) {
    queryContext.delete(name);
    notifyContextChange(name);
    return;
  }

  // Already a QShape — stamp the underlying shape and store as-is. (Checked before
  // the plain-`{id}` branch below: a QueryShape's `.id` getter is also a string, so
  // testing for `{id}` first would wrongly require a shapeType and no-op.)
  if (value instanceof QueryShape) {
    const orig = (value as any).originalValue;
    if (orig) {
      orig.__queryContextName = name;
      if (typeof orig.id === 'string') orig.__queryContextId = orig.id;
    }
    queryContext.set(name, value as any);
    notifyContextChange(name);
    return;
  }

  // A Shape-shaped value (e.g. a `createShapeTarget` proxy target) — stamp it and
  // wrap as a QShape. Needs no shapeType (it already carries its shape class).
  if (value instanceof Shape) {
    value.__queryContextName = name;
    if (typeof value.id === 'string') value.__queryContextId = value.id;
    queryContext.set(name, new QueryShape(value) as any);
    notifyContextChange(name);
    return;
  }

  // A plain QResult `{id}` — materialize a shape (requires shapeType).
  if (typeof value.id === 'string') {
    if (!shapeType) {
      // A silent no-op here is a trap: the context never sets and the caller
      // gets no signal. A `{id}` value cannot be materialized without its shape.
      throw new Error(
        `setQueryContext('${name}'): a {id} value requires a shapeType so the shape can be materialized. Pass the Shape class as the third argument.`,
      );
    }
    const shape = createShapeTarget(shapeType as any, value.id);
    shape.__queryContextId = value.id;
    shape.__queryContextName = name;
    queryContext.set(name, QueryShape.create(shape) as any);
    notifyContextChange(name);
    return;
  }

  throw new Error(
    `setQueryContext('${name}'): value is not a QueryShape, Shape, or {id} result. Got ${typeof value}. Pass a Shape instance, a query-context shape, or a {id} result (with its shapeType).`,
  );
}
