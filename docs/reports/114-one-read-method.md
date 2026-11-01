---
summary: >
  Master plan 111 done: every read of IDataset (select, count, ask, triples and terms reads) is one
  method, readQuery, dispatched by the query's kind, with ask, triples and terms support declared as
  query features; graphQuery stays its own (write) method. One read endpoint, readQuery, on
  @_linked/server's /call and on CN's app gateway, authorized by the decoded kind; DSL-JSON 1.10.
  Core minor, server minor, cli patch; test doubles of fuseki, react, shape-ui, auth, server-utils;
  CN converted. This report links every step report and holds the master's decision ledger.
packages: [core, server, cli, fuseki, react, shape-ui, auth, server-utils, create-now]
---

# 114 — One read method (`IDataset.readQuery`), master summary

## PR

### Summary

`IDataset` had four read methods (`selectQuery` for selects and counts, `askQuery?`, and the
unreleased `triplesQuery?` / `triplesTermsQuery?`), each with its own dispatch helper, its own
`LinkedStorage` static and its own wire endpoint. They are now one method:

```ts
readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>>;
```

The answer type follows the query's kind (select → `SelectResult`, count → `number`, ask →
`boolean`, triples → `Triple[]`, terms → `string[]`). Optional support is declared through query
features (`ask`, `triples`, `triplesTerms`) instead of optional methods. `graphQuery` stays a method
of its own, because every graph kind writes. No alias and no legacy endpoint remains. The plan ran
as a master worktree (`../wt/one-read-method`) across nine repos in three waves.

### Changes (one report per step)

| Step | Repo | What | Report |
|---|---|---|---|
| C1 | `@_linked/core` | `readQuery`, `ReadQuery`/`ReadKind`/`ReadResult`, `readKindOf`/`readKindOfJSON`, features `ask`/`triples`/`triplesTerms`, `resolveRead`/`dispatchRead`/`assertReadSupported`, `LinkedStorage.readQuery`, `Transaction.readQuery`, terms read as `kind: 'triples_terms'`, DSL-JSON 1.10. Minor. | [core 112](112-one-read-method-core.md) |
| S1 | `@_linked/server` | `RemoteDataset.readQuery` (`supports: ['ask']`, + `transactions` after ping); one `POST /call/@_linked/server/readQuery` endpoint, rule picked by the body's kind before decoding; `selectQuery`/`askQuery` endpoints removed; `/api/select` checks by kind too. Minor. | [server 028](../../../_linked-server/docs/reports/028-one-read-method.md) |
| X1 | fuseki, react, shape-ui, cli, auth, server-utils | Test doubles, fixtures and README examples answer `readQuery`; no production code. cli patch (react-native template test). | [core 113](113-one-read-method-satellites.md), [cli 047](../../../_linked-cli/docs/reports/047-one-read-method-template.md) |
| N1 | Create Now | Routers, stores, Execution Gateway, `dataQuery.ts` answer `readQuery` through `resolveRead`; the app gateway serves one `readQuery` endpoint authorized by the decoded kind; four per-kind endpoints removed (404). Unit tests. | [CN 396](../../../../docs/reports/396-one-read-method.md) |
| gw-m48 | Create Now | Done alongside (CN backlog 393 Q1): the gateway checks the graphs a read covers (lowered IR, else the shape's `defaultReadGraphs`), end-user M48 404 on hidden definition graphs, end-user `graphs.union` 403. | [CN 398](../../../../docs/reports/398-gateway-covered-read-graphs.md) |
| N2 | Create Now | Integration specs and the data-routing probe post to `readQuery`; arch-04 and arch-07 describe the one read method and the covered-graph checks; regular set green. | [CN 397](../../../../docs/reports/397-one-read-method.md) |
| W | all | This report; plans 111, 027 (server) and 394 (CN) removed; EG README and server changeset corrected; cli backlog 017 extended; land into `dev`. | 114 |

Paths are relative to a CN checkout with the packages localized (`packages-local/_linked-*`).

### Verification

Quoted from the step reports (each ran in its own step worktree against the master state):

- core (112), own Fuseki: `Tests: 122 skipped, 3345 passed, 3467 total`;
  `[fuseki] live tests: 493 total — 491 passed, 0 failed, 2 skipped`.
- server (028): `Tests: 2 skipped, 543 passed, 545 total`.
- CN N1 (396): vitest `Tests 2791 passed | 2 skipped (2793)`; execution-gateway
  `Tests: 78 passed, 78 total`.
- CN wave run (397, master state with report 398): Playwright `522 passed`, `19 skipped`, 0 failed,
  0 flaky; vitest `Tests 4097 passed | 5 skipped (4102)`; packages access `68 passed`, documents
  `418 passed`, execution-gateway `78 passed`, maps `9 passed`.
- X1 (113): react, shape-ui, fuseki, auth, server-utils `npm test` and cli unit tests green against
  the landed core (summaries in report 113).
- The old-names grep (`grep -rnwE 'selectQuery|askQuery|triplesQuery|triplesTermsQuery'`) over
  every repo at wrap-up shows only: historical reports, plans, ideas and backlog items; the
  changesets that announce the rename; the module path `queries/triplesQuery`; tests that assert
  the removed endpoints answer 404/501; `Lincd_API_Client.selectQuery` in server-utils (the legacy
  `/api/select` client, not an `IDataset` method); arch-10's quoted historical 501.
- The post-land gate (`npx linked build-all`, `npm run typecheck:gate`,
  `npm run test:changed -- --tier smoke` in the owner's checkout) is in the landing summary.

### Deviations

- Plan 111's W listed `npm run test:heavy` on the master worktree. The master scoped W to the land
  and a post-land smoke run instead; the regular set had already run green on the master state
  (397). The heavy set runs before the release, as CN's CLAUDE.md asks.
- The removed server endpoints answer `501 No provider` (like every unknown `/call` method), not
  404 as the plan said; CN's gateway answers 404. The server changeset said 404 and is corrected.
- Contract change and additions from C1 (`TriplesTermsQuery` keeps the fixed positions, no
  `limit`/`recordClass`; `assertReadSupported`, `ReadTarget`, `TriplesBuilder.toTriplesTermsQuery()`)
  are in report 112 and were applied to every sub-plan before wave 2.
- Two copies of core in step worktrees (397) produced false typecheck and Playwright failures; the
  step fixed its own link farm. Not a code issue: cli backlog 017.

### Follow-ups

- Release, through the release skill, only when the owner asks: core minor, then server minor
  (core range `^2.46.0`), the test-only PRs of fuseki, react, shape-ui, auth, server-utils after
  core is on npm, cli patch with the react-native template's exact core pin (`2.43.0`) moved to the
  new minor, CN last with ranges bumped. Plus `@_linked/rdfs`'s `default-read-graphs` changeset
  (core report 110), already on `dev`.
- Triples and terms reads over the server's `/call`: server backlog 006 (owner decision 4).
- Worktree link farms load two copies of core: cli backlog 017 (extended with this plan's evidence).
- Gateway test gaps from 398's review (refused read in a transaction, `defaultVisibleDefinitionGraphs`
  unit test, workspace member meeting a hidden record, term shapes routed to another store):
  report 398, Follow-ups.
- Third-party datasets that implemented `askQuery` must declare `'ask'` to keep native asks
  (otherwise they get the select `LIMIT 1` fallback): stated in core's changeset.
- `Terms.of(…).used()`, a dedicated builder for terms reads: optional, later (owner).
- Leftover test dataset `cn-wt-n1` and reuse-mode datasets from CN on 4616: reports 396 and 397.

## Details

### The owner's input and decisions

Input: collapse every read method of `IDataset` into `readQuery`; optional support becomes
declared features; no alias, no legacy; the builder API (`exec()`, `.exists()`, `.whichExist()`,
`AskBuilder`, `CountBuilder`, the select builders, the graph statics) unchanged; the ask fallback
keeps working; ships as a minor.

Decisions on the open questions (2026-11-01):

1. `graphQuery` stays a separate method. Every `GraphQuery` kind (`graph_create`, `graph_replace`,
   `graph_patch`, `graph_drop`) writes a graph and its record; `AppDataRouter.graphQuery` forks the
   branch and fires `onWrite`; the wire authorizes it under the `graph` rule; `Transaction` refuses
   it. So `readQuery` covers select, count, ask, triples and terms only, there is no `'graph'`
   feature, and graph detection (`syncShapeGraphs`, `syncTargets`, `syncOntologies`,
   `resolveGraphQuery`) still checks for a `graphQuery` method.
2. `LinkedStorage`'s read statics collapse into `LinkedStorage.readQuery`.
3. No legacy endpoints: an app on `@_linked/server` ≤ 3.13 gets 501 from a new server and 404 from
   a new CN gateway on its reads. Client and server ship together; PGCN redeploys both at once.
4. The server's `readQuery` refuses triples and terms reads (parity with today); backlog 006.

### Contracts as built

**C-1 `IDataset`.** `readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>>` is
required; `graphQuery(query: GraphQuery): Promise<GraphResult>` is unchanged. Every dataset answers
`select` and `count`; a kind beyond that is sent only to a dataset that declares its feature; a
dataset handed a kind it does not handle rejects. An unreachable store rejects, never answers empty,
`false` or `0`.

**C-2 Types and helpers** (`src/queries/readQuery.ts`, `@_linked/core/queries/readQuery`; types and
`readKindOf` re-exported from the root):

```ts
type ReadQuery = SelectQuery | CountQuery | AskQuery | TriplesQuery | TriplesTermsQuery;
type ReadKind = 'select' | 'count' | 'ask' | 'triples' | 'triples_terms';
type ReadResult<Q> = /* by __queryKind ('count' → number, 'ask' → boolean, 'select' → SelectResult),
                        else by kind ('triples_terms' → string[], 'triples' → Triple[]) */;
function readKindOf(query: ReadQuery): ReadKind;      // throws on a write or a graph query
function readKindOfJSON(json: unknown): ReadKind;     // wire body: DSL-JSON op (absent = select) or plain-data kind
function readFeaturesOf(query: ReadQuery): QueryFeature[];
```

Discrimination is on `__queryKind` / `kind`, never structural: `SelectQuery` and `CountQuery`
overlap structurally. Type probes per kind are in `src/tests/read-query.test.ts`.

**C-3 Features.** `QueryFeature` gains `ask`, `triples`, `triplesTerms` (in `ALL_QUERY_FEATURES`;
`transactions` stays out). `SparqlDataset.supports = ALL_QUERY_FEATURES`; `InMemoryDataset.supports
= ['shapelessDelete', 'transactions', 'ask']`; `Transaction.supports` lists every feature except
`triples` and `triplesTerms`; `RemoteDataset.supports = ['ask']` (+ `transactions` after ping).

| Feature | Declared by a dataset that… | Without it |
|---|---|---|
| `ask` | answers an `AskQuery` natively | the ask's pattern runs as a select of ids with `LIMIT 1` (`true` if a row comes back); a shapeless ask is refused |
| `triples` | answers a triples read (graph, subject read) | refused before sending |
| `triplesPattern` | also answers a triples read that fixes the predicate or object | refused |
| `triplesTerms` | answers a terms read | refused |

A router that lists `ALL_QUERY_FEATURES` forwards through `resolveRead`, never `child.readQuery`
directly, so a child without `ask` still gets the fallback and one without `triples` the right
refusal.

**C-4 The terms read has its own kind** (DSL-JSON 1.10). `TriplesQuery` (`kind: 'triples'`;
`subject?`, `predicate?`, `object?`, `graphs?`, `limit?`, `recordClass?`) lost `objects` and
`predicates`; `parseTriplesQuery` refuses them. `TriplesTermsQuery` (`kind: 'triples_terms'`;
exactly one of `objects` / `predicates`, with the fixed positions `subject?`, `predicate?` with
objects, `object?` with predicates, `graphs?`; no `limit`, no `recordClass`).
`parseTriplesTermsQuery`, `isTriplesTermsQuery`, `triplesTermsQueryOf`. `TriplesBuilder.toNode([…])
.whichExist()` / `withPredicate([…]).whichExist()` build a terms read and still answer a
`Set<string>` of the list's own IRIs; `toTriplesTermsQuery()` and `toTriplesQuery()` each refuse the
other kind. `SparqlDataset`'s per-400-term chunking is unchanged. `fromJSON` refuses
`triples_terms` with the other plain-data kinds.

**C-5 Dispatch** (`src/queries/queryDispatch.ts`). `QueryDispatch.readQuery` replaces the per-kind
members; `graphQuery?` stays. `resolveRead(target, query)` is the one way to send a read: select →
`assertQuerySupported` (features, txId); count → a non-negative integer or reject; ask → a real
boolean if `ask` is declared, else the `LIMIT 1` fallback; triples → `triples` (+`triplesPattern`)
declared, an array; terms → `triplesTerms` declared, an array filtered to the list's own.
`dispatchRead(query, target?)` sends through an explicit target (observed like the global path) or
the global dispatch. `assertReadSupported(target, query)` refuses an undeclared read before it is
sent; a router checks every dataset with it before it asks the first. Removed: `resolveExistence`,
`resolveCount`, `resolveTriples`, `resolveTriplesTerms`, `dispatchTriplesQuery`,
`dispatchTriplesTermsQuery`, `assertTriplesTarget`, `assertTriplesTermsTarget`. Kept:
`resolveGraphQuery`, `dispatchGraphQuery`, `assertQuerySupported`. `QueryDispatchEvent.kind` values
are unchanged (a count reports `'select'`), so listeners are unaffected.

**C-6 `LinkedStorage`, `Transaction`.** `LinkedStorage.readQuery` replaces the four statics and
routes each kind as before (select/count/ask by shape; a shapeless ask across the datasets with the
fan-out notice; triples by record class; node and terms reads across every dataset; each outside the
shape catalog where it was), and keeps the pinned-dataset identity. `Transaction.readQuery` runs
select, count and ask in the transaction and refuses triples and terms reads ("does not run in a
transaction"); `Transaction.graphQuery` refuses as before. `TransactionRouter.readQuery` (select,
count, ask) replaces its `selectQuery` / `askQuery`; CN's `AppDataRouter.gatewayRouter` and
`ExecutionGateway.childRouter` implement it.

**C-7 The wire.** One read endpoint, `POST /call/@_linked/server/readQuery` with `{"args": [json]}`,
on `@_linked/server` (`@callable('public')`) and on CN's gateway
(`/gateway/call/@_linked/server/readQuery`). The receiver reads the kind with `readKindOfJSON`
before decoding, then `fromJSON` / `parseTriplesQuery` / `parseTriplesTermsQuery`, and the decoded
query must be of that kind. Authorization is by the decoded kind, never the endpoint: select and
count under `select`, ask under `ask`, triples and terms under `triples` (gateway only). A graph
query, a write or (on the server) a triples or terms read posted to `readQuery` is 400.
`graphQuery`, the writes, `ping`, `beginTransaction`, `commit`, `rollback`, `rawQuery` are
unchanged. Removed: `selectQuery`, `askQuery` (server and gateway), `triplesQuery`,
`triplesTermsQuery` (gateway). `WIRE_VERSION = '1.10'`; `assertWireVersion` compares majors only.

**C-8 Not changed.** Builders and their results, `NamedGraph.readContent`, the graph statics,
`Shape.select`/`.count`/`.exists`, the writes, `graphQuery` everywhere and graph detection,
`IDataset`'s other members, the `GraphQuery`/`GraphResult`/`Triple`/`SelectResult` shapes,
`Lincd_API_Client` and the server's `/api/select` path (which now checks its read by kind too).

### Implementers converted

| Repo | Production implementers | Test doubles |
|---|---|---|
| core | `SparqlDataset` (one switch over private `selectRead`/`askRead`/`triplesRead`/`termsRead`), `InMemoryDataset`, `Transaction`, the dispatch `setDefaultDataset` installs, `instrumentDispatch`'s wrapper, `begin()`'s `TransactionRouter` | `test-helpers/read-double.ts` (`readQueryOf({select, ask, triples, terms})`), memory-graph-store, query-capture-store, test-utils; inline doubles in 31 test files |
| server | `RemoteDataset` | `src/tests/read-double.ts`; 10 test files |
| fuseki | `FusekiStore` (inherits `SparqlDataset`) | none changed |
| react, shape-ui | none | fixtures, component and barrel tests; catalog test |
| cli | none | react-native template's `nativeDefaults.test.tsx` |
| auth, server-utils | none | DPoP URL fixtures and README examples |
| CN | `AppDataRouter` (+ `toAppOrFallbackTo`, `gatewayRouter`), `WorkspaceCnRouter`, `DraftsRouter`, `AppDataFusekiStore`, `OntologyFileStore`, `ExecutionGateway` (+ `childRouter`) | 22 unit test files, `scripts/probes/data-routing-logic.ts`, 16 integration specs |

### Waves as run

| Wave | Steps | Result |
|---|---|---|
| 1 | C1 | Landed; the master's preview CN did not compile until wave 2 (expected). |
| 2 | S1, N1, X1 (+ gw-m48, CN 398) | Landed S1 → N1 (rebased on S1) → X1. Gate: core and server `npm test`, CN unit tests and typecheck. |
| 3 | N2, then W | N2 converted specs and docs; the regular set ran green on the master state (397). W: this report and the land. |

### Two copies of core in worktrees

A master or step worktree's `node_modules` is a link farm. The shape packages localized only in the
main checkout (`@_linked/owl`, `schema`, `rdfs`, `dcat`, `dcmi`, `translation` and 11 more) resolve
`@_linked/core` from the main checkout, the old core with `selectQuery`. In tsc this gave 63
`IDataset` identity errors (0 with a `paths` mapping to the master's core); at runtime, in-process
Playwright specs failed with "dispatch.selectQuery is not a function" and "[linked] 2 copies of
@_linked/core's shape registry have loaded". The step replaced those 17 farm links with copies.
After the land the owner's checkout has one core, so nothing in the code changes. Evidence: CN
report 397, "Two copies of core: the evidence"; cli backlog 017.

### Release order

1. core minor (`one-read-method`, with the rest of `dev`'s changesets); DSL-JSON 1.10.
2. server minor (core `^2.46.0`); fuseki, react, shape-ui, auth, server-utils test-only PRs after
   core is on npm (their CI installs core from npm); cli patch, with the react-native template's
   exact `@_linked/core` pin (`2.43.0` in `apps/mobile`, `packages/app-shapes`, `services/api`)
   moved to the new core minor; `@_linked/rdfs` (`default-read-graphs`, core report 110).
3. CN last, ranges bumped (core, server, cli).

### Numbers used

core: plan 111 (deleted here), reports 112, 113, 114. server: plan 027 (deleted here), report 028,
backlog 006. cli: report 047, backlog 017 (extended). CN: plan 394 (deleted here), reports 396, 397,
398 (395 was taken on `dev`).

### Autonomous decisions

The master ran keep-going; its ledger:

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| 1 | CN 389 addendum | Routing unknown: reads use last-read routes (none if never read) | Gateway keeps it (reads less, never more); term usage reports inData as unknown when routing was never read, instead of a guessed count | Throw a visible error on the page | Correctness: no silent undercount; page stays usable |
| 2 | CN backlog 393 Q1 | Gateway checks DSL-JSON graphs, not the IR's resolved default graphs; no M48 for default term/shape reads | Gateway checks the resolved graphs and applies M48 (side step after readQuery lands, independent review) | Leave as explicit .from(allShapes) did | Safety: access check must see where the read goes |
| 3 | CN backlog 393 Q2 | Collaborator plain term read now 404s when a hidden graph exists | Keep the tightening | Loosen to skip hidden graphs silently | Safety; no caller affected |
| 4 | CN backlog 392 Q1 | Boot pass only covers primary hubs | Cover separate hubs too | Wait for next sync/import | Consistency; inference must hold everywhere |
| 5 | CN backlog 392 Q2 | RDF/RDFS/OWL show as installed ontologies | Group them as "Base vocabularies" (nothing removed) | Hide them | Visible but not noisy; no UI removed |
| 6 | CN backlog 392 Q3 | Removing a direct import of a base package drops its graphs until next sync | Rewrite them right away on removal | Wait for next sync | Correctness: inference never has a gap |
| 7 | CN backlog 390 | Gateway terms cap 10 000 | Keep 10 000 | Lower to 2 000 | schema.org alone has ~1 500 properties; lower cap would break real hubs |
| 8 | release | Push / release | Push and release all repos after the wave lands (owner: "land and then release everything") | — | Owner instruction |
| 9 | plan 111 Q1 | GraphQuery kinds are writes (fork, onWrite, refused in tx) | Keep `graphQuery` a separate method (write side); readQuery = select/count/ask/triples/triples_terms; graph detection stays as it is | Fold into readQuery as feature 'graph' | Correctness: a read path must not write; transactions/onWrite stay right |
| 10 | plan 111 Q2 | LinkedStorage read statics | Collapse into `LinkedStorage.readQuery` | Keep per-kind statics | One explicit way |
| 11 | plan 111 Q3 (owner confirmed A) | No legacy endpoints: apps on server ≤3.13 get 404 from new server/gateway | No legacy; client and server ship together; PGCN redeploys both at once | Keep old endpoints one release | Owner rule "no legacy"; only stale browser tabs affected until reload |
| 12 | plan 111 Q4 | Server readQuery has no triples/terms | Refuse for parity; backlog item in server | Add now | Scope; no caller needs it |
| 13 | plan 111 X1 (owner confirmed) | Six reports for test-double-only repos | One paragraph in core report 113; only cli (publishes) gets report 047 | Report per repo | Less overhead |
| 14 | plan 111 C-4 | Terms read: own kind vs optional field | Own kind `triples_terms` | `terms` field on TriplesQuery | Clear rights check and typing |

Wrap-up decisions (step W):

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| W1 | cli backlog | The two-copies item already exists as cli backlog 017 (seen in side-225 step ct) | Extend 017 with this plan's evidence and the refined cause (main-only localized shape packages) | A new item 018 | No copies: one item per problem |
| W2 | EG README | `packages/execution-gateway/README.md` still named `ExecutionGateway.triplesQuery`, `resolveTriples` and the `selectQuery`/`askQuery` endpoints | Corrected to `readQuery`, `resolveRead`, the `triples` feature and `readQuery`/`graphQuery` | Leave for a later docs pass | Current docs describe the current code |
| W3 | server changeset | It said an older client gets 404; the server answers 501 `No provider` (397) | Corrected to 501, with the gateway's 404 | Leave | The changelog must be right |
| W4 | plans 027, 394 | Sub-plans fully done (progress ticked, steps in 028/396/397, contracts verbatim from 111) | Deleted; their contracts live in this report | Keep as records | Wrap-up rule: plans become reports |
