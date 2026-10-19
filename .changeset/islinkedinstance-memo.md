---
'@_linked/core': patch
---

`isLinkedInstance` memoises its prototype-chain lookup per prototype, so a repeated failed check is
one WeakMap and one Map lookup instead of a walk. This recovers most of the query-building time
2.36.2 added: select +50% → +17%, create +30% → +20% against 2.36.1 (medians). The rest is tracked
in backlog 058.
