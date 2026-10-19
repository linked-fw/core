---
'@_linked/core': patch
---

Query building is back to 2.36.1 speed. A failed `isLinkedInstance` check no longer reads `Object.getPrototypeOf` and `Object.prototype` by their global names on every call, returns at once for plain objects, arrays and functions, and memoises per class; `FieldSet` checks query proxies before the `FieldSet` and `ExpressionNode` class checks. Values from another copy of core are still recognised everywhere they were.
