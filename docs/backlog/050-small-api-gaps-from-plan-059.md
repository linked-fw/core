---
summary: >
  Two small gaps found by Create Now plan 059. (1) `.some()` / `.every()` / `.none()` on a plural
  relation throws when the value shape has no authored class: data-only `sh:node`, or
  `sh:class` only. (2) There is no public way to ask whether a package is registered, so Create
  Now reads `globalThis._linked._packages` directly.
packages: [core]
status: open
---

# 050 — small API gaps found by plan 059

Checked on `feat/relation-shape-resolver` (2026-10-07).

## 1. `.some()` on a relation to a data-only shape throws

**Measured** with a throwaway jest test (deleted afterwards). Two shapes registered with
`registerRuntimeShapes`, both data-only: `Team` and `Member`. `QueryBuilder.from(<Team adapter>)
.where(t => t[label].some(m => m.equals({id})))` followed by `toRawInput()` / `toJSON()`:

- `members` (plural, `valueShape` → data-only `Member`) → `Cannot read properties of undefined
  (reading 'prototype')` at `createShapeTarget` ← `createProxiedPathBuilder` ←
  `QueryShapeSet.buildPredicateExpression` (`src/queries/SelectQuery.ts:1125`).
- `leads` (plural, `sh:class` only) → `Cannot read properties of undefined (reading 'id')` at
  `getLeastSpecificShapeClasses` (`src/utils/ShapeClass.ts:726`), one step earlier.

Cause: `buildPredicateExpression` (:1122) takes the shape from
`getOriginalValue().getLeastSpecificShape()`, which calls `getShapeClass`. That function returns
**authored** classes only, so a data-only value shape has none. Property access on the set
(`proxifyShapeSet`, :926-932) falls back to `property.valueShape`, but also through
`getShapeClass`. Neither path uses `getOrCreateShapeAdapter`.

Create Now works around it with a DSL-JSON condition
(`where: {[label]: {'@id': target}}`), which lowers to an existential match.

**Proposed fix:** in `buildPredicateExpression` and `proxifyShapeSet`, resolve the value shape
as authored class → `getOrCreateShapeAdapter(property.valueShape)`. For a class-only relation,
use the one shape `resolveRelationShape` gives, or fall back to a bare `Shape` proxy that allows
only `equals` / `id`. Add a test for each case.

## 2. No public "is this package registered" API

`registerPackageMetadata` (`src/utils/Package.ts:530`) writes `_linked._packages[packageName]`,
and nothing exported reads it. Create Now's `isRegisteredPackageName` and
`registeredPackageNamesForSlug` (`src/utils/shapeUtils.ts:25`) read
`globalThis._linked?._packages` directly. They decide whether `getNodeShapeUri`'s computed IRI can
be trusted (a registered package with its own base URI) or is just the linked.cm fallback.

**Proposed fix:** export `isRegisteredPackage(name)` and `getRegisteredPackages()` (a read-only
list of `PackageMetadata`) from `utils/Package`. Perhaps also `getPackageBaseUri(name)`, which
returns `undefined` when the package is unregistered, so callers can tell a fallback from a
configured root.

## Open questions

1. For a class-only relation, should `.some()` fail with a clear error ("declare `sh:node`")
   instead of guessing a shape?
2. Should `getNodeShapeUri` itself say whether it used the fallback, which would make most of
   item 2 unnecessary?
