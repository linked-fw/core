---
summary: >
  Blank-node support in core — next steps after `sh:nodeKind`-driven minting (report 035): update
  and upsert of blank values through their parent, a read model that returns blank values as
  nested objects without an id, a node-level `sh:nodeKind`, consumers reading path structure
  through the DSL again, and smaller gaps found on the way (undetectable blank labels from a
  select, blank values of non-dependent owned children, the concrete shape of a blank value).
packages: [core]
---

# 054 — Blank-node support in core: next steps

Sources: [report 034](../reports/034-shacl-complex-paths-as-blank-nodes.md) (complex SHACL paths
as blank nodes, `__blank`) and [report 035](../reports/035-nodekind-driven-blank-nodes.md)
(`__blank` replaced by minting from the property's `sh:nodeKind`). Contract:
[owned-values](../architecture/owned-values.md#blank-node-values).

## Today

- A nested **create** under a blank-capable property (`sh:BlankNode`, `sh:BlankNodeOrIRI`
  without an id, `sh:BlankNodeOrLiteral`) is written as an untyped blank node.
- Deleting the subject, replacing / unsetting the property and the containment cascade delete
  blank values and the blank nodes below them, through blank-capable properties only.
- Refused with an error: an update / upsert / update-where whose value would be blank; a `_:…` id
  (link, `update().for()`, delete by id).
- A select returns a blank value as its store label.

## Open items

1. **Update / upsert of blank values through the parent.** `Place.update({geo: {lat: '1'}})`
   under a `sh:BlankNodeOrIRI` property throws today. A `DELETE/INSERT … WHERE` template mints a
   blank node per WHERE solution, and the update's cleanup UNION yields several, so the INSERT
   must run where exactly one solution exists: a second operation in the same request
   (`DELETE … WHERE …; INSERT DATA { <s> <p> _:b0 . … }`), or an INSERT whose WHERE is reduced to
   one row. Questions: one request with two operations versus one operation; how `updateWhere`
   (many subjects) mints one structure per matched subject; what the result reports.
2. **Read model for blank values.** A select of a blank-capable property returns a label (Fuseki
   `b0`), valid only within that result. Return the value as a nested object without an `id`
   (its fields projected), or mark blank labels (`_:b0`) so they are recognisable. Marking would
   also let core refuse the label when it is passed back as an id: today only the `_:` form is
   detected, and a bare `b0` becomes the relative IRI `<b0>`.
3. **Node-level `sh:nodeKind`.** Rejected for this step (it cannot decide anything under a
   polymorphic slot such as `sh:path`, whose values are untyped). Worth revisiting for user
   shapes whose instances are always anonymous, alongside a way to say whether a blank node is
   typed: today a blank node never gets `rdf:type`, so the concrete subclass of a blank value is
   not persisted.
4. **Consumers reading path structure through the DSL again.** Path structure can only be read in
   the same query that finds the path (blank labels are per result set, report 034 "Readers").
   With item 2 a consuming application could select `PropertyShape.path` with its operators as
   nested objects instead of a hand-written SPARQL query keyed by the property-shape IRI. Needs
   the `byShape` polymorphic projection ([backlog 031](031-byshape-polymorphic-projection.md)),
   since `sh:path` values are a predicate IRI, a `PathNode` or a `PathList`.
5. **Blank values of non-dependent owned children.** A subject delete removes an
   immediately-owned child's own triples (the `contains` + value-shape block) but not that child's
   blank values unless the child is dependent-typed. Add a blank-node cascade per owned child
   shape with blank-capable properties.
6. **Legacy sequence-member operator nodes.** The IRI-named operator nodes of versions before 2.30
   that sat under a sequence cell's `rdf:first` are still left as unreferenced orphans (report 034
   "Migration"; query to remove them in the README).
