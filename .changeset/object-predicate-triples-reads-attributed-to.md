---
'@_linked/core': minor
---

Triples reads by object and by predicate, and an IRI-valued graph-record field.

- `TriplesBuilder.toNode({id})` reads the triples whose object is that node, optionally
  `.from(graphs)` (without graphs it looks where a subject read looks).
- `TriplesBuilder.withPredicate({id})` reads the triples of one predicate; it needs `.from(graphs)`.
  `.withPredicate({id})` on a read narrows it to that predicate.
- `.exists(target?)` on a triples read: the read with `limit: 1`, `true` when a triple comes back.
- `TriplesQuery` gains `predicate` and `object`. A read that uses one needs the new query feature
  `triplesPattern` in the dataset's `supports` (`SparqlDataset` lists it); other datasets are
  refused before they are asked. DSL-JSON wire version 1.4.
- `NamedGraph.attributedTo` (`prov:wasAttributedTo`, an IRI, maxCount 1), on every graph-record
  class: `ShapesGraph.update(g).set({attributedTo: {id}}).replaceContent(c)` writes the mark in the
  same graph query as the content, `set({attributedTo: null})` clears it, and
  `select(g => [g.attributedTo])` reads it as `{id}`. A record field set to `null` is cleared. A record
  field can now be a node (`GraphRecordField` with `nodeKind: 'iri'`, values `{id}`); new terms
  module `@_linked/core/ontologies/prov`.
