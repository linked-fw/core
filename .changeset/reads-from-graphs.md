---
'@_linked/core': minor
---

Reads from named graphs.

- `.from(graph | graph[])` on select, count and ask builders (`.count()` and `.exists()` keep it), carried as `graphs` in DSL-JSON and in the IR. Portable names are expanded by the store: `graphs.allOntologies` / `graphs.allShapes` to the graphs the registry lists of that kind, `graphs.default` alone to the default graph, `graphs.union` alone through `SparqlOptions.mapGraphName`.
- `SparqlDataset` compiles one graph as `GRAPH <iri> { … }` and several as `FROM NAMED` with one `GRAPH ?g` block per subject; a set that expands to no graph answers `[]`, `0` or `false` without a request.
- `SparqlOptions.isolateLinkedTypeChecks` (store-level): a linked subject's inferred type check goes in a second `GRAPH ?g` block (same rows; faster on Jena). No query the DSL builds today has such a check.
- `SparqlOptions.mapGraphName(iri)`: a store's name for `graphs.default` / `graphs.union`.
- A per-process, per-dataset cache of the graph registry: updated by the store's own graph queries, dropped by `invalidateGraphRegistry(dataset?)` (on `SparqlDataset` and as a package export), re-read after 30 seconds (`GRAPH_REGISTRY_MAX_AGE_MS`). `SparqlDataset` subclasses key it with the protected `graphRegistryKey()`.
- `SparqlGraph` takes a graph variable (`{type: 'graph', variable, inner}`); `SparqlSelectPlan` and `SparqlAskPlan` gain `dataset: {fromNamed}`.
- `NamedGraph.select()` reads `graphs.registry` through the same path.

**Breaking changes**

- `SparqlGraph` is a union of `{iri}` and `{variable}`: code that reads `node.iri` of a graph node must handle the variable form.
- `graphs.default` or `graphs.union` together with other graphs in `.from()` is refused (`unsupported-query-kind`).
