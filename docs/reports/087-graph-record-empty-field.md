---
date: 2026-10-29
summary: >
  A graph-registry record field given an empty list is left out of the SPARQL that
  `graphQueryToSparql` generates (it wrote `<p> ;`, a parse error); an update still deletes the
  field's old values. Patch. Closes backlog 085. Found by CN plan 282 (CN report 289, third
  addendum); the whole plan: CN report 299.
---

# 087 — Graph record field with an empty list

## PR

### Summary

`graphQueryToSparql` serialised a record field whose value is an empty list as `<p> ;` (an
`a, b` list joined from nothing). Fuseki answers 400, so the graph's create or update failed as a
whole. The ontology sync hit it for a registration without data files (`sources: []`, backlog
085), and CN's hub sync hit it for an app's single-owner graph (CN report 289). An empty field now
writes no triple; on `graph_replace`/`graph_patch` its old values are still deleted, so `set({x: []})`
clears the field, and when no field is left to insert the INSERT is omitted.

### Changes

- `src/sparql/graphQueryToSparql.ts`: `recordFields` skips empty lists; the record INSERT of an
  update is built only when at least one field has values.
- `src/tests/graph-query.test.ts`: two tests (create with `sources: []` leaves `dcterms:source`
  out; `update().set({sources: []})` sends only the DELETE). Both fail without the fix.

### Verification

- `jest src/tests/graph-query.test.ts`: without the fix `Tests: 2 failed, 62 passed, 64 total`;
  with it `Tests: 64 passed, 64 total`.
- `npm test` (whole suite plus typecheck): see CN report 299 §Verification.

### Deviations

None. Backlog 085's second question (should `linkedOntology` refuse `load` without `dataSource`)
is moot: such a registration now writes its record without sources.

### Follow-ups

None.

## Details

The fix sits in the serializer rather than in the ontology sync, so every record class and every
caller (the syncs, CN's `datasetGraphTarget.write`) gets it. CN still leaves empty fields out on its
side; that is now redundant but harmless.
