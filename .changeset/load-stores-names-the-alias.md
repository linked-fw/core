---
"@_linked/core": patch
---

`loadStores` rethrows a store constructor's error as `loadStores: alias "<alias>" (<store>): <message>`, with the original error as `cause`.
