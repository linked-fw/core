/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {LinkedStorage} from '../utils/LinkedStorage.js';
import type {IDataset} from '../interfaces/IDataset.js';
import {subscribeQueryContext} from '../queries/QueryContext.js';
import {resolveContextId} from '../queries/ContextRef.js';
import {subscribeQueryDispatch, type QueryDispatchEvent} from '../queries/queryDispatch.js';
import {
  mutationEffects,
  queryDependencies,
  type MutationEffects,
  type QueryDependencies,
} from '../queries/queryDependencies.js';
import {getShapeClass} from '../utils/ShapeClass.js';
import type {ShapeConstructor} from '../shapes/Shape.js';
import {effectsHash, normalizeChange, type ChangeEvent} from './changes.js';
import {selectInstances} from './matcher.js';
import {
  bindParams,
  kindOf,
  paramsKey,
  splitQuery,
  stableStringify,
  type InstanceParams,
  type LiveBuilder,
  type LiveQueryKind,
} from './keys.js';
import {setLiveQueryStore, peekLiveQueryStore} from './registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LiveStatus = 'pending' | 'loading' | 'success' | 'error';

/**
 * What a live query currently knows.
 *
 * - `pending`: nothing requested yet (no storage configured, or the subject is
 *   a query context that has not been set).
 * - `loading`: first request in flight, no data yet.
 * - `success` / `error`: last request settled. On error the previous `data`,
 *   if any, is kept so a screen does not go blank over a transient failure.
 * - `refreshing`: a request is in flight while `data` is present.
 * - `notFound`: a single-subject query answered `null`.
 *
 * The object is replaced (never mutated) on every change, so it is safe as a
 * `useSyncExternalStore` snapshot.
 */
export type LiveState<R = unknown> = {
  status: LiveStatus;
  data?: R;
  error?: Error;
  notFound: boolean;
  refreshing: boolean;
};

export type LiveListener<R = unknown> = (state: LiveState<R>) => void;

export type LiveQueryOptions = {
  /** Metadata for the template registry (`prepare()`), not identity. */
  name?: string;
  /** `false` opts this template out of automatic invalidation. Default `true`. */
  reactive?: boolean;
  /** A pinned template survives having no instances (component definitions, `prepare()`). */
  pinned?: boolean;
};

/**
 * The handle returned by `query.live()`.
 *
 * It is `PromiseLike`: `await live` resolves with the first successful `data`
 * (or rejects with the first error) and the handle stays live afterwards.
 * Because of that, do not `return` a handle from an `async` function — the
 * promise machinery would unwrap it. `subscribe(cb)` follows the Svelte store
 * contract (returns the unsubscribe function).
 */
export interface LiveQuery<R = unknown> extends PromiseLike<R> {
  readonly state: LiveState<R>;
  /** Identity of the underlying instance (template key + params). */
  readonly key: string;
  subscribe(listener: LiveListener<R>): () => void;
  /** Refetch now, keeping the current data on screen until the response lands. */
  refresh(): Promise<void>;
  /** Local edit of the cached data, no request; overwritten by the next refetch. */
  patch(partial: Partial<R> | ((current: R) => R)): void;
  /** Detach every listener added through this handle and release the instance. */
  close(): void;
}

export type Template = {
  key: string;
  kind: LiveQueryKind;
  name?: string;
  json: Record<string, unknown>;
  builder: LiveBuilder;
  shapeIri?: string;
  reactive: boolean;
  pinned: boolean;
  deps?: QueryDependencies;
  instances: Map<string, Instance>;
};

export type Instance = {
  key: string;
  template: Template;
  params: InstanceParams;
  state: LiveState;
  /** Sequence of the latest issued request; a response carrying an older sequence is dropped. */
  seq: number;
  inflight: boolean;
  /** Invalidated while a request was in flight: run one more request when it settles. */
  staleWhileInflight: boolean;
  /** Every node id the last result mentions, plus the subject(s). */
  ids: Set<string>;
  listeners: Set<LiveListener>;
  gcTimer?: ReturnType<typeof setTimeout>;
};

export type LiveQueryStoreOptions = {
  /** Grace period before an instance with no listeners is dropped. */
  gcMs: number;
  /** Window in which identical change events are treated as one (local + remote echo). */
  echoMs: number;
};

const IDLE: LiveState = Object.freeze({status: 'pending', notFound: false, refreshing: false}) as LiveState;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Holds every live query in the runtime: templates (what is read) and
 * instances (what it is applied to, and the data). Framework-free; UI layers
 * subscribe to instances. One store per runtime, registered on `globalThis`
 * (see `registry.ts`).
 */
export class LiveQueryStore {
  readonly options: LiveQueryStoreOptions = {gcMs: 30_000, echoMs: 50};

  /** @internal */
  readonly _templates = new Map<string, Template>();
  /** @internal Indexes read by the change matcher. */
  readonly templatesByProp = new Map<string, Set<Template>>();
  /** @internal */
  readonly templatesByShape = new Map<string, Set<Template>>();
  /** @internal */
  readonly instancesById = new Map<string, Set<Instance>>();

  private readonly _disposers: Array<() => void> = [];
  private readonly _feeds = new Map<IDataset, () => void>();
  private readonly _recentChanges = new Map<string, number>();
  private _pendingRefetch = new Set<Instance>();
  private _flushScheduled = false;

  constructor() {
    this._disposers.push(subscribeQueryContext((name) => this._onContextChange(name)));
    this._disposers.push(subscribeQueryDispatch((e) => this._onDispatch(e)));
    this._disposers.push(LinkedStorage.onRoutingChanged(() => this._onRoutingChanged()));
    this._scanDatasets();
  }

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  /** Register (or find) the template of `query`. Options merge into an existing template. */
  template(query: LiveBuilder, opts: LiveQueryOptions = {}): Template {
    const split = splitQuery(query);
    const key = stableStringify(split.templateJson);
    let t = this._templates.get(key);
    if (!t) {
      t = {
        key,
        kind: split.kind,
        json: split.templateJson,
        builder: query,
        shapeIri: typeof split.templateJson.shape === 'string' ? (split.templateJson.shape as string) : undefined,
        reactive: true,
        pinned: false,
        instances: new Map(),
      };
      this._templates.set(key, t);
    }
    if (opts.name !== undefined) t.name = opts.name;
    if (opts.reactive !== undefined) t.reactive = opts.reactive;
    if (opts.pinned) t.pinned = true;
    return t;
  }

  /** The registered templates (for database tuning, devtools). */
  templates(): ReadonlyArray<{key: string; kind: LiveQueryKind; name?: string; json: Record<string, unknown>}> {
    return [...this._templates.values()].map((t) => ({key: t.key, kind: t.kind, name: t.name, json: t.json}));
  }

  /** Compute the dependencies of every template now (they are otherwise computed on first use). */
  prepare(): void {
    for (const t of this._templates.values()) this.depsOf(t);
  }

  /** @internal The watch set of a template, computed once. */
  depsOf(template: Template): QueryDependencies {
    if (!template.deps) {
      template.deps = queryDependencies(template.builder as any);
      this._onDepsComputed(template);
    }
    return template.deps;
  }

  private _onDepsComputed(t: Template): void {
    const deps = t.deps!;
    for (const set of [deps.narrow, deps.filter, deps.hidden]) {
      for (const p of set) addToIndex(this.templatesByProp, p, t);
    }
    for (const s of deps.shapes) addToIndex(this.templatesByShape, s, t);
  }

  // -------------------------------------------------------------------------
  // Instances and handles
  // -------------------------------------------------------------------------

  /** @internal Get or create the instance of `template` for `params`. */
  instance(template: Template, params: InstanceParams): Instance {
    const pk = paramsKey(params);
    let inst = template.instances.get(pk);
    if (!inst) {
      this.depsOf(template); // index the template before its first instance exists
      inst = {
        key: `${template.key}|${pk}`,
        template,
        params,
        state: IDLE,
        seq: 0,
        inflight: false,
        staleWhileInflight: false,
        ids: new Set(),
        listeners: new Set(),
      };
      template.instances.set(pk, inst);
    }
    return inst;
  }

  /**
   * Subscribe to `query`. The first listener on an instance starts its fetch;
   * identical queries share one instance and one request.
   */
  subscribe<R = unknown>(query: LiveBuilder, listener?: LiveListener<R>, opts: LiveQueryOptions = {}): LiveQuery<R> {
    const template = this.template(query, opts);
    const {params} = splitQuery(query);
    const handle = new LiveQueryHandle<R>(this, this.instance(template, params));
    if (listener) handle.subscribe(listener);
    return handle;
  }

  /** @internal */
  _attach(inst: Instance, listener: LiveListener): void {
    this._cancelGc(inst);
    inst.listeners.add(listener);
    if (inst.state.status === 'pending' && !inst.inflight) {
      void this._fetch(inst);
    }
  }

  /** @internal */
  _detach(inst: Instance, listener: LiveListener): void {
    inst.listeners.delete(listener);
    if (inst.listeners.size === 0) this._scheduleGc(inst);
  }

  /** Refetch an instance, keeping its data on screen. Resolves when that request settles. */
  refresh(inst: Instance): Promise<void> {
    return this._fetch(inst);
  }

  /** Local edit of an instance's data. Never touches the store. */
  patch(inst: Instance, partial: unknown): void {
    const current = inst.state.data;
    const next =
      typeof partial === 'function'
        ? (partial as (c: unknown) => unknown)(current)
        : current && typeof current === 'object' && !Array.isArray(current)
          ? {...(current as object), ...(partial as object)}
          : partial;
    this._setState(inst, {...inst.state, data: next, notFound: next === null});
    this._collectIds(inst, next);
  }

  /**
   * Refetch every instance matching `target`: a shape class or shape IRI
   * (everything that scans or traverses it, as after a delete), a node
   * reference (`{id}`), a query (its template), or a template.
   */
  invalidate(target: ShapeConstructor<any> | string | {id: string} | LiveBuilder | Template): void {
    if (typeof target === 'function' || typeof target === 'string') {
      const shape = typeof target === 'string' ? target : (target as {shape?: {id?: string}}).shape?.id;
      if (!shape) throw new Error('invalidate(): the shape class has no registered shape.');
      this.publish({effects: {op: 'delete', shape, props: new Set(), ids: undefined, membership: new Set([shape])}});
      return;
    }
    const instances = new Set<Instance>();
    if (isTemplate(target)) {
      for (const i of target.instances.values()) instances.add(i);
    } else if (typeof (target as {__queryKind?: string}).__queryKind === 'string') {
      const t = this._templates.get(stableStringify(splitQuery(target as LiveBuilder).templateJson));
      if (t) for (const i of t.instances.values()) instances.add(i);
    } else if (typeof (target as {id?: unknown}).id === 'string') {
      const id = (target as {id: string}).id;
      for (const t of this._templates.values()) {
        for (const i of t.instances.values()) if (i.ids.has(id)) instances.add(i);
      }
    }
    this._refetchAll(instances);
  }

  /** @internal Refetch a set of instances, folding in-flight ones into one follow-up request. */
  _refetchAll(instances: Iterable<Instance>): void {
    for (const inst of instances) {
      if (inst.listeners.size === 0) continue; // nobody is watching; it will refetch when subscribed again
      if (inst.inflight) inst.staleWhileInflight = true;
      else void this._fetch(inst);
    }
  }

  // -------------------------------------------------------------------------
  // Change sources
  // -------------------------------------------------------------------------

  /**
   * Tell the store that data changed. Every source ends here: local mutations
   * (automatically), dataset change feeds, and application code via
   * `publishChange()`. Identical events within `options.echoMs` are folded
   * into one, so a local change and its remote echo refetch once.
   */
  publish(event: ChangeEvent): void {
    const effects = normalizeChange(event);
    const hash = effectsHash(effects);
    const now = Date.now();
    const last = this._recentChanges.get(hash);
    if (last !== undefined && now - last < this.options.echoMs) return;
    this._recentChanges.set(hash, now);
    if (this._recentChanges.size > 256) {
      for (const [h, t] of this._recentChanges) if (now - t >= this.options.echoMs) this._recentChanges.delete(h);
    }
    for (const inst of selectInstances(this, effects)) this._pendingRefetch.add(inst);
    this._scheduleFlush();
  }

  private _scheduleFlush(): void {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    queueMicrotask(() => {
      this._flushScheduled = false;
      const batch = this._pendingRefetch;
      this._pendingRefetch = new Set();
      this._refetchAll(batch);
    });
  }

  private _onDispatch(e: QueryDispatchEvent): void {
    if (e.kind !== 'create' && e.kind !== 'update' && e.kind !== 'delete') return;
    const query = e.query as {shape?: {id?: string}};
    const shapeClass = query.shape?.id ? getShapeClass(query.shape.id) : undefined;
    const dataset = LinkedStorage.getDatasetForShapeClass(shapeClass as Function | undefined);
    if (dataset?.authoritativeChanges) return; // the dataset's own feed will report it
    e.result.then(
      (result) => this.publish({effects: mutationEffects(e.query as any, result)}),
      () => {}, // a failed mutation changed nothing
    );
  }

  /**
   * Storage changed (a dataset was set, pinned or unpinned): what is cached may
   * come from a store that no longer answers, so instances nobody watches are
   * dropped and watched ones fetch again. Also picks up new change feeds.
   */
  private _onRoutingChanged(): void {
    this._scanDatasets();
    this._recentChanges.clear();
    for (const t of [...this._templates.values()]) {
      for (const inst of [...t.instances.values()]) {
        if (inst.listeners.size === 0) {
          this._cancelGc(inst);
          t.instances.delete(paramsKey(inst.params));
          this._handles.delete(inst);
          this._onInstanceDropped(inst);
        } else {
          this._refetchAll([inst]);
        }
      }
      if (t.instances.size === 0 && !t.pinned) {
        this._templates.delete(t.key);
        this._onTemplateDropped(t);
      }
    }
  }

  private _scanDatasets(): void {
    for (const dataset of LinkedStorage.getDatasets()) {
      if (typeof dataset.subscribeChanges !== 'function' || this._feeds.has(dataset)) continue;
      this._feeds.set(dataset, dataset.subscribeChanges((event) => this.publish(event)));
    }
  }

  /** Drop every template and instance (tests). Subscriptions to sources stay. */
  reset(): void {
    for (const t of this._templates.values()) {
      for (const i of t.instances.values()) this._cancelGc(i);
    }
    this._templates.clear();
    this.templatesByProp.clear();
    this.templatesByShape.clear();
    this.instancesById.clear();
    this._recentChanges.clear();
    this._pendingRefetch.clear();
  }

  /** @internal */
  dispose(): void {
    this.reset();
    for (const off of this._disposers) off();
    for (const off of this._feeds.values()) off();
    this._feeds.clear();
  }

  // -------------------------------------------------------------------------
  // Fetching
  // -------------------------------------------------------------------------

  private async _fetch(inst: Instance): Promise<void> {
    if (!LinkedStorage.isInitialised()) {
      this._setState(inst, {...inst.state, status: 'pending', refreshing: false});
      return;
    }
    const bound = bindParams(inst.template.builder, inst.params);
    if (inst.params.contextName && !inst.params.subject) {
      this._setState(inst, {...inst.state, status: 'pending', refreshing: false});
      return;
    }
    const seq = ++inst.seq;
    inst.inflight = true;
    const hasData = inst.state.data !== undefined;
    this._setState(inst, {
      ...inst.state,
      status: hasData ? inst.state.status : 'loading',
      refreshing: hasData,
    });
    try {
      // `exec()` is the same path `await query` takes: dispatch, count/ask
      // contracts, error wrapping. The store adds nothing of its own to it.
      const data = await (bound as {exec(): Promise<unknown>}).exec();
      if (seq !== inst.seq) return;
      this._applyResult(inst, data);
    } catch (err) {
      if (seq !== inst.seq) return;
      this._setState(inst, {
        ...inst.state,
        status: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
        refreshing: false,
      });
    } finally {
      if (seq === inst.seq) {
        inst.inflight = false;
        if (inst.staleWhileInflight) {
          inst.staleWhileInflight = false;
          void this._fetch(inst);
        }
      }
    }
  }

  private _applyResult(inst: Instance, data: unknown): void {
    const notFound = data === null && inst.template.kind === 'select' && !!(inst.params.subject || inst.params.one);
    if (inst.state.status === 'success' && deepEqual(inst.state.data, data)) {
      // Structural sharing: same data, keep the reference and stay quiet.
      if (inst.state.refreshing) this._setState(inst, {...inst.state, refreshing: false, error: undefined});
      return;
    }
    this._collectIds(inst, data);
    this._setState(inst, {status: 'success', data, error: undefined, notFound, refreshing: false});
  }

  private _collectIds(inst: Instance, data: unknown): void {
    const ids = new Set<string>();
    if (inst.params.subject) ids.add(inst.params.subject);
    for (const s of inst.params.subjects ?? []) ids.add(s);
    collectIds(data, ids);
    for (const old of inst.ids) if (!ids.has(old)) removeFromIndex(this.instancesById, old, inst);
    for (const id of ids) if (!inst.ids.has(id)) addToIndex(this.instancesById, id, inst);
    inst.ids = ids;
  }

  private _setState(inst: Instance, state: LiveState): void {
    inst.state = state;
    for (const l of [...inst.listeners]) {
      try {
        l(state);
      } catch (err) {
        console.error('[linked] live query listener failed', err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Query context
  // -------------------------------------------------------------------------

  private _onContextChange(name: string): void {
    const resolved = resolveContextId(name, false);
    for (const t of [...this._templates.values()]) {
      for (const inst of [...t.instances.values()]) {
        if (inst.params.contextName !== name) continue;
        const params: InstanceParams = {...inst.params};
        if (resolved) params.subject = resolved;
        else delete params.subject;
        const pk = paramsKey(params);
        if (pk === paramsKey(inst.params)) continue;
        // Move the listeners to the instance for the new subject and drop the old one.
        const next = this.instance(t, params);
        t.instances.delete(paramsKey(inst.params));
        this._cancelGc(inst);
        this._onInstanceDropped(inst);
        inst.seq++; // any in-flight response for the old subject is now stale
        for (const l of inst.listeners) next.listeners.add(l);
        inst.listeners.clear();
        for (const h of this._handlesOf(inst)) h._moveTo(next);
        if (next.listeners.size > 0) {
          if (!resolved) this._setState(next, {...IDLE});
          else if (next.state.status === 'pending' && !next.inflight) void this._fetch(next);
          else this._setState(next, next.state); // publish the cached state to the moved listeners
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Handles and GC
  // -------------------------------------------------------------------------

  private readonly _handles = new Map<Instance, Set<LiveQueryHandle<any>>>();

  /** @internal */
  _registerHandle(h: LiveQueryHandle<any>, inst: Instance): void {
    let set = this._handles.get(inst);
    if (!set) this._handles.set(inst, (set = new Set()));
    set.add(h);
  }

  /** @internal */
  _unregisterHandle(h: LiveQueryHandle<any>, inst: Instance): void {
    const set = this._handles.get(inst);
    if (!set) return;
    set.delete(h);
    if (set.size === 0) this._handles.delete(inst);
  }

  private _handlesOf(inst: Instance): LiveQueryHandle<any>[] {
    const set = this._handles.get(inst);
    const list = set ? [...set] : [];
    this._handles.delete(inst);
    return list;
  }

  private _scheduleGc(inst: Instance): void {
    this._cancelGc(inst);
    const timer = setTimeout(() => {
      inst.gcTimer = undefined;
      if (inst.listeners.size > 0) return;
      const t = inst.template;
      t.instances.delete(paramsKey(inst.params));
      this._handles.delete(inst);
      this._onInstanceDropped(inst);
      if (t.instances.size === 0 && !t.pinned) {
        this._templates.delete(t.key);
        this._onTemplateDropped(t);
      }
    }, this.options.gcMs);
    (timer as {unref?: () => void}).unref?.();
    inst.gcTimer = timer;
  }

  private _cancelGc(inst: Instance): void {
    if (inst.gcTimer) {
      clearTimeout(inst.gcTimer);
      inst.gcTimer = undefined;
    }
  }

  private _onInstanceDropped(inst: Instance): void {
    for (const id of inst.ids) removeFromIndex(this.instancesById, id, inst);
  }

  private _onTemplateDropped(t: Template): void {
    for (const set of this.templatesByProp.values()) set.delete(t);
    for (const set of this.templatesByShape.values()) set.delete(t);
  }
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

class LiveQueryHandle<R> implements LiveQuery<R> {
  private _inst: Instance;
  private readonly _mine = new Set<LiveListener>();
  private _closed = false;

  constructor(
    private readonly store: LiveQueryStore,
    inst: Instance,
  ) {
    this._inst = inst;
    store._registerHandle(this, inst);
  }

  get state(): LiveState<R> {
    return this._inst.state as LiveState<R>;
  }

  get key(): string {
    return this._inst.key;
  }

  subscribe(listener: LiveListener<R>): () => void {
    if (this._closed) throw new Error('This live query has been closed.');
    const l = listener as LiveListener;
    this._mine.add(l);
    this.store._attach(this._inst, l);
    return () => {
      if (this._mine.delete(l)) this.store._detach(this._inst, l);
    };
  }

  refresh(): Promise<void> {
    return this.store.refresh(this._inst);
  }

  patch(partial: Partial<R> | ((current: R) => R)): void {
    this.store.patch(this._inst, partial);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const l of this._mine) this.store._detach(this._inst, l);
    this._mine.clear();
    this.store._unregisterHandle(this, this._inst);
  }

  then<T1 = R, T2 = never>(
    onfulfilled?: ((value: R) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this._firstResult().then(onfulfilled, onrejected);
  }

  /** Resolves with the first successful data; the subscription it needs is released afterwards. */
  private _firstResult(): Promise<R> {
    const s = this.state;
    if (s.status === 'success') return Promise.resolve(s.data as R);
    if (s.status === 'error') return Promise.reject(s.error);
    return new Promise<R>((resolve, reject) => {
      const off = this.subscribe((st) => {
        if (st.status === 'success') {
          off();
          resolve(st.data as R);
        } else if (st.status === 'error') {
          off();
          reject(st.error);
        }
      });
    });
  }

  /** @internal The instance was re-keyed (query context changed). */
  _moveTo(next: Instance): void {
    this.store._unregisterHandle(this, this._inst);
    this._inst = next;
    this.store._registerHandle(this, next);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addToIndex<K, V>(index: Map<K, Set<V>>, key: K, value: V): void {
  let set = index.get(key);
  if (!set) index.set(key, (set = new Set()));
  set.add(value);
}

function removeFromIndex<K, V>(index: Map<K, Set<V>>, key: K, value: V): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) index.delete(key);
}

function isTemplate(v: unknown): v is Template {
  return !!v && typeof v === 'object' && 'instances' in (v as object) && 'builder' in (v as object);
}

/** Every string value under an `id` key, at any depth. */
export function collectIds(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, into);
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'id' && typeof v === 'string') into.add(v);
      else if (v && typeof v === 'object') collectIds(v, into);
    }
  }
  return into;
}

/** Deep equality over the plain-data results the store holds (objects, arrays, dates, primitives). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** The runtime's live-query store (registered on `globalThis` when this module loads). */
export function getLiveQueryStore(): LiveQueryStore {
  let store = peekLiveQueryStore();
  if (!store) {
    store = new LiveQueryStore();
    setLiveQueryStore(store);
  }
  return store;
}

/** Publish a change from application code (your own transport, a server push). */
export function publishChange(event: ChangeEvent): void {
  getLiveQueryStore().publish(event);
}

/** Refetch every live query that `target` can have affected. See {@link LiveQueryStore.invalidate}. */
export function invalidate(target: ShapeConstructor<any> | string | {id: string} | LiveBuilder | Template): void {
  getLiveQueryStore().invalidate(target);
}

export type {ChangeEvent, MutationEffects};

/** Replace the store with a fresh one (tests). */
export function resetLiveQueryStore(): LiveQueryStore {
  peekLiveQueryStore()?.dispose();
  const store = new LiveQueryStore();
  setLiveQueryStore(store);
  return store;
}

// Register on load: importing this module is what makes `.live()` work.
if (!peekLiveQueryStore()) setLiveQueryStore(new LiveQueryStore());
