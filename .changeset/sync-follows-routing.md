---
'@_linked/core': minor
---

The ontology and shape syncs can follow the storage routing. New module
`@_linked/core/shapes/syncTargets` (server only):

- `graphSyncTargets()` tells, per package, the datasets of its shape graph (every dataset one of
  its shapes routes to, plus those of the `sh:NodeShape` / `sh:PropertyShape` shapes) and of its
  ontology graph (also wherever a shape targeting one of its classes routes, and the datasets of
  the ontology term shapes), and the datasets of the app's single-owner shape graph. Without pins
  everything goes to the default dataset.
- `syncShapeGraphsRouted()` and `syncOntologiesRouted()` run the per-dataset syncs once per target
  dataset with that dataset's packages (each package's text read once, the same bytes everywhere),
  drop a package graph routing no longer sends to the default dataset there, report one left in
  another dataset (`leftovers`), and report a dataset that fails (`failed`) while the others sync.
- `graphContent()` answers what the `'package'`-mode syncs would write (text, hash, sources) for
  each package and for the app's graph, writing nothing.
- `SHAPE_SHAPE_CLASSES` and `ONTOLOGY_TERM_CLASSES` move here from `@_linked/server`.

`syncShapeGraphs(ds)` and `syncOntologies(ds)` are unchanged. `syncParsedOntologies`,
`packageSources`, `readOntologyRecords` and `readShapesRecords` are exported for the routed syncs.
