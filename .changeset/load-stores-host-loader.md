---
'@_linked/core': minor
---

`loadStores` imports stores through a host-supplied loader when one is set. A host that runs the app through another module loader puts a function `(specifier: string) => Promise<unknown>` on `globalThis[Symbol.for('@_linked/core:importModule')]`; `loadStores` calls it with each entry's `store` specifier unchanged and builds the store from the namespace it resolves to. Without it, `loadStores` uses the native `import()` as before. `linked start` (dev) sets it so a store named in a datasets file comes from the same copy of its package as the app's own import of it.
