---
'@_linked/core': minor
---

Ontology data as Turtle, ontology sync, the shape check, tighten-only warnings, SHACL metamodel terms.

- `@_linked/core/ontology/loadOntologyFiles`: a package's `loadData` reads its Turtle data
  (`src/data/<name>.ttl`) relative to the ontology module. `linkedOntology` records every
  ontology in a registry (`getRegisteredOntologies()`); `loadData` is optional; data that is not
  Turtle text is skipped with one warning. `autoLoadOntologyData` is a no-op (removed in the next
  major).
- `@_linked/core/ontology/hierarchy`: `hierarchyFromTurtle`, `subClassClosure`,
  `definedTermsFromTurtle` (server only, `n3` loaded on demand).
- `@_linked/core/ontology/syncOntologies`: writes each package's `rdfs:subClassOf` triples into a
  dataset, skipped by a content hash stored on a new built-in `OntologySync` node per package.
- `@_linked/core/shapes/checkShapeHierarchy`: shape `extends` against the class hierarchy,
  borrowed target classes, mirror packages (`linkedPackage(name, {mirrors})`) and overrides that
  widen the inherited class. `@linkedShape({sharedTargetClass: true})` exempts a shape that shares
  its class on purpose (`PathList`).
- Tighten-only: an override that changes the datatype, names a value shape that is not a
  sub-shape, says `contains: false`, or changes the path warns (an error in the next major); an
  override inherits the datatype, class, value shape and `contains` it does not restate, so its
  generated SHACL gains them. Shapes known only as data warn for every case.
- The SHACL metamodel gains `sh:name`, `sh:targetSubjectsOf`, `sh:deactivated`, `sh:message`,
  `sh:severity`, `sh:and`/`sh:xone`/`sh:not` (node shapes), `sh:flags`, `sh:languageIn`,
  `sh:uniqueLang`, `sh:qualifiedMinCount` and nested `sh:property` (property shapes), and the
  built-in `PropertyGroup`; `sh:group` is an IRI (`PropertyShapeData.group` is a
  `NodeReferenceValue`). Core's built-ins are now eight.
