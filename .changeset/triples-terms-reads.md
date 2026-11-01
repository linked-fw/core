---
'@_linked/core': minor
---

Terms reads: which of a list of terms occur, in one query.

- `TriplesBuilder.toNode([{id}, …])` and `withPredicate([{id}, …])` (static and on a read) take a
  list of terms. `.whichExist(target?)` answers the `Set` of the listed IRIs that some triple of the
  read has in that position; `.exists()` on such a read asks whether any does. A terms read has no
  `exec()`.
- `TriplesQuery` gains `objects` and `predicates` (one list per read, not with `object` /
  `predicate`). It is answered by the new optional `IDataset.triplesTermsQuery` (never by
  `triplesQuery`), which needs `triplesPattern` in `supports`. `SparqlDataset` answers it with
  `SELECT DISTINCT ?t WHERE { VALUES ?t { … } FILTER EXISTS { … } }`, one query per 400 terms
  (`TRIPLES_TERMS_PER_QUERY`); `LinkedStorage` sends it to every dataset and joins the answers.
  New exports: `resolveTriplesTerms`, `assertTriplesTermsTarget`, `dispatchTriplesTermsQuery`,
  `triplesTermsToAlgebra`, `triplesTermsToSparql`, `mapSparqlTriplesTermsResult`.
- DSL-JSON wire version 1.9.
