---
'@_linked/core': minor
---

Graph routing: storage rules pick the named graph of a shape, per dataset.

- `LinkedStorage.setDatasetForShapes(dataset, [shapes], {graph})` pins shapes to a dataset and routes their instances to a graph there (the variadic form stays). `setShapeGraphs`, `getShapeGraphs`, `unsetShapeGraph` and `graphRoutingFor` are exported for composite datasets.
- A shape's graph is its own route, else its nearest routed super-shape's, else the default graph; its read set adds its sub-shapes' graphs and the read sets of the shapes that own it (`contains`).
- Routed reads: each subject group reads its shape's set (`GRAPH <g>`, `FROM NAMED` with `GRAPH ?g`, `VALUES ?g` for a narrower type-checked subject); a set holding the default graph is read without `FROM NAMED`, through `VALUES` with the store's name for it. Without routes every query compiles exactly as before.
- `.from()` with `graphs.default` among other graphs now reads (through `VALUES`) on a store that maps the default graph.
- Routed writes: a create writes the shape's graph (`INSERT DATA { GRAPH <g> … }`); an update, upsert or delete writes the graph the subject lives in (`WITH <g>`, or, when the shape's read set holds several graphs, `GRAPH ?g` found in the same update over `VALUES` of the read set; an upsert of a subject found nowhere creates it in the shape's graph). Owned nodes live in the owner's graph; the owned-link check refuses a node that lives in another graph. `.into(graph)` on create, update and delete builders, checked against the routing (`GraphQueryError('graph-not-routed')`) and never carried in DSL-JSON.
- `SparqlOptions.namedGraphUriParameter`: the `FROM NAMED` set goes to the transport (`SparqlDataset.executeSparqlSelectWithNamedGraphs`, which refuses by default).
- Live queries: `QueryDependencies.graphs` and `MutationEffects.graph`; the matcher skips a template that does not read the written graph.

**Breaking changes**

- Under routing, reads and writes of routed shapes (and of shapes whose sub-shapes or owners are routed) leave the default graph: data written before a route was added stays where it was and is no longer read for that shape.
- `GraphQueryErrorCode` gains `graph-not-routed`: an exhaustive `switch` or `Record<GraphQueryErrorCode, …>` over the codes needs the new case (the published `@_linked/server`'s `queryPlane.ts` has one; its next core bump adds it).
- Mutation IR kinds gain an optional `graph` (and `writeGraphs` on changes to existing subjects); `SparqlDeleteInsertPlan` gains `graphIn`; a store that builds its own SPARQL from the IR must honour it (or refuse a mutation that has one).
- Under routing, an update of a subject found in no graph of its shape's read set writes nothing (an upsert creates it).
- `.from([graphs.default, …])` is no longer refused on a store with `mapGraphName`; it reads the default graph with the others.
