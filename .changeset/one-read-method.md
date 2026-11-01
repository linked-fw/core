---
'@_linked/core': minor
---

One read method: `IDataset.readQuery(query)` answers every read, by the query's kind.

- `readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>>` replaces `selectQuery`,
  `askQuery` and the unreleased `triplesQuery` / `triplesTermsQuery` (no aliases). A select answers
  `SelectResult`, a count a `number`, an ask a `boolean`, a triples read `Triple[]`, a terms read
  `string[]`. `@_linked/core/queries/readQuery` has the types and `readKindOf(query)`,
  `readKindOfJSON(json)` (a wire body's kind, before decoding; refuses writes and graph queries)
  and `readFeaturesOf(query)`. `graphQuery` stays a method of its own: a graph query is a write.
- New query features `'ask'`, `'triples'` and `'triplesTerms'` (in `ALL_QUERY_FEATURES`; a
  `SparqlDataset` lists them). A read a dataset does not declare is refused before it is sent;
  an ask to a dataset without `'ask'` is still answered, as a select `LIMIT 1`.
  `InMemoryDataset.supports` adds `'ask'`.
- The dispatch: `QueryDispatch.readQuery`; `resolveRead(target, query)` (the feature checks, the
  ask fallback, the answer checks), `dispatchRead(query, target?)` and
  `assertReadSupported(target, query)` replace `resolveExistence`, `resolveCount`,
  `resolveTriples`, `resolveTriplesTerms`, `dispatchTriplesQuery`, `dispatchTriplesTermsQuery`,
  `assertTriplesTarget` and `assertTriplesTermsTarget`. A router that lists `ALL_QUERY_FEATURES`
  forwards each read through `resolveRead`. Listener event kinds are unchanged.
- `LinkedStorage.readQuery(query)` replaces the `selectQuery` and `askQuery` statics and routes
  every read as they did. `Transaction.readQuery` runs selects, counts and asks in the
  transaction and refuses triples and terms reads; `TransactionRouter.readQuery` replaces its
  `selectQuery` / `askQuery`.
- A terms read is a `TriplesTermsQuery` of its own kind, `'triples_terms'`
  (`TriplesBuilder…toTriplesTermsQuery()`, `parseTriplesTermsQuery`, `isTriplesTermsQuery`);
  `TriplesQuery` has no `objects` / `predicates`, and `parseTriplesQuery` refuses them.
- DSL-JSON wire version 1.10.
