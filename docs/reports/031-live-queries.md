---
summary: Live queries in @_linked/core — a framework-free LiveQueryStore behind `query.live()` that keeps select/count/ask results current by observing every mutation (local through the dispatch, remote through optional dataset change feeds, or app-published) and refetching exactly the instances a change can have affected, using predicate-level dependency analysis from the IR. Additive minor release; @_linked/react 2.0 builds its reactive components and hooks on it.
packages: [core, react]
---

# Live queries (core)

The full cross-repository record, including the React layer, the ideation decisions and the worked matching examples, is `@_linked/react` `docs/reports/001-reactive-components-and-live-queries.md`. This report covers what lives in core.

User documentation: [`documentation/live-queries.md`](../../documentation/live-queries.md) and the README section "Live queries". Release note: `.changeset/live-queries.md` (minor).

## What was built

```ts
const live = Team.select((t) => [t.name, t.members.size()]).for({id: teamId}).live();
const first = await live;                      // first data; the handle stays live
const off = live.subscribe((s) => render(s.data));
live.close();

Team.select().toCount().live((s) => setTotal(s.data));   // listener shorthand; counts and asks too

await Team.update({members: {add: [{id: personId}]}}).for({id: teamId});
// every live query that reads this team's members refetches; unrelated ones do not
```

`await query` and the mutation API are unchanged. Everything is additive.

## Architecture

```
builders ─► getQueryDispatch() (instrumented) ─► LinkedStorage ─► IDataset ──(optional) subscribeChanges
                │ subscribeQueryDispatch                                   │
                ▼                                                          ▼
       mutationEffects(q, result) ──► LiveQueryStore.publish(event, origin) ◄── publishChange / invalidate
                                          │  matcher(selectInstances) over indexes
                                          ▼
                        templates (deps = queryDependencies) / instances (data, ids)
                                          │
                        query.live() → LiveQuery handle (state, subscribe, then, refresh, patch, close)
```

### Files

| File | Responsibility |
|---|---|
| `src/queries/queryDispatch.ts` | `setQueryDispatch` stores an instrumented dispatch; `subscribeQueryDispatch(listener)` gets `{kind, query, result, target?}` for every select/ask/create/update/delete at call time; `resolveMutationDispatch` instruments `exec(target)` too and sets `target`. Listener errors are isolated. |
| `src/queries/queryDependencies.ts` | `queryDependencies(query)` and `mutationEffects(mutation, result?)`, both computed from `lower(query)`. |
| `src/shapes/nodeShapeData.ts` | `findPropertyShapeById` (moved from `sparql/irToAlgebra.ts`, same version-keyed cache). |
| `src/live/registry.ts` | `globalThis.__linkedLiveQueryStore`; `peekLiveQueryStore`, `requireLiveQueryStore` (throws "Live queries are not loaded…"). The builders import only this file. |
| `src/live/keys.ts` | `splitQuery` (template JSON vs instance params: subject, subjects, contextName, where-level contextNames, one, limit, offset), `templateKey`, `paramsKey`, `stableStringify`, `stripSubjects`. |
| `src/live/LiveQueryStore.ts` | The store: templates, instances, indexes, fetching, GC, context re-keying, change sources, `publish`, `invalidate`, the handle; `getLiveQueryStore`, `resetLiveQueryStore`, `publishChange`, `invalidate`. Registers itself on load. |
| `src/live/changes.ts` | `ChangeEvent`, `ChangeOrigin`, `normalizeChange` (mutation JSON → effects via `fromJSON`; effects with array sets revived), `effectsHash`. |
| `src/live/matcher.ts` | `selectInstances(index, effects)`, `isUnbound`, `expandShapes`, `intersects`. |
| `src/live.ts` | `@_linked/core/live` barrel. The root `src/index.ts` imports it (side effect) and re-exports the API. `package.json` `sideEffects` lists the live entry. |
| `src/interfaces/IDataset.ts` | Optional `subscribeChanges(listener)` and `authoritativeChanges`. |
| `src/utils/LinkedStorage.ts` | `onRoutingChanged(listener)`, notified by `setDefaultDataset`, `setDatasetForShapes`, `unsetDatasetForShape`. |
| `src/queries/{QueryBuilder,CountBuilder,AskBuilder}.ts` | `.live(listenerOrOptions?, options?)`. |
| `src/queries/QueryContext.ts` | Query-context listener errors are isolated. |

### Public API added

`subscribeQueryDispatch`, `QueryDispatchEvent`, `QueryDispatchListener`; `queryDependencies`, `mutationEffects`, `QueryDependencies`, `MutationEffects`; `findPropertyShapeById`; `LiveQueryStore`, `getLiveQueryStore`, `resetLiveQueryStore`, `publishChange`, `invalidate`, `LiveQuery`, `LiveState`, `LiveStatus`, `LiveListener`, `LiveQueryOptions`, `LiveQueryStoreOptions`, `ChangeEvent`; `.live()` on the three builders; `IDataset.subscribeChanges?` / `authoritativeChanges?`; `LinkedStorage.onRoutingChanged`.

## Key decisions

- **Store in core, not in a UI binding.** Subscriptions must work outside React (workers, other frameworks, tests) and change sources (dataset feeds, routing) are core concerns. React is a thin `useSyncExternalStore` layer.
- **Observation at the dispatch.** Instrumenting `setQueryDispatch` (and `exec(target)`) catches every mutation without wiring and survives repeated `setDefaultDataset`. Select and ask events are ignored by the store — its own fetches run through the same dispatch.
- **Two tracks: templates and instances.** A template is the subject-less query (canonical DSL-JSON minus subject/subjects/one/limit/offset); it owns the watch set and is what a database could be asked to tune (`templates()`, `prepare()`). An instance is a template applied to params; it owns the data, the ids the result mentions and the listeners. Each instance executes the builder it was subscribed with; the template keeps a subject-stripped builder for dependency analysis only, so `unbound` is decided per instance.
- **Predicates, not property shapes.** IR `property` fields are property-shape ids; both helpers map them to the predicate IRIs written to disk (`pathExpr` → `collectPathUris`, else `findPropertyShapeById(...).path`). An `Employee.update({name})` therefore reaches a `Person.select(p => p.name)` list.
- **Dependency classes.** `narrow` (read on nodes whose ids are in the result, matched by id), `filter` (where, scoped where, minus, exists, sortBy, inner orderBy — matched template-wide), `hidden` (read on nodes whose ids are not projected: `size()`, computed values over traversals — template-wide), `shapes` (root scan, traversed value shapes, declaring shapes of every property read — the IR drops `as()` casts, so the declaring shape is the only trace), `unbound`.
- **Matcher rules.** (1) known ids: instances mentioning an id whose `narrow` reads a written predicate; (2) written predicate in `filter ∪ hidden`: every instance of the template; (3) unknown ids (forAll/where/delete_all/delete_where): every instance of every template reading a written predicate; (4) membership (create/upsert/delete): unbound instances of templates touching the shape or a related one in the class hierarchy, and for a delete every instance of those templates; (5) `reactive: false` templates never refetch. Rules 1–3 are scoped by shape (the written node's shape plus membership shapes, expanded up and down the hierarchy), which keeps a `Team` rename away from a `Person` list sorted on the same `schema:name`. Where the store cannot tell, it refetches.
- **Change events are plain data** (`{mutation, result?}` or `{effects}`), so a server can broadcast what it already has. Events carry an origin (`local`, `feed`, `app`, `manual`); only a remote echo of a local change (or the reverse) within `echoMs` (50 ms) folds into one refetch; two local writes never fold; `invalidate()` never folds. `authoritativeChanges` on a dataset (routed or used as `exec` target) suppresses local effects in favour of the dataset's confirmation.
- **Freshness.** Data stays during refetches (`refreshing`); identical results keep their reference (structural sharing); out-of-order responses are dropped by sequence; an invalidation during a fetch yields one follow-up fetch; refetches are batched per microtask. A storage change resets the cache: unwatched instances are dropped, watched ones refetch.
- **Handles.** `PromiseLike` (first successful data), Svelte-store `subscribe`, `refresh`, `patch` (merge objects, replace arrays/functions; counts as loaded), `close` (detach this handle's listeners; reusable — React StrictMode closes and re-subscribes). A handle re-resolves an instance the store dropped (GC after `gcMs` = 30 s idle, routing change) or moved (query-context re-key). Handles created without a listener hold nothing and are released.
- **Query context.** A subject from `getQueryContext(name)` is an instance param (`contextName`): the instance is `pending` until set, re-keyed when it changes. A context used inside `where` is lifted into `contextNames`; an unset one gives provisional dependencies (shape only) instead of throwing, and a change refetches.
- **Tree-shaking kept.** Builders reach the store through `registry.ts`; a bundle that only builds and forwards DSL-JSON never loads the store or the IR lowering. The package root registers it.

## Tests

| File | Covers |
|---|---|
| `src/tests/query-dispatch-subscribe.test.ts` | Five event kinds, `exec(target)`, listener isolation, repeated `setDefaultDataset`, unsubscribe, no double wrap. |
| `src/tests/query-dependencies.test.ts` | 19 cases: projection, nested, `size()`, computed, where/sortBy, scoped where, relation filters, minus ×3, `as()`, preload, selectAll, count, ask, override predicate identity, inverse path. |
| `src/tests/mutation-effects.test.ts` | 13 cases: literal, add/remove, nested create, create with result ids, upsert, deletes, bulk modes, JSON round trip. |
| `src/tests/live-query-store.test.ts` | Keys, sharing, thenable, notFound, errors, sequencing, structural sharing, refreshing, ids, patch, GC/pinned, context re-key, count/ask, missing storage, registry error, invalidate; plus the review regressions (shared bound/unbound template both orders, limit/one isolation, reopenable close, re-resolve after GC/routing, listener-less handle release, quiet refresh while pending, patch semantics, where-level context). |
| `src/tests/live-matching.test.ts` | Every worked example (clear hits, defensive refetches, non-triggers) against seven live instances; `reactive:false`; manual invalidation. |
| `src/tests/change-sources.test.ts` | Local, `exec(target)`, feed with JSON and with effects, array-set effects, `publishChange`, echo folding, two local writes, double invalidate, authoritative datasets and targets, routing pick-up and feed removal, malformed feed events, rejected mutations, in-flight invalidation. |
| `src/test-helpers/live-fixtures.ts` | Team/Person/Employee with a shared `schema:name`, inverse `teams` path, ids, `predicate()`. |

Final validation: `npm test` → 2073 passed, 120 skipped (Fuseki suites; no Docker in this environment); typecheck clean.

## Architecture docs updated

`docs/architecture/runtime-instances.md`: the module-level state list now includes the dispatch listeners and the live-query store (both `globalThis`-backed, with `__linkedStorageRouting` listeners), notes that the query context is still module-level, and adds change events as plain data that crosses the client/server boundary.

## Known limitations and follow-ups

- `.for(getQueryContext(name))` binds a context reference while the context is unset but a plain subject once it is set (asserted by `count-wire.test.ts`). Live queries handle it; `@_linked/react`'s hook keeps the context-bound builder stable. Changing the wire behaviour is a separate decision.
- The query-context map and listeners are module-level, not `globalThis`-backed (pre-existing).
- Over-fetch is accepted where precision would need data: bulk mutations reach every template reading the predicate within the shape scope; every `id` in a mutation result counts as touched.
- `name` and `reactive` are template-level: two consumers of the same query share them.
- Small cleanups remain: two `id`-walkers (`collectIds`, the effect collector), a wide `@internal` surface on the store.
- Fuseki-backed suites were not run here.
