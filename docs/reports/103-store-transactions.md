---
date: 2026-11-01
summary: >
  Store transactions: `LinkedStorage.begin()` / `transaction(fn)` bind to a store at the first
  query, every later query carries the txId (`query.txId`, `txId` on DSL-JSON 1.5), the store
  holds the transaction (`'transactions'` in `supports`, `beginTransaction`/`commit`/`rollback`).
  A store without support warns once and runs directly; a second store warns. New
  `InMemoryDataset` holds transactions for real. Minor. Closes backlog 090.
packages: [core]
---

# 103 — Store transactions

## PR

### Summary

Every DSL write was its own request, so a multi-step write (delete the old config, create the new
one) could stop halfway. Core now has store transactions, as the owner decided in backlog 090
(closed into this report, see Details).

```ts
const tx = LinkedStorage.begin();             // nothing is sent yet
await AppConfig.delete(oldId).exec(tx);       // routed to store X: X.beginTransaction() → t1
await AppConfig.create(cfg).exec(tx);         // sent at once, with t1
const c = await AppConfig.select().exec(tx);  // X answers with t1's own writes
await tx.commit();                            // X.commit(t1)

await LinkedStorage.transaction(async (tx) => { … });  // commit on return, rollback on a throw
```

- **API:** `LinkedStorage.begin(): Transaction`, `LinkedStorage.transaction(fn)`; `Transaction`
  (`commit()`, `rollback()`, `state`, `failedWith`), `TransactionEndedError`; `inTransaction`,
  `txIdOf`; `QueryFeature` gains `'transactions'`, which `ALL_QUERY_FEATURES` leaves out (a
  separate `DatasetFeature` type broke the host app's `AppDataRouter`, which narrows `supports` to
  `QueryFeature`).
- **Store protocol (`IDataset`):** `supports` may list `'transactions'`; `beginTransaction():
  Promise<string>`, `commit(txId)`, `rollback(txId)`; the txId on every query as `query.txId`.
  Expiry is the store's own (documented on `IDataset`).
- **Unsupported store** (`SparqlDataset`, so Fuseki): one warning per store per process, "[linked]
  store X does not support transactions; these writes are not atomic. …", and the queries run
  directly. Nothing is emulated in SPARQL.
- **A second store** gets its own transaction, with a warning that the stores together are not
  atomic; `commit()` commits them in order (a partial commit throws, state `'failed'`).
- **Wire:** DSL-JSON 1.4 → **1.5** (minor; 1.4 was report 102's triples reads): `txId` on every query envelope. `fromJSON()` returns the query
  with its txId; a builder's own static `fromJSON` refuses an envelope with one.
- **Checks:** a query carrying a txId is refused before it is sent to a dataset that does not
  declare `'transactions'` (`assertQuerySupported`, now also on `LinkedStorage`'s create, update
  and delete, and on `CreateBuilder`/`UpdateBuilder.exec(target)`).
- **`InMemoryDataset`** (`@_linked/core/memory/InMemoryDataset`): snapshot at begin, swap at commit
  (refused when the store was written since; a transaction that only read commits as a no-op),
  drop at rollback, expiry after **30 seconds idle** (`transactionTimeoutMs`, reset by every
  query). It answers a subset (creates, updates/upserts and deletes by id, delete all, shapeless
  delete; selects/counts/asks of one shape with its own properties and a simple where) and
  refuses the rest with `InMemoryQueryRefusal`.
- **Live queries** hear of a transaction's writes at commit (the transaction declares
  `authoritativeChanges`; `notifyCommittedWrites` reports them with the store as target).
- Docs: README "Transactions", `documentation/dsl-json.md` "Transactions (`txId`)".

### Choices the owner asked to settle

1. `exec(tx)` on a supporting store resolves when the store has applied the write inside the
   transaction (its method resolves after it changed the transaction's data).
2. `update().for(id)` on a missing node inside a transaction behaves as outside it: nothing is
   written, it resolves with the fields it was given, and outside production it warns.
3. A second `commit()`, a query on an ended transaction, and `rollback()` after a commit throw
   `TransactionEndedError` (branded). A `rollback()` of a rolled back transaction is a no-op, so a
   `catch` that rolls back never hides the error that ended it.
4. Nested `begin()` is refused: `tx.begin()` and `tx.transaction()` throw. Core has no async
   context (as with shape catalogs), so a `LinkedStorage.begin()` elsewhere is its own transaction;
   pass `tx` on.

Further choices: a failed (or refused) query fails the transaction (rolled back in every store,
error passed on), except an unresolved query context (a select's "not ready"), which does not run;
`transaction(fn)` rejects when a query failed and `fn` returned anyway; a shapeless ask or delete
in a transaction needs LinkedStorage to know one dataset; graph queries and triples reads do not
run in a transaction; dispatch listeners see a transaction's write twice (at exec with the
transaction as target, at commit with the store).

### Verification

- `src/tests/transactions.test.ts`: 27 tests: commit, rollback, a throw, a failed query, expiry
  (fake timers: 30 s default, reset per query), a second store, the unsupported-store warning
  (once per store), the four settled choices, the wire round trip through a forwarder that sends
  DSL-JSON, live notification at commit.
- Core's whole suite (`npm test`, jest then `tsc -p tsconfig-tests.json`), exit 0:
  ```
  Test Suites: 19 skipped, 150 passed, 150 of 169 total
  Tests:       590 skipped, 2746 passed, 3336 total
  [fuseki] live tests: 470 total — 0 passed, 0 failed, 470 skipped
  ```
  (after the rebase onto report 102's triples reads; no Fuseki of this run's own, so the live tests skip)
- `npx linked build`: `✔ Build successful`.
- The host app's main checkout `npm run typecheck:gate`, after landing and `npx linked build` there:
  `No new type errors. 0 pre-existing errors still in the baseline.` (The first landing reported
  `src/data/AppDataRouter.ts: TS2345: Argument of type 'DatasetFeature' is not assignable to
  parameter of type 'QueryFeature'`; fixed in core by making `'transactions'` a `QueryFeature`.)

### Deviations from the brief

- No backlog items in `@_linked/server` or the host app: the owner moved their forwarding to the next step;
  the contract is below.
- There was no in-memory dataset in core, so `InMemoryDataset` is new, with a deliberate subset.
- `RemoteDataset` is unchanged: a query's `toJSON()` already carries `txId`, so it forwards it;
  it declares no `'transactions'` yet, so today a transaction through it warns and runs directly.

### Forwarding contract (the next step)

- **Envelope:** the txId is the top-level `"txId"` string of the query's DSL-JSON (`v` "1.5"), on
  select, count, ask, create, update, upsert and delete envelopes; never on graph or triples
  envelopes. No header. `query.toJSON()` includes it; decode with core's `fromJSON()` (the result
  has `query.txId`); never strip it, never use a builder's own `fromJSON` (it throws).
- **`RemoteDataset`:** keep posting `{args: [query.toJSON()]}` (the txId rides inside). Add
  `beginTransaction()` → `POST {url}/call/@_linked/server/beginTransaction` with `{args: []}`,
  answering the txId string; `commit(txId)` → `…/commit` with `{args: [txId]}`; `rollback(txId)` →
  `…/rollback` with `{args: [txId]}`; never retried. Declare `'transactions'` in `supports` only
  when the server answers them (decide from `ping`), so an old server is never sent a txId.
- **Server `/call` handler and the host app's gateway:** pass through `beginTransaction`, `commit(txId)`,
  `rollback(txId)` to the store the transaction's queries route to, plus every query with its
  txId (`fromJSON()` → `LinkedStorage.xQuery(query)` or the routed store, which receives
  `query.txId`). Check rights per query as today. Bind a txId to its caller and refuse it from
  anyone else.
- **`supports` on a forwarder whose child has no support:** do not list `'transactions'` (list
  only what the child answers); core then warns once and runs the writes directly. A forwarder
  must never accept a txId and run the query outside the transaction.
- **Errors to pass back:** a query with a txId to a child without support → refused before it is
  sent (core's `assertQuerySupported` message, "does not declare 'transactions'"); an unknown or
  expired txId on a query or commit → reject (`InMemoryDataset`: "transaction X is unknown or
  expired"); a commit the store cannot apply → reject, the store rolls back; `rollback` of an
  unknown txId → resolve (no-op). Pass the store's message and status through as for any failed
  query; the client rolls the transaction back on any rejected query.

### Follow-ups

- Conditions (`.when(...)` on a write, `tx.require(select…exists())`) for compare-and-set (the host app's
  lease locks, `storeLocks.ts`, `forkClaims.ts`): later, in the IR, independent of any engine.
- Logos: transactions as short-lived branches, merged at commit (recorded in Logos's repo).
- Forwarding in `@_linked/server` and the host app's gateway: the next step (contract above).
- `lowerMutationJSON` (JSON straight to IR) carries no txId: a receiver that uses it runs the write
  outside the transaction; receivers use `fromJSON()`.

## Details

### Backlog 090 (closed here)

Source: The host app's review of its multi-step writes (owner decisions, 2026-10-31). The host app's cases:
`writeActivation` (delete the old app config, then create the new one), `commitImport`,
`ensureSingleUserWorkspace`, `createApplication`, `setMembership` and other delete-then-create
pairs. Decided: no dataset is named; the transaction object holds only `{store → txId}`, the store
holds the transaction; a store declares support in `IDataset.supports`; queries are sent at once;
unsupported stores warn once and run directly; a second store gets its own transaction with a
warning; abandoned transactions expire in the store; the in-memory store implements it for real;
`transaction(fn)` as the convenient form. The host app keeps running on Fuseki for now, so its call
sites gain the code shape but not atomicity until a store with support is behind them.

### How the txId reaches the store

The transaction hands the store a **transaction view** of the query (`inTransaction`): an object
whose prototype is the query, with an own `txId` and a `toJSON()` that adds it. Methods, getters,
brands and the captured catalog are the query's own; the caller's query is unchanged. Chosen over
a field on six builders (more code, same effect) and a second argument on every `IDataset` method
(every store and router would change).

### Review

An independent review found, and iteration 1 fixed: `transaction(fn)` resolved after a failed
query that `fn` caught; `exec(target)` of a create or update did not check the target; a partial
commit did not report what committed, and did not roll back the refusing store; an unresolved
context failed the transaction while answering `null`; the in-memory conflict check was coarser
than needed; a txId on a graph envelope; a second concurrent `rollback()` threw; `process`
unguarded in the browser; the double report to listeners undocumented. Kept: the names
`commit`/`rollback` on `IDataset` (the owner's).
