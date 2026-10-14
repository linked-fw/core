---
summary: >
  `irToAlgebra.ts` keeps four memo caches keyed on `getRegistryVersion()` — `predicateTermCache`,
  `blankWalkCache`, `classHoldersCache` and `ownedWalkCache`. They cannot disagree, but the
  invalidation pattern is duplicated. Small cleanup: fold them into one version-keyed memo.
packages: [core]
---

# 051 — Merge the registry-version caches in `irToAlgebra.ts`

Source: [report 032](../reports/032-owned-replace-noop-and-single-owner-shacl.md) (follow-up L11);
updated by [report 036](../reports/036-per-property-ownership.md), which removed the two caches
this item first named (`containmentCache`, `reachableCache`) and added `classHoldersCache` and
`ownedWalkCache`.

## Today

- `resolvePropertyPredicateTerm` memoizes in `predicateTermCache`, checked against
  `predicateTermCacheSize` (actually the registry version, despite its name).
- `blankWalkPredicates`, `classHolders` and `ownedWalk` each keep a `Map` reset when their
  `…Version` variable differs from `getRegistryVersion()`.

All are invalidated by the same counter, so they cannot drift apart; it is purely duplicated
plumbing.

## Proposal

One small helper, e.g. `memoOnRegistryVersion<T>(compute)` / a per-version `Map`, used by all
four. Rename `predicateTermCacheSize` to what it holds. No behaviour change; covered by the
existing `shacl-cascade` and `owned-walk-recursion` unit tests.

## Open questions

- Are there other registry-version caches (outside `irToAlgebra.ts`) worth folding into the same
  helper?
