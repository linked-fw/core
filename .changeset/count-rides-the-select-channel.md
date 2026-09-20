---
'@_linked/core': minor
---

Carry a root `COUNT` over the `selectQuery` channel, and remove `IDataset.countQuery`.

A count was modelled on an ask and given a method of its own. That was wrong, and it
made the feature unusable outside a store held directly. An ask really is a distinct
SPARQL query form (`ASK WHERE { … }`) and earns its own method; a count is
`SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { … }` — a select with an aggregate
projection, lowered by `countToAlgebra` calling `selectToAlgebra` and swapping the
projection, sent over the same transport, answered with the same result-set response.

Because it had its own method, every router had to grow an arm for it — and
`LinkedStorage` never did: `setDefaultDataset` registered select/ask/create/update/
delete, so `.count()` rejected with "does not implement `IDataset.countQuery`" on every
path that went through the router, which is every path in an application.
`@_linked/server`'s backend API store could not implement the handler either, having
no `LinkedStorage.countQuery` to call. Only the tests that held a `SparqlDataset`
directly passed.

- `SparqlDataset.selectQuery` now branches on the lowered IR (`kind === 'count'`,
  as `updateQuery` and `deleteQuery` already branch on theirs) and emits the aggregate.
  It is overloaded: a `SelectQuery` answers `SelectResult`, a `CountQuery` answers
  `number`. The select path is untouched, and `countToAlgebra` and the lowering are
  unchanged.
- `IDataset.selectQuery` and `QueryDispatch.selectQuery` accept
  `SelectQuery | CountQuery` and may answer `SelectResult | number`. Existing
  implementations stay valid with no edit (a narrower parameter and a narrower return
  type both remain assignable), and every router that already forwards a select now
  forwards a count for free — `LinkedStorage` needed no new method at all.
- **`IDataset.countQuery` and `SparqlDataset.countQuery` are removed.** A caller who
  held a SPARQL store and called `store.countQuery(query)` calls
  `store.selectQuery(query)` with the same query instead. The optional interface
  member could not be usefully implemented by anyone: a store that implemented it was
  never reached, because no router forwarded to it.
- The count contract is unchanged and still enforced in one place, now at the select
  dispatch in `resolveCount`: the answer must be a finite, non-negative integer, never
  coerced, and a failure always rejects. A store that ignores the count and answers
  with rows is refused by that same check rather than having its array measured — `0`
  is a plausible count, and one that came from a broken query renders an empty table
  indistinguishable from real data.

Minor rather than major: the only removed surface that ever worked is
`SparqlDataset.countQuery`, reachable only by a caller holding a SPARQL store
directly, released one version ago, and replaced by a call with the same argument.
Nothing that went through `LinkedStorage` can break, because nothing there worked.
