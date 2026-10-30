---
'@_linked/core': patch
---

`.select()`, `.where()` and `.selectAll()` on a plural relation whose value shape has no authored class (a data-only `sh:node`, or `sh:class` only) no longer throw "Cannot read properties of undefined (reading 'shape')": they resolve the members' shape through the relation, as `.some()` / `.every()` / `.none()` already do.
