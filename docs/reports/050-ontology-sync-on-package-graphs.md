---
summary: >
  The ontology sync writes each registered package's whole ontology data into its own named
  graph (`{package IRI}/graph/ontology`, an `OntologyGraph` record that feeds the hierarchy), in
  one graph query per changed package with an N-Triples body, skipped by a `/2` hash over the
  raw file texts; it removes what the earlier default-graph sync kept for a package (its
  `OntologySync` node's lines, except those another node lists) and keeps that sync as the
  fallback for stores without graph queries. CN plan 071, sub-plan 004.
packages: [core]
---

# 050 — The ontology sync on package graphs

## Why

CN plan 071 moves each package's ontology data out of the default graph into its own ontology
graph, recorded in the graph registry, so the store builds its class hierarchy from the graphs the
registry marks (fuseki image `6.2.0-2`, fuseki report 002) and readers can find labels and
comments per package. Report 048 provided the graph queries; this step makes the sync use them.
Sub-plan [004](../plans/004-named-graphs.md) §K3 holds the plan-mode detail; master §Ontology sync
the contract.

## What

**`syncOntologies(ds?, {force, packages, orphanScope})`** (`src/ontology/syncOntologies.ts`),
same signature and result:

- Per package (sorted, sequential): `ontologyGraphHash(texts)` = SHA-256 of
  `linked-ontology-sync/2\n` + the raw data file texts in registration order joined with `\n`,
  compared with the `core:contentHash` of the package's record (one
  `OntologyGraph.select(r => [r.package, r.contentHash])` per run). Equal and no `force` →
  `skipped`, no write. Otherwise the body is built by `nTriplesFromTurtle` (new in
  `src/ontology/hierarchy.ts`: each file parsed with its own blank-node prefix `f<i>_`,
  default-graph triples only, deduped N-Triples lines), and sent as
  `OntologyGraph.create({id, package, sources}).withContent(body, {contentHash})` or
  `OntologyGraph.update(id).set({sources}).replaceContent(body, {contentHash})`. The sync's hash is
  passed as `contentHash`, so the record holds the hash of the raw bytes, not of the N-Triples.
  `sources` are the registrations' files without leading `./`/`../` (`data/schema.ttl`).
- **Cleanup of the default-graph sync (P4):** after a package's graph is written, or found
  unchanged (so an interrupted cleanup is finished by the next run), every line its
  `OntologySync` node lists is removed from the default graph unless another remaining node lists
  it (one `ClassAxioms` update per subject class, eight in flight), then the node is deleted.
  A triple two packages listed goes with the second. A hand-written axiom no node lists stays.
- **Orphans** (`orphanScope: 'all'`, no `packages`): `OntologyGraph.delete(iri)` for each record
  whose package is not registered, and the cleanup above for each node whose package is not
  registered; both are reported in `pruned`.
- **Fallback:** an explicit dataset without a `graphQuery` function, or the first graph query
  answering `unsupported-query-kind` (before any graph write), runs the plan-070 default-graph
  sync, moved unchanged into a private function (`/1` hash, `OntologySync` nodes). Any other graph
  error is thrown. `OntologySync`, `ontologySyncHash`, `ontologyTriplesText`,
  `ontologySyncNodeIri` and `toNTriplesLine` stay exported, marked deprecated.

**Docs.** `docs/architecture/ontologies.md` §The ontology sync rewritten; README §Store
requirements (image `6.2.0-2`, package graphs); changeset `ontology-sync-on-package-graphs.md`
(minor, breaking list); backlog 064.

## Deviations from the sub-plan and the master

- **No `version` in the record.** Master §Ontology sync shows `update(...).set({version})`; core
  knows no package's version (`OntologyRegistration` and `linkedPackage` carry none), so the sync
  records `package` and `sources` only. The field is optional; the hash decides rewrites.
  Follow-up: core backlog 064.
- **Reading of P4's "or the package graph does not replace":** a line the node lists but the
  package no longer has is removed too (plan 070 would have removed it on the change). Keeping it
  would leave a stale axiom no node lists, and master Verify's "empty default-graph hierarchy for
  synced packages" would not hold. Written into sub-plan 004 §K3 before coding.
- **Phases:** the cleanup landed with the graph path in phase 1 (one module, one unit suite);
  phase 2 was the live suite. Sub-plan §K3 Phases updated.
- `ontology-sync-fuseki.test.ts` drops all graphs between its tests (`DROP ALL`): the shared
  `clearAllData` clears only the default graph, and the registry would survive.

## Verification

Worktree `named-graphs--k3`, own Fuseki `linked-fuseki:071` (F1's local `6.2.0-2` build) on
:3174, compose project `fuseki-071-k3`; env `FUSEKI_BASE_URL=http://localhost:3174
FUSEKI_TEST_PORT=3174 LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-071-k3
LINKED_FUSEKI_IMAGE=linked-fuseki:071`.

Quick gates:

- Phase 1: `jest src/tests/ontology-sync.test.ts src/tests/ontology-hierarchy.test.ts`:
  `Tests: 37 passed, 37 total`, `Time: 0.811 s`; `npm run typecheck` clean, 3.1 s.
- Phase 2: `jest src/tests/ontology-sync-fuseki.test.ts src/tests/ontology-sync.test.ts`
  (`REQUIRE_FUSEKI=1`, `LINKED_SCHEMA_TTL` = schema's `src/data/schema.ttl`): `Tests: 33 passed,
  33 total`, `Time: 3.468 s`; `npm run typecheck` clean.

Master Verify, in `ontology-sync-fuseki.test.ts` (`[fuseki]`, all passed): the first sync writes
both packages' graphs with records (`feedsHierarchy` true, the `/2` hash, `sources`) and returns
them in `written`, and nothing in the default graph; the second sync `skipped`, 0 updates; a label
change rewrites only that package (1 update, the other's `dcterms:modified` unchanged); a
superclass select returns a subclass instance through the package graph and loses it when the
axiom goes, and `force` rewrites with 1 update; a dataset written by the default-graph sync ends
with only the hand-written `Puppy ⊑ Dog` in the default graph, both nodes gone, `ASK { ?x a
Animal }` and `ASK { bo a Animal }` true; a store refusing graph queries takes the old path (the
hierarchy in the default graph, no records).

Measurement (same suite): `[measure] first schema.org ontology sync: 743 ms, 1 update, 17931
triples in its graph; second (skipped) sync: 39 ms, 0 updates` (schema's whole `schema.ttl`);
with the hierarchy fixture: `112 ms, 1 update, 952 triples; second 17 ms, 0 updates`. Plan 070's
default-graph sync of the same fixture took 907 updates.

Full gate (before the rebase check; `named-graphs` had not moved):

- `npx linked build`: `✔ Build successful`, 6.3 s.
- `npm test`: `Test Suites: 1 failed, 4 skipped, 125 passed, 126 of 130 total`, `Tests: 120
  skipped, 2547 passed, 2667 total`, `Time: 11.74 s` (14.0 s wall), `[fuseki] live tests: 333
  total — 333 passed, 0 failed, 0 skipped`. The failing suite is `two-copies-built.test.ts`
  ("Jest worker encountered 4 child process exceptions"), backlog 060. A first run before the
  build also failed `two-copies-entry-points` and `ontology-load-files`, which read `lib/esm`
  (`run linked build before the tests`); both pass after the build.
- `npm run typecheck`: clean, 3.2 s. `npm run test:fuseki`: `Tests: 2372 skipped, 333 passed,
  2705 total`, `Time: 7.601 s`. `npm run check:dts`: clean, 1.7 s.
- `lib/esm`: `n3` only as `import('n3')` (`ontology/hierarchy.js`, `sparql/graphQueryToSparql.js`).

## Follow-ups

- The package version in records: core backlog 064.
- The server's boot and control route call `syncOntologies(ds, {orphanScope})` unchanged; routing
  graph queries through `RemoteDataset` and the plane is V1 (master §V1). Until V1 lands, an app
  whose dataset is a `RemoteDataset` built against this core has no `graphQuery` and takes the
  default-graph path.
- Readers of ontology terms in the default graph (CN's term readers) move to
  `graphs.allOntologies` in C2.

## Incident

The first unit run of phase 1 was started without the Fuseki env in the same shell, so jest's
global setup reached the default `http://localhost:3939` (a stock `secoresearch/fuseki:6.2.0`,
container `tests-fuseki-1`, not this step's): it ran `reapTestDatasets` (deletes datasets named
`nashville-test-*` and the inference probe) and the inference probe, then aborted on the stock
image. No dataset count was printed for the reap. Every later run sourced the env first and
checked `FUSEKI_BASE_URL` before starting jest.
