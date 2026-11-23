---
summary: >
  `cached()` gains a keyed form `cached(key, fn, args, …)` that hits for inline functions, plus
  `invalidateCached(key, args?)`. Rejected promises are evicted in both forms unless
  `alsoCacheErrors`; the identity form warns once per source outside production on the
  inline-function miss. Consumes backlog 049. Core minor.
packages: [core]
---

# 117 — Keyed `cached()` and `invalidateCached`

## PR

### Summary

`cached(fn, args, …)` keys its store by the function object, so the common inline call
`cached(async () => …, [id], ms)` never hit (backlog 049). Per master plan 006 decision 7:

- New keyed form `cached(key: string, fn, args, cacheTimeMs?, alsoCacheErrors?)`, chosen when the
  first argument is a string; entries live in a `Map` by key, then args key. Inline functions hit.
- New export `invalidateCached(key, args?)`: drops all entries of a key, or one args entry.
- In both forms a promise returned by `fn` that rejects is evicted (next call retries) unless
  `alsoCacheErrors`; the caller still receives the rejection.
- Outside production the identity form warns once per function source text when it sees a new
  function object whose source equals one it already cached, pointing at the keyed form.
- The identity form is otherwise unchanged and not deprecated.

### Changes

- `src/utils/cached.ts` — overloads, shared `lookup()` / `argsKey()`, keyed store, eviction of
  rejected promises, the development warning, `invalidateCached`. JSDoc documents both forms
  (`cached` is not mentioned in `README.md` or `documentation/`; it is reached through the
  `@_linked/core/utils/cached` deep import, which now also serves `invalidateCached` — contract C3).
- `src/tests/cached-keyed.test.ts` — new, 13 tests.
- `.changeset/keyed-cached.md` — minor.
- `docs/backlog/049-cached-keyed-by-function-identity.md` removed; plan 006 Progress ticks S6.

### Verification

Typecheck — `time npx tsc -p tsconfig-tests.json --noEmit`: no output, exit 0, `real 0m8.529s`.

Tests — `time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/cached-keyed.test.ts src/tests/gap1-fixes.test.ts`:

```
PASS src/tests/gap1-fixes.test.ts (6.822 s)
PASS src/tests/cached-keyed.test.ts (6.95 s)
Test Suites: 2 passed, 2 total
Tests:       18 passed, 18 total
real	0m10.863s
```


### Deviations

- Return type: the keyed overload is generic (`cached<T>(key, fn: () => T, …): T`); the identity
  overload keeps its `any` return so existing callers see no type change.
- The warning keys on source text only (decision 7), not also on already-cached args as backlog
  049 first proposed.

### Follow-ups

- Backlog 049 open question 3 (whether Create Now wants its catalog / instance-data caches back,
  with invalidation on shape edits, now that the keyed form exists) is the consumer's decision and
  out of core's scope; it belongs in Create Now's own backlog, not core's.

## Details

### Design

- **Two stores.** Identity form: `WeakMap<fn, Map<argsKey, entry>>` (unchanged; reclaimed with
  the function). Keyed form: `Map<key, Map<argsKey, entry>>`, held strongly; the nested map makes
  `invalidateCached(key)` a single delete. Both go through one `lookup()` so expiry, sync-error
  caching and promise eviction behave identically.
- **Args key** unchanged: shapes by `id ?? uri`, `{id}` objects by `id`, everything else by
  `toString()`, then `JSON.stringify`. `invalidateCached(key, args)` uses the same function.
- **Expiry** unchanged: `timeout = now + cacheTimeMs`, expired when `timeout < now` (the boundary
  millisecond still hits). `cacheTimeMs = 0` calls `fn` and stores nothing; `undefined` or
  `Infinity` never expires (undefined gives a NaN timeout).
- **Rejected promises.** When `fn` returns a thenable and `alsoCacheErrors` is off, `lookup`
  attaches a rejection handler that deletes the entry only if it is still the stored one (a later
  call may have replaced it). The original promise is returned, so callers see the rejection.
  With `alsoCacheErrors` the rejected promise stays for the window, mirroring the sync behaviour
  (sync throws are cached and re-thrown).
- **Warning.** `_seenSources: Map<source, warned>`, filled only outside production
  (`inProduction()`). First sighting of a source records it; a later *new* function object
  (no WeakMap entry yet) with the same source warns once, with an 80-char source preview.

### Known limitations

- A factory that returns distinct closures with identical source text, each reused correctly,
  triggers the warning once (false positive by design: source text is all the identity form can see).
- The eviction handler counts as handling the promise, so a cached promise that rejects and is
  never awaited by the caller no longer surfaces as an unhandled rejection.
- Expired keyed entries are removed only when their args are looked up again or the key is
  invalidated; growth is bounded by the distinct args used per key.
- `invalidateCached` only touches the keyed form; identity-form entries cannot be invalidated
  (hoisted functions can switch to the keyed form for that).

### Tests (`src/tests/cached-keyed.test.ts`)

Keyed: inline function hits / different args miss; two keys with the same args stay separate;
expiry with a mocked `Date.now` (boundary inclusive); `cacheTimeMs = 0` never caches nor seeds the
store; `invalidateCached(key)` clears only that key; `invalidateCached(key, args)` clears one entry
(args compared by `{id}`), unknown key is a no-op. Async: rejection evicted (keyed and identity),
kept with `alsoCacheErrors` (keyed and identity), resolved promise stays. Warning: fires once per
source for repeated inline functions, never for a reused function, never under
`NODE_ENV=production`. Existing `src/tests/gap1-fixes.test.ts` (identity collisions, cached sync
errors re-thrown) still passes.

### Phases

Single phase (small step, no plan doc): implementation + tests in one commit, then the wrapup
commit with this report, the changeset, the backlog removal and the Progress tick.
