---
summary: >
  Graph routing: a read set is computed in one traversal (a delete by id no longer walks every path
  of a `contains` cycle), and the routing of each dataset is kept until a route, a shape
  registration or the data root changes. Same read sets; minor. Closes backlog 070.
packages: [core]
---

# 124 — Graph routing: read-set traversal and a routing cache per dataset

## PR

### Summary

`graphRoutingFor(dataset)` rebuilt the route table and scanned every registered shape on every
read, write, `.into()` check and live-query dependency. A delete by id was also slow at scale:
the shapes that may link to the deleted node were found with a recursive read-set walk that never
kept what it computed below the top level. With 300 shapes that own each other densely, one
delete took about 12 ms. Two changes fix this:

1. **Read sets in one traversal.** A read set is the graphs of every shape reachable through its
   owners. It is now computed with a reached set and kept for every shape. The sets are identical
   to the earlier recursive form, checked against a re-implementation of that form on a cyclic and
   a dense fixture.
2. **One routing object per dataset, kept.** It is rebuilt whole on its next use when:
   - a route is set or unset (one shared version),
   - any shape is registered or re-registered (`getRegistryVersion()`),
   - the dataset's data root changes (still read on every call).

   Owners, read sets and a value-shape → referring-shapes index are kept on it, per shape catalog.
   Read sets are frozen. The documented rule: change a shape, then re-register it. There is no
   invalidate export (decision 31).

### Changes

- `src/utils/graphRouting.ts`:
  - route version: `bumpRoutesVersion()` is called by `setShapeGraphs`, and by
    `unsetShapeGraph` when it removes a route;
  - the per-dataset cache in `graphRoutingFor`;
  - `buildRouting` with per-catalog memos;
  - `ownerIndex` and `referrerIndex`;
  - `referringGraphsForShape` uses the routing's memo, and falls back to a fresh index for a
    routing built elsewhere.
- `src/tests/graph-routing-read-sets.test.ts` (new): read sets and referring graphs equal the
  earlier recursive form, in forward and reverse call order.
- `src/tests/graph-routing-cache.test.ts` (new): the cache's identity and frozen arrays, and that
  it refreshes on:
  - route set and unset (not on a no-op unset), including another dataset's route change;
  - re-registration that adds a `contains` edge;
  - any registration;
  - a data-root change.

  Also: a routing that throws is not kept; a dataset without routes never has its root read;
  catalog separation; a foreign routing.
- `src/tests/routing-cost.bench.test.ts` (new, opt-in: `ROUTING_BENCH=<shape count>`, skipped
  otherwise).
- Docs and release: README "Graph routing" (under Storage configuration);
  `docs/architecture/ontologies.md` Graph routing (the caching paragraph); changeset
  `graph-routing-cache.md` (minor).

### Verification

- `npx tsc -p tsconfig-tests.json --noEmit` → `TSC_OK` (8.4 s).
- The 37 suites that grep `graphRoutingFor|setShapeGraphs|queryDependencies|LinkedStorage`, plus
  the read-set suite (14.6 s):
  `Test Suites: 5 skipped, 32 passed, 32 of 37 total` / `Tests: 66 skipped, 566 passed, 632 total`
  (the skipped suites are Fuseki; there is no Docker here).
- The new suites: `Tests: 14 passed, 14 total`.
- Mutation checks on the new tests:
  - dropping the registry version from the key fails 2 tests;
  - dropping the root from the key fails 1;
  - one memo across catalogs fails the catalog test;
  - no bump on unset fails the unset test;
  - expanding only direct owners fails 4 read-set tests.
- Full regular set after `npm run build` (35 s):
  `Test Suites: 20 skipped, 172 passed, 172 of 192 total` / `Tests: 698 skipped, 3175 passed, 3873 total`.
- Benchmark (`ROUTING_BENCH=300 npx jest routing-cost.bench`, median / p95, µs). "Cold" re-sets one
  route before each delete, so it measures the first delete after a change. The run registers
  308 shapes and 302 routes.

  | scenario | before | after phase 1 (traversal) | after phase 2 (cache) |
  |---|---|---|---|
  | select.for | 359.9 / 702.5 | 330.3 / 708.7 | 199.9 / 327.8 |
  | create (owned cover) | 419.4 / 826.2 | 368.3 / 796.0 | 114.1 / 250.6 |
  | update.for | 385.5 / 800.0 | 570.8 / 1039.5 | 45.8 / 117.6 |
  | delete by id | 12412.1 / 19568.3 | 1959.9 / 4615.7 | 48.6 / 99.3 |
  | delete by id, cold (first after a change) | 12173.2 / 18709.3 | 1643.2 / 4438.5 | 1654.9 / 2942.0 |
  | live deps (select) | 221.4 / 491.1 | 191.7 / 476.5 | 17.8 / 37.9 |
  | live effects (delete) | 158.2 / 299.6 | 172.2 / 328.7 | 5.4 / 8.3 |

  With `ROUTING_BENCH=10` (18 shapes, 12 routes) every scenario is 15–140 µs before and after. Runs
  vary by about ±40% in this container, so the 10-shape gain (roughly 1.2–3×) is indicative only.
  Before: select 118, create 126, update 60, delete 137, cold delete 114, deps 33, effects 18.
  After: select 84–126, create 95–100, update 46–64, delete 57–84, cold delete 126–197, deps 18,
  effects 5–8.

### Deviations

- **The catalog is not part of the cache key; the registry memos are per catalog instead.** The
  plan put the active catalog in the dataset's key. A routing obtained outside a catalog is used
  inside one when a store compiles an IR captured in that catalog, so a key would not stop memos
  from being shared across catalogs. Ledger 1.
- `readGraphsForShape` and `referringGraphsForShape` now return frozen arrays. This was planned
  ("cached read-set arrays are frozen") and is called out in the changeset.

### Follow-ups

None. The known limits are documented where they apply:
- an in-place `NodeShapeData` edit is not seen (README, architecture doc, changeset: the
  re-register rule);
- an older copy of core writing the shared route table does not move the version (architecture
  doc).

## Details

### How a read set is computed now

`readGraphsForShape(s)` is the union, over every shape `x` reachable from `s` through `ownersOf`,
of `x`'s graph and its sub-shapes' graphs. `ownersOf(x)` is the shapes declaring a `contains`
property whose value shape is `x`, a super-shape or a sub-shape of it.

The traversal keeps a `reached` set and a stack. A popped shape whose read set is already known
contributes that set and is not expanded. A known set is always complete, since every computed set
is now complete, and everything reachable from it is reachable from `s`. Every computed set is kept.

The earlier form used a path set (`visiting`) and kept only sets computed with an empty path, so
it walked every simple path: near-exponential with `contains` cycles. It gave the same union,
because every reachable shape lies on some simple path. `graph-routing-read-sets.test.ts` keeps a
copy of it as the reference. That copy is exponential, which is why the dense fixture has only 12
shapes.

### The cache

- `routingCache: WeakMap<dataset, {routesVersion, registryVersion, root, routing}>`.
- `routesVersion` is `globalThis.__linkedGraphRoutesVersion`, next to the shared
  `__linkedGraphRoutes` table, so two copies of the module agree on it.
- A dataset with no routes returns `undefined` before anything is read, as before. Its
  `dataRoot()` is not called and it gets no cache entry.
- A routed dataset's `dataRootOf` is read on every call. It is part of the key. The resolve itself
  still reads it lazily, so the resolve and the key cannot differ within one call.
- `resolvedTable` throws for a route that needs a missing root or names a managed graph. The throw
  happens before `routingCache.set`, so nothing is kept and the next call throws again.
- Inside a routing (`buildRouting`), `memo()` picks the global memo or the active catalog's
  (WeakMap) each time a method runs. Each memo holds:
  - `owners`: value shape → owning shapes, built lazily;
  - `referrers`: value shape → shapes declaring any property with it, minus `storedInGraph`
    classes, built lazily;
  - `readSets`;
  - `referringGraphs`.
- The table is shared across catalogs because routes do not depend on the catalog. `graphForShape`
  is not memoized: it uses the super-shapes of the active catalog.
- `referringGraphsForShape(routing, shape)` calls the routing's own `[REFERRING_GRAPHS]` method (a
  module-private symbol) when there is one. A routing from a store that overrides `graphRouting()`
  gets the uncached form: a fresh referrer index on each call, which matches the earlier scan.

### What does not refresh the cache

- A `NodeShapeData` edited in place (properties added, `contains` or `valueShape` changed) without
  `registerNodeShape` / `registerRuntimeShape`. The other registry caches (`RegistryCache`) have the
  same rule.
- A route written by an older copy of core, which does not call `bumpRoutesVersion`.
- A shape class's `storedInGraph` changed after registration (static in practice).

### Callers (unchanged)

- `SparqlDataset.graphRouting()` (read and write options, `resolveWriteGraph`, `checkOwnedLinks`).
  Up to 3 calls per update by id, and 2 per create or delete.
- `queryDependencies` and `mutationEffects` (`routingForShape`).
- `irToAlgebra`'s delete-by-id referrer cleanup.

### Benchmark

`src/tests/routing-cost.bench.test.ts`:
- Uses the graph-routing fixtures (GRAlbum `'own'`, which `contains` GRPhoto, routed to
  `dataGraph('photos')`) plus `n` synthetic data-only shapes. All of them are routed to 10 data
  graphs.
- Shapes form chains of 5 via `extends`. Each has 4 properties, plus a `contains` on every 3rd
  shape and a link to the photo on every 10th.
- Each scenario gets up to 300 warm-up runs, then 2000 timed runs (200 for the cold delete).
- The store answers everything empty and sends nothing.

### Decision ledger

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 1 | Phase 2, catalog | A routing obtained outside a catalog is used inside one during compile, so a catalog in the dataset's key would still share memos | Registry memos per catalog inside the routing; the key is routes, registry version and root | Catalog in the key (the plan's wording) | Correctness: it enforces "the read-set memo must not be shared across catalogs" for every call order |
| 2 | Phase 2, route version | Version per dataset or one shared | One shared counter on the global | Per-dataset counter | Simplicity; route changes are rare, so a full rebuild costs one cold call |
| 3 ⚠ | Phase 2, frozen arrays | Cached read sets are handed to every caller | Freeze them (and the referring graphs); changeset says to copy before changing | Return a copy per call | Plan; a mutation by one caller would silently poison later reads; nothing in core mutates them (full suite green) |
| 4 | Phase 2, unrouted dataset | A cache lookup reads the root, which an unrouted dataset never read | Return `undefined` before the lookup, with no entry | Cache `undefined` too | Backward compatibility (no new `dataRoot()` calls); unrouted lookups were already cheap |
| 5 | Phase 1, test oracle | The earlier recursive form is exponential on a dense graph | Dense equality fixture of 12 shapes (3 edges each), plus the hand-built cycle | 40 shapes (did not finish within 5 min) | The oracle must finish; 12 shapes with cycles already exercise the memo reuse |
| 6 | Benchmark | Where to keep it | `src/tests/routing-cost.bench.test.ts`, skipped unless `ROUTING_BENCH` is set | A script outside jest | Uses the jest/ts setup as is; one skipped suite in the regular run |

## Addendum — review fixes

An independent review confirmed that the read sets match exactly (8 random cyclic fixtures and a
catalog) and that every input change inside core moves the cache key. Three findings were fixed or
recorded.

- **MEDIUM 1 (regression, fixed).** The routing's own `referringGraphsForShape` answer was carried
  on an enumerable symbol property. A store that overrides `graphRouting()` and wraps the built
  routing (`{...graphRoutingFor(this), readGraphsForShape: …}`, or `Object.create`) copied or
  inherited that symbol. Delete by id and the live check then used the inner read sets, so links
  in a graph the wrapper adds were never cleaned. The answer now lives in a module WeakMap keyed
  by the built routing object itself, so any wrapper is answered from its own
  `readGraphsForShape`. Tests in `graph-routing-cache.test.ts`:
  - spread and `Object.create` wrappers;
  - a delete by id through a store whose wrapper adds a graph to a referrer's read set.

  Both fail with the earlier symbol.
- **LOW 1 (decision 33, fixed).** `SparqlDataset.resolveWriteGraph` put the frozen, shared read set
  into `ir.writeGraphs`. The IR now gets a copy, so hooks that sort or push work as before. The
  frozen arrays stay internal to the routing and to direct callers. The changeset is reworded to
  match. A test checks that `writeGraphs` is not frozen, and that pushing to it leaves the
  routing's read set unchanged; it fails without the copy.
- **LOW 2 (pre-existing, recorded).** A mutation lowered in a shape catalog takes its write graphs
  from the global registry's read sets, because `LinkedStorage` sends it outside any catalog. A
  probe (catalog-only `Owner contains Item`, update and delete of an `Item` by id) produced the
  same SPARQL on 0981f9a, before this work, as with the cache: `WITH <…/g/item>`, without the
  owner's graph. So the cache did not introduce it. Recorded as backlog
  [115](../backlog/115-catalog-write-graphs-from-global-read-sets.md).

Verification of the fix round:
- `npx tsc -p tsconfig-tests.json --noEmit` → `TSC_OK`.
- The 37 routing / live-query / LinkedStorage suites:
  `Test Suites: 5 skipped, 32 passed, 32 of 37 total` / `Tests: 66 skipped, 569 passed, 635 total`.
- Full set after `npm run build`:
  `Test Suites: 20 skipped, 172 passed, 172 of 192 total` / `Tests: 698 skipped, 3178 passed, 3876 total`.

The Details section above describes the symbol mechanism that this addendum replaces.
`referringGraphsForShape` now looks the routing up in `builtReferringGraphs`.
