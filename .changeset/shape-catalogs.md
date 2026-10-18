---
"@_linked/core": minor
---

ShapeCatalog and withShapeCatalog: build and run queries against a catalog without registering it.

`ShapeCatalog.from(shapes, {name})` builds an immutable set of shapes (core's built-ins included, from the data when present); `withShapeCatalog(catalog, fn)` makes it the shapes every registry accessor reads while `fn` runs. Builders, field sets and IRs capture the catalog and re-enter it when they are lowered, compiled or live-tracked later, so one shape IRI can mean different shapes in different catalogs at once. `fromJSON(json, {catalog})` decodes against a catalog; the wire format is unchanged. Registry caches are kept per catalog, and an app that never uses a catalog runs as before.

`syncShapes` now also writes core's six built-in shapes (`Shape`, `NodeShape`, `PropertyShape`, `List`, `PathNode`, `PathList`) into the dataset, with the same hash skip as every other shape: the first sync after upgrading writes them once.
