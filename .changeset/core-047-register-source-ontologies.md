---
'@_linked/core': minor
---

`registerInstalledOntologies(packageDirs, options?)` takes `options.importModule`: a package
directory without built register modules (`lib/esm/ontologies/*.register.js`) but with
`src/ontologies/*.register.ts` (a workspace package in dev) registers through it, e.g. Vite's
`ssrLoadModule`. Without the option such a directory is skipped, as before.
