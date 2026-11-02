---
'@_linked/core': minor
---

Terms reads: which of a list of terms occur, in one query.

- `TriplesBuilder.toNode([{id}, …])` and `withPredicate([{id}, …])` (static and on a read) take a
  list of terms. `.whichExist(target?)` answers the `Set` of the listed IRIs that some triple of the
  read has in that position; `.exists()` on such a read asks whether any does. A terms read has no
  `exec()`.
- A terms read is a `TriplesTermsQuery` (`kind: 'triples_terms'`, `objects` or `predicates`, one
  list per read). It goes to `IDataset.readQuery`, only to a dataset that declares the
  `'triplesTerms'` and `'triplesPattern'` query features. `SparqlDataset` answers it with
  `SELECT DISTINCT ?t WHERE { VALUES ?t { … } FILTER EXISTS { … } }`, one query per 400 terms
  (`TRIPLES_TERMS_PER_QUERY`); `LinkedStorage` sends it to every dataset and joins the answers.
  New exports: `triplesTermsToAlgebra`, `triplesTermsToSparql`, `mapSparqlTriplesTermsResult`.
