---
summary: >
  Step C1 of master plan 111: IDataset's read methods (selectQuery, askQuery, triplesQuery,
  triplesTermsQuery) become one readQuery dispatched by the query's kind; ask/triples/terms
  support as query features; resolveRead/dispatchRead; LinkedStorage.readQuery; Transaction;
  the terms read gets kind 'triples_terms' (DSL-JSON 1.10). graphQuery stays (owner decision 1).
status: Implementation
---

# 112 One read method in core (step C1)

Contracts: master plan [111](111-one-read-method.md) C-1 to C-8 (after the owner's decisions of
2026-11-01: `graphQuery` stays a method of its own; no `'graph'` feature).

## Phases

1. **Types, features, terms kind.** `src/queries/readQuery.ts` (`ReadQuery`, `ReadKind`,
   `ReadResult`, `readKindOf`, `readKindOfJSON`, `readFeaturesOf`); `QueryFeature` gains `ask`,
   `triples`, `triplesTerms` (`ALL_QUERY_FEATURES` too); `TriplesTermsQuery`,
   `parseTriplesTermsQuery`, `isTriplesTermsQuery`, `triplesTermsQueryOf`; `TriplesQuery` loses
   `objects`/`predicates`; `WIRE_VERSION = '1.10'`; `fromJSON` refuses `triples_terms`; exports.
   Validation: `npx tsc --noEmit -p tsconfig.json` on the new modules (whole build after phase 4).
2. **Dispatch and builders.** `QueryDispatch.readQuery`; `resolveRead`, `dispatchRead`; the
   per-kind helpers removed; `instrumentDispatch`; `QueryBuilder`, `GroupedSelectBuilder`,
   `AskBuilder`, `CountBuilder`, `TriplesBuilder` send through them.
3. **LinkedStorage and Transaction.** `LinkedStorage.readQuery` (routing per kind as today);
   `setDefaultDataset`'s dispatch; `begin()`'s router; `Transaction.readQuery`;
   `TransactionRouter.readQuery`.
4. **Stores and helpers.** `IDataset.readQuery` and its doc; `SparqlDataset.readQuery` (private
   per-kind methods); `InMemoryDataset`; `triplesToSparql` types; test helpers. Validation:
   `npx tsc -p tsconfig.json --noEmit`.
5. **Tests, docs, changesets.** Every test double and call; new `read-query.test.ts`;
   `tsconfig-tests.json`; README, `docs/architecture/ontologies.md`; changesets. Validation: the
   Verify of step C1 (build, `npm test` with live Fuseki, grep).

## Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| 1 types, features, terms kind | done | (this commit) | `tsc --pretty false`: no error in `readQuery.ts`, `triplesQuery.ts`, `queryFeatures.ts`, `wireVersion.ts`, `fromJSON.ts`, `index.ts` (the others are the callers of phases 2-4) |
| 1 | phase 1, C-4 | The contract's `TriplesTermsQuery` has no `subject`/`predicate`/`object`, but report 109's terms reads fix them (`forNode(s).withPredicate([…])`, `toNode([…]).withPredicate(p)`), and has `recordClass?`, which 109 refuses on a terms read | `TriplesTermsQuery` keeps `subject?`, `predicate?` (with `objects`), `object?` (with `predicates`); no `recordClass`, no `limit`. **Contract change**, recorded in 111, 027 and 394 | Drop the fixed positions (loses 109's reads) or keep a `recordClass` that is always refused | Correctness (keeps every read 109 ships); one explicit way (no dead field) |
| 2 | phases 1-4 | `IDataset`'s method changes break every implementer at once, so a phase cannot compile alone | Phases 1-3 are checked by the typecheck of their own files (`tsc --pretty false` filtered); the whole build compiles from phase 4 on | One commit for everything | The plan asks for 5 phases; each commit stays reviewable |
| 3 | phase 1, C-2 | `readFeaturesOf` of an ask: include `ask`, though a dataset without it is still answered | Include it, and say in its doc that `ask` alone is not refused (the `LIMIT 1` fallback) | Leave `ask` out | It says what the read uses natively; `resolveRead` owns the fallback |
| 4 | phase 1, C-2 | `readKindOf` on a plain object with neither `__queryKind` nor a read `kind` | Throw, naming what it got | Treat it as a select | Discriminate on the kind, never structurally (C-2) |

## Progress

| Phase | Status | Commit | Validation |
|---|---|---|---|
