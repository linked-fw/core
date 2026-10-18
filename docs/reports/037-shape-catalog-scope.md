---
summary: >
  `ShapeCatalog` and `withShapeCatalog`: queries are built, serialized, lowered, compiled and
  live-tracked against an immutable catalog of shapes without registering it, so one shape IRI
  can mean different shapes in different catalogs at once. The scope is synchronous and lives on
  the shared registry container; builders, field sets and IRs capture their catalog and every
  place core picks a query up later re-enters it. Registry caches are per catalog. An app with
  no catalog runs the same code at the same cost. `syncShapes` now also writes core's six
  built-in shapes; a catalog still resolves them from code. Minor.
packages: [core]
---

# 037 — Shape catalogs: a synchronous scope over the shape registry

Contract: [runtime instances § Shape catalogs](../architecture/runtime-instances.md#shape-catalogs).
User docs: README "Shape catalogs". Consumer: Create Now plan 068 phase 3, which resolves each
project branch's shapes against its own catalog instead of re-registering them process-wide.

## Problem

The registry is process-wide and last-wins. A host that serves several projects, or several
branches of one, holds the same shape IRI with different properties at the same time. Before
this work it had to serialize requests and re-register a project's shapes on every switch, and
the browser registered every project shape it ever saw into one registry.

## What changed

- **`src/utils/ShapeCatalog.ts`** (export path `@_linked/core/utils/ShapeCatalog`, re-exported
  from the root): `ShapeCatalog.from(shapes, {name})`, `get`, `has`, `values`, `size`, `name`;
  `withShapeCatalog(catalog, fn)`, `getActiveShapeCatalog()`, `catalogOf(queryOrIr)`,
  `shapeCatalogKey(catalog)`, `builtInShapeIris()`. Wires convert as `registerRuntimeShape`
  converts them. Core's six built-ins (`Shape`, `NodeShape`, `PropertyShape`, `List`, `PathNode`,
  `PathList`) always come from core's code, as classes; rows for them in the data are ignored
  (review round 1).
- **`syncShapes` writes the six built-ins** (owner decision) like every package's shapes, with
  the same hash skip: the first sync after upgrading writes them once, later syncs only when
  their hash changes — which happens when processes on different core versions sync one
  dataset (each rewrites what its version describes differently). Under
  `orphanScope: 'ownedNamespaces'` core's namespace is never pruned.
  Other shapes declared with core's own `linkedShape` (core's test fixtures) are still skipped,
  and `syncShape` (one shape) still refuses core-package shapes.
- **State:** `globalThis.__linkedShapeRegistry.activeCatalog`. `withShapeCatalog` calls `fn`
  directly when the catalog is already active; otherwise it sets and restores it in `finally`.
- **Accessors** (`ShapeClass.ts`): every read of the metadata map or the class map goes through
  `activeNodeShapes()` / `activeShapeClasses()`, one shared read and a null check. Inside a
  catalog the class map holds the built-ins only, adapters live in a per-catalog map, and the
  query layer's class lookups (`getQueryShapeClass`) return the catalog's constructor for any
  shape it holds. Outside a catalog, `getQueryShapeClass` is `getShapeClass`.
- **Caches:** `RegistryCache` (`utils/registryCache.ts`) holds one map for the global registry,
  keyed on its version as before, and one per catalog in a `WeakMap`. Converted: `subShapesCache`,
  `mostSpecificSubShapesCache`, `childIndex`, `targetClassIndex` (ShapeClass), `propertyShapeCache`
  (nodeShapeData), `declaringShapeCache` (queryDependencies), `predicateTermCache`,
  `blankWalkCache`, `classHoldersCache`, `ownedWalkCache` (irToAlgebra). Adapters: per
  (catalog, IRI). Warn-once sets stay global.
- **Writes throw inside a scope:** `registerNodeShape`, `addNodeShapeToShapeClass`,
  `registerRuntimeShape`, `registerRuntimeShapes`.
- **Capture:** `SelectBuilder`, `AskBuilder`, `CountBuilder`, `CreateBuilder`, `UpdateBuilder`,
  `DeleteBuilder` and `FieldSet` store the catalog at construction (a `catalog` getter, never
  in `toJSON`) and pass it through `clone`, `forAll`, `toCount` and `_toAsk`. A builder keeps the
  active catalog when its root is an IRI or a shape the catalog holds, none for an authored class
  the catalog does not hold, and the building catalog for an adapter class used outside its
  scope. Inside a catalog, `resolveShape` resolves an authored class whose IRI the catalog holds
  to the catalog's shape (the data wins). `Shape.count` goes through `resolveShape` too.
- **Re-entry points** (each checks `catalogOf(x) !== active` and only then opens a scope):
  - builders: `toJSON`, `toRawInput`, `fields`, `selectAll`, `_patternSpec`, `_toAsk`, `toCount`
    (select); `toJSON`, `toRawInput` (ask, count); `toJSON`, `_lowerSpec` (create, update, delete);
  - `FieldSet`: `for`, `all`, `select`, `add`, `set`, `orderBy`, `toJSON`;
  - `lower` (and every IR literal attaches the active catalog as a non-enumerable `catalog`:
    `buildSelectQuery`'s select, the ask and count literals, the seven canonical mutation IRs,
    and the select IRs `askToAlgebra` / `countToAlgebra` derive);
  - the ten `*ToAlgebra` and ten `*ToSparql` exports, from the IR;
  - `collectOwnedLinks`, from the IR;
  - `LinkedStorage`'s routing (`resolveDatasetForQuery`), then the dataset is called in the
    caller's scope;
  - `queryDependencies`, `mutationEffects`;
  - `fromJSON(json, {catalog})` (the key present, even `undefined`, decodes in that catalog);
  - live store: template keys (`templateKeyFor`), `_onDispatch`'s routing lookup, change
    decoding per catalog (`normalizeChange(event, {catalog})`), `selectInstances(…, {catalog})`
    (which expands shapes in the catalog). `splitQuery` re-enters through `toJSON`.
- **Live keys:** `<shapeCatalogKey(catalog)>|<stable template JSON>`; the global registry keeps
  the bare JSON. A change is decoded once for the global registry and once per catalog among
  the templates; a catalog where it does not decode, or (for precomputed effects) that does not
  hold its shape, is left alone. A change that decodes nowhere throws as before.

## Deviations from the plan

- **`exec()` and `then()` open no scope.** The plan lists them as re-entry points, but their
  only registry reads are the routing, the lowering and the error message's `toJSON`, each of
  which re-enters on its own. Wrapping the dispatch would run the dataset inside the query's
  catalog, which decision 34 forbids. The test "a builder built in a scope and awaited outside
  it" checks both: the SPARQL uses the catalog, and the dataset is called with no catalog active.
- **The built-ins are picked by IRI**, the six `https://linked.cm/shape/core/<name>` shapes,
  not by filtering on `packageName === '@_linked/core'`: core's own test fixtures (and any code
  using core's `linkedShape`) carry that package name, and the base `Shape` carries none.
- **Global template keys are unchanged** (no `0|` prefix), so an app without catalogs keys its
  live queries exactly as before.
- **One `WeakMap` per cache** (`RegistryCache`) rather than one record per catalog; the effect
  is the same.
- **Added beyond the contract's list:** `getQueryShapeClass` (the query layer's class lookups —
  `FieldSet`, `PropertyPath`, `SelectQuery`, `MutationSerialization`, `validation` and
  `getLeastSpecificShapeClasses` — would otherwise miss every data-only shape in a catalog);
  adapter classes remember their catalog; `selectAll` re-enters.

## Verification

```
npx linked build            ✔ Build successful
npm test                    Test Suites: 4 skipped, 103 passed, 103 of 107 total
                            Tests:       120 skipped, 2297 passed, 2417 total
```

`src/tests/shape-catalog.test.ts` (27 tests) covers: built-ins from code, with built-in rows in
the data ignored; a live Fuseki round trip (a sync into an empty store writes the six, a second
sync writes nothing, a catalog read back from the store resolves the six from code and drives a
`NodeShape` create); the review round 1 cases below; nesting and
restore; two catalogs with one IRI compiled interleaved; per-catalog adapters; a builder awaited
outside its scope (dataset called outside the catalog); `then()` through `LinkedStorage`;
`forAll`/`limit`/`FieldSet` outside the scope; a create and an update compiled after the
owned-link `await`; the non-enumerable IR field; the `fromJSON` round trip; `type` through the
built-in `Shape`; a `NodeShape` create with an `sh:in` list and a sequence path in a catalog
without core rows; the catalog's own `getAllNodeShapes()`, class holders and blank-walk
predicates unaffected by global shapes; a class-built builder outside the catalog capturing
none; the catalog winning over an authored class; registry writes throwing; live templates per
catalog and a change touching only the catalog it decodes in. `shacl-syncshapes.test.ts` and
`shape-sync-hash.test.ts` now expect the six built-ins in the sync. `live-query-store.test.ts` gained
the key and per-catalog invalidation tests, `owned-walk-recursion.test.ts` the per-catalog walk.

Timing (`src/tests/query-compile-timing.test.ts`, median of 5 × 2000 iterations, six
alternating runs on one machine, best run each; the same file copied into a `main` worktree):

| case | main | change |
|---|---|---|
| select (build + lower + selectToSparql) | 50.82 ms/1000 | 50.98 ms/1000 |
| create (build + lower + createToSparql) | 126.21 ms/1000 | 121.62 ms/1000 |
| select inside a catalog | — | 50.62 ms/1000 |

## Review round 1

Independent review: no high, three medium, six low. All fixed.

- **M1, M2: the built-ins resolve from code, always.** Earlier in this PR a catalog took the built-ins
  from its data when present. With the data winning, `NodeShape` routing flipped between a
  pinned dataset and the default one depending on what the dataset held (`LinkedStorage` finds
  pins through `getShapeClass`, which sees only code built-ins), and the metamodel's cascades
  depended on how faithfully a catalog was read and on the core version that last synced it.
  `ShapeCatalog.from` now adds the six from code first and ignores data rows for them
  (decisions 27, 31); the sync still writes them. Tests: `NodeShape.select()` inside a catalog
  whose data holds a different `NodeShape` row reaches its pin with the same SPARQL as globally;
  a `NodeShape` delete inside such a catalog compiles to the same cascade as in a catalog
  without the rows (property shapes, `sh:in` lists, path nodes).
- **M3: decision 32 for `FieldSet`.** `resolveShapeInput` resolves an authored class (or
  metadata) whose IRI the active catalog holds to the catalog's shape. Test:
  `FieldSet.for(Pet, ['onlyInData'])` inside a catalog with that data-only property.
- **L4: local mutations stay in their catalog.** `_onDispatch` publishes a local mutation's
  effects to its own catalog's templates only (the global ones for a mutation outside any
  catalog). The live test now checks that a create in branch b leaves branch a's count unchanged, and the reverse.
- **L5: decision 34 from inside a scope.** `LinkedStorage` calls the dataset with no catalog
  active (`outsideShapeCatalog`), even when the caller is inside a scope; `withShapeCatalog`
  warns once, outside production, when `fn` returns a `Promise` (not on builders, which are
  thenables by design and the intended return value). Test: a query awaited inside another
  catalog's scope, dataset called with none active, one warning for two calls.
- **L6: IRs without a catalog field.** The `*ToAlgebra` / `*ToSparql` exports and
  `collectOwnedLinks` use `ir.catalog`, else the active catalog. Test: a spread copy of an IR.
- **L7: built-in sync side effects.** Core's namespace is excluded from `ownedNamespaces`
  pruning (test); the one-time write after upgrading and the rewrite under version skew are in
  the changeset and above.
- **L8: cold cost.** `select-cold-catalog` builds a new catalog for every query, so every index,
  adapter and cache fills from empty.
- **L9:** the tests above.

Timing after the round (five alternating runs, best run each; medians in brackets):

| case | main | change |
|---|---|---|
| select | 51.85 (54.34) | 50.60 (55.14) |
| create | 122.02 (128.90) | 127.38 (136.69) |
| select inside a catalog, warm | — | 49.13 (55.60) |
| select inside a new catalog, cold | — | 115.55 (129.41) |

The machine was noisy in this round (one run on each side was 40–80 % slower than the others).
Best-of-run select and create are within 5 % of `main`.

## Follow-ups

- A data-only shape in the **global** registry still resolves nested value shapes through
  `getShapeClass` (authored classes only), as before; only catalogs get the constructor
  fallback. Hosts moving project shapes into catalogs (CN plan 068 phase 3) no longer depend on
  the global path for them. Recorded here; no backlog item, since the global path is kept as is
  on purpose.
