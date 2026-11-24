---
date: 2026-10-29
summary: >
  `ComponentsGraph`, the graph-registry record class of a package's component index graph
  (`core:ComponentsGraph`, next to `ShapesGraph`; fields `package`, `version`, `commit`,
  `sources`), and the `core:commit` term, for the host app's master plan, step CX (M35). Minor. The whole step: the host app's
  report.
---

# 086 — ComponentsGraph record class

## PR

### Summary

A host that keeps a package's component index (`lib/esm/data/components.ttl`, K8) as a named graph
records it with core's graph API like any other graph kind: `ComponentsGraph.create({id, package,
version?, commit?}).withContent(…)`, `update(iri).set({commit}).replaceContent(…)`, `delete(iri)`.
The record class could not live in the host app: `registerGraphRecordShape` is private and the other graph
kinds are here (M35). The graph IRI is the host's (for example `{package record}/graph/components/{key}`).

### Changes

- `src/shapes/NamedGraph.ts`: `ComponentsGraph extends NamedGraph` (`targetClass =
  core:ComponentsGraph`; `package`, `version`, `commit` properties; `recordFields` typing),
  registered as a built-in shape.
- `src/queries/graphRecords.ts`: its record fields (`sources`, `package`, `version`, `commit`);
  it never feeds the class hierarchy.
- `src/ontologies/linked-core.ts`, `src/data/core.ttl`: `core:commit` (datatype property, "the
  commit a named graph's content was built from").
- `src/utils/ShapeCatalog.ts`: `ComponentsGraph` among the built-in shape names.
- Tests: `graph-query.test.ts` (create/replace queries with the record fields; `core:commit` in the
  SPARQL write; never feeds the hierarchy; five graph-record built-ins), `shape-catalog.test.ts`
  (built-in list), golden `src/tests/fixtures/core-shapes.ttl` regenerated (the new shape, +33
  lines). Changeset `.changeset/components-graph-record.md` (minor).

### Verification

In the step worktree's `packages-local/_linked-core` (`hub-imports--cx`):

- `jest src/tests/graph-query.test.ts src/tests/shape-catalog.test.ts
  src/tests/shapes-to-turtle.test.ts src/tests/core-ontology.test.ts` → `Tests: 1 skipped, 118
  passed, 119 total`.
- `npx linked build` → `✔ Build successful`.
- `npm test` (jest + typecheck) → `Test Suites: 17 skipped, 140 passed, 140 of 157 total` /
  `Tests: 535 skipped, 2581 passed, 3116 total`, exit 0 (1:05). An earlier run had one failure in
  `change-sources.test.ts` ("a change and its echo fold…", a timing assertion, `Expected: 2,
  Received: 3`); alone it passed (`Tests: 20 passed`) and the next full run was green. Untouched
  by this change.

### Deviations

None.

### Follow-ups

None in core. The host app writes and reads the graphs (its report).
