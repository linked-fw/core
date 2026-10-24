---
summary: >
  The graph targets (ontologyGraph, shapeGraph) are one global setting the host sets
  (`setGraphTargets` / `getGraphTargets`, on globalThis, default 'package'); the syncs, the
  readers, the probe and the other-mode warnings read it. Every per-store path is removed
  (SparqlOptions fields, store methods, `loadStores`' option and config handling). Backlog 076:
  the sync follows routing.
packages: [core]
---

# 075 — The graph targets are one global setting

## PR

### Summary

The owner's decisions of 2026-10-24 (second round): where the ontology and shape syncs write is
one global core setting, set by the host from the environment, not a store setting (report 057
made it per store).

- **New:** `setGraphTargets({ontologyGraph?, shapeGraph?})` and `getGraphTargets()` in
  `utils/graphTargets` (also root exports). The state is `sharedState('@_linked/core',
  'graphTargets')` on `globalThis`, so every copy of core sees one setting. With nothing set both
  are `'package'`. Each call is checked with the existing `parseGraphTargetOptions` and replaces
  both settings (one left out is `'package'`; a refused call changes nothing; `{}` resets).
- **Readers of the setting:** `syncOntologies`, `syncShapeGraphs`, `expandReadGraphs`
  (`graphs.allOntologies` / `graphs.allShapes`); the probe and the other-mode warnings take the
  mode the sync read. Nothing reads targets off a store.
- **Removed (breaking, in a minor):** `SparqlOptions.ontologyGraph` / `.shapeGraph`,
  `SparqlDataset.setGraphTargets()` / `.graphTargets()`, `IDataset.setGraphTargets?` /
  `.graphTargets?`, `graphTargetsOf(ds)`, `loadStores`' second argument (`LoadStoresOptions`,
  `{graphTargets}`) and its `config.ontologyGraph` / `config.shapeGraph` handling.
  `graphTargetOptionsFromEnv(env)` stays for hosts.
- **Docs:** README "Ontology and shape graphs" (one global setting set by the host, `@_linked/server`
  from the two variables; default `package`; no per-store settings; the frontend needs none when
  its queries go through the backend; every copy of core must be this version) and "Store
  requirements" (no graph-target setting on a store); `loadStores` reference;
  `docs/architecture/ontologies.md`.
- **Backlog 076** (option 2): the sync follows routing. Backlog 074 reworded (its graph-target
  case is gone; the general constructor-error case stays).
- Changeset `global-graph-targets.md` (minor, the removed fields and methods listed as breaking).

### Changes

- `src/utils/graphTargets.ts` (`setGraphTargets`, `getGraphTargets`, module doc; `graphTargetsOf`
  removed), `src/index.ts`, `src/sparql/SparqlDataset.ts`, `src/sparql/sparqlUtils.ts`,
  `src/interfaces/IDataset.ts`, `src/utils/graphRegistryCache.ts` (`expandReadGraphs` reads the
  global; its `targets` context field is gone), `src/utils/loadStores.ts`,
  `src/ontology/syncOntologies.ts`, `src/shapes/syncShapeGraphs.ts`.
- Tests: `graph-targets.test.ts` (the global setting: default, replace, refusal, reset, the
  `globalThis` container; no store methods; `loadStores` passes a config verbatim and warns; a
  `SparqlDataset` read of `graphs.allShapes` follows the setting; the readers per mode),
  `graph-targets-fuseki.test.ts` and `graph-targets-measure-fuseki.test.ts` set the global before
  each store (`storeIn`) and reset it after.

### Verification

Worktree `gglobal`, own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3322 (compose project
`fuseki-gglobal`), `FUSEKI_BASE_URL=http://localhost:3322 FUSEKI_ADMIN_PASSWORD=admin
REQUIRE_FUSEKI=1`.

- `npx linked build`: `✔ Build successful`.
- `npm test`: `Test Suites: 1 failed, 4 skipped, 142 passed, 143 of 147 total`, `Tests: 122
  skipped, 2819 passed, 2941 total`, `[fuseki] live tests: 398 total — 396 passed, 0 failed, 2
  skipped`. The failed suite is the known `two-copies-built.test.ts` (`Module cache already has
  entry …/lib/esm/shapes/SHACL.js. This is a bug in Jest`, backlog 060).
- `npm run typecheck`, `npm run check:dts`: clean.

### Deviations

- The setting lives in `utils/graphTargets` (next to the parser) rather than on `LinkedStorage`.
- `loadStores` warns about an entry whose config still sets `ontologyGraph` / `shapeGraph` (the
  value used to switch the mode and would now be ignored silently). Asked for by the review.

### Review

An independent read-only review found no bug in core's logic and three medium findings: the
README's `loadStores` signature still showed the removed option (fixed); fuseki still passed the
removed options (fixed in fuseki's own PR, released after this one); a target left in a datasets
config was dropped silently (now a warning, tested). Low, applied: the frontend wording (holds
when queries go through the backend), the changeset says every copy of core must be this version,
a `SparqlDataset` read test, `toMatchObject` for the shared container.

### Follow-ups

- Backlog 076: the sync follows routing.
- `@_linked/server` and `@_linked/fuseki` move to the global setting in their own PRs.
