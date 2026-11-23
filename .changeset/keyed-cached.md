---
"@_linked/core": minor
---

`cached()` gains a keyed form, `cached(key, fn, args, cacheTimeMs?, alsoCacheErrors?)`, which stores entries under an explicit string key plus the args, so an inline function gets cache hits (the function-identity form only hits for a reused function). New export `invalidateCached(key, args?)` drops every entry of a key or one args entry. In both forms a promise that rejects is now evicted, so the next call retries, unless `alsoCacheErrors` is set; callers still receive the rejection. Outside production, the identity form warns once per function source when a new function with an already-cached source text is passed (an inline function that can never hit), pointing at the keyed form.
