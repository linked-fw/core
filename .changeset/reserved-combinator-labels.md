---
'@_linked/core': patch
---

Registering a property labelled `and`, `or` or `not` throws again, next to the `$`-prefixed names. `$`-prefixed names and `and`/`or`/`not` throw; the other reserved names warn. A shape loaded as data is still only reported.
