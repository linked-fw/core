---
date: 2026-11-01
summary: >
  Terms reads: `TriplesBuilder.toNode([…])` and `withPredicate([…])` take a list of terms, and
  `.whichExist()` answers the Set of the listed IRIs that occur, through the new optional
  `IDataset.triplesTermsQuery` (`SELECT DISTINCT ?t`, `VALUES ?t`, `FILTER EXISTS`, 400 terms per
  query). `TriplesQuery.objects` / `.predicates`, wire 1.9. Minor.
packages: [core]
---

# 109 — Terms reads

## PR

### Summary

A triples read can now ask which of a list of terms occur, in one query instead of one read per
term (the host app's term usage made one per class and per property).

```ts
const instantiated = await TriplesBuilder.toNode(classes).withPredicate(rdf.type).from(dataGraphs).whichExist(ds);
const used = await TriplesBuilder.withPredicate(properties).from(dataGraphs).whichExist(ds);
```

- **Builders:** `toNode` and `withPredicate` (static and on a read) take `NodeReferenceValue[]`.
  `.whichExist(target?)` answers a `Set<string>`; `.exists()` on a terms read asks whether any term
  occurs; `.exec()` is refused (a terms read answers terms, not triples). A later `withPredicate`
  replaces an earlier one, list or term.
- **Query:** `TriplesQuery.objects` / `.predicates`, one list per read, never with `object` /
  `predicate` or `recordClass`; each term an absolute IRI, kept once. A list of objects is a node
  read (graphs optional); a list of predicates needs graphs. It needs `triplesPattern`, as a
  one-term read does.
- **Dataset:** a new optional `IDataset.triplesTermsQuery(query): Promise<string[]>`. Only it
  answers a terms read and it answers only those: `resolveTriples` refuses a list,
  `resolveTriplesTerms` refuses a read without one. `resolveTriplesTerms` checks the method and the
  feature first, answers `[]` for an empty list without asking, and keeps only the listed terms.
  The dispatch observes it (`kind: 'triplesTerms'`); `Transaction` refuses it.
- **SPARQL:** `SELECT DISTINCT ?t WHERE { VALUES ?t { … } FILTER(EXISTS { <scoped pattern> }) }`,
  the pattern scoped to the graphs exactly as the one-term read's is (`GRAPH <g>`, `FROM NAMED` with
  a graph variable, `VALUES ?g_s` with the store's name for the default graph). Each term stops at
  its first match. `SparqlDataset` sends one query per `TRIPLES_TERMS_PER_QUERY` (400) terms.
- **LinkedStorage:** sent to every dataset (no routing key), each checked before the first is asked
  (report 105's rule), answers joined, stopping once every term is found; the fan-out notice as for
  a node read.
- **Wire:** DSL-JSON 1.9 (`documentation/dsl-json.md`, README).

### Verification

- `FUSEKI_BASE_URL=http://localhost:3961 FUSEKI_ADMIN_PASSWORD=admin npm test` (own Fuseki):
  `Test Suites: 4 skipped, 168 passed, 168 of 172 total`, `Tests: 122 skipped, 3321 passed, 3443
  total`, `[fuseki] live tests: 493 total — 491 passed, 0 failed, 2 skipped`; typecheck clean.
- `npx linked build`: `✔ Build successful`.
- The host app (its own report): term usage on the terms read; `npm run test:changed` in the worktree ran the
  regular set: unit `Tests 4063 passed | 5 skipped (4068)`, playwright `517 passed (13.1m)`,
  packages PASS. The host app's main checkout after landing: see its report for `npm run typecheck:gate`.

### Deviations

- The answer type differs from a triples read's, so it is a dataset method of its own
  (`triplesTermsQuery`) rather than a mode of `triplesQuery`. A store that predates it lacks the
  method and is refused, so no new query feature was needed.
- Name: `whichExist()` (working name `existsEach`), next to `exists()`.

### Follow-ups

- The host app's routers without `triplesTermsQuery`, `@_linked/server`'s `RemoteDataset` sending neither
  triples nor terms reads, the gateway's 10 000-term cap: the host app's backlog.

## Details

### Changes

- `src/queries/triplesQuery.ts`: `objects`, `predicates`; `checkTriplesTerms`,
  `triplesTermsPosition`, `triplesTermsOf`; the whole-read checks count the lists.
- `src/queries/TriplesBuilder.ts`: list forms, `whichExist()`, `exec()` refusal, `exists()`.
- `src/queries/queryDispatch.ts`: `assertTriplesTermsTarget`, `resolveTriplesTerms`,
  `dispatchTriplesTermsQuery`, the dispatch event, the list refusal in `assertTriplesTarget`.
- `src/sparql/triplesToSparql.ts`: `triplesTermsToAlgebra`, `triplesTermsToSparql`,
  `mapSparqlTriplesTermsResult`. `src/sparql/SparqlDataset.ts`: `triplesTermsQuery`,
  `TRIPLES_TERMS_PER_QUERY`; graph expansion and sending shared with `triplesQuery`.
- `src/utils/LinkedStorage.ts`, `src/utils/Transaction.ts`, `src/interfaces/IDataset.ts`,
  `src/utils/fanOutNotice.ts`, `src/queries/wireVersion.ts` (1.9).
- Tests: `triples-read.test.ts` (7 new: builders, wire, SPARQL, chunking, refusals, dispatch,
  LinkedStorage), `triples-read-fuseki.test.ts` (1 live), `select-node-type.test.ts` (wire 1.9).
- `.changeset/triples-terms-reads.md`: **minor**.

### Review

An independent review of the core and the host app diffs found nothing at medium or above. Its low findings:
LinkedStorage counted the raw query's terms (now checked with `triplesQueryOf` first), the
gateway's cap counted one list (now both), a duplicate import (merged); the rest are the host app's backlog.
