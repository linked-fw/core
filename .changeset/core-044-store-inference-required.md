---
'@_linked/core': minor
---

Core requires a store with RDFS class inference and the ontology hierarchy synced
(`syncOntologies`; with Fuseki, the inferring image `ghcr.io/linked-fw/fuseki`).

Breaking changes:

- The store requirement: class-scoped reads and bulk mutations, the owned-link check, the owned
  walk and the single-owner constraint rely on the store inferring `rdf:type` through
  `rdfs:subClassOf`. On a store without inference, subclass instances are no longer found
  through their superclass, and a link to one is refused.
- Tighten-only overrides throw (see "New errors" below), and a `label` accessor on any predicate
  other than `rdfs:label` throws at load.
- `SHAPE_HASH_VERSION` 2: the next shape sync rewrites every stored shape once.
- xsd `Bytes` is removed (not an XSD term).

Changes:

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
  at registration. The shape check's `override-not-tightened` (a class that is not
  the inherited class or a subclass of it) is an error for a decorated shape; data-only shapes
  stay warnings. Every shape inherits the base `Shape`'s `label` (`rdfs:label`), so a `label`
  accessor on any other predicate is a changed path and now throws at load: use `rdfs:label`, or
  name the accessor differently.
- A refused override found while another shape registers (its value shape, named by
  `[package, name]`) no longer leaves that shape half-registered: every pending callback runs and
  the first error is thrown at the end.
- `NodeShape` and `PropertyShape` carry typed accessors for every metamodel property
  (`sh:name`, `sh:targetSubjectsOf`, `sh:deactivated`, `sh:message`, `sh:severity`, …), so a
  select over them type-checks.
