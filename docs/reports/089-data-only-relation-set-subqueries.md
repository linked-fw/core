---
date: 2026-10-30
summary: >
  `.select()`, `.where()` and `.selectAll()` on a plural relation whose value shape has no authored
  class (a data-only `sh:node`, or `sh:class` only) no longer throw "Cannot read properties of
  undefined (reading 'shape')": they take the members' shape from `memberShapeClass`, as
  `.some()` / `.every()` / `.none()` do since report 081. Closes backlog 084. Patch.
packages: [core]
---

# 089 — Sub-queries on a set of data-only members

## PR

### Summary

`QueryShapeSet.select`, `where` and `selectAll` (`src/queries/SelectQuery.ts`) read the members'
shape from `getLeastSpecificShape()`, which knows authored classes only. On a relation to a
data-only shape they got `undefined` and threw. They now use the relation-aware lookup report 081
added for `.some()`. Closes backlog 084.

### Changes

- A module function `memberShapeClassOrBase(set)`: `memberShapeClass(set)` (the least specific
  authored class, else the shape the relation resolves to, through its adapter), else the base
  `Shape`. `where`, `select` and `buildPredicateExpression` (`some` / `every` / `none`) call it.
- `selectAll` calls `memberShapeClass` directly: with no shape at all (a `sh:class` no shape
  targets) there are no properties to list, so it throws `selectAll() on '<label>': its members
  have no shape to list properties from (a sh:class no shape targets). Declare sh:node on the
  property, or select fields with select().` instead of a `TypeError`.
- Tests in `src/tests/data-only-relation-some.test.ts`, a new `describe` with eight cases:
  `.select()`, `.selectAll()` and `.where()` each on a data-only `sh:node` and on a `sh:class`-only
  relation, `.where()` with `equals` on a `sh:class` no shape targets, and the `selectAll()` error
  there. All fail before the fix (`TypeError: Cannot read properties of undefined (reading 'shape')` / `(reading 'id')`).

### Verification

In the worktree, after `npx linked build` (`✔ Build successful`), the full jest suite:

```
Test Suites: 16 skipped, 137 passed, 137 of 153 total
Tests:       534 skipped, 2556 passed, 3090 total
Time:        21.478 s
```

The skipped suites are the live `[fuseki]` ones. `tsc -p tsconfig-tests.json` prints nothing. The
built `lib/esm/queries/SelectQuery.d.ts` is identical to the one on `dev`, so the public types do
not change.

### Deviations

None from backlog 084's first proposal. Its second question (on a `sh:class` no shape targets,
ask for `sh:node` or fall back to `Shape`?) is decided per entry point: `select` / `where` fall
back to `Shape`, as `.some()` does, so `id` and `equals` still work; `selectAll` has nothing to
list, so it throws the error above asking for `sh:node`.

### Follow-ups

None. `as()` still compares against `getLeastSpecificShape()`; for a data-only set that is
`undefined`, so `as()` rebuilds the set, which is the correct result.

## Details

`memberShapeClass` returns `undefined` only for a relation with no resolvable shape; the base
`Shape` fallback lived inline in `buildPredicateExpression` and is now shared. Both are module
functions, not members, so they reserve no name on the query proxies (the
`dsl-property-name-collisions` guard, report 090).
