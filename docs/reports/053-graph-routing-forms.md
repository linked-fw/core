---
summary: >
  Graph routes state intent: `{graph: 'own'}` → `{DATA_ROOT}/graph/{package slug}/{shape name}`,
  `{graph: dataGraph('slug')}` → `{DATA_ROOT}/graph/{slug}`, resolved under the store's data root
  (`IDataset.dataRoot()`, `SparqlOptions.dataRoot`, else `DATA_ROOT`) whenever the routing is read;
  full IRIs stay accepted. The datasets config's `graphs` key is removed (ignored with a warning).
  Backlog 069 records per-instance graph functions. CN plan 071, sub-plan 004.
packages: [core]
---

# 053 — Graph routing forms

## Why

CN plan 071, open question 5, as decided by the owner on 2026-10-23: graph routing lives only in
the app's code (arch-04 Layer 1), not in `linked.backend.datasets.json` (1a); a route states intent
and developers never write graph IRIs (1c-i); graph IRIs live under the data's root (1c-ii).
Sub-plan [004](../plans/004-named-graphs.md) §K6 holds the plan-mode detail.

## What

**Route forms** (`ontologies/graphs.ts`, `utils/graphRouting.ts`). A route given to
`LinkedStorage.setDatasetForShapes(store, shapes, {graph})` or `setShapeGraphs(dataset, {shape:
route})` is one of:

| Route | Graph |
|---|---|
| `'own'` (`OWN_GRAPH`) | `{DATA_ROOT}/graph/{package slug}/{shape name}` |
| `dataGraph('slug')` | `{DATA_ROOT}/graph/{slug}` |
| an absolute graph IRI | as given |

- **The `'own'` rule.** The package is the one the shape class was registered by
  (`linkedPackage(name)`, the class's `packageName`, read from the shared registry by shape IRI).
  Its slug is `packageNameToSlug(name)`, arch-02's rule for package IRIs: drop the npm scope
  (`@scope/`), replace every run of characters other than ASCII letters and digits with `-`, trim
  leading and trailing `-`, lower-case (`@acme/News_Site` → `news-site`, `@_linked/core` → `core`).
  The shape name is the shape IRI's last path segment, case kept: `@linkedShape({name})` if given,
  else the class name (`RFStoryShape` named `Story` → `Story`). So `Article` of `@acme/news-site`
  → `{DATA_ROOT}/graph/news-site/Article`. The path is derived when the route is set; a shape no
  package registered is refused then. An unrouted sub-shape inherits its routed super-shape's graph
  (K4's rule), so `'own'` on `Article` alone puts `NewsArticle` in `…/Article`.
- **`dataGraph(slug)`** returns a frozen `{dataGraph: slug}`. The slug is one or more
  `/`-separated segments, each `^[a-z0-9]+(?:-[a-z0-9]+)*$`; anything else throws (no silent
  rewriting). A route that arrives as plain data (`{dataGraph: '../x'}`) is checked again.
- **`DATA_ROOT`.** The one the store mints ids under (`generateEntityUri`): the new optional
  `IDataset.dataRoot()` (`SparqlDataset.dataRoot()` returns `SparqlOptions.dataRoot`; CN's
  `AppDataFusekiStore` sets that option to the project's app data root once resolved), else the
  process's `DATA_ROOT`. `dataRootOf(dataset)` trims it and drops trailing slashes (as the server's
  `appShapesGraph` does). There is no `example.org` fallback.
- **When it resolves.** The table keeps an absolute IRI or a path under the root; the root is
  joined in `graphRoutingFor(dataset)`, which every read, write, `.into()` check and live-query
  dependency calls, so a root the store learns later is the one used. A route that needs a root the
  dataset lacks is refused there, naming the shape and the form. `getShapeGraphs` returns the
  resolved IRIs (what a `GET /admin/routes` would show). The shared-global key changed
  (`__linkedGraphRoutes`), since its values changed shape.
- `.into()` and the read set are unchanged: they work on the resolved IRIs.
- **Exports.** `dataGraph`, `OWN_GRAPH`, types `GraphRoute`, `DataGraphRoute` from
  `@_linked/core/ontologies/graphs` and the index, next to `graphs`; `dataRootOf` from
  `@_linked/core/utils/graphRouting` and the index.

**The datasets config's `graphs` key** is removed. `parseDatasetsConfig` no longer checks it
(unknown alias keys pass through, as they always have), `DatasetEntry.graphs` leaves the type, and
`loadStores` routes nothing from it and warns once per alias that has one, pointing to
`setDatasetForShapes`. Ignoring follows the parser's existing style; refusing would crash an app
whose file still carries the key. No published dependent uses it: core 2.38.1 (the latest on npm)
has neither the key nor `DatasetEntry.graphs`; server, server-utils, fuseki, cli and webid.email do
not read it (grep of their sources on `named-graphs`).

## Deviations from the sub-plan

None in core. One finding about CN contradicted the step's brief (below); CN was fixed first.

## Breaking changes (changeset `graph-routing-forms.md`, minor)

- The datasets config's per-alias `graphs` key is removed (never released); `DatasetEntry.graphs`
  is gone; `loadStores` warns and routes nothing from it.
- A route string that is neither `'own'` nor an absolute graph IRI is refused with the new message.

The unreleased `graph-routing.md` changeset no longer mentions the config key. No export was
removed.

## CN relied on the key: fixed in CN before this landed

The brief assumed "removing the key from core does not break that CN code, because CN parses the
file itself". CN's C3 `parseAppGraphRoutes` (`src/data/appGraphRoutes.ts`) parsed the JSON itself
but passed `graphs` through core's `parseDatasetsConfig` and read
`parsed.datasets.appData.graphs` back. Against this step's core that was `error TS2339: Property
'graphs' does not exist on type 'DatasetEntry'.`, and `appGraphRoutes.test.ts:73` expected core to
throw `/graph IRIs/`. The step stopped; the master chose to fix CN first. CN `2004766be` ("fix: app
graph routes read graphs from the raw datasets entry and check the IRIs in CN") reads `graphs` from
the raw entry, resolves its placeholders through core's parser (in the `config` slot, typed in both
cores) and checks shape IRI → graph IRI in CN with core's old rule and message. Its gate:
`typecheck:gate` "No new type errors." (current core), the same file compiled against this step's
`lib` with no error in it, Vitest `appGraphRoutes.test.ts` `Tests 11 passed`,
`tests/integration/graph-routing.spec.ts` `9 passed (25.7s)` on :3190 with `CN_TEST_PORT=4192`
(4190, the port first assigned, is on the fetch spec's blocked-port list: undici answers "bad
port", so CN never looks healthy).

## Verification

Worktree `named-graphs--k6`, own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3190 (compose
project `fuseki-071-k6`), env `FUSEKI_TEST_PORT=3190 FUSEKI_BASE_URL=http://localhost:3190
LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-071-k6 LINKED_FUSEKI_IMAGE=ghcr.io/linked-fw/fuseki:6.2.0-2`
exported before every jest run (nothing reached :3939).

Quick gates:

- Phase 1 (`graph-routing`, `load-stores-loader`, `dataset-pin-identity`): `Tests: 48 passed, 48
  total`, `Time: 10.05 s` (16 s wall); `npm run typecheck` clean, 12 s.
- Phase 2 (the same plus `read-graphs`, `query-dependencies`): `Tests: 99 passed, 99 total`,
  `Time: 3.4 s` (6 s wall); typecheck clean, 4 s.
- Phase 3 (`graph-routing-fuseki`): `[fuseki] live tests: 11 total — 11 passed, 0 failed, 0
  skipped`, `Time: 2.04 s`.

Full gate (`npx linked build` first: `✔ Build successful`, 8 s):

- `npm test` (jest): `Test Suites: 1 failed, 4 skipped, 132 passed, 133 of 137 total`, `Tests: 120
  skipped, 2664 passed, 2784 total`, `Time: 71.548 s` (76 s wall), `[fuseki] live tests: 353 total
  — 353 passed, 0 failed, 0 skipped`. The failing suite is `two-copies-built.test.ts` ("Jest worker
  encountered 4 child process exceptions"; alone: "Module cache already has entry
  …/lib/esm/shapes/SHACL.js. This is a bug in Jest"), backlog 060.
- `npm run typecheck`: clean, 5 s. `npm run check:dts`: clean, 2 s. `npm run test:fuseki`: `353
  total — 353 passed`, `Time: 19.008 s` (27 s wall). `lib/esm/utils/graphRouting.js` and
  `lib/esm/ontologies/graphs.js`: no `n3` or `node:` import.

Verify:

- Golden IRIs (`graph-routing.test.ts`, "route forms"): `'own'` → `{root}/graph/news-site/RFArticle`
  (`@acme/News_Site`), `{root}/graph/news-site/Story` (explicit name), `{root}/graph/core/Person`,
  `{root}/graph/graph-routing-test/GRPhoto`; `dataGraph('albums')` → `{root}/graph/albums`,
  `dataGraph('pets/archive-2026')` → `{root}/graph/pets/archive-2026`; the root from the store, from
  `DATA_ROOT`, trailing slashes dropped, learned later; no root refused with the shape named;
  unregistered package, bad slugs and plain-data slugs refused; `setDatasetForShapes(…, {graph:
  'own'})` compiles creates, selects and `.into()` with the resolved IRI.
- `[fuseki]` "{graph: 'own'} through LinkedStorage: a create lands in {root}/graph/{package
  slug}/{shape name} and reads back from it": DSL dispatch with no `.exec(store)`; the article in
  `…/graph/news-site/RFArticle`, the routed sub-shape in `…/RFNewsArticle`, a default-graph decoy
  left out of the read, an update in the same graph, a minted id under the root and in the graph.
- The JSON key: "a graphs key is not validated, and loadStores routes nothing from it and warns".

## Follow-ups

- Backlog [069](../backlog/069-per-instance-graph-functions.md): per-instance graph functions.
- CN (C6): `AppDataFusekiStore` must resolve its data root before reads that use intent routes
  (today it does so on reads only when it has `ownRoutes`); otherwise `dataRoot()` falls back to
  CN's own `DATA_ROOT`. C6 also moves `routesForProject` from the datasets file to the storage file.
- To confirm (master, 1c-ii): the root is stable across a project's branches, so fork copies keep
  graph names.
