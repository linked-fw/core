---
"@_linked/core": minor
---

Live queries: `query.live()` on select, count and ask builders returns a handle that keeps its result current — subscribe, await the first result, refresh, patch, close — backed by a framework-free `LiveQueryStore` in core (`@_linked/core/live`, registered automatically by the package root).

- Automatic refetching: every local mutation (including `exec(target)`) is observed through the new `subscribeQueryDispatch(listener)`; a dataset may report changes made elsewhere through the optional `IDataset.subscribeChanges(listener)` (and `authoritativeChanges` to defer refetches to its own confirmation); application code can `publishChange(event)`; `invalidate(Shape | iri | {id} | query)` is the manual lever. `LinkedStorage.onRoutingChanged(listener)` lets the store pick up feeds of datasets registered later.
- Two helpers describe what queries read and mutations write in predicate IRIs: `queryDependencies(query)` (`narrow`, `filter`, `hidden`, `shapes`, `unbound`) and `mutationEffects(mutation, result?)` (`op`, `shape`, `props`, `ids?`, `membership`). The matcher uses them to refetch by node id where it can, template-wide where it must, scoped by shape.
- `LinkedStorage.setDefaultDataset` / `setDatasetForShapes` / `unsetDatasetForShape` now notify `onRoutingChanged` listeners; the live store uses this to reset its cache on a storage change. `QueryDispatchEvent` carries the explicit `target` of an `exec(target)` call. Errors thrown by query-context listeners are now isolated (logged, not propagated).
- `findPropertyShapeById` is now exported from `shapes/nodeShapeData` (moved from the SPARQL layer; behaviour unchanged).

All additions are backwards compatible; `await query` and the mutation API are unchanged.
