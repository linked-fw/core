---
'@_linked/core': minor
---

The ontology sync writes each package's whole ontology data into its own named graph.

- `syncOntologies(ds?, {force, packages, orphanScope})` (same signature and result) creates or replaces `{package IRI}/graph/ontology` per package in one graph query, recorded in the graph registry as an `OntologyGraph` (`package`, `sources`) that feeds the store's class hierarchy. The body is sent as N-Triples (one blank-node prefix per file).
- Skipped by a content hash per package: `ontologyGraphHash(texts)`, SHA-256 of `linked-ontology-sync/2\n` + the package's raw data file texts, recorded as the graph's `core:contentHash`. Every dataset rewrites its graphs once on the first boot with this version.
- After a package's graph is written, the hierarchy the earlier sync kept for it in the default graph (the lines its `OntologySync` node lists, except those another node lists) is removed, then the node. Hand-written default-graph axioms stay.
- `orphanScope: 'all'` drops the ontology graphs of packages no longer registered.
- A store without graph queries (`unsupported-query-kind`, or a dataset without `graphQuery`) keeps the earlier default-graph sync; `OntologySync`, `ontologySyncHash`, `ontologyTriplesText`, `ontologySyncNodeIri` and `toNTriplesLine` stay for it, deprecated.
- `nTriplesFromTurtle(texts, sources?)` in `@_linked/core/ontology/hierarchy`.

**Breaking changes**

- The sync requires `ghcr.io/linked-fw/fuseki:6.2.0-2` or a store that builds its class hierarchy from the graph registry. On `6.2.0-1` the hierarchy is read from the default graph only, which this sync empties of package hierarchies: inference loses every synced class. Move every store to `6.2.0-2` before an app runs this core.
- Ontology data (labels, comments, the hierarchy) moves out of the default graph into package graphs: a reader that queried it in the default graph finds nothing there; read the package graphs (`graphs.allOntologies`) instead.
