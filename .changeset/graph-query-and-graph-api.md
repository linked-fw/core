---
'@_linked/core': minor
---

Named graphs: whole-graph operations with automatic records in a graph registry.

- `IDataset.graphQuery(query)` runs `graph_create`, `graph_replace`, `graph_patch` and `graph_drop`; `SparqlDataset` implements it as one SPARQL update per query (body and registry record in one transaction).
- `NamedGraph`, `OntologyGraph`, `ShapesGraph` and `DraftGraph` (`@_linked/core/shapes/NamedGraph`, built-in shapes): `OntologyGraph.create({id, package, version}).withContent(c)`, `NamedGraph.replaceContent(iri, c)`, `NamedGraph.patchContent(iri, {insert, delete})`, `OntologyGraph.update(iri).set({...})` (optionally `.replaceContent(c)` / `.patchContent(p)`), `OntologyGraph.delete(iri)`, `OntologyGraph.iriFor(pkg)`; `select()` reads the registry. Server-only.
- Portable graph names in `@_linked/core/ontologies/graphs`: `graphs.default`, `graphs.union`, `graphs.allOntologies`, `graphs.allShapes`, `graphs.registry`; writes to them are refused.
- Typed refusals: `GraphQueryError` with `code` `unsupported-query-kind`, `graph-not-registered`, `graph-name-read-only`, `graph-exists` (`isGraphQueryError`); `parseGraphQuery` checks a graph query that arrived as JSON.
- Terms: `core:OntologyGraph`, `core:ShapesGraph`, `core:DraftGraph`, `core:contentHash`, `core:feedsHierarchy`, `core:package`, `core:version`; `sd:NamedGraph`, `sd:name` (`@_linked/core/ontologies/sd`).
- `deleteInsertPlanToSparql` honours `plan.graph` (emits `WITH <g>`).

**Breaking changes**

- `IDataset.graphQuery` is required. A dataset without graph support implements it by throwing `unsupportedGraphQuery(query)`. Core's callers treat a dataset without the method as `unsupported-query-kind` at runtime, so an older dataset class keeps working until it is updated.
- `IDataset.updateQuery`, `createQuery` and `deleteQuery` are required (a read-only dataset implements them by throwing).
- `IDataset.askQuery` is optional: an ask on a dataset without it is answered with a select `LIMIT 1` (a shapeless ask is refused there).
- Core's built-in shapes gain `NamedGraph`, `OntologyGraph`, `ShapesGraph` and `DraftGraph` (shape sync writes them like the other built-ins).
