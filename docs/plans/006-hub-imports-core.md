---
summary: >
  Sub-plan of Create Now master plan 282 (shapes and packages per hub) for `@_linked/core` (and,
  for step SY, its `@_linked/server` half): the ontology and shape syncs follow the storage
  routing (K4: every dataset a package's shapes route to, plus the datasets the shape and term
  shapes are pinned to, graphs left behind pruned), the server's boot sync uses it, and a hosted
  app gets a writer flag and a read-only graph content endpoint (K3). Lands on master `hub-imports`.
status: Plan
---

# 006 — Hub imports: core (and step SY)

## Master plan

[CN plan 282](../../../../docs/plans/282-shapes-and-packages-per-hub.md) —
`/Users/rene/web/wt/hub-imports/docs/plans/282-shapes-and-packages-per-hub.md` (decisions D1–D25,
gaps G1–G12, decisions taken by the master M1–M6, rules for every step, status table, numbers,
starter prompt). Steps land on master `hub-imports`
(`/Users/rene/web/wt/hub-imports/packages-local/_linked-core`, branch `hub-imports`). The server
half of SY is in `@_linked/server`'s
[plan 001](../../../_linked-server/docs/plans/001-hub-imports-server.md), which points here.

## Contracts

Copied verbatim from plan 282; the rest are there. A step that changes one updates it here, in
server plan 001 and in 282 in the same landing.

- **K3 Hosted-app writer flag and graph-content endpoint** (provider SY in `@_linked/server`; consumer
  HS; M9): `LINKED_GRAPH_WRITER=app|host` (under `host` the app writes no shape or ontology graph,
  at boot or on request); `POST /admin/graph-content {packages?, reload?}` on the admin channel
  returns, without writing, per package its shapes and ontology graphs and the app's single-owner
  graph, each `{graph, mediaType, text, hash, sources}` (the exact bytes and hash the package-mode
  sync writes); `appGraph` null when the app has none, absent without `DATA_ROOT`; 409 when a graph
  target is not `package`. `/admin/sync-shapes` and `LINKED_SYNC_*_ON_BOOT` stay until HS (M5);
  under `host`, `/admin/sync-shapes` reloads but answers `skipped: 'host-writer'`; `/admin/routes`
  reports `graphWriter`. Exact text in core sub-plan 006 §Contracts.
- **K4 Open-source sync targets** (provider SY in `@_linked/core`; consumer `@_linked/server`'s boot
  sync; M10–M12): `graphSyncTargets()`, `syncShapeGraphsRouted`, `syncOntologiesRouted` in core
  `src/shapes/syncTargets.ts`. A package's graphs go to every dataset any of its shapes route to ∪
  the dataset NodeShape/PropertyShape (and the ontology term shapes) are pinned to (G2); an ontology
  graph also where shapes targeting its classes route; the single-owner graph to the datasets of
  shapes declaring `contains` properties ∪ the NodeShape/PropertyShape dataset. Prune only in the
  app's default dataset (M11). Per-dataset `syncShapeGraphs(ds)`/`syncOntologies(ds)` unchanged.

### K3 in full (accepted by the master, 282 M9)

The code does not fit K3 as worded in two places (see [Pitfalls](#pitfalls), items 1 and 2):

- **An ontology graph's content is N-Triples, not Turtle.** `syncOntologies` writes
  `nTriplesFromTurtle(texts, sources)` of all the package's data files, and its hash
  (`ontologyGraphHash(texts)`) covers the raw file texts, not the written content. Joining several
  Turtle files into one `turtle` field merges equal blank node labels across files. So each graph
  is answered as the content the sync would write plus the hash it would record.
- **A dev app must reload changed source before it computes.** Today only `POST /admin/sync-shapes`
  reloads (`resyncShapes` → `reloadPackageFromDisk`), and HS removes it. A GET that reloads is not
  safe; a POST is.

The full wording (282's K3 summarises it):

> **K3** (provider SY in `@_linked/server`; consumer HS): env `LINKED_GRAPH_WRITER` = `app`
> (default) or `host`; any other value stops the boot, naming the variable. Under `host` the app
> writes no shape or ontology graph: the boot registers ontologies, loads the hierarchy and runs
> the shape check but syncs nothing, and `POST /admin/sync-shapes` reloads and answers
> `{written: 0, skipped: 'host-writer', reloaded, shapes, shapeCheck}`. `GET /admin/routes` adds
> `graphWriter: 'app' | 'host'`. New `POST /admin/graph-content` on the admin channel, body
> `{packages?: string[], reload?: string[]}` (`reload`: the same rule as sync-shapes' `packages`;
> reloaded first, in the same queue and timeout), writes nothing and answers
> `{graphTargets, packages: [{name, shapes?: GraphContent, ontology?: GraphContent}],
> appGraph?: GraphContent | null, withoutTurtle: string[], unreadable: string[], reloaded: string[]}`
> with `GraphContent = {graph, mediaType: 'text/turtle' | 'application/n-triples', text, hash,
> sources: string[]}`: `text` and `hash` are exactly what the `'package'`-mode sync would write
> and record (`shapeGraphHash(text)`, `ontologyGraphHash(raw texts)`), `sources` the record's
> `dcterms:source`. Without `packages`, every registered package with shapes or ontology data.
> `appGraph` is `null` when the app has no single-owner shapes (the host drops the graph) and
> absent without `DATA_ROOT`. When a graph target (`LINKED_SHAPE_GRAPH`, `LINKED_ONTOLOGY_GRAPH`) is
> not `'package'`, it answers 409 naming it. `/admin/sync-shapes` and `LINKED_SYNC_*_ON_BOOT`
> stay until HS (M5).


### K4 in detail (282 M10–M12)

- Module `@_linked/core/shapes/syncTargets` (new): `SHAPE_SHAPE_CLASSES`, `ONTOLOGY_TERM_CLASSES`
  (moved from `@_linked/server/utils/graphTargets`), and `graphSyncTargets(): GraphSyncTargets` =
  `{shapes: Map<pkg, IDataset[]>, ontologies: Map<pkg, IDataset[]>, appShapes: IDataset[],
  datasets: IDataset[]}` (each list without duplicates, the default dataset first, then in pin
  order; `datasets` = `LinkedStorage.getDatasets()`).
- `syncShapeGraphsRouted(options)` and `syncOntologiesRouted(options)` in the same module:
  same options as today minus `ds`, plus `prune?: boolean` (default true) and `targets?` (default
  `graphSyncTargets()`); result `{targets: Array<{dataset: string; result: SyncShapeGraphsResult |
  SyncOntologiesResult}>, pruned: RoutedGraph[], leftovers: RoutedGraph[], failed:
  Array<{dataset: string; error: string}>}` with `RoutedGraph = {dataset, package, graph}`:
  `pruned` the graphs dropped from the default dataset, `leftovers` those left in another dataset
  (M11; one warning) (`dataset` is `datasetLabel(ds)`, the label the server's logs use: store
  class plus `id` or Fuseki dataset name). As built in SY.
- `graphContent({packages?, turtleFor?, appShapes?})` (same module): `{packages: [{name, shapes?,
  ontology?}], appGraph?, withoutTurtle, unreadable}`, each part K3's `GraphContent`; the server's
  endpoint adds `graphTargets` and `reloaded`. As built in SY.
- **The single-owner graph** (K4 is silent): goes to every dataset a shape that declares a
  `contains` property routes to, ∪ the NodeShape/PropertyShape datasets; one text everywhere
  (`singleOwnerShapesTurtle` of all registered shapes), so K3's one `appGraph` stays valid.
- **Ontology graph of a package with shapes:** its shapes' datasets ∪ the datasets of any shape
  whose target class is in one of its namespaces ∪ the term shapes' datasets (inference needs the
  hierarchy where the instances are). For an ontology-only package the first set is empty, which
  is K4's "follows the shapes that target its classes".

## SY — Sync follows routing; hosted-app writer flag and graph content endpoint

**Depends on:** nothing (wave 1, parallel with CL and HI). **Repos:** `@_linked/core`,
`@_linked/server` (CN unchanged). **Agent worktree:** `npx linked worktree add sy --from
hub-imports --with _linked-core,_linked-server --port 4522` (from `/Users/rene/web/create_now`).
**Plan doc:** the step agent creates `_linked-core/docs/plans/007-sync-follows-routing.md` as its
own plan doc from this section (SY is large), and deletes it before landing. **Reports:** core
`docs/reports/084-sync-follows-routing.md`, server `docs/reports/023-graph-writer-and-graph-content.md`.
**Size:** large, about 5 phases. **Sensitive:** no (no CN data).

### Goal

An open-source app's boot sync writes each package's ontology and shape graphs into every dataset
its routing needs them in (D12, D14, G2, core backlog 076), not only into the default dataset, and
prunes the copies routing no longer needs. A CN-hosted app can be told to write no graph at all
and to answer the content of its graphs instead (D9, D20), so CN becomes the only writer in HS.

### Scope

1. **K4 in core.** `graphSyncTargets()` computes, per package, the datasets of its shape graph and
   ontology graph (union of G2; no split-pin refusal; ontology-only packages follow shapes that
   target their classes) and the datasets of the single-owner graph. `syncShapeGraphsRouted` and
   `syncOntologiesRouted` parse and generate once, then call the existing per-dataset sync once per
   target dataset with that dataset's package subset, then prune: in every dataset routing knows
   that is not a target of package P, drop P's package graph (the record's `core:package` is P and
   the graph is P's `ShapesGraph.iriFor` / `OntologyGraph.iriFor`; never a shared graph, never the
   app graph, never a graph of another package).
2. **Shared and default modes with subsets.** The shared shape graph already treats `packages` as
   its members. The shared and default ontology modes rebuild from every parsed package
   (`run.parsed`), so they get the dataset's subset as members while the in-memory hierarchy is
   still set from every package, once (`setHierarchyFromPackages`).
3. **Server boot (D12).** `materializeShapesIntoStore` and `syncOntologiesOnBoot` (both boot
   paths, `initOnlyBoot` ~501 and the full boot ~866) and `resyncShapes` use the routed syncs; the
   explicit "every registered shape goes into the app's own data store, regardless of routing"
   goes. `warnOfSyncPins`/`syncPinWarning` are replaced by one boot log line naming the target
   datasets per graph kind (the warning's premise, "the syncs write into the default dataset
   only", no longer holds). The server's per-package Turtle choice (`shapeTurtleSource`, file vs
   generated, packages without `shapes.ttl` left out) stays and is passed per run.
4. **K3: `LINKED_GRAPH_WRITER`.** Parsed and checked at boot next to the graph targets; under
   `host` nothing writes a shape or ontology graph (boot, `resyncShapes`), registration, the
   hierarchy and the shape check still run; `/admin/routes` reports it.
5. **K3: the graph content endpoint** (name and shape per the accepted K3) on the admin channel
   behind `requireAdmin`, in `resyncShapes`'s queue and timeout, writing nothing; computes texts
   and hashes through core functions the syncs share (no second implementation of the hash or the
   N-Triples conversion).
6. `/admin/sync-shapes`, `LINKED_SYNC_SHAPES_ON_BOOT`, `LINKED_SYNC_ONTOLOGIES_ON_BOOT` and
   `syncShapesOnBoot` stay (M5); they now drive the routed syncs.

Out of scope: CN (HS sets the flag and calls the endpoint); several apps sharing one store (D12,
later); the inference-caveat warning of 076 beyond what the probe already warns per dataset.

### Files found in code

Core (`packages-local/_linked-core`):
- `src/shapes/syncShapeGraphs.ts` — `syncShapeGraphs(ds?, options)` ~139 (modes: package
  `syncGraphs` ~340, shared `syncSharedGraph` ~271, default `syncDefaultMode` ~248, store fallback
  `syncDefaultGraph` ~165); `shapeGraphHash` ~52; app graph from `singleOwnerShapesTurtle` ~385;
  orphan prune by registration ~405.
- `src/ontology/syncOntologies.ts` — `syncOntologies(ds?, options)` ~241 (reads and parses every
  package and sets the hierarchy ~247–250; package mode `syncGraphs` ~320, shared ~503, default
  ~590 with `defaultModeNamespaces` ~550); `ontologyGraphHash` ~103; content via
  `nTriplesFromTurtle` ~363; record fields `package`, `sources` (`packageSources` ~225).
- `src/shapes/shapesToTurtle.ts` — `packageShapes(pkg)` ~307 (by `shapeClass.packageName`; core's
  built-ins), `packagesWithShapes()` ~323, `singleOwnerShapesTurtle` ~281.
- `src/ontology/registryData.ts` — `readPackageOntologies`, `registrationsByPackage` ~33 (each
  registration's `ns('')`), `setHierarchyFromPackages` ~122.
- `src/utils/LinkedStorage.ts` — `getDatasetForShapeClass` ~234 (prototype walk, then IRI, then
  default), `getDatasets` ~212, `getDefaultDataset` ~93. (076 says `getStoreForShapeClass`; it
  does not exist.)
- `src/utils/graphTargets.ts` — the global `ontologyGraph`/`shapeGraph` targets.
- New: `src/shapes/syncTargets.ts`.
- `README.md` §Store requirements (~24), §Ontology and shape graphs (~87).

Server (`packages-local/_linked-server`): see server plan 001 §SY for the list; in short
`src/shapes/LinkedServer.tsx` (~501–503, ~529–563, ~579–587, ~597–625, ~649–675, ~866–868, ~961),
`src/utils/syncShapes.ts` (`syncShapeGraphsInto` ~217, `appShapesGraph` ~139, `bootOrphanScope`),
`src/utils/ontologySync.ts` (`shapeSyncOn` ~88, `bootSyncsOntologies` ~98, `loadOntologyCore`
~111, `runOntologyPhase` ~166), `src/utils/graphTargets.ts` (`SHAPE_SHAPE_CLASSES`,
`ONTOLOGY_TERM_CLASSES`, `syncPinWarning` ~114), `src/utils/adminChannel.ts`
(`registerAdminRoutes` ~181, `/admin/routes` ~209, `/admin/sync-shapes` ~231, `ShapeSyncResult`
~52), `src/utils/effectiveRoutes.ts`, `README.md` (~474, ~504–517).

### Architecture

- **Targets are computed from routing, never configured.** For each registered shape class
  (`getAllShapeClasses()`, outside any catalog: `assertNoActiveCatalog`),
  `LinkedStorage.getDatasetForShapeClass` gives its dataset; a package's shape datasets are those
  of `packageShapes(pkg)`. The "description" datasets are those of the shapes whose target class
  is `sh:NodeShape`/`sh:PropertyShape` (shape graphs) or one of `ONTOLOGY_TERM_CLASSES` (ontology
  graphs), found the way the server's `watchedClassOf` finds them today (own `targetClass`, else
  the nearest ancestor's). An app with no pins gets `{default}` everywhere: today's behaviour,
  byte for byte, which existing tests prove.
- **One parse, many writes.** The routed syncs read and generate each package's text once and pass
  it per dataset (`turtleFor` for shapes; a parsed-packages argument for ontologies), so every
  dataset gets the same bytes and the same hash. The per-dataset functions `syncShapeGraphs(ds,…)`
  and `syncOntologies(ds,…)` keep their signature and meaning: CN calls them with an explicit
  dataset (`cnMainShapeSync.ts`, `cnMainOntologySync.ts`, `ProjectProvider.ts`) and must not
  change.
- **Prune** reads each known dataset's registry (one read each; the per-dataset sync already reads
  its own) and drops only package-mode graphs of packages that are registered here and not targeted
  there. The registration-based orphan prune (`orphanScope: 'all'`) stays separate and opt-in.
- **Failure isolation.** A dataset that cannot be read or written (a context router that refuses
  a context-free call) fails its own target only: `failed` names it, the others still sync, and
  the boot logs one warning per failed dataset.
- **Server writer flag** sits next to `applyGraphTargetsFromEnv` (boot, before stores); one
  predicate `appWritesGraphs(env)` gates every write path (boot ontology sync, boot shape sync,
  `resyncShapes`), so a new write path cannot miss it.
- **Graph content** is a pure function in core (`graphContent(packages?)` in `syncTargets.ts` or
  next to each sync: shapes `{text, hash: shapeGraphHash(text), sources: ['data/shapes.ttl']}`,
  ontology `{text: nTriplesFromTurtle(...), hash: ontologyGraphHash(texts), sources:
  packageSources(pkg)}`, app graph from `singleOwnerShapesTurtle`), and the syncs write what it
  returns; the server adds the Turtle source choice and the HTTP shape.

### Pitfalls

1. **K3's `turtle` for the ontology** does not match what is stored (N-Triples of several files;
   hash over raw texts). Concatenating the Turtle files merges equal blank-node labels. Answer the
   written content and the recorded hash; never let CN recompute the ontology hash from the text.
2. **Reload.** Without a reload before computing, CN gets the shapes registered at boot, not the
   ones a shape edit just wrote. The endpoint needs `reload` (or HS keeps a reload route).
3. **Shared/default ontology modes ignore `packages`** for membership (`run.parsed`); calling them
   per dataset without a member subset writes every package everywhere. The hierarchy must still be
   set from all packages, once.
4. **Default ontology mode cannot prune per package:** its state is one combined hash and it sweeps
   only the current packages' namespaces, so a package that left a dataset keeps its terms there.
   SY warns once naming the package and dataset; home: core backlog 068 (extend it to ontology
   terms) unless the master decides SY records the swept namespaces.
5. **The routed prune deletes in datasets the app routes to.** In a store several apps share (D12,
   later) it could drop another app's copy of a package graph that this app no longer routes there.
   Only package-mode graphs whose record names the package; document it next to backlog 263's
   warning in the README.
6. **Two boot paths** call the sync sequence (`initOnlyBoot` and the full boot); change both.
7. **CN's own process** runs with `syncShapesOnBoot: false` and calls the per-dataset syncs with
   explicit datasets; routing-aware boot must not reach CN's context routers. Do not change the
   explicit-`ds` functions.
8. **Two copies of a shape class** (src vs lib): resolve datasets through
   `getDatasetForShapeClass` (it falls back to the IRI), never the identity map directly.
9. **A pinned dataset may be a router that refuses context-free calls**; isolate failures per
   dataset (Architecture).
10. **No fallbacks:** a dataset class without `graphQuery` keeps today's per-dataset behaviour
    (shapes fall back to the default graph; ontologies throw) per target, nothing new.
11. The server's `@_linked/core` range (`^2.45.0`) does not change in the step (Renovate and the
    release skill own ranges); inside the master the npm workspace links the built core.

### Tests

New (core, `src/tests/`):
- `sync-targets.test.ts`: no pins → every package `{default}`; a pinned shape adds its dataset; a
  sub-shape follows its parent's pin; NodeShape and PropertyShape pinned to two datasets → both
  (no refusal); term shapes pinned → ontology graphs add that dataset; ontology-only package
  follows a shape of another package targeting its class; single-owner graph targets.
- `sync-routed.test.ts` (in-memory datasets): each target gets the same text and hash; a second run
  writes nothing; moving a pin prunes the graph in the old dataset and keeps other packages'
  graphs; shared shape and ontology graphs per dataset hold only that dataset's packages; the
  hierarchy still covers every package; a failing dataset lands in `failed`, others sync.
- `sync-routed-fuseki.test.ts`: two Fuseki datasets, a pinned package, its graphs in both, pin moved,
  pruned.
- `graph-content.test.ts`: content and hash equal what the package-mode sync writes and records
  (write, then read the record's `core:contentHash`).

Existing (core, must stay green): `shape-graphs.test.ts`, `shape-graphs-fuseki.test.ts`,
`ontology-sync.test.ts`, `ontology-sync-fuseki.test.ts`, `graph-targets.test.ts`,
`graph-targets-fuseki.test.ts`, `store-routing.test.ts`, `shape-sync-hash.test.ts`,
`shacl-syncshapes.test.ts`, `sparql-fuseki-shape-sync.test.ts`.

Server tests: see server plan 001 §SY.

### Verify

From `/Users/rene/web/wt/hub-imports--sy/packages-local/_linked-core`:
- `npm test` (jest + `tsc -p tsconfig-tests.json`).
- `FUSEKI_BASE_URL=http://localhost:3030 FUSEKI_ADMIN_PASSWORD=<from CN's .env> npm run test:fuseki`
  (tests create and drop their own datasets; never `cn-main`).
- `npm run check:dts`, then `npx linked build`.

From `.../_linked-server`:
- `npm test`; the live suites with `FUSEKI_BASE_URL=http://localhost:3030` (`shape-graphs-live`,
  `graph-sync-live`); `npx linked build`.

From the step worktree root: `npm run typecheck:gate` (CN unchanged; proves the built packages
still type against CN).

Timed, output quoted in the reports.

### Done when

- An app with no pins writes exactly what it wrote before (existing tests unchanged and green).
- An app that pins a package's shapes, or NodeShape/PropertyShape, or the term shapes, to another
  dataset finds the package's graphs there after boot, and a moved pin leaves no copy behind.
- `LINKED_GRAPH_WRITER=host`: a boot and a `POST /admin/sync-shapes` send no graph query (asserted
  by observing graph queries, as `observeGraphQueries` does); the content endpoint answers text and
  hash equal to what the `app` writer would have stored.
- K3 and K4 in this plan, server plan 001 and master 282 read as built; core README and server
  README describe the routed sync, the flag and the endpoint; changesets (minor) in both repos;
  reports core 084 and server 023; this plan's Progress ticked; plan 007 deleted.

### Size and phases

Large; about 5 phases, one commit each:
1. Core `syncTargets.ts`: constants moved, `graphSyncTargets()`, graph content functions; unit tests.
2. Core routed syncs: per-target runs, shared/default subsets, prune, failure isolation; unit and
   Fuseki tests; README.
3. Server boot and `resyncShapes` on the routed syncs; `syncPinWarning` replaced by the targets log;
   server tests.
4. Server `LINKED_GRAPH_WRITER`: parsing, gating, `/admin/routes`; tests.
5. Server graph content endpoint, README, changesets in both repos.

## Progress

- [x] SY — K4 routed syncs in core; server boot follows routing; K3 writer flag and graph content
  endpoint (reports core 084, server 023).
