---
'@_linked/core': minor
---

Graph routes state intent, and graph routing lives only in code.

- `setDatasetForShapes(store, shapes, {graph: 'own'})` puts each shape in its own graph, `{DATA_ROOT}/graph/{package slug}/{shape name}` (the package the shape was registered by, slugged as package IRIs are; the shape IRI's last segment, case kept). `{graph: dataGraph('slug')}` routes to `{DATA_ROOT}/graph/{slug}`. An absolute graph IRI stays accepted. `setShapeGraphs` takes the same forms.
- `DATA_ROOT` is the store's: the new optional `IDataset.dataRoot()` (`SparqlDataset.dataRoot()` returns `SparqlOptions.dataRoot`, the root it mints ids under), else the process's `DATA_ROOT`. It is joined whenever the routing is read; a route that needs a root the store lacks is refused then. `getShapeGraphs` returns the resolved IRIs.
- `dataGraph`, `OWN_GRAPH` and the types `GraphRoute`, `DataGraphRoute` are exported from `@_linked/core/ontologies/graphs` and the index, next to `graphs`; `dataRootOf(dataset)` from `@_linked/core/utils/graphRouting` and the index.

**Breaking changes**

- The datasets config's per-alias `graphs` key is removed (it was never released): `parseDatasetsConfig` no longer checks it, `DatasetEntry.graphs` is gone, and `loadStores` routes nothing from it and warns. Route shapes in code instead.
- A route string that is not `'own'` or an absolute graph IRI is refused with the new message (`'own', dataGraph('slug') or an absolute graph IRI`).
