---
'@_linked/core': minor
---

Triples reads: a graph read and a subject read, without a shape.

- `NamedGraph.readContent(graph)` (and on every graph-record class: `DraftGraph.readContent(g)`)
  reads every triple of a graph, routed like that class's graph queries.
- `TriplesBuilder.forNode({id})` reads one subject's triples, optionally `.from(graphs)`; without
  graphs it looks where a shapeless ask looks. Both take `.limit(n)`.
- The answer is `Triple[]` (`{subject, predicate, object, graph?}`): IRIs as `{id}`, blank nodes as
  `{id: '_:label'}`, literals as `{value, datatype, language?}`.
- New optional `IDataset.triplesQuery(query)`; `SparqlDataset` implements it with one SELECT
  (`triplesToSparql`, `mapSparqlTriplesResult` in `@_linked/core/sparql`). `LinkedStorage` routes
  it; the dispatch refuses a dataset without it. `TriplesQuery` is plain data, checked at a wire
  boundary with `parseTriplesQuery`.
