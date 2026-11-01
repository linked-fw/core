---
status: Implementation
summary: >
  Store transactions as decided in backlog 090: `LinkedStorage.begin()` / `transaction(fn)`, a
  `Transaction` that binds to a store at its first query, the txId on every query and on DSL-JSON
  (1.4), `supports: ['transactions']` with `beginTransaction`/`commit`/`rollback` on `IDataset`,
  a warning for stores without support, and an `InMemoryDataset` that implements it for real.
packages: [core]
---

# 006 — Store transactions

Source: [backlog 090](../backlog/090-store-transactions.md) (design decided by the owner).

## Ideation

The design is settled in backlog 090; what was open is decided here.

### Decision 1 of 8: how the txId reaches the store

- A. A `txId` field on every builder class (six builders, their clones, their JSON).
- B. The transaction hands the store a view of the query: an object whose prototype is the query
  itself, with an own `txId` and a `toJSON()` that adds it. Every method, getter, brand and the
  catalog are the query's own.
- C. A second argument on every `IDataset` method.

**Chosen: B.** One module (`queries/transactionQuery.ts`) instead of six builders; the store reads
`query.txId` (declared on every closed `*Query` interface) and a forwarder reads it in `toJSON()`,
so `RemoteDataset` forwards it without a change. C would change every store and router signature.

### Decision 2 of 8: the txId on the wire

`txId?: string` on every query envelope (select, count, ask, create, update, upsert, delete),
DSL-JSON 1.3 → **1.4** (minor: an older reader ignores an unknown key, and a store that does not
support transactions is never sent one). `fromJSON()` reads it, checks it is a non-empty string,
and returns the transaction view. The builders' own static `fromJSON`s refuse an envelope with a
txId (decode it with `fromJSON()`), so a txId is never dropped silently.

### Decision 3 of 8: what `supports` holds

`IDataset.supports` becomes `readonly DatasetFeature[]`, `DatasetFeature = QueryFeature |
'transactions'`. `'transactions'` is not a `QueryFeature`: `ALL_QUERY_FEATURES` (what a SPARQL
store answers) stays without it, so `SparqlDataset` does not claim it. A query carrying a txId is
refused by `assertQuerySupported` on a dataset that does not declare it, and `LinkedStorage` now
checks every routed create, update and delete there too: a txId is never ignored by a store.

### Decision 4 of 8: failure inside a transaction

As backlog 090 says, a refused query fails the transaction: when any query of a transaction
rejects, the transaction rolls back every store it opened and ends; the error propagates; any
later use throws. `transaction(fn)` also rolls back on any throw from `fn`.

### Decision 5 of 8: the four behaviours the owner asked to settle

- `exec(tx)` on a supporting store resolves when the store has applied the write inside the
  transaction (the store's method resolves after it changed the transaction's working copy).
- `update().for(id)` on a missing node inside a transaction behaves as outside it: nothing is
  written, the call resolves with the fields it was given (outside production a warning says so).
- `commit()` twice, `rollback()` after the end, and any query on an ended transaction throw
  `TransactionEndedError`.
- Nested `begin()` is refused: `tx.begin()` and `tx.transaction()` throw. Core has no async
  context (as with shape catalogs), so a `LinkedStorage.begin()` made elsewhere during a
  transaction is a separate transaction; the README says to pass `tx` on instead.

### Decision 6 of 8: expiry

Idle timeout, reset by every query of the transaction: **30 seconds** in `InMemoryDataset`
(`transactionTimeoutMs`), documented on `IDataset` as the store's own choice. An expired
transaction is rolled back; a query or commit with its txId rejects (`unknown or expired`).
A rollback of an unknown txId is a no-op (a client's rollback after expiry must not throw over the
error that caused it).

### Decision 7 of 8: the in-memory store

There is no in-memory dataset in core; `InMemoryDataset` (`src/memory/InMemoryDataset.ts`) is new.
It keeps nodes as `subject → predicate → values` and answers a deliberate subset: creates (nested
included), updates and upserts by id, deletes by id, selects/counts/asks of one shape (by subject,
with one-step property projections and a simple where of `=`/`!=`/`and`/`or`/`not` on the
subject's own properties). Anything else is refused loudly, never answered partially.
Transactions: `beginTransaction` snapshots the data; the transaction's queries read and write its
copy; `commit` swaps it in if nothing else committed since the snapshot (else it rejects with a
conflict and rolls back); `rollback` drops it.

### Decision 8 of 8: live queries

A write in a transaction is not visible outside it until commit, so the live-query store must not
refetch at exec time. `Transaction.authoritativeChanges = true` (the live store waits), and at
commit the transaction reports each committed write through the dispatch listeners, with the store
as target. A rolled back transaction reports nothing.

## Plan

### Contracts

```ts
// interfaces/IDataset.ts
readonly supports?: readonly DatasetFeature[];
beginTransaction?(): Promise<string>;
commit?(txId: string): Promise<void>;
rollback?(txId: string): Promise<void>;

// utils/LinkedStorage.ts
static begin(): Transaction;
static transaction<T>(fn: (tx: Transaction) => Promise<T> | T): Promise<T>;

// utils/Transaction.ts
class Transaction implements IDataset {
  readonly state: 'open' | 'committed' | 'rolledBack';
  commit(): Promise<void>; rollback(): Promise<void>;
  begin(): never; transaction(): never;
}
class TransactionEndedError extends Error {}
```

### Files

- `src/queries/transactionQuery.ts` (new): `inTransaction(query, txId)`, `txIdOf`, `parseTxId`.
- `src/utils/Transaction.ts` (new): the client side.
- `src/memory/InMemoryDataset.ts` (new).
- `IDataset.ts`, `queryFeatures.ts` (`DatasetFeature`), `queryDispatch.ts` (txId check,
  committed-write notification), `LinkedStorage.ts` (`begin`, `transaction`, checks), `fromJSON.ts`,
  the six builders' static `fromJSON` (refuse a txId), the JSON envelope types and closed query
  interfaces (`txId?`), `wireVersion.ts` (1.4), `index.ts`, README.
- Backlog: `_linked-server/docs/backlog/` (server forwarding), CN `docs/backlog/` (gateway).

### Pitfalls

- Circular import Transaction ↔ LinkedStorage: `Transaction` gets the router functions it needs
  from `LinkedStorage.begin()` instead of importing it.
- A shapeless ask fans out over every dataset; in a transaction it needs exactly one.
- `existenceBySelect` rebuilds a select from an ask's JSON: it must keep the txId.
- Timers must `unref()` so a test or a CLI process can exit.

## Tasks

### Phase 1: protocol, wire and the transaction object
- `DatasetFeature`, `IDataset` members, `txId?` on interfaces and envelopes, wire 1.4.
- `transactionQuery.ts`, `fromJSON` and the builders' refusal, `existenceBySelect`.
- `Transaction`, `LinkedStorage.begin/transaction`, txId checks, warnings, live notification.
- Validation: `npx tsc --noEmit -p tsconfig.json` clean.

### Phase 2: InMemoryDataset
- Data model, create/update/upsert/delete/select/count/ask subset, refusals, transactions, expiry.
- Validation: typecheck clean.

### Phase 3: tests and docs
- `src/tests/transactions.test.ts`: commit, rollback, a throw, expiry, a second store, the warning
  once per unsupported store, the four settled behaviours, the wire round trip, live notification.
- README section; backlog items in server and CN.
- Validation: the new spec, core's whole suite, `npx linked build`.

Dependencies: 1 → 2 → 3 (2 and 3's docs could run beside each other; one agent, so sequential).
