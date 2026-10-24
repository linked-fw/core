---
'@_linked/core': minor
---

Configurable graph targets for the ontology and shape syncs. A store takes two settings, `ontologyGraph` and `shapeGraph` (`SparqlOptions`, `store.setGraphTargets()`, or a datasets config entry's `config` read by `loadStores`), each `'package'` (the default, unchanged), `'default'`, or an absolute graph IRI. A host fills unset ones from `LINKED_ONTOLOGY_GRAPH` / `LINKED_SHAPE_GRAPH` (`graphTargetOptionsFromEnv(env)`, `loadStores(config, {graphTargets})`); core never reads `process.env` for them. An invalid value fails when the store is built, naming the setting.

- **A shared graph IRI:** one `OntologyGraph` (feeding the hierarchy) or `ShapesGraph` holds every package's data, rebuilt whole in one update when any package changes. Its record lists `packageHashes` (new field, `core:packageHash`) and `sources` (`{package}/{file}`).
- **`'default'`:** the whole ontology in the default graph. When the combined hash changes, one update deletes every package-owned term (subjects in a registered package's ontology namespace and subjects of a package's current Turtle, with their outgoing triples and the blank nodes under them) and inserts every package's data. Subjects outside that set are never touched. Shapes use the default-graph `syncShapes`. New optional `IDataset.replaceDefaultGraphTerms` (implemented by `SparqlDataset`) and `probeDefaultGraphInference`, which tests the default graph in that mode.
- **Readers follow the mode:** `graphs.allOntologies` / `graphs.allShapes` read the package graphs, the shared graph or the default graph.
- **No copies:** a sync that finds another mode's data logs one warning and leaves it. Switching modes means clearing first (README, "Ontology and shape graphs").
- `syncShapes` rewrites a shape keeping the links other nodes hold to it (`core:isExtending`, `sh:node`); before, the rewrite deleted them.
- Sync results gain `target` (the mode written) and `fallback` (a store without graph queries took the default-graph sync instead).
- The `OntologyGraph` and `ShapesGraph` shapes gain `packageHashes`, so core's `shapes.ttl` and its shape graph change once.
