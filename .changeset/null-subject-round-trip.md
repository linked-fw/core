---
"@_linked/core": patch
---

`QueryBuilder.fromJSON` reads a `nullSubject` query back as `.for(null)` built it: its `toJSON()` no longer gains a `limit: 1`.
