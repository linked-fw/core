---
summary: >
  Two gaps a host meets when it validates and queries data-only shapes in a ShapeCatalog:
  `validate` checks datatypes by JavaScript type, so lexical values ("2026-01-02" for xsd:date,
  "12.50" for xsd:decimal, an IRI string for an sh:node field) fail although they are valid
  RDF literals; and the errors for an sh:node target missing from the active catalog name the
  shape but not the property or the catalog.
packages: [core]
status: Done — §2 implemented (PR #350); §1 closed by decision, not implemented
---

# 056 — `validate` accepts lexical forms; missing-shape errors name the property

Source: Create Now plan 068 phase 3 (its report 098, review round 1).

## 1. Lexical forms in `validate`

`src/shapes/validation.ts` accepts `xsd:date`/`xsd:dateTime` only as a `Date`, numeric datatypes
only as a `number`, `xsd:boolean` only as a `boolean`, and an `sh:node` value only as an object.
Data that comes from RDF text (an extraction's facts, staged triples, a form) carries the lexical
form: `"2026-01-02"`, `"12.50"`, `"3"`, `"true"`, `"https://…"`. Those are valid literals and
references, and `validate` rejects them. Create Now validates such data with its own lexical rule
instead (`src/utils/shapeValidity.ts`), so its readiness and its commit agree.

Wanted: an option (or the default) under which `validate` accepts the lexical form of each XSD
datatype it checks (the XSD lexical spaces), and an IRI string for a node-valued property.

Closed by owner decision, not implemented: core refuses strings for typed datatypes on purpose
(`src/shapes/validation.ts`, the `xsd:date`/`xsd:dateTime` note above the datatype checks); Create
Now keeps its own lexical rule.

## 2. Errors for a missing `sh:node` target

Inside a `ShapeCatalog`, a property whose `sh:node` names a shape the catalog does not hold makes
query building throw `Shape class not found for <shape>` (`SelectQuery.generatePathValue`), and
`fromJSON` throws `Cannot resolve shape for '<shape>'`. Neither names the property that points at
the shape, nor the catalog (`catalog.name`). Wanted: `Property '<label>' of '<shape>' points at
'<target>', which catalog '<name>' does not hold`, with the IRIs as fields on the error, so a host
can map it without parsing the message.

Done: every such error (select, `walkPropertyPath`, `FieldSet`, `fromJSON`, mutations, and
`validate`'s violation message) names the property, its shape and the catalog, and is thrown as
`UnresolvedShapeError` (still an `Error`) with `shapeIri`, `property`, `propertyIri`,
`ownerShapeIri` and `catalog` fields. The message names the scope only while a scoped
`ShapeCatalog` is active (`… points at it; not among the shapes in scope 'p1#main'`); against the
global registry it ends after "points at it".
