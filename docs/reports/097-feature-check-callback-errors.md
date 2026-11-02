---
date: 2026-10-31
summary: >
  Addendum to report 096: the dispatch-side feature check (`requiredFeatures`) evaluated the
  select and where callbacks before the dataset was asked, so a callback that throws made `exec`
  reject even on a dataset that never lowers the query (CN's shape-ui catalog test). The check now
  reports no features when a callback throws and leaves the error to lowering. Patch.
packages: [core]
---

# 097 — The feature check and callbacks that throw

## PR

### Summary

Report 096 added `assertQuerySupported` to `SelectBuilder.exec`, which calls
`requiredFeatures()`, which evaluates the select and where callbacks through the proxy. That
evaluation is the same one lowering does (`processWhereClause`, the same proxy and catalog). What
changed is **when** it happens: before the dataset is asked, instead of when the dataset lowers
or serializes the query.

CN's `src/data/CnDataManagerHost.catalog.test.tsx` failed with
`TypeError: instance[label.label].contains is not a function`
(`@_linked/shape-ui/src/search.ts:54`). Its `Todo.title` has no `maxCount`, so it is a
multi-valued literal (`QueryPrimitiveSet`), which has no `contains()`. The test's dataset records
the query and returns `[]` without lowering it, so before 096 the callback never ran.

Real runtime: a dataset that lowers (`SparqlDataset`, through `lower()`) or forwards
(`RemoteDataset`, through `toJSON()`) evaluates the same callback and threw the same error before
096 too. Search on a single-valued label is unaffected; search on a multi-valued label was
already broken, in shape-ui (see Follow-ups).

Fix: `SelectBuilder.requiredFeatures()` catches an error from evaluating the callbacks and
reports no features; the error surfaces where it did before 096. A grouped select is unaffected:
its callbacks were already evaluated by `groupBy()`, and it always requires `groupBy`.

### Changes

- `src/queries/QueryBuilder.ts`: `requiredFeatures()` tolerates a callback that throws.
- `src/tests/query-features.test.ts`: regression tests with shape-ui's dynamic-key search,
  `select((i) => [i[label]]).where((i) => i[label].contains('a'))` on the shape's IRI.
  - With a single-valued label, the query reaches a dataset without `supports`.
  - With a multi-valued label, the check does not throw: a non-lowering dataset answers, and a
    lowering one rejects with `contains is not a function`.
- `.changeset/feature-check-callback-errors.md`: patch.

### Verification

- The new test fails without the fix (`Tests: 1 failed, 9 passed`) and passes with it
  (`Tests: 10 passed, 10 total`).
- `npx linked build`: `✔ Build successful`. Full jest against an own Fuseki:
  `Tests: 122 skipped, 3106 passed, 3228 total`, `[fuseki] live tests: 437 total — 435 passed,
  0 failed, 2 skipped`. `npm run check:dts`: clean.
- CN, after landing and building core in the main checkout:
  `node_modules/.bin/vitest run src/data/CnDataManagerHost.catalog.test.tsx` →
  `Test Files  1 passed (1)`, `Tests  3 passed (3)` (before: `Tests  1 failed | 2 passed (3)`).

### Deviations

None.

### Follow-ups

- `@_linked/shape-ui` `searchInstancesWithDsl` (`src/search.ts:54`) calls `.contains()` on the
  label path. When the label property is multi-valued that path is a set, which has no
  `contains()`, so search throws on any dataset that lowers the query. It needs
  `.some((v) => v.contains(query))` for a set. Home: shape-ui's backlog, to be filed by the CN
  session.

## Details

The dispatch check stays where report 096 put it. A query whose callbacks throw cannot be
answered by any dataset that reads it, so not checking it loses nothing: the dataset reports
the error.
