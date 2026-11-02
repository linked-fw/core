---
'@_linked/core': minor
---

A shape may declare the graphs a read of it covers without `.from()`: `static defaultReadGraphs`,
inherited by subclasses. `NodeShape` and `PropertyShape` declare `graphs.allShapes`, so a select,
count or ask of them reads every shape graph the registry lists (with `@_linked/rdfs`'s next minor,
its `Class` and `Property`, and OWL's term shapes through them, read `graphs.allOntologies`). The
set is put on the IR when the read is lowered, so access rules see it; an explicit `.from()` wins;
writes are unchanged. A graph route for such a shape is refused (`graph-name-read-only`).
`InMemoryDataset` reads its one graph for `graphs.allOntologies` / `graphs.allShapes`. The
default-graph shape sync (`syncShapes`) reads the default graph explicitly. Code that writes
NodeShapes into the default graph and reads them back without `.from()` now adds
`.from(graphs.default)`. See docs/architecture/ontologies.md, "A shape's default read set".
