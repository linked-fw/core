---
date: 2026-11-01
summary: >
  Step C1 of master plan 111: IDataset's reads (selectQuery, askQuery and the unreleased
  triplesQuery / triplesTermsQuery) are one method, readQuery, dispatched by the query's kind; ask,
  triples and terms support are query features; resolveRead / dispatchRead / assertReadSupported
  replace the per-kind helpers; LinkedStorage.readQuery and Transaction.readQuery; a terms read is
  kind 'triples_terms' (DSL-JSON 1.10). graphQuery stays its own method (owner decision). Minor.
packages: [core]
---

# 112 — One read method in core (step C1)

## PR

**What changed**

- `IDataset.readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>>` replaces
  `selectQuery`, `askQuery?`, `triplesQuery?` and `triplesTermsQuery?` (no aliases). The answer type
  follows the kind: select → `SelectResult`, count → `number`, ask → `boolean`, triples →
  `Triple[]`, terms → `string[]`. `graphQuery` stays a method of its own (owner decision 1: a graph
  query is a write).
- New module `src/queries/readQuery.ts` (`@_linked/core/queries/readQuery`): `ReadQuery`,
  `ReadKind`, `ReadResult`, `readKindOf` (by `__queryKind` / `kind`, never by structure; refuses
  writes and graph queries), `readKindOfJSON` (a wire body's kind before decoding; refuses write
  envelopes, graph kinds, unknown ops and kinds) and `readFeaturesOf`. `readKindOf` and the types
  are exported from the package root.
- Query features `'ask'`, `'triples'`, `'triplesTerms'` (in `ALL_QUERY_FEATURES`; `transactions`
  stays out). No `'graph'` feature; graph detection is unchanged. `InMemoryDataset.supports` adds
  `'ask'`; `Transaction.supports` lists every feature but `triples` and `triplesTerms`.
- Dispatch (`src/queries/queryDispatch.ts`): `QueryDispatch.readQuery` (its `graphQuery?` stays);
  `resolveRead(target, query)` makes every check the per-kind helpers made (features and txId, the
  ask fallback as a select `LIMIT 1` for a target without `'ask'`, a count's non-negative integer,
  a real boolean, arrays, the terms read filtered to the list's own); `dispatchRead(query,
  target?)`; `assertReadSupported(target, query)`. Removed: `resolveExistence`, `resolveCount`,
  `resolveTriples`, `resolveTriplesTerms`, `dispatchTriplesQuery`, `dispatchTriplesTermsQuery`,
  `assertTriplesTarget`, `assertTriplesTermsTarget`. The observing wrapper reports today's event
  kinds (a count as `'select'`).
- The builders send through them: `QueryBuilder`, `GroupedSelectBuilder`, `AskBuilder`,
  `CountBuilder` (`resolveRead`), `TriplesBuilder` (`dispatchRead`; new `toTriplesTermsQuery()`).
- `LinkedStorage.readQuery(query)` replaces the `selectQuery` and `askQuery` statics (and the
  unreleased `triplesQuery` / `triplesTermsQuery`) and routes each kind as they did (shape;
  shapeless ask fan-out with its notice; record class; every dataset for node and terms reads;
  outside the shape catalog); each routed dataset is sent its read through `resolveRead`.
  `Transaction.readQuery` runs select, count and ask in the transaction and refuses triples and
  terms reads with today's messages; `TransactionRouter.readQuery` replaces its `selectQuery` /
  `askQuery`.
- Stores: `SparqlDataset.readQuery` switches on `readKindOf` over private `selectRead`, `askRead`,
  `triplesRead`, `termsRead` (400-term chunking unchanged); `InMemoryDataset.readQuery`.
- The terms read is `TriplesTermsQuery` (`kind: 'triples_terms'`), `parseTriplesTermsQuery`,
  `isTriplesTermsQuery`, `triplesTermsQueryOf`; `TriplesQuery` has no `objects`/`predicates` and
  `parseTriplesQuery` refuses them; `fromJSON` refuses `triples_terms` too. DSL-JSON 1.10.
- Tests: every double answers `readQuery` (new side-effect-free helper
  `src/test-helpers/read-double.ts`: `readQueryOf({select, ask, triples, terms})`, `isSelectRead`);
  new `src/tests/read-query.test.ts` (type probes per kind, `readKindOf` / `readKindOfJSON`,
  `readFeaturesOf`, per-feature refusal before sending, the ask fallback, answer checks, event
  kinds, the target-named refusal).
- Docs: README (the dataset section, grouped selects, triples and terms reads),
  `docs/architecture/ontologies.md` (a graph query is a write, not a read),
  `documentation/dsl-json.md` (1.10, `triples_terms`), `intermediate-representation.md` and
  `sparql-algebra.md` (the `readQuery` skeletons). Changesets: new `one-read-method.md` (minor);
  `triples-reads.md`, `triples-terms-reads.md` and the mention in `sort-and-leaf-path-edges.md`
  rewritten for `readQuery`.

**Verification** (worktree `one-read-method--c1`, own Fuseki on :3962, compose project
`fuseki-orm-c1`; app-main untouched)

- `npx linked build` (the main checkout's `linked` binary; `npx linked` does not resolve inside a
  package checkout): `✔ Build successful`, 7.5 s.
- `FUSEKI_TEST_PORT=3962 FUSEKI_BASE_URL=http://localhost:3962 FUSEKI_ADMIN_PASSWORD=admin
  LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-orm-c1 npm test` (jest + `tsc -p tsconfig-tests.json`),
  28.4 s, exit 0:

  ```
  Test Suites: 4 skipped, 170 passed, 170 of 174 total
  Tests:       122 skipped, 3345 passed, 3467 total
  Snapshots:   5 passed, 5 total
  [fuseki] live tests: 493 total — 491 passed, 0 failed, 2 skipped
  ```
  The typecheck printed no error.
- `grep -rnwE 'selectQuery|askQuery|triplesQuery|triplesTermsQuery|resolveExistence|resolveCount|resolveTriples|resolveTriplesTerms' src README.md docs/architecture`
  → 18 hits, every one the module path `queries/triplesQuery` (imports, and two "see
  `triplesQuery.ts`" comments); no method, helper or endpoint name.

**Deviations from the plan**

- Contract change (C-4): `TriplesTermsQuery` keeps report 109's fixed positions (`subject?`,
  `predicate?` with `objects`, `object?` with `predicates`) and has no `recordClass` (109 refuses it
  on a terms read) and no `limit`. Recorded in plans 111, 027 and 394.
- Contract addition (C-5): `assertReadSupported(target, query)` is exported (a router checks every
  dataset before it asks the first) and `ReadTarget` is an exported type; `TriplesBuilder` gains
  `toTriplesTermsQuery()` and its `toTriplesTermsQuery()` / `toTriplesQuery()` refuse the other
  kind. Recorded in the three plans.
- `TriplesBuilder…exec(tx)` of a triples read is refused by the feature check ("(Transaction) does
  not declare 'triples'") rather than by the transaction's own "does not run in a transaction",
  which `tx.readQuery` still gives when called directly (C-6 keeps the features off
  `Transaction.supports`).
- Phases 1-3 do not compile on their own (the method change breaks every implementer at once);
  the build compiles from phase 4 on.

**Follow-ups**

- Wave 2 (master plan 111): `@_linked/server` (S1), the host app (N1, N2) and the test doubles of the other
  repos (X1) do not compile or pass against this core until they land; expected.
- Third-party datasets that implemented `askQuery` must declare `'ask'` in `supports` to keep
  answering asks natively (else they get the select `LIMIT 1` fallback); said in the changeset.

## Details

**Contracts after the owner's decisions (2026-11-01)**, applied in a first docs commit to plans
111 (core), 027 (server) and the host app's before the code: `graphQuery` stays its own method, endpoint
and dispatch path; `readQuery` covers select, count, ask, triples and terms; no `'graph'` feature;
`LinkedStorage`'s read statics collapse into `LinkedStorage.readQuery`; no legacy endpoints or
aliases; the server's `readQuery` refuses triples and terms reads (S1's concern).

**Commits**

| Commit | Phase |
|---|---|
| `1ffeb58` | Plan 111: owner decisions (docs, landed first) |
| `9607362` | 1 types, features, terms kind, DSL-JSON 1.10 |
| `a9a3c95` | 2 dispatch, `IDataset.readQuery`, builders |
| `22cb9e9` | 3 `LinkedStorage.readQuery`, `Transaction.readQuery` |
| `480c4df` | 4 `SparqlDataset`, `InMemoryDataset`, test helpers |
| `81f3a67` | 5 tests, docs, changesets |

Plans 027 and 394 were changed in the master worktree directly (docs only): `dce1459` / `4417000cf`
(owner decisions) and `59158ad` / `7edb84bc3` (the contract changes above).

**Decision ledger**

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| 1 | phase 1, C-4 | The contract's `TriplesTermsQuery` has no `subject`/`predicate`/`object`, but report 109's terms reads fix them (`forNode(s).withPredicate([…])`, `toNode([…]).withPredicate(p)`), and has `recordClass?`, which 109 refuses on a terms read | `TriplesTermsQuery` keeps `subject?`, `predicate?` (with `objects`), `object?` (with `predicates`); no `recordClass`, no `limit`. **Contract change**, recorded in 111, 027 and 394 | Drop the fixed positions (loses 109's reads) or keep a `recordClass` that is always refused | Correctness (keeps every read 109 ships); one explicit way (no dead field) |
| 2 | phases 1-4 | `IDataset`'s method change breaks every implementer at once, so a phase cannot compile alone | Phases 1-3 checked by the typecheck of their own files (`tsc --pretty false`, filtered); the whole build compiles from phase 4 on | One commit for everything | The plan asks for 5 phases; each commit stays reviewable |
| 3 | phase 1, C-2 | `readFeaturesOf` of an ask: include `ask`, though a dataset without it is still answered | Include it; its doc says `ask` alone is not refused (the `LIMIT 1` fallback) | Leave `ask` out | It says what the read uses natively; `resolveRead` owns the fallback |
| 4 | phase 1, C-2 | `readKindOf` on a plain object with neither `__queryKind` nor a read `kind` | Throw, naming what it got | Treat it as a select | Discriminate on the kind, never structurally (C-2) |
| 5 | phase 2, C-5 | Where a select's feature check runs in `QueryBuilder.exec` (it threw outside the error wrapping) | Keep `assertQuerySupported` before the `try`, then `resolveRead` (which checks again) | Only `resolveRead` inside the `try` | The refusal keeps its own message, unwrapped, as today |
| 6 | phase 2, C-5 | `exec(target)` of a select, count or ask was not observed, unlike graph, triples and mutations | Unchanged: `resolveRead(target ?? dispatch, q)`; triples and terms use `dispatchRead` (observed) | Every builder through `dispatchRead` | Backward compatibility: listeners (the live-query store) see what they saw |
| 7 | phase 2, C-5 | The two per-kind target asserts are removed, but a router checks every dataset before it asks the first | Exported `assertReadSupported(target, query)` for every kind, used by `resolveRead`, `dispatchRead` and `LinkedStorage`. **Contract addition** | Keep the two per-kind asserts | One explicit way, the same check for every kind |
| 8 | phase 3, C-6 | `Transaction.supports` must not list `triples`/`triplesTerms`, so `exec(tx)` of a triples read is refused by the feature check before the transaction's own message | Keep the contract; `Transaction.readQuery` still refuses them with today's messages when called directly | List them so the transaction's message is reached | The contract as written; the refusal names the transaction |
| 9 | phase 3 | `LinkedStorage` used to call `dataset.selectQuery` directly for a select/count | Every routed dataset is sent its read through `resolveRead` (a count is checked there too) | Call `dataset.readQuery` directly | C-3: a router listing `ALL_QUERY_FEATURES` forwards through `resolveRead` |
| 10 | phase 4 | `SparqlDataset`'s per-kind methods: private or protected | Private (`selectRead`, `askRead`, `triplesRead`, `termsRead`); a subclass overrides `readQuery` and calls `super.readQuery` | Protected | The plan says private; one override point |
| 11 | phase 4 | `InMemoryDataset.readQuery` handed a triples or terms read | Rejects with `InMemoryQueryRefusal` | A generic Error | Its existing refusal type for everything it does not answer |
| 12 | phase 5 | Test doubles: one `readQuery` per double across ~40 files | Side-effect-free helper `readQueryOf({select, ask, triples, terms})` and `isSelectRead` (`src/test-helpers/read-double.ts`) | A `switch` in every double | Fewest moving parts; a kind without a handler is refused |
| 13 | phase 5 | Current docs outside the Verify grep (`documentation/*.md`) name the old methods | Updated too | Leave them | Current docs describe the current state |
| 14 | phase 5, Verify | The Verify grep hits the module path `queries/triplesQuery` | Keep the module name; the hits are import paths only | Rename the module | C-4 names `triplesQuery.ts`; a rename breaks every importer for nothing |
| 15 | start | The owner's decisions had to land in three repos' plans before the code | Core's in this worktree (fast-forwarded into the master first); server's and the host app's committed directly in the master worktree (docs only) | Worktrees for server and the host app too | Smallest footprint; no code in those repos |
| 16 | wrapup | The changesets of the unreleased triples reads named methods that no longer exist | Rewrote `triples-reads.md`, `triples-terms-reads.md` and the mention in `sort-and-leaf-path-edges.md`; one new minor `one-read-method.md` | Leave them and explain in the new one | A changelog that names removed methods misleads |

**Notes for wave 2**

- A dataset that implemented `askQuery` declares `'ask'`; a triples-reading one `'triples'`
  (+`'triplesPattern'`); a terms-reading one `'triplesTerms'` + `'triplesPattern'`.
- A `SparqlDataset` subclass that overrode `selectQuery` (the host app's `AppDataFusekiStore`) overrides
  `readQuery` and calls `super.readQuery(query)`.
- `readKindOfJSON` throws on graph kinds, so a `readQuery` endpoint refuses a graph query by
  calling it first.
