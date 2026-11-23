import {Shape} from '../shapes/Shape.js';
import {isLinkedInstance} from './linkedError.js';
import {inProduction} from './inProduction.js';

type CacheEntry = {timeout: number; value: any; isError: boolean};

// Identity form: per-function caches. Keying by the function identity (WeakMap) instead of a
// single global string map means two different functions with identical args no longer
// collide, and a function's cache is reclaimed once the function itself is unreferenced
// (bounding growth). The price: an inline arrow is a new object on every call and never hits.
const _cache = new WeakMap<() => any, Map<string, CacheEntry>>();

// Keyed form: caches by an explicit caller-chosen key, so inline arrows hit. Held strongly;
// `invalidateCached` empties a key.
const _keyedCache = new Map<string, Map<string, CacheEntry>>();

// Development only: source texts of functions the identity form has cached, mapped to whether
// the inline-arrow warning was already printed for that source.
const _seenSources = new Map<string, boolean>();

function argsKey(args: any[]): string {
  return JSON.stringify(
    args.map((a) => {
      if (isLinkedInstance(a, Shape)) {
        return a.id ?? a.uri;
      } else if (a && typeof a === 'object' && 'id' in a) {
        return (a as {id: string}).id;
      } else {
        return a?.toString();
      }
    }),
  );
}

function isThenable(value: any): value is PromiseLike<any> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof value.then === 'function'
  );
}

function lookup(
  store: Map<string, CacheEntry>,
  key: string,
  fn: () => any,
  cacheTimeMs: number | undefined,
  alsoCacheErrors: boolean | undefined,
) {
  const now = Date.now();
  let entry = store.get(key);
  if (entry && entry.timeout < now) {
    store.delete(key);
    entry = undefined;
  }
  if (!entry) {
    // An undefined cacheTimeMs gives a NaN timeout, which never compares as expired.
    try {
      entry = {timeout: now + cacheTimeMs, value: fn(), isError: false};
    } catch (e) {
      if (alsoCacheErrors) {
        entry = {timeout: now + cacheTimeMs, value: e, isError: true};
      } else {
        throw e;
      }
    }
    store.set(key, entry);
    if (!entry.isError && !alsoCacheErrors && isThenable(entry.value)) {
      // A rejected promise must not stay cached: evict it so the next call retries. The caller
      // still holds (and sees the rejection of) the original promise we return. Only evict our
      // own entry — a later call may already have replaced it.
      const stored = entry;
      stored.value.then(undefined, () => {
        if (store.get(key) === stored) store.delete(key);
      });
    }
  }
  if (entry.isError) throw entry.value;
  return entry.value;
}

function warnInlineFunction(fn: () => any, fnIsNew: boolean) {
  if (inProduction()) return;
  const source = Function.prototype.toString.call(fn);
  const warned = _seenSources.get(source);
  if (warned === undefined) {
    _seenSources.set(source, false);
  } else if (fnIsNew && !warned) {
    _seenSources.set(source, true);
    const preview = source.length > 80 ? source.slice(0, 77) + '...' : source;
    console.warn(
      `cached(): a new function with the same source as one already cached was passed (${preview}). ` +
        'The function form caches per function object, so an inline function never gets a hit. ' +
        "Use the keyed form instead: cached('some-key', fn, args, cacheTimeMs).",
    );
  }
}

/**
 * Caches the result of a function call based on its arguments for a specified time.
 * Arguments are converted to strings for comparison (shapes and `{id}` objects by their id).
 *
 * Two forms:
 * - `cached(key, fn, args, cacheTimeMs?, alsoCacheErrors?)` — keyed: entries are stored under
 *   the string `key` plus the args, so an inline `fn` (`cached('catalog', async () => …, [id])`)
 *   hits. Two different keys never share entries. Clear with {@link invalidateCached}.
 * - `cached(fn, args, cacheTimeMs?, alsoCacheErrors?)` — by function identity: entries belong to
 *   the `fn` object, so only a hoisted (reused) function ever hits. Outside production a warning
 *   is printed (once per function source) when a new function with the same source text as one
 *   already cached is passed, which is how an inline function looks.
 *
 * Use cacheTimeMs = 0 to disable caching; cacheTimeMs = Infinity (or undefined) never expires.
 * When `alsoCacheErrors` is set, a thrown error is remembered for the window so the function is
 * not re-invoked — but it is re-thrown to the caller, never returned as if it were a value; a
 * rejected promise likewise stays cached. Without it, a promise that rejects is evicted, so the
 * next call runs `fn` again (the caller still receives the rejection).
 *
 * Entries are held until they are looked up again after expiring, or invalidated: an expired
 * entry that is never asked for again stays in memory (the keyed form holds its keys strongly).
 * With args from an open-ended set (request input, ids), pass a `cacheTimeMs` and call
 * {@link invalidateCached}, or keep such values out of the args.
 */
export function cached<T>(
  key: string,
  fn: () => T,
  args: any[],
  cacheTimeMs?: number,
  alsoCacheErrors?: boolean,
): T;
export function cached(fn: () => any, args: any[], cacheTimeMs?: number, alsoCacheErrors?: boolean): any;
export function cached(...params: any[]): any {
  if (typeof params[0] === 'string') {
    const [key, fn, args, cacheTimeMs, alsoCacheErrors] = params as [string, () => any, any[], number?, boolean?];
    if (cacheTimeMs === 0) return fn();
    let store = _keyedCache.get(key);
    if (!store) {
      store = new Map<string, CacheEntry>();
      _keyedCache.set(key, store);
    }
    return lookup(store, argsKey(args), fn, cacheTimeMs, alsoCacheErrors);
  }
  const [fn, args, cacheTimeMs, alsoCacheErrors] = params as [() => any, any[], number?, boolean?];
  if (cacheTimeMs === 0) return fn();
  let fnCache = _cache.get(fn);
  warnInlineFunction(fn, !fnCache);
  if (!fnCache) {
    fnCache = new Map<string, CacheEntry>();
    _cache.set(fn, fnCache);
  }
  return lookup(fnCache, argsKey(args), fn, cacheTimeMs, alsoCacheErrors);
}

/**
 * Drops entries of the keyed {@link cached} form: every entry under `key`, or, with `args`, only
 * the entry for those args (compared the same way `cached` compares them).
 */
export function invalidateCached(key: string, args?: any[]): void {
  if (!args) {
    _keyedCache.delete(key);
    return;
  }
  _keyedCache.get(key)?.delete(argsKey(args));
}
