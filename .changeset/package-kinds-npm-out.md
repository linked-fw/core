---
"@_linked/core": minor
---

Package kinds `core:OntologyPackage` and `core:AssetPackage` (`rdfs:subClassOf core:Package`),
exported as `coreOntology.OntologyPackage` / `coreOntology.AssetPackage`.

Removed (small breaking changes): the `npm:` module (`@_linked/core/ontologies/npm`, the
`http://purl.org/on/npm/` terms; npm's terms are now `@_linked/npm` on `https://linked.cm/ont/npm/`),
`core:packageName` and `core:ontologyTriples` with the `OntologySync.packageName` /
`ontologyTriples` properties, and the ontology sync's default-graph fallback with its exports
`ontologySyncNodeIri`, `toNTriplesLine`, `ontologyTriplesText`, `ontologySyncHash` and the
result's `fallback`. A store without graph queries is now refused by the `'package'` and shared
`ontologyGraph` modes with an error naming the store; `'default'` still serves it. The
`'package'` mode no longer removes per-package `OntologySync` nodes an earlier sync left.
