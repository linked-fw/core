---
'@_linked/core': minor
---

`@_linked/core/ontology/registerInstalled` (server only): `registerInstalledOntologies(packageDirs)`
imports `<dir>/lib/esm/ontologies/*.register.js` of each package directory and returns the names
of the packages it registered, so an app that deep-imports a package's shape files still syncs and
checks that package's ontology data. A directory without register modules is skipped silently; a
register module that throws is warned about and its package left out.
