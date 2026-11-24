---
date: 2026-11-01
summary: >
  Registering a property labelled `and`, `or` or `not` throws again, next to the `$`-prefixed
  names (report 105 had turned it into a warning). `$`-prefixed names and `and`/`or`/`not` throw;
  the other reserved names warn. Patch.
packages: [core]
---

# 106 — Reserved combinator labels throw

## PR

### Summary

Owner decision: `$`-prefixed names and `and`/`or`/`not` throw; the other reserved names warn.

- `registerPropertyShape` (`src/shapes/SHACL.ts`) throws for `and`, `or`, `not` as it does for a
  `$`-prefixed label. A shape loaded as data (`registerRuntimeShape`, `ShapeCatalog`) is still only
  reported through `warnOnReservedPropertyLabel`, and a condition on such a property is still
  written as an S-expr.
- Tests: `src/tests/reserved-labels.test.ts` (throw cases extended; warn cases now `size`, `id`,
  `some`).
- Docs: README, `documentation/dsl-json.md`, JSDoc in `reservedQueryNames.ts` and `SHACL.ts`,
  and report 105's changeset.

### Verification

Core suite, `npx linked build`, and the host app's `npm run typecheck:gate` (results in the hand-off).
