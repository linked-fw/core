---
'@_linked/core': patch
---

`registerInstalledOntologies` no longer loads a second copy of a package under `linked start`. It
used to import each package's built `lib/esm/ontologies/*.register.js` by file path: Node's copy
next to the one Vite's SSR runner bundles (the cli's dual-copy guard reported "TWO COPIES"), or
the built `lib` next to the `src` a workspace package resolves to (core warned that 2 copies of the
shape registry had loaded). When the host loader that `loadStores` also reads is set
(`Symbol.for('@_linked/core:importModule')`, set by `linked start`), each register module of a
package that the app resolves to that directory is now imported through it by specifier
(`<name>/ontologies/<prefix>.register`), so it is the same module the app's own imports get. Such
a package registers this way also when it was never built. Without the host loader (a built app,
the cli's build check) nothing changes.
