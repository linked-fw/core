---
'@_linked/core': patch
---

Dataset pins survive duplicate copies of a shape class.

`LinkedStorage.setDatasetForShapes()` keyed its pins on the class object, which
is only a usable key while exactly one copy of the declaring module has
evaluated. In a built app there is not: the backend runs from `lib/`, while
`linked.backend.storage` is loaded from the app root and imports the app's
shapes from `src/`. The pin landed on one copy and the query resolved the
other, so a shape that *was* pinned fell through to the default dataset.

For an app whose default is a router, the symptom is remote from the cause:

```
[AppDataRouter] query reached the app-data router with NO active project.
CN-internal shapes must be pinned to cn-main/cn-ai ...
```

— reporting a missing pin for a shape that is pinned two files away. Dev loads
both halves from `src`, so this only ever appeared in production.

`getDatasetForShapeClass()` now falls back to matching on the shape's IRI when
the class-identity lookup misses. No API change, and unpinning through
`getShapeToDatasetMap()` keeps working, because the IRI match scans that same
map rather than a parallel index.
