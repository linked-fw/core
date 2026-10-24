---
summary: >
  A store constructor that throws inside `loadStores` (a missing endpoint, a bad config value)
  gives its own message only, without the entry it came from. Prefix constructor errors with the
  alias and the store path.
packages: [core]
---

# 074 — `loadStores` names the alias of a constructor error

`loadStores` builds each store with `new StoreClass(entry.config)`. When that constructor throws
(a missing endpoint, a config value the store refuses), the error carries the store's own message
only: no alias, no `datasets.<alias>` path, so with several entries it is not clear which one
failed.

Fix: in `loadStores`, wrap the constructor call and rethrow with `loadStores: alias "<alias>"
(<store>): ` before the message (keep the cause). A store cannot do it itself: nothing runs before
`super()` that could catch.

Found by the review of fuseki report 004. Its first case, the graph targets a store checked in its
constructor, is gone: the graph targets are one global setting since core report 075.
