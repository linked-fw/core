---
summary: >
  Transactions as a store feature: `LinkedStorage.begin()` binds to a store at its first query and
  opens a transaction there; every later query carries the txId; `commit()`/`rollback()`. A store
  without support warns once and runs the writes directly. Logos implements it with branches;
  Fuseki gets no support.
packages: [core]
---

# 090 — Store transactions (begin / commit)

Source: Create Now's review of its multi-step writes (owner decisions, 2026-10-31). Proposal with
the call sites: CN session scratchpad `transactions-proposal.md`; the call sites are listed below.

## Why

Every DSL write is its own request, so a multi-step write can stop halfway. Create Now's cases:
`writeActivation` (delete the old app config, then create the new one: a failed create leaves the
app without a config), `commitImport` (instances written, provenance not: undo can never find them),
`ensureSingleUserWorkspace` (a workspace without an owner), `createApplication`, `setMembership`
and other delete-then-create pairs.

## Design (decided)

```ts
const tx = LinkedStorage.begin();             // nothing is sent yet
await AppConfig.delete(oldId).exec(tx);       // first query: routing picks store X,
                                              //   X.beginTransaction() returns txId t1
await AppConfig.create(cfg).exec(tx);         // sent at once, with t1
const c = await AppConfig.select().exec(tx);  // the store answers with t1's own writes
await tx.commit();                            // X.commit(t1); a thrown error: X.rollback(t1)
```

- **No dataset is named.** The transaction object binds to a store when shape routing first sends
  a query of the transaction there.
- **Who holds what.** The transaction object lives wherever the DSL runs (browser, Node, CLI) and
  holds only `{store → txId}`. The dataset store holds the transaction itself (pending changes,
  commit, rollback, expiry). Every layer in between (`RemoteDataset`, CN's backend and gateway)
  forwards the txId with each query and checks rights per query as today; a refused query fails
  the transaction and rolls it back. No backend is required.
- **A store declares support** in `IDataset.supports` and implements `beginTransaction`,
  `commit(txId)`, `rollback(txId)`, plus the txId on every query. Queries are sent immediately;
  nothing is buffered on the client.
- **A store without support** (Fuseki, any plain SPARQL store) warns once, loudly ("store X does
  not support transactions; these writes are not atomic"), and the writes run directly. Core does
  not emulate transactions in SPARQL (no graph clones, no staging graphs).
- **A second store in one transaction** gets its own transaction, with a warning that the two
  together are not atomic.
- **Abandoned transactions** expire in the store after a timeout and are rolled back.
- **The in-memory store** implements it for real (snapshot, swap on commit), so the protocol is
  testable in core.
- `transaction(async tx => …)` as the convenient form: commit on return, rollback on a throw.

## Open

- The txId on the DSL-JSON wire and through `RemoteDataset`; the expiry default.
- Conditions (`.when(...)` on a write, `tx.require(select…exists())`) for compare-and-set (CN's
  lease locks, `storeLocks.ts`, `forkClaims.ts`): later, defined in the IR independently of any
  engine.
- Logos: transactions as short-lived branches, merged at commit. Recorded in Logos's own repo.
- Create Now keeps running on Fuseki for now, so its call sites gain the code shape (`begin` /
  `commit`) but not atomicity until a store with support is behind them.
