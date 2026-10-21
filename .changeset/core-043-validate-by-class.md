---
'@_linked/core': minor
---

The class hierarchy in memory, `validateByClass`, and multiple inheritance in the shape check.

- `@_linked/core/ontology/classHierarchy` (browser-safe): `superClassesOf(iri)` and
  `subClassesOf(iri)`, reflexive and transitive, over the shape tree's edges (a shape targeting C
  that extends one targeting D gives `C ⊑ D`) plus the ontology triples set with
  `setOntologyHierarchy(triples)`.
- `@_linked/core/ontology/hierarchy`: `loadOntologyHierarchy()` parses every registered package's
  ontology data and sets it. `syncOntologies` sets it from its own parse; `checkShapeHierarchy()`
  without a `hierarchy` loads it.
- `validateByClass(data, {types?, mode?, maxDepth?})`: validates a node against every registered
  shape that targets one of its types or a superclass of one, the in-process counterpart of SHACL
  class targeting. No known type, or no shape, validates nothing and says so (`sh:Info`).
- The shape check's `subclass-without-extends`: when a shape already extends an in-scope shape of
  a superclass, a superclass shape off that extends chain (multiple inheritance) is a warning, not
  an error.
