---
'@_linked/core': minor
---

Ontology data: labels, descriptions and types for every term.

- Core registers its own vocabulary (`core:`, `https://linked.cm/ont/core/`) and `npm:`
  (`http://purl.org/on/npm/`) with `linkedOntology`, from `ontologies/linked-core.register` and
  `ontologies/npm.register`, which core's index imports. Each module exports `dataFiles` and
  `loadData`.
- `src/data/core.ttl` (20 terms) and `src/data/npm.ttl` (2 terms), copied into `lib/esm/data/`:
  the ontology node (`dcterms:title`, `dcterms:description`, `owl:versionInfo`) and every term
  typed (`owl:Class`, `owl:ObjectProperty` or `owl:DatatypeProperty`) with an English label and
  comment, in the deterministic Turtle form. The ontology sync now records `@_linked/core`.
