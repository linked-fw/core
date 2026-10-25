---
date: 2026-10-25
summary: >
  Outside production, a `SparqlDataset` follows an update by id with one `ASK`, scoped as the
  update's WHERE, and `console.warn`s when the update matched no node (it wrote nothing and still
  resolved, report 078). Gated on `NODE_ENV=production` through a new `inProduction()`, which the
  catalog-scope warning now uses too. Minor.
---

# 079 — Warn when an update by id matched no node

## PR

### Summary

Since report 078, `update().for({id})` on an absent id (or an untyped half-node) writes nothing,
and still resolves with the id and fields it was given. Apps that updated nodes they never typed
broke silently. Outside production the store now says so.

### Changes

- **The check** (`src/sparql/irToAlgebra.ts` `updateSubjectTypedAsk`): `ASK` whether `<id>` has
  an `rdf:type` (any type) where the update's WHERE looks for it:
  - unrouted: `ASK { <id> rdf:type ?t }`;
  - one graph (`WITH <g>`): `ASK { GRAPH <g> { … } }`;
  - several graphs (`writeGraphs`): `ASK { VALUES ?g { … } GRAPH ?g { … } }`, the default graph
    named through `mapGraphName` as the update does.
  - `null` for a shape without a targetClass (`ClassAxioms`): its update writes any node it names.
- **The warning** (`SparqlDataset.updateQuery` → `warnWhenUpdateMatchedNoNode`): only for kind
  `update` (not upsert, not `forAll`/`where`), after the update is sent. It names the id, the
  shape IRI and the graph(s), and points to `upsert(values).for({id})` or creating the node first.
  The result is unchanged; a failing check is swallowed.
- **The gate** (`src/utils/inProduction.ts`): `NODE_ENV === 'production'`, read through
  `globalThis.process`, the switch core already used for the `withShapeCatalog` promise warning
  (`ShapeClass.ts` now calls it). In production no `ASK` is sent.
- **Docs:** `Shape.update` doc comment, `documentation/dsl-json.md` (update). Changeset
  `update-no-match-warning.md`, minor.

### Tests

- `update-no-match-warning.test.ts` (stub store): the ASK text and the warning for unrouted, one
  graph and several graphs; no warning when typed; a failing ASK resolves with the same result;
  production sends no ASK; no check for a targetClass-less shape, an upsert or `forAll`.
- `update-absent-id.test.ts` `[fuseki]`: in all three routings an absent id and an untyped
  half-node warn once, a present id does not (the ASK's scope matches the update's).
- `owned-link-check` and `shape-catalog` stubs answer the ASK, so their select counts stay what
  they measure.

### Verification

- `npx linked build`: `✔ Build successful`.
- `npm test` with a Fuseki of its own (:3361): `Test Suites: 4 skipped, 147 passed, 147 of 151
  total`, `Tests: 122 skipped, 2958 passed, 3080 total`, `[fuseki] live tests: 415 total — 413
  passed, 0 failed, 2 skipped`; typecheck clean.

### Notes

- Unrouted, the ASK reads the query endpoint's default graph. A store whose query default graph
  is the union of all graphs (`unionDefaultGraph`) would find a node typed only in a named graph
  and not warn, though the update (on the real default graph) wrote nothing. A missed warning,
  never a false one.
- The check doubles the round trips of an update by id in development.
