---
summary: >
  Step SY of CN master plan 282 (seeded from core plan 006 §SY): the ontology and shape syncs
  follow the storage routing (K4) in core, the server's boot sync uses them, and a hosted app gets
  the writer flag `LINKED_GRAPH_WRITER` and `POST /admin/graph-content` (K3). Deleted before landing.
status: Implementation
---

# 007 — Sync follows routing (step SY)

Scope, files, pitfalls, tests and verify list: [plan 006 §SY](006-hub-imports-core.md#sy--sync-follows-routing-hosted-app-writer-flag-and-graph-content-endpoint).
Contracts K3 (full wording in 006 §Contracts) and K4 (282 M10–M12). Server half:
[server plan 001](../../../_linked-server/docs/plans/001-hub-imports-server.md).

## Design as built

- `src/shapes/syncTargets.ts` (server only, not in the index): `SHAPE_SHAPE_CLASSES`,
  `ONTOLOGY_TERM_CLASSES`, `datasetLabel(ds)`, `graphSyncTargets()`, `syncShapeGraphsRouted`,
  `syncOntologiesRouted`, `graphContent`.
- A per-dataset run whose member set equals every package passes no `packages` subset, so an app
  without pins makes exactly the calls it made before (orphan prune included).
- Routed shapes: per target, `syncShapeGraphs(ds, {...options, packages: subset, appShapes only
  where the app graph goes})`, `turtleFor` memoized across targets.
- Routed ontologies: one `readPackageOntologies` + `setHierarchyFromPackages`, then per target an
  internal run over the dataset's subset of the parsed packages (`syncOntologies(ds)` itself keeps
  parsing and setting the hierarchy).
- Prune (package mode only): every known dataset's package-mode records read once; a registered
  package's own graph in a dataset that is not its target is dropped in the default dataset and
  reported as a leftover (one warning) elsewhere (M11).

## Phases

1. [x] **Core targets and content** — `syncTargets.ts`: constants, `datasetLabel`,
   `graphSyncTargets()`, `graphContent()`; refactor `syncOntologies` so a parsed set can be passed
   (signature unchanged); export the record readers the prune needs. Tests:
   `sync-targets.test.ts`, `graph-content.test.ts`. Validation: those plus the existing shape and
   ontology sync suites green; `npm run typecheck`.
2. [x] **Core routed syncs** — `syncShapeGraphsRouted`, `syncOntologiesRouted`: per-target runs,
   shared/default subsets, prune (M11), failure isolation, default-mode warning (M10).
   Tests: `sync-routed.test.ts`, `sync-routed-fuseki.test.ts`. README §Store requirements and
   §Ontology and shape graphs. Validation: `npm test`, `npm run test:fuseki` (own datasets),
   `npm run check:dts`, `linked build`.
3. [x] **Server boot on the routed syncs** — `syncShapeGraphsInto` and `runOntologyPhase` call the
   routed syncs and report per target; both boot paths and `resyncShapes`; `syncPinWarning`
   replaced by a targets log line; constants imported from core. Tests: updated
   `boot-shape-sync`, `boot-ontology-sync`, `graph-targets`; a pinned-package case each.
4. [x] **Server `LINKED_GRAPH_WRITER`** — parse/check at boot, `appWritesGraphs`, gating, sync-shapes
   `skipped: 'host-writer'`, `/admin/routes` `graphWriter`. Tests: `graph-writer.test.ts`.
5. [x] **Server `POST /admin/graph-content`** — handler in the shape-sync queue and timeout, 400/409,
   README, changesets (minor) in core and server. Tests: `graph-content.test.ts`.

## Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| S2 | phase 1 | Which shapes "declare `contains`" for the app graph's targets | The shapes whose own node shape has `contains` properties (what `buildSingleOwnerConstraints` builds from); a sub-shape that inherits them does not count | Count inherited ones too | K4's words; the single-owner shapes are generated from the declaring shape only |
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
| S18 | phase 5 | `appGraph: null` cannot occur with core's built-ins registered (they declare `contains`) | Tested with a stand-in core (server pass-through) and in core (`graphContent` without single-owner shapes) | — | The contract case still holds for a process without such shapes |
| S1 | setup | The master's `_linked-cli` worktree had no `lib/`, so `npx linked` and the server's tests (which import `@_linked/cli/*`) could not run | Ran `linked build` with the main checkout's CLI binary (read only) in my worktrees, and built the master's `_linked-cli` once (lib only, gitignored; tsc emitted JS though it could not type against the master's unbuilt core) | Repoint my link farm to the main checkout's CLI | Tests run against the master's CLI code; nothing tracked changed; the master rebuilds core then cli after landings |
