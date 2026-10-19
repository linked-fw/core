import {Shape} from '../shapes/Shape.js';
import {isLinkedInstance} from './linkedError.js';

type CacheEntry = {timeout: number; value: any; isError: boolean};

// Per-function caches. Keying by the function identity (WeakMap) instead of a
// single global string map means two different functions with identical args no
// longer collide, and a function's cache is reclaimed once the function itself
// is unreferenced (bounding growth).
const _cache = new WeakMap<() => any, Map<string, CacheEntry>>();

/**
 * Caches the result of a function call based on its arguments for a specified time.
 * Arguments are converted to strings for comparison.
 * Use cacheTimeMs = 0 to disable caching.
 * Use cacheTimeMs = Infinity to never expire the cache.
 * When `alsoCacheErrors` is set, a thrown error is remembered for the window so
 * the function is not re-invoked — but it is re-thrown to the caller, never
 * returned as if it were a value.
 * @param fn
 * @param args
 * @param cacheTimeMs
 * @param alsoCacheErrors
 */
export function cached(fn: () => any, args: any[], cacheTimeMs?: number,alsoCacheErrors?: boolean) {
  if (cacheTimeMs !== 0) {
    const now = Date.now();
    const keyArgs = args.map((a) => {
      if (isLinkedInstance(a, Shape)) {
        return a.id ?? a.uri;
      } else if (a && typeof a === 'object' && 'id' in a) {
        return (a as {id: string}).id;
      } else {
        return a?.toString();
      }
    });
    const key = JSON.stringify(keyArgs);
    let fnCache = _cache.get(fn);
    if (!fnCache) {
      fnCache = new Map<string, CacheEntry>();
      _cache.set(fn, fnCache);
    }
    let entry = fnCache.get(key);
    if (entry && entry.timeout < now) {
      fnCache.delete(key);
      entry = undefined;
    }
    if (!entry) {
      try {
        entry = {timeout: now + cacheTimeMs, value: fn(), isError: false};
      } catch (e) {
        if (alsoCacheErrors) {
          entry = {timeout: now + cacheTimeMs, value: e, isError: true};
        } else {
          throw e;
        }
      }
      fnCache.set(key, entry);
    }
    if (entry.isError) throw entry.value;
    return entry.value;
  } else {
    return fn();
  }
}
