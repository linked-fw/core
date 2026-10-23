---
summary: Why @_linked/core must be a single module instance per runtime, the state it holds, shape catalogs (a synchronous scope over the shape registry, captured by builders and IRs), how the two runtimes communicate across a serialization boundary, and the dev guardrail against duplication.
---

# Runtime instances and the cross-runtime contract

`@_linked/core` holds **module-level state**:

- the **shape registry** (`nodeShapeRegistry` and `nodeShapeToShapeClass`, `utils/ShapeClass.ts`) — NodeShape URI → metadata, and → Shape class for authored shapes — plus the **active shape catalog** (see [Shape catalogs](#shape-catalogs)),
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

Framework code that discovers and imports package modules at runtime (stores, ontology register
modules) loads them through the host's module loader (`importPackageModule`), never a bare
`import()`, so in dev a package Vite bundles is not loaded a second time by Node: see
[Loading package modules](./loading-package-modules.md).

Critical process-wide state is additionally **`globalThis`-backed** (e.g.
`LinkedStorage.getLoadedInstanceCount`), so an accidental double-evaluation shares state
rather than silently forking it.

## Shape catalogs

The registry is process-wide and last-wins: one IRI has one definition. A host that serves
several projects, or several branches of one, holds the same shape IRI with different
properties at once, so it cannot register them. A **`ShapeCatalog`** (`utils/ShapeCatalog.ts`)
is an immutable set of shapes that queries resolve against instead.

```ts
const catalog = ShapeCatalog.from(wires, {name: `${projectId}#${branch}`});
const rows = await withShapeCatalog(catalog, () => SelectBuilder.from(personIri).select(['name']));
```

- **The scope is synchronous.** `withShapeCatalog(catalog, fn)` sets
  `globalThis.__linkedShapeRegistry.activeCatalog` for the duration of `fn` and restores it in
  `finally`; `undefined` means the global registry (it never inherits an outer catalog). It
  works the same in the browser and in Node, with no AsyncLocalStorage, and two copies of core
  see one scope. A promise returned by `fn` runs on outside the scope; outside production
  `withShapeCatalog` says so once when `fn` returns a `Promise` (a builder is not one).
- **Every registry accessor reads the active catalog** (`getNodeShape`, `getAllNodeShapes`,
  `getShapeClass`, `getSuperShapes`, `getSubShapes`, `getTargetClassId`,
  `getShapesForTargetClass`, `findPropertyShapeById`, …), else the global registry: one shared
  read and a null check. Inside a catalog `getAllNodeShapes()` is exactly the catalog's shapes
  plus core's built-ins (`Shape`, `NodeShape`, `PropertyShape`, `List`, `PathNode`,
  `PathList`, `PropertyGroup`, `OntologySync`), always from core's code, as classes. `syncShapes` writes the built-ins into a
  dataset like any package's shapes, but a catalog ignores those rows: the metamodel's cascades
  and routing pins never depend on how a catalog was read or which core version synced it.
  `getShapeClass` knows only the built-ins. A catalog is exhaustive and never falls back to the
  global registry.
- **The catalog's data wins** (built-ins aside). A class whose IRI the catalog holds (an app's compiled `Person`
  for a project's `Person`) resolves to the catalog's shape inside the scope.
- **Builders, field sets and IRs capture their catalog.** A builder made inside a scope keeps
  the active catalog when its root is an IRI or a shape the catalog holds; one made from an
  authored class the catalog does not hold keeps none, so host code run inside a project scope
  still lowers its own shapes globally. An adapter class built by a catalog brings that catalog
  along wherever it is used. `clone`, `forAll`, `toCount` and `exists` carry the catalog; the
  IR records it as a non-enumerable `catalog` field (`catalogOf(x)` reads either).
- **Re-entry.** Most registry reads happen long after the builder is made: at lowering, at
  compile (`SparqlDataset` compiles a mutation after an `await`), in the live store. Every
  place core picks a query up re-enters `withShapeCatalog(catalogOf(x), …)`: the builders'
  `toJSON`, `toRawInput`, `fields`, `_lowerSpec` and `selectAll`, `FieldSet`'s resolving
  methods, `lower`, every `*ToAlgebra` and `*ToSparql`, `collectOwnedLinks`,
  `queryDependencies`, `mutationEffects`, `LinkedStorage`'s routing, and the live store
  (template keys, local mutations, change decoding, matching). Re-entry wraps core's own
  registry reads, never a call into an `IDataset`: `LinkedStorage` resolves only the route
  inside the catalog and calls the dataset with no catalog active, even from inside an outer
  scope. A router's own queries therefore never run inside a project's catalog. An IR without
  its `catalog` field (built by hand, or a spread copy) compiles in the active catalog.
- **The wire never carries a catalog.** DSL-JSON stays IRIs only; each side supplies its own
  (`fromJSON(json, {catalog})`, where an explicit `undefined` is the global registry).
- **Caches are per catalog.** Every registry-derived cache (`RegistryCache`) keeps one map for
  the global registry, keyed on its version as before, and one per catalog in a `WeakMap` on
  the catalog object. A catalog is immutable, so its maps need no version; a reload makes a new
  catalog. Adapters are per (catalog, IRI). Warn-once sets stay global.
- **Writes throw inside a scope** (`registerNodeShape`, `registerRuntimeShape(s)`,
  `addNodeShapeToShapeClass`). `syncShapes` enumerates the global classes and must run outside
  any scope.
- **Live queries.** A template's key is `<shapeCatalogKey(catalog)>|<template JSON>` (the bare
  JSON for the global registry), so one query in two catalogs is two templates. A change is
  decoded once per catalog among the templates; one that does not resolve in a catalog (its
  shape is not there) leaves that catalog's templates alone. A local mutation refetches only
  the templates of the catalog it was made in (the global ones when made outside any).

## Two runtimes, one contract

An app runs in two runtimes — the **browser** and the **Node backend** — each with its
own core instance. They are separate by design (normal client/server) and never share
objects, only **serialized data**. Two things cross that boundary (three, with live queries):

- **Shape identity.** A shape's URI is `getNodeShapeUri(packageName, ShapeClass.name)`.
  The client and backend independently register the same shapes and must arrive at the
  **same URI** — that is how a query forwarded from the browser
  (`/call/<pkg>/<Shape>/<method>`) resolves to the right provider on the backend.
  IRIs derived from it, such as a generated single-owner shape at
  `<shape URI>/<accessor>.singleOwner` ([owned-values](owned-values.md)), inherit that
  stability; generated shapes are only written to the store and never registered.
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
