---
'@_linked/core': minor
---

Shape graphs: each package's shapes in its own named graph, written from a deterministic `shapes.ttl`.

- `@_linked/core/shapes/shapesToTurtle`: `shapesToTurtle(shapes, {prefixes})` writes shapes as deterministic Turtle (fixed prefix block, subjects sorted, `a` first, predicates sorted, one statement per line; blank nodes only for complex `sh:path` values, inline under their one IRI subject). `packageShapes(pkg)` and `packageShapesTurtle(pkg)` give a package's registered shapes and their `shapes.ttl` (what `linked build` writes to `lib/esm/data/shapes.ttl`); `singleOwnerShapesTurtle(shapes)` gives the generated single-owner shapes for an app's own shape graph.
- `@_linked/core/shapes/syncShapeGraphs`: `syncShapeGraphs(ds, {force, packages, turtleFor, appShapes, orphanScope})` replaces a package's graph `{package IRI}/graph/shapes` (a `ShapesGraph` record) whole when its hash (`linked-shape-graph/1`) differs, writes the app's generated shapes to the app's graph, removes once the shapes an earlier sync wrote into the default graph, and falls back to `syncShapes` on a store without graph queries.
- `NamedGraph.patchContent`: a delete body may hold blank nodes; each blank-node structure is deleted as a pattern through the IRI subject it hangs off (the shape's concise bounded description).

**Breaking changes**

- Shapes are stored as declared: `syncShapes`/`syncShape` (and the shape graphs) write a shape's own property shapes plus `core:isExtending`, no longer copies of the inherited ones. A reader of stored shapes that relied on the copies must follow `core:isExtending`. `SHAPE_HASH_VERSION` is 3, so the next default-graph sync rewrites every stored shape once.
- `sh:and` and `sh:xone` lists are written with IRI cells (`{shape IRI}/and/0`, …) instead of blank cells.
- The property readers (`getPropertyShapes(shape, true)`, `getPropertyShape`) end the inheritance chain of a shape known only as data at the root `Shape`: such a shape now lists the root's `label` and `type`, which it previously had only through the stored copies.
- A `graph_patch` whose delete body holds blank nodes is no longer refused: a store that implements `graphQuery` itself must delete each blank-node structure through its IRI subject, or refuse it.
