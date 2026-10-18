---
"@_linked/core": minor
---

ShapeCatalog and withShapeCatalog: build and run queries against a catalog without registering it.

`ShapeCatalog.from(shapes, {name})` builds an immutable set of shapes (core's built-ins included); `withShapeCatalog(catalog, fn)` makes it the shapes every registry accessor reads while `fn` runs. Builders, field sets and IRs capture the catalog and re-enter it when they are lowered, compiled or live-tracked later, so one shape IRI can mean different shapes in different catalogs at once. `fromJSON(json, {catalog})` decodes against a catalog; the wire format is unchanged. Registry caches are kept per catalog, and an app that never uses a catalog runs as before.
