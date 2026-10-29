---
summary: >
  Step SY of CN master plan 282 (seeded from core plan 006 §SY): the ontology and shape syncs
  follow the storage routing (K4) in core, the server's boot sync uses them, and a hosted app gets
  the writer flag `LINKED_GRAPH_WRITER` and `POST /admin/graph-content` (K3). Deleted before landing.
status: Tasks
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

1. **Core targets and content** — `syncTargets.ts`: constants, `datasetLabel`,
   `graphSyncTargets()`, `graphContent()`; refactor `syncOntologies` so a parsed set can be passed
   (signature unchanged); export the record readers the prune needs. Tests:
   `sync-targets.test.ts`, `graph-content.test.ts`. Validation: those plus the existing shape and
   ontology sync suites green; `npm run typecheck`.
2. **Core routed syncs** — `syncShapeGraphsRouted`, `syncOntologiesRouted`: per-target runs,
   shared/default subsets, prune (M11), failure isolation, default-mode warning (M10).
   Tests: `sync-routed.test.ts`, `sync-routed-fuseki.test.ts`. README §Store requirements and
   §Ontology and shape graphs. Validation: `npm test`, `npm run test:fuseki` (own datasets),
   `npm run check:dts`, `linked build`.
3. **Server boot on the routed syncs** — `syncShapeGraphsInto` and `runOntologyPhase` call the
   routed syncs and report per target; both boot paths and `resyncShapes`; `syncPinWarning`
   replaced by a targets log line; constants imported from core. Tests: updated
   `boot-shape-sync`, `boot-ontology-sync`, `graph-targets`; a pinned-package case each.
4. **Server `LINKED_GRAPH_WRITER`** — parse/check at boot, `appWritesGraphs`, gating, sync-shapes
   `skipped: 'host-writer'`, `/admin/routes` `graphWriter`. Tests: `graph-writer.test.ts`.
5. **Server `POST /admin/graph-content`** — handler in the shape-sync queue and timeout, 400/409,
   README, changesets (minor) in core and server. Tests: `graph-content.test.ts`.

## Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| S1 | setup | The master's `_linked-cli` worktree had no `lib/`, so `npx linked` and the server's tests (which import `@_linked/cli/*`) could not run | Ran `linked build` with the main checkout's CLI binary (read only) in my worktrees, and built the master's `_linked-cli` once (lib only, gitignored; tsc emitted JS though it could not type against the master's unbuilt core) | Repoint my link farm to the main checkout's CLI | Tests run against the master's CLI code; nothing tracked changed; the master rebuilds core then cli after landings |
