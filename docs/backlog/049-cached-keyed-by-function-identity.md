---
summary: >
  `cached()` keys its store by function identity (a `WeakMap`), so a call that passes a fresh
  inline arrow never gets a cache hit, and the arrow runs on every call. The common
  `cached(async () => …, [args])` form has been a no-op since 2.12.0. Proposal: add a key-based
  overload.
packages: [core]
status: open
---

# 049 — `cached()` misses for every inline function

Found by Create Now plan 059. Checked against `src/utils/cached.ts` on
`feat/relation-shape-resolver` (2026-10-07).

## Context

- `src/utils/cached.ts` stores entries in `WeakMap<() => any, Map<argsKey, entry>>`, looked up
  with `_cache.get(fn)`. An inline `cached(async () => …, [projectId], ms)` creates a new `fn`
  object on each call, so it always gets a new, empty map. The args key is never consulted
  across calls.
- The change came in `395c183` (released in v2.12.0). Before it, a single global
  `Map<string, …>` was keyed by the args alone. That worked for inline functions, but two
  different functions with the same args collided. The test in `src/tests/gap1-fixes.test.ts`
  ("two different functions with identical args do not collide") uses named functions only.
- Core itself does not call `cached()`. Create Now does, both times with inline arrows:
  `shapeCatalogCached(projectId)` (`src/backend/shapes/ProjectProvider.ts:394`, `[projectId]`)
  and `getInstanceData` (`:1907`, `[projectId, shapeId, instanceId]`). Neither ever hits.

## Why it matters

Callers think they have a cache and do not. Each catalog load re-reads every shape from the
store. If a caller is changed to hoist the function, which makes the cache work, results start
to go stale, and nothing today invalidates them.

## First proposed fix

Add an explicit key: `cached(key: string, fn, args, cacheTimeMs?, alsoCacheErrors?)`, storing
entries in a `Map` by `key + argsKey`. Keep the function-identity form for hoisted functions.
Warn in development when the identity form sees a function it has never seen before with args
it has already cached (the inline-arrow case). Add an `invalidate(key, args?)` export.

## Open questions

1. Should the identity form be deprecated? An inline arrow is the natural way to call it, and
   that is the case that fails.
2. Where `fn` is async, should a rejected promise be evicted? Today the rejected promise is
   stored as a value. `alsoCacheErrors` only covers synchronous throws.
3. Does Create Now want these caches back (with invalidation on shape edits), or should it remove
   them now that the catalog is read fresh?
