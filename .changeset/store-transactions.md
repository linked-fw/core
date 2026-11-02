---
'@_linked/core': minor
---

Store transactions. `LinkedStorage.begin()` (or `LinkedStorage.transaction(async (tx) => …)`)
opens a transaction that binds to a store at its first query (`exec(tx)`) and calls the store's
`beginTransaction()`; every later query carries the txId (`query.txId`, and `txId` on DSL-JSON,
now version 1.5) and is sent at once; `tx.commit()` / `tx.rollback()` end it, and a failed query
rolls it back. A store declares `'transactions'` in `IDataset.supports` and implements
`beginTransaction()`, `commit(txId)` and `rollback(txId)`. A store without support
(`SparqlDataset`) warns once and runs the queries directly; a second store in one transaction gets
its own, with a warning that the two are not atomic. A query with a txId is refused by a store
that does not declare support. New `InMemoryDataset` (`@_linked/core/memory/InMemoryDataset`)
holds transactions for real (snapshot, swap on commit, 30 s idle expiry) and answers a subset of
queries. `QueryFeature` gains `'transactions'` (not in `ALL_QUERY_FEATURES`). New exports: `Transaction`,
`TransactionEndedError`, `inTransaction`, `txIdOf`.
