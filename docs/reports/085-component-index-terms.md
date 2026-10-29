---
date: 2026-10-29
summary: >
  Component index vocabulary for CN plan 282 step CI (K8): `core:Component`, `core:SetComponent`,
  `core:ComponentsGraph`, `core:definesComponent`, `core:exportName`, `core:startShape`,
  `core:queryShape`, `core:query` and `rdf:JSON`; `QueryBuilder.fromJSON` reads a `nullSubject`
  query back without an added limit. Minor + patch. The whole step: cli report 042.
---

# 085 — Component index terms

## PR

### Summary

The terms `linked build`'s `components.ttl` (written by `@_linked/react`'s generator) uses, and a
round-trip fix the index relies on. The whole step, its sandbox run and its decision ledger are in
`@_linked/cli` report 042.

### Changes

- `src/ontologies/linked-core.ts`: `Component`, `SetComponent`, `ComponentsGraph`,
  `definesComponent`, `exportName`, `startShape`, `queryShape`, `query` in `coreOntology`.
- `src/data/core.ttl`: their definitions (labels, comments, domains, ranges; `core:SetComponent ⊑
  core:Component`, `core:ComponentsGraph ⊑ sd:NamedGraph`; `sh:` prefix for the `sh:NodeShape`
  ranges); `core:query` ranges over `rdf:JSON`.
- `src/ontologies/rdf.ts`: `rdf.JSON`.
- `src/queries/QueryBuilder.ts`: `fromJSON` rebuilds a `nullSubject` query with `.for(null)`, so
  its `toJSON()` equals the input (it gained `limit: 1` through `.one()`).
- Tests: `core-ontology.test.ts` (module ↔ `core.ttl` for every new term), a `.for(null)` round
  trip in `serialization.test.ts`. Changesets: minor (terms), patch (fix).

Commits `136e858`, `860834b`.

### Verification

In `/Users/rene/web/wt/hub-imports--ci/packages-local/_linked-core`: `jest
src/tests/core-ontology.test.ts` → `Tests: 17 passed, 17 total`; `jest serialization
query-builder ask-wire count-wire` → `Tests: 25 skipped, 359 passed, 384 total`; `npm test` →
`Test Suites: 16 skipped, 137 passed, 137 of 153 total` / `Tests: 534 skipped, 2558 passed, 3092
total`, exit 0 (1:28); `linked build` → `✔ Build successful`.

### Deviations

The `fromJSON` fix is outside "terms only"; it is a single branch in `QueryBuilder.ts`, not in the
sync files step SY changes.

### Follow-ups

None in core. CN stores the index (CN plan 282, step CX).
