---
'@_linked/core': minor
---

The graph targets (`ontologyGraph`, `shapeGraph`) are one global setting of the process, set by the host, instead of a store setting. New `setGraphTargets({ontologyGraph?, shapeGraph?})` and `getGraphTargets()` (root export and `@_linked/core/utils/graphTargets`); with nothing set both are `'package'`. Each call is checked and replaces both settings. `syncOntologies`, `syncShapeGraphs`, the `graphs.allOntologies` / `graphs.allShapes` expansion, the probe and the other-mode warnings read it. The state lives on `globalThis` (`sharedState('@_linked/core', 'graphTargets')`), so every copy of core sees one setting. `@_linked/server` sets it from `LINKED_ONTOLOGY_GRAPH` / `LINKED_SHAPE_GRAPH`; a frontend sets nothing.

**Breaking** (the per-store paths are removed):

- `SparqlOptions.ontologyGraph` and `SparqlOptions.shapeGraph`;
- `SparqlDataset.setGraphTargets()` and `SparqlDataset.graphTargets()`;
- `IDataset.setGraphTargets?()` and `IDataset.graphTargets?()`;
- `graphTargetsOf(ds)` (use `getGraphTargets()`);
- `loadStores`' second argument (`LoadStoresOptions`, `{graphTargets}`) and its handling of `config.ontologyGraph` / `config.shapeGraph` (a config is passed to the store verbatim).

A host that set targets on a store calls `setGraphTargets` once at boot, before it loads its stores and runs the syncs.
