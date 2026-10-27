---
date: 2026-10-27
summary: >
  Step CK of CN plan 057: package kinds `core:OntologyPackage` / `core:AssetPackage`
  (⊑ `core:Package`) in core; the `npm:` module (`http://purl.org/on/npm/`), `core:packageName`,
  `core:ontologyTriples` and the ontology sync's default-graph fallback removed. A store without
  graph queries is now refused by the `'package'` and shared modes. npm's terms moved to the new
  `@_linked/npm` (its report 001). Minor (small breaking removals).
---

# 080 — Package kinds in core; npm out of core

## PR

### Summary

Core names the package kinds and nothing npm-specific (contract K-core of CN plan 057). npm's
terms live in their own vocabulary package, `@_linked/npm` on `https://linked.cm/ont/npm/` (npm
report 001). The deprecated default-graph ontology sync, kept for stores without graph queries,
is gone with the per-package `OntologySync` records it wrote.

### Changes

- **Kinds.** `coreOntology.OntologyPackage`, `coreOntology.AssetPackage`; `core.ttl` types,
  labels and comments both, `rdfs:subClassOf core:Package`.
- **npm out.** `src/ontologies/npm.ts`, `npm.register.ts`, `src/data/npm.ttl` deleted, with the
  registration in `src/index.ts`. `core:packageName` and `core:ontologyTriples` deleted (term,
  Turtle, `OntologySync` properties, golden `core-shapes.ttl`); only the fallback read them.
- **`OntologySync`** stays, with `ontologyHash` only: the `'default'` mode's record
  (`DEFAULT_GRAPH_ONTOLOGY_NODE`) and the default-graph inference probe use it. Its comment in
  `core.ttl` and JSDoc now say so.
- **The sync** (`src/ontology/syncOntologies.ts`, 917 → 668 lines): deleted `syncDefaultGraph`,
  `removeSyncNode`, `diffUpdates`, `runBounded`, the per-package half of `readSyncState` (now
  `readDefaultModeState`), the exports `ontologySyncNodeIri`, `toNTriplesLine`,
  `ontologyTriplesText`, `ontologySyncHash`, and the result's `fallback`. A dataset without
  `graphQuery`, or a probe answering `unsupported-query-kind`, in the `'package'` or a shared
  mode throws `[syncOntologies] ontologyGraph is '<mode>', but the store <class> <dataset> has no
  graph queries … Use a store with graph queries, or ontologyGraph 'default'.` before anything is
  written. The `'package'` mode no longer removes per-package nodes an earlier sync left, and the
  "other modes" warning no longer names them.
- **`ClassAxioms`** stays (the hierarchy probe writes through it); its comment no longer names the
  fallback.
- **Docs:** `docs/architecture/ontologies.md` (core's vocabularies: no `npm`, the kinds, npm terms
  by IRI only; the sync section without the fallback and the node removal; results), `README.md`
  (Ontology and shape graphs). Changeset `package-kinds-npm-out.md`, minor.

### Tests

- New `core-ontology.test.ts`: both kinds exported, `owl:Class`, `rdfs:subClassOf core:Package`,
  labelled; `coreOntology` has no `packageName` / `ontologyTriples`; `core.ttl` names no purl npm
  IRI; core registers only the `core` prefix.
- `ontology-sync.test.ts`: the fallback suite and the node-removal tests are gone; new: refused
  in `'package'` mode once the probe is refused (no writes), a dataset without `graphQuery`
  refused before any read, refused in a shared mode; the in-memory hierarchy and unreadable
  package tests now run on the graph store.
- `hierarchy-probe.test.ts`: node removals out; each answer writes no default-graph update.
- `ontology-sync-fuseki.test.ts` `[fuseki]`: "a dataset the default-graph sync wrote …" deleted;
  a store without graph queries is refused and writes nothing; no `OntologySync` node at all after
  a sync on a non-inferring store.

### Verification

- Quick gate (8 suites incl. ontology-sync, ontology-registry, auto-load-ontology-data,
  metadata, shapes-to-turtle, shape-catalog, hierarchy-probe, core-ontology):
  `Tests: 1 skipped, 90 passed, 91 total`.
- `npx linked build`: `✔ Build successful` (7.7 s in the worktree, 14.4 s in the main checkout).
- `npm test` with a Fuseki of its own (`FUSEKI_BASE_URL=http://localhost:3941`, started by the
  global setup, compose project `linked-core-test-3941`): `[fuseki] live tests: 414 total — 412
  passed, 0 failed, 2 skipped`, `Test Suites: 4 skipped, 148 passed, 148 of 152 total`,
  `Tests: 122 skipped, 2946 passed, 3068 total`, jest 16.8 s, 30.6 s wall with the typecheck
  (clean).
- `git grep -n 'purl.org/on/npm\|packageName' src/ontologies src/data` and
  `git grep -n 'ontologies/npm' src`: no output.
- CN on the new core (CN code unchanged), worktree `ck`, `CN_TEST_PORT=4341 npm run test:regular`
  (7 min 34 s): `unit (vitest) PASS 77s` (`Tests 2968 passed | 5 skipped`), `packages PASS 12s`
  (9 tests), `playwright (integration + sign-in e2e) PASS 343s` (`335 passed`, `14 skipped`,
  `1 flaky`: `dataset-records.spec.ts:175` "a second project creates no store and connects to the
  same dataset", passed on retry), `typecheck:gate FAIL 21s`. The gate failure is the worktree
  layout, not the change: `@_linked/schema` and the other unchanged packages resolve core from the
  main checkout, so tsc sees two `Shape` declarations (59 `TS2322`/`TS1238`). With one copy it is
  clean: `npx tsc -p tsconfig.typecheck.json --noEmit --preserveSymlinks` in the worktree (24.8 s,
  no output), and after landing `npm run typecheck:gate` in CN's main checkout: `No new type
  errors. 0 pre-existing errors still in the baseline.` (19.6 s).
- CN's boot ontology sync on the new core into a throwaway dataset (`cn-main-test-ck-purl`, mem,
  on :3030, dropped after): `tsx tests/helpers/cnMainOntologySync.ts` wrote all 19 packages;
  `SELECT (COUNT(*) …) FILTER(STRSTARTS(STR(?s),"http://purl.org/on/npm/"))` → `0`; the same with
  `https://linked.cm/ont/npm/` → `0` (nothing CN loads depends on `@_linked/npm` yet);
  `…/core/OntologyPackage` → `4`.
- cn-main (read only): the purl count is `15` today; it drops to `0` at the owner's next CN
  restart, when the sync replaces core's ontology graph (its hash changed). Restarting the owner's
  CN on :4040 was refused to this session, so that query is open (see Deviations).

### Deviations

- **Owner's CN not restarted.** The Verify item "restart the owner's CN on :4040, purl count 0 on
  cn-main" was not run: stopping the owner's running process was not permitted here. Measured
  instead on a throwaway dataset (above). Owner's path: CN on :4040 serves the rebuilt core to the
  browser, a signed-in session loads the dashboard and Projects; the project and Ontology Manager
  half needs the owner's own account (this browser's account has no projects).
- **CN's regular gate**: its `typecheck:gate` step fails in a worktree that overlays core (two
  copies of core's types); measured clean with one copy, in the worktree and in the main checkout
  after landing.
- **The server** keeps reading the removed `fallback` (structural type, always unset now):
  server backlog 006.

### Follow-ups

- Server `docs/backlog/006-ontology-sync-fallback-field.md` — drop the dead `fallback` branch.
- The cn-main purl check after the owner's next CN restart — owner, at the next restart (sub-plan
  005 Verify).

## Details

- Core's own `package.json` gets `linked.kind: "library"` in step RK, not here.
- No migration: datasets with old purl npm triples heal on the next sync (core's graph is replaced
  whole when its hash changes); per-package `OntologySync` nodes are no longer removed by the
  sync — cn-main has none (plan 057 master decision); any elsewhere are inert, and a `'default'`
  rebuild replaces core's namespace.
- `syncOntologies` still reads every registered package also with `packages` set: the shared and
  default modes rebuild from all, and the in-memory hierarchy needs all.
