---
summary: >
  Master plan: every read method of IDataset (selectQuery, askQuery, triplesQuery,
  triplesTermsQuery) becomes one method, readQuery<Q extends ReadQuery>(q): Promise<ReadResult<Q>>,
  dispatched by the query's kind, with ask, triples and terms support declared as query
  features; graphQuery (a write) stays its own method. One read endpoint on the /call wire (readQuery) in @_linked/server and CN's gateway;
  DSL-JSON 1.10. Steps across core, server, CN and the repos with test doubles; waves, report
  numbers, release order.
status: Plan
---

# 111 One read method (`IDataset.readQuery`)

Master plan. It holds the contracts, the core step in full, the satellite step, the waves, the
status table and the release order. The other repos' steps are in their sub-plans, which repeat
the contracts verbatim:

- `@_linked/server`: `packages-local/_linked-server/docs/plans/027-one-read-method.md`
- Create Now: `docs/plans/394-one-read-method.md` (CN root)

## Owner decision (the input)

Collapse all read methods of `IDataset` into one method, `readQuery`.

- Today: `selectQuery(SelectQuery | CountQuery)`, `askQuery?`, `graphQuery`, `triplesQuery?`,
  `triplesTermsQuery?` (the last added in report 109; it never shipped).
- After: `readQuery<Q extends ReadQuery>(q: Q): Promise<ReadResult<Q>>`, with
  `ReadQuery = SelectQuery | CountQuery | AskQuery | GraphQuery | TriplesQuery` (and the terms
  read, below). Result per kind: select → `SelectResult`, count → `number`, ask → `boolean`,
  graph → `GraphResult`, triples → `Triple[]`, terms read → `string[]`.
- Optional support (ask, triples, terms) becomes declared query features, not optional methods.
- `selectQuery` is renamed: no alias, no legacy. Writes (`createQuery`, `updateQuery`,
  `deleteQuery`) and the other members (`init`, `dataRoot`, `supports`, transactions,
  `replaceDefaultGraphTerms`, `subscribeChanges`, `authoritativeChanges`) are out of scope.
- The builder API stays: `TriplesBuilder.exec()` / `.exists()` / `.whichExist()`, `AskBuilder`,
  `CountBuilder`, the select builders, the graph statics.
- The ask fallback (`resolveExistence`: an ask on a store without ask support runs as a select
  with `LIMIT 1`) keeps working, through the features.
- Ships as a **minor** (the owner's semver rule). Release order: core, then dependants, then CN.

**Owner decisions on the open questions (2026-11-01):** (1) `graphQuery` stays a separate
method: graph kinds are writes, so `readQuery` covers select, count, ask, triples and terms only,
there is no `'graph'` feature and graph detection stays as it is; (2) `LinkedStorage`'s read
statics collapse into `LinkedStorage.readQuery`; (3) no legacy endpoints or aliases; (4) the
server's `readQuery` refuses triples and terms reads (S1). The contracts below apply them; the
bullets above are the original input.

## What the code says today (found, not assumed)

- Published `@_linked/core` 2.45.0 (DSL-JSON 1.1) has `selectQuery`, `askQuery?`, `graphQuery`.
  `triplesQuery?` (report 093) and `triplesTermsQuery?` (report 109) and DSL-JSON 1.2-1.9 are on
  `dev` only (89 commits ahead of `main`). So the terms read and its wire form can change freely.
- Live queries carry `__queryKind` (`'select' | 'count' | 'ask'`). Graph and triples queries are
  plain data with `kind` (`'graph_create' | 'graph_replace' | 'graph_patch' | 'graph_drop'`,
  `'triples'`); a terms read is a `kind: 'triples'` with `objects` or `predicates`, so today it
  has **no discriminant of its own**.
- **Every `GraphQuery` kind is a write.** `AppDataRouter.graphQuery` forks the branch and fires
  `onWrite`; the server and the gateway authorize it under the `graph` rule; `Transaction`
  refuses it. See open question 1.
- The wire names the method: `POST /call/@_linked/server/<selectQuery|askQuery|graphQuery|…>`
  (`@_linked/server` `backend.ts`, `RemoteDataset.call`) and
  `POST /gateway/call/@_linked/server/<…|triplesQuery|triplesTermsQuery>` (CN
  `appGatewayRoutes.ts`, `GATEWAY_QUERY_METHODS`). The server has no triples endpoint;
  `RemoteDataset` has no `triplesQuery`.
- Graph support is detected by method presence in three places
  (`shapes/syncShapeGraphs.ts:147`, `shapes/syncTargets.ts:476`, `ontology/syncOntologies.ts:278`)
  and in `resolveGraphQuery`; it stays so (graph queries keep their own method).
- `instrumentDispatch` casts an `IDataset` to `QueryDispatch` (`queryDispatch.ts`), so the
  dispatch interface must have the same read method as `IDataset`.

### Implementers and callers

| Repo | Production implementers | Test doubles / fakes | Wire |
|---|---|---|---|
| core | `SparqlDataset`, `InMemoryDataset`, `Transaction`, the dispatch `LinkedStorage.setDefaultDataset` installs, `instrumentDispatch`'s wrapper; plus the `TransactionRouter` `LinkedStorage.begin()` builds (5 + 1) | `test-helpers/memory-graph-store.ts`, `query-capture-store.ts`, `test-utils.ts` (`FusekiStore.ts` inherits `SparqlDataset`); inline doubles in 31 test files | none |
| server | `RemoteDataset` (1) | inline doubles in 10 test files | `backend.ts` `selectQuery`/`askQuery`/`graphQuery` callables; `RemoteDataset.call` |
| fuseki | `FusekiStore` (inherits `SparqlDataset`, no override) | `FusekiStore.graphs.test.ts` | none |
| react | none | `src/tests/fixtures.ts`, `react-component-behavior.test.tsx`, `native-barrel.test.tsx` (3) | none |
| shape-ui | none | `src/catalog.test.ts` (1) | none |
| cli | none | `defaults/app-react-native/apps/mobile/__tests__/nativeDefaults.test.tsx` (1, a template shipped to apps) | none |
| auth | none | none (2 test URLs name `/gateway/call/@_linked/server/selectQuery`) | none |
| server-utils | none (`Lincd_API_Client.selectQuery` is the legacy `/api/select` client, not an `IDataset`) | none | comments name `LinkedStorage.graphQuery` |
| CN | `AppDataRouter` (+ its `toAppOrFallbackTo` view and `gatewayRouter` `TransactionRouter`), `WorkspaceCnRouter`, `DraftsRouter`, `AppDataFusekiStore`, `OntologyFileStore`, `ExecutionGateway` (+ its `childRouter`) (6 + 3) | inline doubles in 22 unit test files, `scripts/probes/data-routing-logic.ts` | `appGatewayRoutes.ts`; 16 integration specs post to the method paths |

No other installed `@_linked/*` package implements `IDataset` (every `node_modules/@_linked/*` is a
`packages-local/` checkout or a CN workspace member; translation, s3, npm, sentry, dcat, owl,
rdfs, schema and the rest have no read method).

## Contracts

Provider: core, unless noted. Consumers: every step. Items marked *open* wait on the owner.

### C-1 `IDataset.readQuery`

```ts
// src/interfaces/IDataset.ts — replaces selectQuery, askQuery?, triplesQuery?, triplesTermsQuery?
readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>>;
graphQuery(query: GraphQuery): Promise<GraphResult>; // unchanged: graph kinds are writes
```

Required. Every dataset answers `select` and `count` (the baseline, as `selectQuery` did). A kind
beyond the baseline is sent only to a dataset that declares its feature (C-3); a dataset handed a
kind it does not handle rejects. Must reject on failure; an unreachable store is never an empty
answer, `false` or `0`. **`graphQuery` stays a method of its own** (owner decision 1): every
`GraphQuery` kind writes a graph and its record, routers fork and fire `onWrite` for it, and
transactions refuse it, so it is not a read.

### C-2 Types and helpers (new module `src/queries/readQuery.ts`, export path `@_linked/core/queries/readQuery`)

```ts
export type ReadQuery =
  | SelectQuery | CountQuery | AskQuery      // live (closed) queries, by __queryKind
  | TriplesQuery | TriplesTermsQuery;        // plain data, by kind

export type ReadKind = 'select' | 'count' | 'ask' | 'triples' | 'triples_terms';

export type ReadResult<Q extends ReadQuery> =
  Q extends {readonly __queryKind: 'count'} ? number :
  Q extends {readonly __queryKind: 'ask'} ? boolean :
  Q extends {readonly __queryKind: 'select'} ? SelectResult :
  Q extends {kind: 'triples_terms'} ? string[] :
  Q extends {kind: 'triples'} ? Triple[] :
  never;

/** The kind of a read: `__queryKind` of a live query, else `kind`. Throws on a mutation or a graph query. */
export function readKindOf(query: ReadQuery): ReadKind;
/** The same for a wire body (DSL-JSON `op`, absent = select; plain-data `kind`). Throws on a mutation envelope, a graph kind or an unknown kind. */
export function readKindOfJSON(json: unknown): ReadKind;
/** The features a read needs (C-3): a select's/count's own (featuresOf), plus the kind's. */
export function readFeaturesOf(query: ReadQuery): QueryFeature[];
```

Discriminate on `__queryKind` / `kind`, never structurally: `SelectQuery` and `CountQuery` overlap
structurally. Re-export the types and `readKindOf` from `src/index.ts`.

### C-3 Query features (`src/queries/queryFeatures.ts`)

```ts
export type QueryFeature =
  | 'groupBy' | 'min' | 'max' | 'shapelessDelete' | 'triplesPattern' | 'transactions'
  | 'ask' | 'triples' | 'triplesTerms';   // new
```

| Feature | Declared by a dataset that… | Without it |
|---|---|---|
| `ask` | answers an `AskQuery` natively | the dispatch sends the ask's pattern as a select of ids with `LIMIT 1` (`true` when a row comes back); a shapeless ask is refused — today's `resolveExistence`, unchanged |
| `triples` | answers a triples read (graph, subject read) | refused, as `resolveTriples` refuses a store without `triplesQuery` |
| `triplesPattern` | (unchanged) also answers a triples read that fixes the predicate or the object | refused |
| `triplesTerms` | answers a terms read (C-4) | refused |

- There is **no `'graph'` feature**: graph support stays detected as today (a `graphQuery`
  method, and `unsupported-query-kind` from one that refuses).
- `ALL_QUERY_FEATURES` gains `ask`, `triples`, `triplesTerms` (it stays "what a SPARQL store
  supports"; `transactions` stays out). `SparqlDataset` keeps `supports = ALL_QUERY_FEATURES`.
- `InMemoryDataset.supports` becomes `['shapelessDelete', 'transactions', 'ask']` (no triples).
- A router lists what it forwards and checks each target itself (as today). A router that lists
  `ALL_QUERY_FEATURES` must forward through `resolveRead` (C-5), never `child.readQuery(q)`
  directly, so a child without `ask` still gets the fallback and a child without `triples` is
  refused with the right error.
- `parseRequires` knows the new names (they are in `ALL_QUERY_FEATURES`); no query writes them
  into `requires`, since the kind carries them.

### C-4 The terms read gets its own kind (DSL-JSON 1.10)

```ts
// src/queries/triplesQuery.ts
export interface TriplesQuery {          // loses `objects` and `predicates`
  kind: 'triples';
  subject?: string; predicate?: string; object?: string;
  graphs?: string[]; limit?: number; recordClass?: string;
}
export interface TriplesTermsQuery {     // new; exactly one of objects / predicates
  kind: 'triples_terms';
  subject?: string;                      // the fixed positions, as in 109 (contract change, C1)
  predicate?: string;                    // with objects
  object?: string;                       // with predicates
  objects?: string[];
  predicates?: string[];
  graphs?: string[];                     // required with predicates unless the subject is fixed, optional with objects (as in 109)
}                                        // no limit, no recordClass (109 refuses both on a terms read)
export function parseTriplesQuery(json: unknown): TriplesQuery;           // refuses objects/predicates
export function parseTriplesTermsQuery(json: unknown): TriplesTermsQuery; // new
export function isTriplesTermsQuery(query: unknown): query is TriplesTermsQuery;
// triplesTermsPosition / triplesTermsOf take a TriplesTermsQuery; triplesQueryFeatures covers 'triples' (+ 'triplesPattern')
```

`TriplesBuilder.toNode([…]).whichExist()` / `withPredicate([…]).whichExist()` build a
`TriplesTermsQuery`; the answer stays a `Set<string>` of the list's own IRIs (the dispatch keeps
only the list's own, as today). Per-400-term chunking in `SparqlDataset` is unchanged.

### C-5 Dispatch (`src/queries/queryDispatch.ts`)

```ts
export interface QueryDispatch {
  readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>>; // replaces selectQuery, askQuery, triplesQuery?, triplesTermsQuery?
  graphQuery?(query: GraphQuery): Promise<GraphResult>;             // unchanged
  createQuery<R = any>(query: CreateQuery): Promise<R>;
  updateQuery<R = any>(query: UpdateQuery): Promise<R>;
  deleteQuery(query: DeleteQuery): Promise<DeleteResponse>;
  readonly supports?: readonly QueryFeature[];
}

/** The one way to send a read to a target (dataset, router, dispatch): feature check, the ask fallback, answer checks. */
export function resolveRead<Q extends ReadQuery>(target: ReadTarget, query: Q): Promise<ReadResult<Q>>;
/** Send a read through an explicit target (observed like the global path) or the global dispatch. */
export function dispatchRead<Q extends ReadQuery>(query: Q, target?: IDataset): Promise<ReadResult<Q>>;
export type ReadTarget = Pick<IDataset, 'readQuery' | 'supports'>;
/** Refuse, before it is sent, a read the target does not declare (any kind); a router checks every dataset with it before it asks the first. (Contract addition, C1.) */
export function assertReadSupported(target: {readonly supports?: readonly QueryFeature[]} | undefined | null, query: ReadQuery): void;
```

`TriplesBuilder` gains `toTriplesTermsQuery()` (a terms read's plain data); its
`toTriplesQuery()` throws for a terms read. *(Contract addition, C1.)*

`resolveRead` keeps every check the per-kind helpers make today: select → `assertQuerySupported`
(features, txId); count → a non-negative integer or reject; ask → `ask` declared: a real boolean
or reject, else the `LIMIT 1` fallback (shapeless refused); triples → `triples` (+`triplesPattern`)
declared, an array or reject; terms → `triplesTerms` declared, an array of IRIs, filtered to the
list's own.

**Removed** (no alias): `resolveExistence`, `resolveCount`, `resolveTriples`, `resolveTriplesTerms`,
`dispatchTriplesQuery`, `dispatchTriplesTermsQuery`, `assertTriplesTarget`,
`assertTriplesTermsTarget`. **Kept:** `resolveGraphQuery`, `dispatchGraphQuery` (graph queries are
not reads), `assertQuerySupported` (CN's gateway uses it). `QueryDispatchEvent.kind` values stay
as today (`'select'` for a select and a count, `'ask'`, `'graph'`, `'triples'`, `'triplesTerms'`,
plus the writes): listeners are unaffected.

### C-6 `LinkedStorage`, `Transaction`

- `LinkedStorage.readQuery<Q extends ReadQuery>(q: Q): Promise<ReadResult<Q>>` replaces the
  statics `selectQuery`, `askQuery`, `triplesQuery`, `triplesTermsQuery` (owner decision 2). It
  routes per kind exactly as the four do today (select/count/ask by shape, a shapeless ask across
  the datasets with the fan-out notice, triples and terms as today, every one outside the shape
  catalog where it is today). `LinkedStorage.graphQuery` and the write statics stay.
- `Transaction.readQuery` runs select, count and ask in the transaction; triples and terms reads
  are refused with today's messages ("does not run in a transaction"). `Transaction.graphQuery`
  refuses as today. `Transaction.supports` does not list `triples`, `triplesTerms`.
- `TransactionRouter` (`utils/Transaction.ts`): `readQuery(query: SelectQuery | CountQuery | AskQuery)`
  replaces `selectQuery` and `askQuery`. CN's `AppDataRouter.gatewayRouter` and
  `ExecutionGateway.childRouter` implement it.

### C-7 The wire (providers: server S1, CN N1; consumer: `RemoteDataset`)

- One read endpoint: `POST /call/@_linked/server/readQuery` with `{"args": [json]}`, on
  `@_linked/server`'s provider (`@callable('public')`) and on CN's gateway
  (`/gateway/call/@_linked/server/readQuery`). `json` is the query's wire form: DSL-JSON for
  select, count and ask (`op`; absent = select), plain data for triples and terms (`kind`). The
  receiver decodes with `readKindOfJSON` and then `fromJSON` / `parseTriplesQuery` /
  `parseTriplesTermsQuery`. A graph query posted to `readQuery` is refused (400).
- **`graphQuery` stays its own endpoint** on the server and the gateway, unchanged.
- Removed endpoints (owner decision 3, no legacy): `selectQuery`, `askQuery` (server and gateway),
  `triplesQuery`, `triplesTermsQuery` (gateway). Writes, `graphQuery`, `ping`,
  `beginTransaction`, `commit`, `rollback` and `rawQuery` are unchanged.
- Authorization is by the decoded kind, never the endpoint: select and count under the `select`
  operation, ask under `ask`, triples and terms under `triples` (gateway only). Graph queries are
  authorized on `graphQuery` as today. Refusal codes and statuses are unchanged; the endpoint
  name in error messages becomes `readQuery`.
- The server's `readQuery` refuses `triples` and `triples_terms` with 400 (it has no triples
  reads today; owner decision 4 leaves that to S1). `RemoteDataset.supports` is `['ask']`, plus
  `'transactions'` once `ping` lists it; it does not claim `triples`/`triplesTerms` or the select
  features (it declares none of those today either).
- DSL-JSON **1.10** (`WIRE_VERSION = '1.10'`): "a terms read is `kind: 'triples_terms'` (a
  `kind: 'triples'` with `objects` or `predicates` is refused); every read goes to `readQuery`."
  `assertWireVersion` compares majors only, so 1.10 needs no other change.

### C-8 Not changed

Builders and their results (`exec()`, `.exists()`, `.whichExist()`, `NamedGraph.readContent`,
the graph statics, `Shape.select`/`.count`/`.exists`); the writes; **`IDataset.graphQuery`,
`QueryDispatch.graphQuery`, `LinkedStorage.graphQuery`, `resolveGraphQuery`, `dispatchGraphQuery`
and graph detection** (`syncShapeGraphs`, `syncTargets`, `syncOntologies` keep checking for a
`graphQuery` method); `IDataset`'s other members; `GraphQuery`/`GraphResult`/`Triple`/`SelectResult`
shapes; `Lincd_API_Client` and the server's `/api/select` legacy path.

## Decisions taken in this plan (reversible by the owner)

- A terms read gets its own kind, `'triples_terms'` (C-4): `ReadResult` needs a discriminant to
  type `string[]` against `Triple[]`, and the form never shipped.
- The per-kind `resolve*`/`dispatch*` helpers fold into `resolveRead`/`dispatchRead` (C-5): one
  explicit way.
- ~~Graph support becomes the feature `'graph'`~~: withdrawn by owner decision 1 (`graphQuery`
  stays its own method, graph detection unchanged).

## Rules for every step

- **Where the steps land: a master worktree.** `npx linked branch start one-read-method --worktree
  --with core,server,fuseki,react,shape-ui,cli,auth,server-utils` from CN's main checkout (target
  `dev`). Steps land in `../wt/one-read-method`; the owner's checkouts stay on `dev` and get
  everything at once through `npx linked branch land one-read-method` (`--dry-run` first) after
  the owner approves. That is how the framework changes land together with the CN changes they
  break: core's step alone breaks CN's compile, and only the master's preview sees that state
  until wave 2 lands.
- Step agents: `npx linked worktree add <agent> --from one-read-method --with <pkgs>`, model
  opus; they start at tasks mode from their section; small steps make no plan doc, medium and
  large ones make one under their pre-assigned number and delete it before landing.
- Landing gate per step: the typecheck, the unit tests of the touched files and the tests named in
  the step's Verify, timed and quoted in the report. The full CN regular set runs once per wave.
- `strictNullChecks`; no `as any`, `@ts-ignore` or `@ts-expect-error`. A cast `as ReadResult<Q>`
  inside a `switch (readKindOf(q))` arm is the expected way to answer the generic signature.
- No alias, no legacy method, no compatibility shim for `selectQuery` & co. Grep for the old
  names before landing: `grep -rnwE 'selectQuery|askQuery|triplesQuery|triplesTermsQuery'`
  over the step's repo (source, tests, README, docs/architecture) must show only historical
  reports/plans and unrelated identifiers (`graphQuery` stays a method: owner decision 1).
- Every framework repo with a published change gets a changeset (core minor, server minor, cli
  patch); test-only repos get none.
- Commits and reports never name the AI tooling; code comments never name steps or phases.
- No step is sensitive in the master skill's sense, but S1 and N1 change request authorization
  paths: the master runs an independent read-only review on both.

## Steps

### C1 — core: `readQuery`, features, dispatch, stores (core)

- **Depends on:** nothing.
- **Goal:** `IDataset` has one read method; every core implementer, the dispatch, `LinkedStorage`,
  `Transaction`, the builders and core's tests use it; DSL-JSON 1.10.
- **Scope:** C-1 to C-6 and C-7's DSL-JSON part, in core only. Docs and changesets.
- **Files:**
  - `src/interfaces/IDataset.ts` (the method and its doc: fold the select/count, ask,
    triples, terms docs into one, per kind; `graphQuery` stays).
  - `src/queries/readQuery.ts` (new; the `./*` export covers its subpath), `src/index.ts` (exports).
  - `src/queries/queryFeatures.ts`, `src/queries/queryDispatch.ts`, `src/queries/triplesQuery.ts`,
    `src/queries/wireVersion.ts`, `src/queries/fromJSON.ts` (its two error messages).
  - Builders: `src/queries/QueryBuilder.ts:1130`, `GroupedSelectBuilder.ts:438`,
    `AskBuilder.ts:243`, `CountBuilder.ts:239`, `TriplesBuilder.ts:128,140,158`,
    `src/shapes/NamedGraph.ts:95`.
  - `src/utils/LinkedStorage.ts` (statics, `setDefaultDataset`'s dispatch, `begin()`'s router),
    `src/utils/Transaction.ts`, `src/utils/fanOutNotice.ts` (doc).
  - Stores: `src/sparql/SparqlDataset.ts` (`selectQuery` overloads, `askQuery`, `triplesQuery`,
    `triplesTermsQuery` → one `readQuery` switching on `readKindOf`; keep the per-kind private
    methods; `graphQuery` stays), `src/sparql/resultMapping.ts:867` (message),
    `src/sparql/triplesToSparql.ts` (terms types), `src/memory/InMemoryDataset.ts`.
  - Graph detection (`syncShapeGraphs`, `syncTargets`, `syncOntologies`): unchanged.
  - `src/shapes/Shape.ts:222` (doc).
  - Test helpers: `src/test-helpers/memory-graph-store.ts`, `query-capture-store.ts`,
    `test-utils.ts`.
  - Tests (`src/tests/`): query-dispatch-subscribe, query-builder, sparql-fuseki-coverage,
    live-query-store, shapeless-delete, triples-read, select-group-by, type-probe-count.ts,
    ontology-sync-fuseki, count-wire, ask-wire, dataset-pin-identity, sparql-fuseki,
    shape-graphs-fuseki, graph-routing, transactions, query-features, graph-query,
    graph-query-fuseki, shape-sync-hash, writes-across-graphs-owned, single-owner-constraint,
    change-sources, store-routing, count-through-linkedstorage, exec-target, live-matching,
    graph-routing-fuseki, ontology-sync, hierarchy-probe, graph-routing-nested, shape-graphs,
    writes-across-graphs-paths, shacl-syncshapes, writes-across-graphs,
    reads-across-graphs-paths, core-utils, triples-read-fuseki, fan-out-notice,
    query-error-cause, shape-catalog. New: `read-query.test.ts` (C-2 typing probes and
    `readKindOf`/`readKindOfJSON`, C-3 per-feature refusal and the ask fallback, C-4 parse).
  - `README.md` (the `IDataset` section and the three mentions), `docs/architecture/ontologies.md`.
  - `.changeset/one-read-method.md` (minor, new). Rewrite the unreleased
    `.changeset/triples-reads.md` and `triples-terms-reads.md` (they announce `triplesQuery` and
    `triplesTermsQuery`, which will not exist) and the mention in `sort-and-leaf-path-edges.md`.
- **Pitfalls:**
  - `ReadResult` must discriminate on `__queryKind`/`kind`; a structural `Q extends CountQuery`
    matches selects too. Add a type probe (like `type-probe-count.ts`) per kind.
  - `instrumentDispatch` wraps a target dataset as a `QueryDispatch`; its `readQuery` wrapper
    must route through `resolveRead` and notify with today's event kinds (count as `'select'`).
  - The terms read that `dispatchTriplesTermsQuery` checks on the bare target before wrapping
    ("the observing wrapper has every method, so it would not say which is missing") becomes a
    feature check on the target's own `supports`; keep the target-specific error.
  - `LinkedStorage.readQuery` must keep `outsideShapeCatalog` exactly where each static had it,
    and the pinned-dataset identity (`dataset-pin-identity.test.ts`).
  - `fromJSON` refuses plain-data kinds; add `'triples_terms'` to that refusal.
  - Wire 1.10 means `count-wire`/`ask-wire` envelopes keep their `v`; tests asserting `v: '1.9'`
    move to `'1.10'`.
- **Architecture:** none of CN's `docs/architecture` constrains core's internals; core's
  `docs/architecture/ontologies.md` (graph detection, reading graphs) is updated. CN arch-04
  (storage model), arch-07 (gateway wire) and arch-10 are consumers, updated by N2.
- **Tests (landing gate):** core `npm test` with the live Fuseki suites; the new
  `read-query.test.ts`; `npx tsc -p tsconfig-tests.json`.
- **Verify:**
  - `cd ../wt/one-read-method--c1/packages-local/_linked-core && npx linked build`
  - `FUSEKI_BASE_URL=http://localhost:<free port> FUSEKI_ADMIN_PASSWORD=admin npm test` (unit,
    live Fuseki and typecheck; quote the jest summary and the `[fuseki] live tests` line).
  - `grep -rnwE 'selectQuery|askQuery|triplesQuery|triplesTermsQuery|resolveExistence|resolveCount|resolveTriples|resolveTriplesTerms' src README.md docs/architecture`
    → no hits (`graphQuery` stays, as a method).
- **Done when:** the old read methods and helpers are gone from core, every core test passes,
  report 112 written, changeset in, the C1 plan doc deleted. CN and server do not compile against
  it yet (expected; wave 2).
- **Size:** large, 5 phases (types/features/terms kind; dispatch + builders; LinkedStorage +
  Transaction; stores + helpers; tests, docs, changesets).

### S1 — server: `RemoteDataset.readQuery` and the `readQuery` endpoint (`@_linked/server`)

In full in `packages-local/_linked-server/docs/plans/027-one-read-method.md`. Depends on C1.
Size: medium, 3 phases. Report 028.

### N1 — CN: every source implementer and caller, and the gateway wire (CN)

In full in CN `docs/plans/394-one-read-method.md`: the routers and stores of `src/data/`, the
Execution Gateway package, the gateway route's `readQuery` endpoint, `dataQuery.ts`, and their
unit tests. One step because CN's typecheck (`src/**`) cannot pass with half of them converted.
Depends on C1; rebases on S1 before it lands. Size: large, 4 phases. Report 395.

### N2 — CN: integration specs, probes, architecture docs (CN)

In full in CN `docs/plans/394-one-read-method.md`. Depends on N1 and S1. Size: medium, 2 phases.
Report 396.

### X1 — the test doubles and comments of the other repos (fuseki, react, shape-ui, cli, auth, server-utils)

- **Depends on:** C1.
- **Goal:** no repo of the workspace names a removed read method.
- **Scope:** test doubles implement `readQuery` (a `switch (readKindOf(q))` that answers what the
  double answered and refuses the rest); `supports` lists `ask` where the double had `askQuery`;
  `graphQuery` stays as it is in every double (it remains a method of `IDataset`). Comments
  renamed. No production code changes.
- **Files:**
  - fuseki: `src/shapes/FusekiStore.graphs.test.ts` (check only: its `graphQuery` calls stay).
  - react: `src/tests/fixtures.ts:106,140,183`, `src/tests/react-component-behavior.test.tsx:96,311-318`
    (`LinkedStorage.readQuery`), `src/tests/native-barrel.test.tsx:35`.
  - shape-ui: `src/catalog.test.ts:58,67,91`.
  - cli: `defaults/app-react-native/apps/mobile/__tests__/nativeDefaults.test.tsx:16-18` (a
    template: generated apps run it against the new core) + `.changeset` (patch).
  - auth: `test/issuer-tokens.test.mjs:21`, `test/solid-access-token.test.mjs:27` (the URL fixture
    becomes `…/readQuery`; DPoP `htu` only, no behaviour).
  - server-utils: `src/utils/QueryAccess.ts:48,393,396` (comments: `LinkedStorage.readQuery`).
- **Pitfalls:** react's and shape-ui's doubles keep `graphQuery` and its `unsupportedGraphQuery`
  import. The cli template's test runs in a generated app, against the core that app installs:
  it is exercised by cli's `tests/template/react-native.full.test.ts`.
- **Verify:** in each repo's worktree: react, shape-ui, fuseki, auth `npm test`; server-utils
  `npm test`; cli `npm run test:unit` and `npx jest --config jest.config.cjs tests/template/react-native.full.test.ts`;
  quote the summaries.
  `grep -rnwE 'selectQuery|askQuery|triplesQuery|triplesTermsQuery' src test defaults`
  per repo → only unrelated identifiers.
- **Done when:** every repo's tests pass against the landed C1; reports: fuseki 006, react 006,
  shape-ui 007, cli 047, auth 024, server-utils 008 (one short report each); cli changeset in.
- **Size:** small, 1 phase per repo (no plan doc).

### W — wrap-up (master)

- **Depends on:** all steps.
- **Scope:** the full CN regular set (`npm run test:regular`) and `npm run test:heavy` on the
  master worktree with its own port and dataset; core, server and satellite suites once more;
  a final security-minded review of S1 + N1 (authorization by decoded kind); one report linking
  every repo's report (core report 113); this plan's status set to done; then
  `npx linked branch land one-read-method --dry-run` and, after the owner approves, the land.
- **Size:** small.

## Waves

| Wave | Steps (agents) | Notes |
|---|---|---|
| 1 | C1 | Everything depends on it. After it lands the master's preview CN does not compile (expected). |
| 2 | S1, N1, X1 (3) | Start together from the landed C1; no shared files. Landing order S1 → N1 (N1 rebases on S1, rebuilds the server checkout and relinks) → X1 (any time). No CN regular-set run yet: the integration specs still post to the old endpoints until N2. Gate: core `npm test`, server `npm test`, CN unit tests and typecheck. |
| 3 | N2 (1), then W | N2 converts the integration specs and docs; its landing closes the wave with CN `npm run test:regular`. W closes the plan. |

Critical path: C1 → N1 → N2 → W. N1 and N2 are not split by file into parallel steps on purpose:
CN's `npm run typecheck:gate` covers all of `src/`, so a partial conversion cannot pass its gate.

## Numbers assigned up front

| Repo | Plan docs | Reports |
|---|---|---|
| core | 111 (this master plan), 112 (C1's plan doc, deleted at landing) | 112 (C1), 113 (wrap-up) |
| server | 027 (sub-plan), 028 (S1's plan doc, deleted at landing) | 028 (S1) |
| CN | 394 (sub-plan), 395 / 396 (N1's / N2's plan docs, deleted at landing) | 395 (N1), 396 (N2) |
| fuseki / react / shape-ui / cli / auth / server-utils | none | 006 / 006 / 007 / 047 / 024 / 008 (X1) |

## Release order

Through the release skill, only when the owner asks:

1. **core** minor (`one-read-method`, with the rest of `dev`'s changesets). DSL-JSON 1.10.
2. **server** minor, its `@_linked/core` range raised to the core minor of step 1 (it calls
   `readQuery`). **fuseki**, **react**, **shape-ui**, **auth**, **server-utils**: their test-only
   PRs, after core is on npm (their CI installs core from npm, and the old doubles fail against
   it). **cli** patch (the template test), after core.
3. **CN** last, with the ranges bumped (core, server, cli).

A CN deployed before the server minor, or an app on `@_linked/server` ≤ 3.13 against a new CN
gateway, gets 404 on its reads (open question 3).

## Test strategy

- Impacted: core, server, fuseki, react, shape-ui, cli, auth, server-utils, CN (`src/`,
  `packages/execution-gateway`, `tests/integration`).
- Quick gate per phase: core `npx jest src/tests/<touched>` + `npx tsc -p tsconfig-tests.json`;
  server `npx jest src/tests/<touched>`; CN `npx vitest run <touched>` + `npm run typecheck:gate`,
  then `npm run test:changed -- --tier smoke`.
- Per step before landing: the Verify list of the step.
- Deferred to the wave runs and W: CN `npm run test:regular` (~8.5-30 min) after wave 3's N2,
  `npm run test:heavy` in W; core's live Fuseki suites run in C1's gate because C1 changes
  `SparqlDataset`.
- Command sources: core `package.json` (`test`, `test:fuseki`) and README "Running the tests";
  server `package.json` `test`; CN `package.json` and `tests/README.md`.

## Open questions (owner) — answered 2026-11-01

Answers: 1 keep `graphQuery` separate; 2 collapse the statics; 3 no legacy endpoints; 4 the
server refuses triples/terms (S1). Applied in the contracts above.

1. **`GraphQuery` is a write.** All four kinds write a graph and its record; routers fork and fire
   `onWrite` for it, the wire authorizes it under the `graph` rule, `Transaction` refuses it. The
   plan puts it in `readQuery` as decided (feature `'graph'`, each step handles it in a phase of
   its own); the alternative is to keep `graphQuery` as its own write method and collapse only
   select/count/ask/triples/terms. Which?
2. **`LinkedStorage`'s read statics.** The plan collapses `LinkedStorage.selectQuery/askQuery/
   graphQuery/triplesQuery/triplesTermsQuery` into `LinkedStorage.readQuery` too (callers: the
   server's `backend.ts` and `LincdAPI.ts`, CN's `dataQuery.ts`, tests). `QueryDispatch` must
   change regardless. Keep the statics as they are?
3. **Wire compatibility.** The old endpoints go (no legacy): an app or browser bundle on
   `@_linked/server` ≤ 3.13 gets 404 from a new server or gateway (a graph query reads 404 as
   `unsupported-query-kind`). Fine while every install is local, or keep the old endpoints on the
   server and the gateway for one release?
4. **Triples over the server's `/call`.** The server has no triples endpoint today; its
   `readQuery` refuses triples and terms reads and `RemoteDataset` does not declare them (parity).
   Add them (with a store rule for shapeless reads) as a follow-up?

## Follow-ups (not planned)

- `Terms.of(…).used()`: a dedicated builder for terms reads (owner: optional, later).
- Open question 4, if the owner wants it.

## Status

| Step | Repo | Scope | Depends on | Status | Commits | Report | Notes |
|---|---|---|---|---|---|---|---|
| C1 | core | readQuery, features, dispatch, stores | — | done | `1ffeb58` (docs), `9607362`..`81f3a67`, wrapup | 112 | contract change C-4 (`TriplesTermsQuery` keeps the fixed positions; no `recordClass`/`limit`), additions C-5 (`assertReadSupported`, `toTriplesTermsQuery()`) |
| S1 | server | RemoteDataset + readQuery endpoint | C1 | todo | | 028 | |
| N1 | CN | routers, stores, Execution Gateway, gateway readQuery endpoint, unit tests | C1 (rebase on S1) | todo | | 395 | |
| N2 | CN | integration specs, probes, arch docs, regular set | N1, S1 | todo | | 396 | |
| X1 | fuseki, react, shape-ui, cli, auth, server-utils | test doubles, comments | C1 | todo | | see numbers | |
| W | all | wave runs, review, final report, land | all | todo | | 113 | |

## Starter prompt (template)

> You are the step agent for step `<id>` of the master plan `packages-local/_linked-core/docs/plans/111-one-read-method.md`
> (sub-plan: `<path>`). Read CN's `CLAUDE.md`, the plan's Contracts and Rules, and your step's
> section; start at tasks mode. Work in `npx linked worktree add <agent> --from one-read-method
> --with <pkgs>`; land by rebasing onto `one-read-method` and fast-forwarding in
> `../wt/one-read-method[/packages-local/<dir>]`, then remove your worktree. Your report number is
> `<n>`. Do not redesign: when the code contradicts the plan, stop and report it. Final message:
> under 15 lines — commits, report path, Verify results with timings, deviations, follow-ups.
