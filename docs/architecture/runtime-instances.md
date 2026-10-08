---
summary: Why @_linked/core must be a single module instance per runtime, the state it holds, how the two runtimes communicate across a serialization boundary, and the dev guardrail against duplication.
---

# Runtime instances and the cross-runtime contract

`@_linked/core` holds **module-level state**:

- the **shape registry** (`nodeShapeToShapeClass`, `utils/ShapeClass.ts`) — NodeShape URI → Shape class,
- **`LinkedStorage`** (`utils/LinkedStorage.ts`) — query dispatch / dataset routing,
- the **query context** (`queries/QueryContext.ts`) — the current user/context references,
- the **query dispatch listeners** (`queries/queryDispatch.ts`, `subscribeQueryDispatch`) — observers of every query that runs,
- the **live-query store** (`live/LiveQueryStore.ts`, registered through `live/registry.ts`) — templates, instances and cached results of every live query, plus its subscriptions to the dispatch, the query context and dataset change feeds.

The dispatch, its listeners, the routing table (with its `onRoutingChanged` listeners) and
the live-query store are `globalThis`-backed (`__linkedQueryDispatch`,
`__linkedStorageRouting`, `__linkedLiveQueryStore`). The query context map and its
listeners are still module-level: under an accidental double evaluation a live query can
miss a `setQueryContext` made through the other copy.

## Single instance per runtime

Within one JavaScript runtime, core must be **one module instance**. Two copies split
the registry and storage — a shape registered on copy A is invisible to a query
dispatched on copy B ("No query dispatch configured"). Keeping core single-instance is
the build's responsibility (see `@_linked/cli` → `docs/architecture/vite-runtime-config`).

Critical process-wide state is additionally **`globalThis`-backed** (e.g.
`LinkedStorage.getLoadedInstanceCount`), so an accidental double-evaluation shares state
rather than silently forking it.

## Two runtimes, one contract

An app runs in two runtimes — the **browser** and the **Node backend** — each with its
own core instance. They are separate by design (normal client/server) and never share
objects, only **serialized data**. Two things cross that boundary (three, with live queries):

- **Shape identity.** A shape's URI is `getNodeShapeUri(packageName, ShapeClass.name)`.
  The client and backend independently register the same shapes and must arrive at the
  **same URI** — that is how a query forwarded from the browser
  (`/call/<pkg>/<Shape>/<method>`) resolves to the right provider on the backend.
- **Change events.** A `ChangeEvent` — a mutation's DSL-JSON plus its result, or
  precomputed `MutationEffects` — is plain data. A server forwards it to clients through
  a dataset's `subscribeChanges` feed or the app's own transport (`publishChange`); each
  client computes which of its live queries to refetch.
- **Shape data.** `JSONWriter`/`JSONParser` (in `@_linked/server-utils`) serialize shape
  values across the boundary. Only **plain data** (query results / `{id}`) should cross —
  a live `Shape` instance serializes to a bare `{__s, u}` reference with no field data
  (see `agents.md`: never construct live Shape instances; use `select`/`create`/`update`
  or plain data).

## Dev guardrail

Because shape URIs embed `ShapeClass.name`, a bundler that duplicates a framework
package renames the copies (`Person`→`Person2`) and registers a shape under a mangled
URI. `addNodeShapeToShapeClass` warns once (dev-only) when a numerically-suffixed URI
registers alongside its base with the same `targetClass` — surfacing a build-config
regression loudly instead of a silent query no-op at forward time.
