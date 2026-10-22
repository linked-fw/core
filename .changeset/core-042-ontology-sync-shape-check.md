---
'@_linked/core': minor
---

Ontology data as Turtle, ontology sync, the shape check, tighten-only overrides, SHACL metamodel
terms.

Breaking changes:

- Ontology data is Turtle only. A package's `loadData()` returns `string[]` (the Turtle text of
  each data file); JSON(-LD) ontology data is no longer loaded: it is skipped with one warning.
- `autoLoadOntologyData` is removed. Nothing loads ontology data at registration; the ontology
  sync writes the hierarchy into the store.
- `PropertyShapeData.group` is a `NodeReferenceValue` (`sh:group` is an IRI to a
  `PropertyGroup`), no longer a literal.
- Core's built-in shapes are now eight (`OntologySync` and `PropertyGroup` join them); code that
  counts or lists them sees two more.

Added:

- `@_linked/core/ontology/loadOntologyFiles`: a package's `loadData` reads its Turtle data
  (`src/data/<name>.ttl`) relative to the ontology module. `linkedOntology` records every
  ontology in a registry (`getRegisteredOntologies()`); `loadData` is optional.
- `@_linked/core/ontology/hierarchy`: `hierarchyFromTurtle`, `subClassClosure`,
  `definedTermsFromTurtle` (server only, `n3` loaded on demand).
- `@_linked/core/ontology/syncOntologies`: writes each package's `rdfs:subClassOf` triples into a
  dataset, skipped by a content hash stored on a built-in `OntologySync` node per package.
  `force` re-inserts every listed triple, repairing a dataset that lost them.
- `@_linked/core/shapes/checkShapeHierarchy`: shape `extends` against the class hierarchy,
  borrowed target classes, mirror packages (`linkedPackage(name, {mirrors})`) and overrides that
  widen the inherited class. `@linkedShape({sharedTargetClass: true})` exempts a shape that shares
  its class on purpose (`PathList`).
- Tighten-only: an override inherits the datatype, class, value shape and `contains` it does not
  restate, so its generated SHACL gains them. A decorated override that widens what it inherits
  throws at registration (the cases are listed with the store requirement); shapes known only as
  data warn for every case.
- The SHACL metamodel gains `sh:name`, `sh:targetSubjectsOf`, `sh:deactivated`, `sh:message`,
  `sh:severity`, `sh:and`/`sh:xone`/`sh:not` (node shapes), `sh:flags`, `sh:languageIn`,
  `sh:uniqueLang`, `sh:qualifiedMinCount` and nested `sh:property` (property shapes), and the
  built-in `PropertyGroup`.
