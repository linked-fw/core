---
summary: >
  Step SY of CN master plan 282: the ontology and shape syncs follow the storage routing (K4).
  New `@_linked/core/shapes/syncTargets`: graphSyncTargets(), syncShapeGraphsRouted,
  syncOntologiesRouted (prune in the default dataset only, leftovers reported elsewhere, failures
  per dataset) and graphContent() (what the 'package'-mode syncs would write). Server half:
  server report 023.
---

# 084 — The ontology and shape syncs follow routing

## PR

### Summary

An app's ontology and shape graphs now go wherever its storage routing needs them, not only into
the default dataset (CN plan 282, D12/D14/G2, K4; consumes core backlog 076). Core computes the
targets and runs the per-dataset syncs per target; `@_linked/server`'s boot uses them (server
report 023). `graphContent()` gives a host the exact text and hash the syncs would write (K3).
`syncShapeGraphs(ds)` and `syncOntologies(ds)` are unchanged (CN calls them).

### Changes

- `src/shapes/syncTargets.ts` (new, server only): `SHAPE_SHAPE_CLASSES`,
  `ONTOLOGY_TERM_CLASSES` (moved from the server), `datasetLabel`, `targetClassOf`,
  `graphSyncTargets()`, `syncShapeGraphsRouted`, `syncOntologiesRouted`, `graphContent()`.
  A package's shape graph goes to its shapes' datasets ∪ those of the `sh:NodeShape` /
  `sh:PropertyShape` shapes; its ontology graph also where shapes targeting its classes route and
  to the term shapes' datasets; the app graph to the datasets of shapes declaring `contains` ∪
  the shape shapes'. A dataset that gets every package is synced with no subset (byte-identical
  to before without pins, orphan prune included). Prune: package-mode graphs of registered
  packages routing no longer sends somewhere: dropped in the default dataset, reported as
  `leftovers` (one warning) elsewhere (M11). `'default'` ontology mode: one warning per dataset
  (M10). Failures per dataset in `failed`.
- `src/ontology/syncOntologies.ts`: `syncParsedOntologies(ds, options, parsed)` split out of
  `syncOntologies` (whose signature and behaviour stay); `packageSources`,
  `readOntologyRecords` exported. `src/shapes/syncShapeGraphs.ts`: `readShapesRecords`,
  `SHAPES_SOURCE` exported.
- Tests: `sync-targets.test.ts` (7), `sync-routed.test.ts` (11), `graph-content.test.ts` (3),
  `sync-routed-fuseki.test.ts` (1, two throwaway datasets `linked-core-test-sync-routed-fuseki[-b]`);
  helper `src/test-helpers/memory-graph-store.ts`.
- README: §Store requirements (the hierarchy where the instances are), §Ontology and shape graphs
  ("Which datasets the syncs write to"). Changeset (minor) `.changeset/sync-follows-routing.md`.
- Plan 006: Contracts K3/K4 replaced with 282's accepted text; K4 detail as built; SY ticked.
  Backlog 076 removed (consumed); 068 extended (M10); 085 new.

### Verification

Run from `/Users/rene/web/wt/hub-imports--sy/packages-local/_linked-core` (CLI: the main
checkout's `launch.js`, see S1).

- `linked build`: `✔ Build successful` (15.6 s).
- `npm test` (jest + typecheck): `Test Suites: 17 skipped, 140 passed, 140 of 157 total`,
  `Tests: 535 skipped, 2569 passed, 3104 total` (Fuseki suites skipped without the env).
- `npm run check:dts`: no output, exit 0 (1.7 s).
- `npm run test:fuseki` against CN's Fuseki on 3030 (own `linked-core-test-*` datasets only):
  first run (phase 2) `[fuseki] live tests: 415 total — 406 passed, 7 failed, 2 skipped`; the 7 all
  `Loading SHACL test data failed: 405 Method Not Allowed — is the test Fuseki running with
  ENABLE_DATA_WRITE/ENABLE_SHACL` (that Fuseki is not the test image; unrelated). The gate rerun
  hit 5 s timeouts (machine load 64, two other test runs holding Fuseki slots); the sync suites
  rerun in band afterwards: `PASS sync-routed-fuseki`, `PASS ontology-sync-fuseki`, `PASS
  graph-targets-fuseki`, `shape-graphs-fuseki` only its SHACL case — `[fuseki] live tests: 32
  total — 29 passed, 1 failed, 2 skipped`.
- CN: `npm run typecheck:gate` in `/Users/rene/web/wt/hub-imports--sy` reports 117 errors, every
  one between two copies of core (`…/hub-imports--sy/packages-local/_linked-core/…` vs
  `…/create_now/packages-local/_linked-core/…`: the step's core next to the copy the main install's
  `@_linked/*` packages resolve). With one copy (`paths` mapping `@_linked/core` to the step's
  build, scratch tsconfig, removed): `tsc` 0 errors (1 min 38 s). Vitest
  `src/services/appShapeSync.test.ts src/services/hubOntologySync.test.ts`: `Test Files 2 passed
  (2)`, `Tests 15 passed (15)`.

### Deviations

- The routed syncs live in `syncTargets.ts` (282 M12), not in the existing sync modules (006's
  first draft); K4 detail in 006 updated.
- Routed result adds `leftovers` (M11's report of graphs left in non-default datasets).
- Phases 1 and 2 split by commit as tests/docs, not by code (S5).
- CN's typecheck gate cannot pass in a step worktree that has its own core (see Verification);
  verified with one core copy instead.

### Follow-ups

- ⚠ K4 wording for the app graph: sub-shapes of `contains` shapes pinned elsewhere (S2): for the
  master (282 contract), proposed change in `graphSyncTargets`.
- `'default'` ontology mode leaves a moved package's terms: core backlog 068 (extended, M10).
- Ontology registration without data file names writes invalid SPARQL: core backlog 085.
- The master rebuilds its `_linked-core` then `_linked-cli` (S1).
- Removal of `/admin/sync-shapes` and the boot flags, CN writing the graphs: step HS (M5).

## Details

Per-dataset sync stays the unit; the routed sync is a loop over `graphSyncTargets().datasets`
with each dataset's package subset, so the shared and default modes hold exactly the packages
routed to that dataset, while `setHierarchyFromPackages` runs once from every package. Local data:
nothing stored changes shape; no reset needed.

### Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| S2 | phase 1, revisited at review | Which shapes take the app graph along (K4: "shapes declaring `contains` properties") | As K4 words it: the declaring shapes only. ⚠ risky: a sub-shape pinned elsewhere inherits the `contains` property, so its instances own values in a dataset without the single-owner constraint. Proposed to the master (follow-up): K4 to say "declaring shapes and their sub-shapes" (a few lines in `graphSyncTargets`) | Widen it in SY | The contract is the master's and lives in 282, which this step does not change |
| S3 | phase 1 | No shape targeting `sh:NodeShape`/`PropertyShape` (or no term shape) is registered | The description datasets are then `{default}` | No description dataset | An app without those shapes keeps today's behaviour (everything in the default dataset) |
| S4 | phase 1 | `graphContent` asked for a valid name the process does not know | Answered `{name}` with neither graph | Leave it out, or an error | The host learns the package has nothing here without a second call; the server refuses invalid names (400) |
| S5 | phase 1 | Commit granularity | `syncTargets.ts` lands whole in phase 1 (targets, content and the routed syncs); the routed syncs' tests, the Fuseki test and the README follow in phase 2 | Split the module across commits | One module, one review; nothing calls the routed syncs before phase 2 |
| S6 | phase 2 | A dataset the router no longer knows (nothing pinned to it) can hold a leftover graph | Not read; the README says so | Remember past targets | Routing is the only source of datasets; no new state |
| S7 | phase 2 | `'default'` ontology mode, a dataset without every package (M10) | One warning per dataset and process naming the packages routed elsewhere; fix homed in core backlog 068 | Per-run warning | Edge case; one line per boot |
| S8 | phase 2 | Live Fuseki suites that need SHACL validation and data upload (7 tests) fail on CN's Fuseki (405, no `ENABLE_SHACL`/data write) | Reported as environment failures; every other live suite, mine included, passes | Start the test image on another port | Unrelated to the change (they load SHACL data over GSP); the owner's Fuseki is not reconfigured |
| S9 | phase 3 | Keep the server's single-dataset sync paths (`syncShapeGraphsInto(ds)`, `runOntologyPhase(ds)` without `routed`)? | Kept: they sync one given dataset (the live suite syncs through a `RemoteDataset` client that is not the router's default); the boot and `resyncShapes` always run routed | Remove them | Same meaning as core's per-dataset `syncShapeGraphs(ds)`/`syncOntologies(ds)`, which stay (M12) |
| S10 | phase 3 | A routed run where one dataset failed | Log the others, then throw naming each failed dataset (boot: the existing non-fatal warning; sync-shapes: 500) | Answer 200 with `failed` | Keeps today's contract: a failed sync is never answered as a success |
| S11 | phase 3 | The boot's targets log line with no pins | Silent (the syncs' own lines say it all); logged only when some graph goes beyond the default dataset | Always log | No new noise for the common case |
| S12 | phase 3 | `syncPinWarning` tests | Replaced by `syncTargetsLine` tests with the same four situations (pinned shape shapes, syncs that run, store named by its dataset, term shapes through a parent) plus the sub-shape case | Delete them | The premise ("writes into the default dataset only") is gone; the situations stay covered |
| S13 | phase 3 | Core's own ontology follows core's own shapes (`NodeShape`, `PropertyShape`) when those are pinned | Kept, as K4 says (a package's ontology goes where its shapes route) | Special-case core | One rule |
| S14 | phase 4 | What `sync-shapes` answers under `host` | `{written: 0, skipped: 'host-writer', reloaded, shapes, shapeCheck}` exactly (no `ontologies`); the ontology phase runs with its sync off, so registration, the hierarchy and the check still run | Include an empty `ontologies` | K3's wording |
| S15 | phase 4 | Where the flag is checked | Parsed in `initStores` next to the graph targets (fatal on a bad value) and read through one predicate `appWritesGraphs(env)` at the shape sync, the boot ontology sync and `resyncShapes` | Store it on the server instance | Env stays the one source, as for the graph targets; one predicate for every write path |
| S16 | phase 5 | Graph content for an installed package without `shapes.ttl` | No `shapes` part; listed in `withoutTurtle` (core would generate it, the sync leaves it out) | Answer the generated Turtle | The answer is what the sync writes |
| S17 | phase 5 | After a `reload`, are ontologies registered again? | Yes: the ontology phase runs without its sync (register, hierarchy, check), as sync-shapes does | Reload only | A reloaded package may register a new ontology module; same rule as sync-shapes |
| S18 | phase 5 | `appGraph: null` cannot occur with core's built-ins registered (they declare `contains`) | The server's pass-through tested with a stand-in core; core answers `null` exactly when `singleOwnerShapesTurtle` gives nothing | — | The contract case still holds for a process without such shapes |
| S1 | setup | The master's `_linked-cli` worktree had no `lib/`, so `npx linked` and the server's tests (which import `@_linked/cli/*`) could not run | Ran `linked build` with the main checkout's CLI binary (read only) in my worktrees, and built the master's `_linked-cli` once (lib only, gitignored; tsc emitted JS though it could not type against the master's unbuilt core) | Repoint my link farm to the main checkout's CLI | Tests run against the master's CLI code; nothing tracked changed; the master rebuilds core then cli after landings |

## Addendum: fix round (master decision M19)

- **S2 resolved by M19**: the app's single-owner graph now goes to every dataset any shape it
  constrains routes to (the shapes declaring `contains` properties and their sub-shapes) ∪ the
  NodeShape/PropertyShape dataset, the same text everywhere. `graphSyncTargets` follows the
  prototype chain; K4 updated in plan 006 and server plan 001; READMEs updated.
  `sync-targets.test.ts` now expects a pinned sub-shape's dataset; server `graph-targets.test.ts`
  expects a NodeShape sub-shape with its own class to take the app graph along (shape graphs stay).
- Gate: core `linked build` `✔ Build successful`; `sync-targets sync-routed graph-content`
  `Tests: 1 skipped, 21 passed, 22 total`; `sync-routed-fuseki` `[fuseki] live tests: 1 total — 1
  passed`; `npm run typecheck` 0 errors. Server `graph-targets boot-shape-sync graph-content
  graph-writer boot-ontology-sync`: `Tests: 76 passed, 76 total`.
- The 117 CN `typecheck:gate` errors of the first round come from two copies of core in a step
  worktree (the link farm loads the step's core and, for the main install's other `@_linked/*`
  packages, the main checkout's); homed in cli backlog 013.
- Typecheck fix: `@linkedPackage('…').linkedShape` (TS1497) in `sync-routed.test.ts` and `sync-routed-fuseki.test.ts` replaced by a named `termsShape` decorator; full `npm test` (jest + typecheck) exit 0: `Test Suites: 17 skipped, 140 passed, 140 of 157 total`, `Tests: 535 skipped, 2579 passed, 3114 total`.
