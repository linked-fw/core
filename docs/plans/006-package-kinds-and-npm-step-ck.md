---
summary: >
  Step CK of CN master plan 057: package kinds `core:OntologyPackage` / `core:AssetPackage` in
  core; core's `npm:` module, `core:packageName` and the default-graph `OntologySync` fallback
  removed; the new hand-made `@_linked/npm` package (ontology + shapes). Seeded from sub-plan 005.
status: Implementation
---

# 006 — Step CK: package kinds in core; `@_linked/npm`

Sub-plan: [005 §CK](005-package-kinds-and-npm.md#ck--package-kinds-in-core-_linkednpm) (scope,
files, pitfalls, contracts K-core, K-npm, K-kind). Master plan: CN plan 057.

## Decisions taken from the code (no design change)

- **Package mode no longer reads per-package `OntologySync` nodes.** With `packageName` gone a
  per-package node cannot be told apart, so `readSyncState` reads only the `'default'` mode's node
  (`DEFAULT_GRAPH_ONTOLOGY_NODE`, its `ontologyHash`), and the "earlier default-graph hierarchy"
  finding of `warnOtherModes` goes with the removal. Leftover nodes heal: none exist in cn-main
  (master decision), and a `'default'` rebuild replaces core's namespace.
- **`ontologyTriples` goes** (term, shape property, fixture): only the fallback reads it.
- **`ClassAxioms` stays**: the hierarchy probe writes through it.
- **`SyncOntologiesResult.fallback` goes.** The server reads it through its own structural type
  (`fallback?: true`, `_linked-server/src/utils/ontologySync.ts:35,222`), so it still compiles;
  the dead branch there is a server follow-up (homed in sub-plan 005 §Follow-ups).
- **No graph queries → throw.** `ds` without `graphQuery`, or a probe answering
  `unsupported-query-kind`, in `'package'` or shared mode throws
  `[syncOntologies] ontologyGraph is '<mode>', but the store <name> has no graph queries …`.

## Phases

### Phase 1 — core

Tasks:
1. `linked-core.ts` / `core.ttl`: add `OntologyPackage`, `AssetPackage` (⊑ `core:Package`);
   delete `packageName`, `ontologyTriples`; rewrite the `OntologySync` comments.
2. Delete `src/ontologies/npm.ts`, `npm.register.ts`, `src/data/npm.ttl`; `index.ts` import and
   comment.
3. `OntologySync` shape: only `ontologyHash`; JSDoc for the `'default'` mode's record.
4. `syncOntologies.ts`: delete `syncDefaultGraph`, `removeSyncNode`, `diffUpdates`,
   `runBounded`, `readSyncNodes`, the per-package half of `readSyncState`, `ontologySyncNodeIri`,
   `toNTriplesLine`, `fromNTriplesLine`, `ontologyTriplesText`, `ontologySyncHash`, `fallback`;
   the throw; header and JSDoc.
5. Tests: `ontology-sync.test.ts` (drop the fallback describe and node removals; new: no
   `graphQuery` throws, probe `unsupported-query-kind` throws, shared mode throws),
   `hierarchy-probe.test.ts` (node removals out), fixture `core-shapes.ttl`; new kinds test
   (`coreOntology.OntologyPackage`/`AssetPackage`, `core.ttl` subclasses, no `packageName`).
6. Docs: `docs/architecture/ontologies.md`, `README.md`.

Validation: quick gate (sub-plan §Tests) green; `npx tsc --noEmit` via `npm test`'s typecheck;
`git grep -n 'purl.org/on/npm\|packageName' src/ontologies src/data` and
`git grep -n 'ontologies/npm' src` empty; `npx linked build` clean.

### Phase 2 — `@_linked/npm`

Tasks:
1. `git init` `packages-local/_linked-npm` (initial commit on `main`, branch `dev`), worktree
   `dev--ck` in the CN worktree, `linked worktree relink ck`.
2. Files on the layout of `_linked-rdfs` (sub-plan list): manifest with `linked.kind` and
   `linkedPackage: true`, `npm.ttl`, generated `npm.ts`/`npm.data.ts`/`npm.register.ts`, shapes
   `NpmPackage`, `NpmDependency`, the shape check test, README, changeset.
3. `npm install` at CN's main root once landed so `npm ls @_linked/npm` resolves to the checkout.

Validation: `npx linked build && npm test` green; `npx linked generate-ontology --check` reports
nothing stale; a test that every K-npm term is exported and typed in `npm.ttl`.

Dependency: phase 2 depends on phase 1 only for the core build it compiles against.

### Landing gate

core `npm test` (Fuseki suites against a Fuseki of my own, never :3030's datasets) +
`npx linked build`; npm build + test; CN `npm run typecheck:gate` and
`CN_TEST_PORT=4341 npm run test:regular`; then the purl count on cn-main after the owner's CN
restarts (read-only query), and the owner's path.

## Progress

- [x] Phase 1 — core: kinds in, `npm:` module, `packageName`, `ontologyTriples` and the default-graph fallback out. Quick gate 8 suites / 90 tests green; full `npm test` with own Fuseki (:3941): 148 suites passed, 4 skipped; 2946 tests passed, 122 skipped; jest 16.8 s, 30.6 s wall incl. typecheck; `linked build` 7.7 s clean; both greps empty.
- [ ] Phase 2
