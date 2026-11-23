---
summary: >
  `cached()` drops an expired entry only when the same key and args are looked up again, so a cache
  fed open-ended args (request input, ids) grows without bound even with a `cacheTimeMs`. Decide a
  pruning policy (sweep on insert, size cap / LRU) for both forms.
packages: [core]
---

# 116 — `cached()` never prunes expired entries it is not asked for again

Source: the final security review of the backlog sweep (report 125), on report 117's keyed form.

## Today

`src/utils/cached.ts` keeps entries in a `Map` per function (identity form, the function held by a
`WeakMap`) or per string key (keyed form, held strongly in a module-level `Map`). `lookup()` checks
an entry's expiry only when that exact key + args is requested: an expired entry for args that are
never asked for again stays in memory. The identity form has done this since before the sweep; the
keyed form keeps its keys for the life of the process, so a keyed cache whose args come from an
open-ended set (one entry per request id) grows with every distinct value. The JSDoc now says so;
`invalidateCached(key)` empties a key.

## Open questions

1. Sweep expired entries of a store when inserting (amortized, e.g. when the store size doubles),
   or cap each store's size (LRU) with an optional `maxEntries` argument?
2. Should the keyed form drop a key's store once it is empty?
3. How to test it without exporting internals (an inspection hook for tests only, or a size
   accessor)?
