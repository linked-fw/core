---
'@_linked/core': minor
---

Core requires a store with RDFS class inference and the ontology hierarchy synced
(`syncOntologies`; with Fuseki, the inferring image `ghcr.io/linked-fw/fuseki`).

- The owned-link check accepts the value shape's `targetClass` and the property's `sh:class`; a
  subclass instance passes through its inferred type (registered sub-shapes are no longer listed).
- The generated single-owner constraint names one `sh:class` (the declaring class) instead of an
  `sh:or` of every registered sub-shape's class. `SHAPE_HASH_VERSION` 2: the next shape sync
  rewrites every stored shape once.
- Owned-walk cycle hops are typed `?n a <C>`. A sub-shape's guarded edge is not followed when a
  shape on a subclass of its class (from the in-memory hierarchy) holds the predicate as a plain
  property; an edge already followed under a more general guard is not repeated.
- Bulk mutations are documented as polymorphic, like select and count.
- New errors (tighten-only): a decorated override that changes its `datatype`, names a value
  `shape` that is not the inherited one or a sub-shape of it, declares `contains: false` over an
  owning property, or changes its path, and a new label redeclaring an inherited path, now throw
  at registration (they warned). The shape check's `override-not-tightened` (a class that is not
  the inherited class or a subclass of it) is an error for a decorated shape; data-only shapes
  stay warnings.
- Removed: `autoLoadOntologyData` (a no-op since the ontology sync); xsd `Bytes` (not an XSD term).
- `NodeShape` and `PropertyShape` carry typed accessors for every metamodel property
  (`sh:name`, `sh:targetSubjectsOf`, `sh:deactivated`, `sh:message`, `sh:severity`, …), so a
  select over them type-checks.
