---
summary: >
  `irToAlgebra.ts` keeps two memo caches keyed on `getRegistryVersion()` — `containmentCache`
  (contains predicates and dependent types) and `reachableCache` (dependent types reachable from a
  shape). They cannot disagree, but the invalidation pattern is duplicated. Small cleanup: fold
  them into one version-keyed memo.
packages: [core]
---

# 051 — Merge the registry-version caches in `irToAlgebra.ts`

Source: [report 032](../reports/032-owned-replace-noop-and-single-owner-shacl.md) (follow-up L11).

## Today

- `collectContainment()` memoizes `{containsPreds, dependentTypes}` in `containmentCache`, checked
  against `containmentCacheSize` (actually the registry version, despite its name).
- `reachableDependentTypes(shapeId)` memoizes per shape in `reachableCache`, reset when
  `reachableCacheVersion` differs from `getRegistryVersion()`.

Both are invalidated by the same counter, so they cannot drift apart; it is purely duplicated
plumbing.

## Proposal

One small helper, e.g. `memoOnRegistryVersion<T>(compute)` / a per-version `Map`, used by both.
Rename `containmentCacheSize` to what it holds. No behaviour change; covered by the existing
`shacl-cascade` unit tests.

## Open questions

- Are there other registry-version caches (outside `irToAlgebra.ts`) worth folding into the same
  helper?
