---
summary: >
  Step C1 of master plan 111: IDataset's read methods (selectQuery, askQuery, triplesQuery,
  triplesTermsQuery) become one readQuery dispatched by the query's kind; ask/triples/terms
  support as query features; resolveRead/dispatchRead; LinkedStorage.readQuery; Transaction;
  the terms read gets kind 'triples_terms' (DSL-JSON 1.10). graphQuery stays (owner decision 1).
status: Review
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
| 1 | phase 1, C-4 | The contract's `TriplesTermsQuery` has no `subject`/`predicate`/`object`, but report 109's terms reads fix them (`forNode(s).withPredicate([…])`, `toNode([…]).withPredicate(p)`), and has `recordClass?`, which 109 refuses on a terms read | `TriplesTermsQuery` keeps `subject?`, `predicate?` (with `objects`), `object?` (with `predicates`); no `recordClass`, no `limit`. **Contract change**, recorded in 111, 027 and 394 | Drop the fixed positions (loses 109's reads) or keep a `recordClass` that is always refused | Correctness (keeps every read 109 ships); one explicit way (no dead field) |
| 2 | phases 1-4 | `IDataset`'s method changes break every implementer at once, so a phase cannot compile alone | Phases 1-3 are checked by the typecheck of their own files (`tsc --pretty false` filtered); the whole build compiles from phase 4 on | One commit for everything | The plan asks for 5 phases; each commit stays reviewable |
| 3 | phase 1, C-2 | `readFeaturesOf` of an ask: include `ask`, though a dataset without it is still answered | Include it, and say in its doc that `ask` alone is not refused (the `LIMIT 1` fallback) | Leave `ask` out | It says what the read uses natively; `resolveRead` owns the fallback |
| 5 | phase 2, C-5 | Where a select's feature check runs in `QueryBuilder.exec` (it threw outside the error wrapping) | Keep `assertQuerySupported` before the `try`, then `resolveRead` (which checks again) | Only `resolveRead` inside the `try` | The refusal keeps its own message, unwrapped, as today |
| 6 | phase 2, C-5 | `exec(target)` of a select, count or ask was not observed (no instrumenting), unlike graph, triples and mutations | Unchanged: they call `resolveRead(target ?? dispatch, q)`; triples and terms use `dispatchRead` (observed) | Route every builder through `dispatchRead` | Backward compatibility: listeners (the live-query store) see what they saw |
| 7 | phase 2, C-5 | `assertTriplesTarget`/`assertTriplesTermsTarget` are removed, but a router needs to check every dataset before it asks the first | New exported `assertReadSupported(target, query)` (any read kind), used by `resolveRead`, `dispatchRead` and `LinkedStorage`. **Contract addition** (C-5) | Keep the two per-kind asserts | One explicit way, the same check for every kind |
| 8 | phase 3, C-6 | `Transaction.supports` must not list `triples`/`triplesTerms` (C-6), so `TriplesBuilder…exec(tx)` is refused by the feature check ("does not declare 'triples'", naming `Transaction`) before the transaction's own "does not run in a transaction" | Keep the contract; `Transaction.readQuery` still refuses them with today's messages when called directly | List them so the transaction's own message is reached | The contract as written; the refusal still names the transaction |
| 9 | phase 3 | `LinkedStorage` used to call `dataset.selectQuery` directly for a select/count (the builder validated the count) | Every routed dataset is sent its read through `resolveRead` (a count is checked there too) | Call `dataset.readQuery` directly for select/count | C-3: a router listing `ALL_QUERY_FEATURES` forwards through `resolveRead` |
| 10 | phase 4 | `SparqlDataset`'s per-kind methods: private or protected | Private (`selectRead`, `askRead`, `triplesRead`, `termsRead`); a subclass overrides `readQuery` and calls `super.readQuery` | Protected, so subclasses can override one kind | The plan says private; one override point |
| 11 | phase 4 | `InMemoryDataset.readQuery` handed a triples or terms read (it declares neither) | Rejects with `InMemoryQueryRefusal` ("a triples read" / "a terms read") | A generic Error | Its existing refusal type for everything it does not answer |
| 12 | phase 5 | Test doubles: one `readQuery` per double, written out per file | A test helper `readQueryOf({select, ask, triples, terms})` (`src/test-helpers/read-double.ts`, no side effects) and `isSelectRead` | A `switch` in every double | Fewest moving parts across 40 files; a kind without a handler is refused |
| 13 | phase 5 | Current docs outside the Verify grep (`documentation/dsl-json.md`, `intermediate-representation.md`, `sparql-algebra.md`) name the old methods | Updated too (1.10, `triples_terms`, the `readQuery` skeletons) | Leave them | Current docs describe the current state |
| 14 | phase 5, Verify | The Verify grep hits the module path `queries/triplesQuery` (the file keeps its name) | Keep the module name; the remaining hits are import paths only | Rename the module | The plan keeps `triplesQuery.ts` (C-4 names it); a rename would break every importer for nothing |
| 4 | phase 1, C-2 | `readKindOf` on a plain object with neither `__queryKind` nor a read `kind` | Throw, naming what it got | Treat it as a select | Discriminate on the kind, never structurally (C-2) |

## Progress

| Phase | Status | Commit | Validation |
|---|---|---|---|
| 1 types, features, terms kind | done | 9607362 | `tsc --pretty false`: no error in `readQuery.ts`, `triplesQuery.ts`, `queryFeatures.ts`, `wireVersion.ts`, `fromJSON.ts`, `index.ts` (the others are the callers of phases 2-4) |
| 2 dispatch and builders | done | a9a3c95 | `tsc --pretty false`: no error in `queryDispatch.ts`, `IDataset.ts`, the five builders |
| 3 LinkedStorage and Transaction | done | 22cb9e9 | `tsc --pretty false`: no error in `LinkedStorage.ts`, `Transaction.ts` |
| 4 stores and helpers | done | 480c4df | `npx tsc --noEmit -p tsconfig.json`: no errors; `tsconfig-tests.json`: errors only in `src/tests/` (phase 5) |
| 5 tests, docs, changesets | done | (next commit) | `npm test` with own Fuseki on :3962: 170 suites passed (4 skipped), 3345 tests passed (122 skipped); `[fuseki] live tests: 493 total — 491 passed, 0 failed, 2 skipped`; typecheck 0 errors |

