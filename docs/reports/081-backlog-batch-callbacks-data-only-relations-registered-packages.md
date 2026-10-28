---
date: 2026-10-27
summary: >
  Step C of CN plan 181 (backlog batch): node callbacks run for a shape without decorated
  properties (backlog 061); `.some()` / `.every()` / `.none()` and property access on a plural
  relation to a data-only or `sh:class`-only shape no longer throw, and `isRegisteredPackage` /
  `getRegisteredPackageNames` are public (backlog 050); `registerInstalledOntologies` hands
  `importModule` a `/`-separated path (backlog 062 §3). Backlog 051 was already done. Minor.
---

# 081 — Backlog batch: value-shape callbacks, data-only relations, registered packages

## PR

### Summary

Four small core backlog items from CN plan 181, step C. Two bug fixes in shape registration and
the query DSL, one additive public API (Create Now switches to it), one Windows path fix. Backlog
051 needed no code: the four version-keyed caches it names were already folded into
`RegistryCache` (`src/utils/registryCache.ts`, commit 84ddff8, the ShapeCatalog work).

### Changes

- **Node callbacks without own properties (061).** `applyLinkedShape` (`src/utils/Package.ts`)
  ran `getAndClearCallbacks(nodeShape.id)` inside `if (constructor['shapeCallbacks'])`. It now
  runs after the class's own property callbacks, whether or not there are any, with the same
  collect-and-rethrow-first error handling. A property-less shape named by `[package, name]`
  before it registers now connects the links waiting on it and runs the deferred tighten-only
  comparison.
- **`.some()` on data-only relations (050 §1).** `QueryShapeSet` took the members' shape from
  `getLeastSpecificShape()`, which knows authored classes only (outside a catalog). A module
  function `memberShapeClass(set)` (`src/queries/SelectQuery.ts`) now resolves it: the least
  specific authored class, else the shape `resolveRelationShape` gives for the set's property
  (`sh:node`, or the shape targeting a `sh:class`), through `resolveShapeConstructor` (the adapter
  for a data-only shape). `buildPredicateExpression` (`some` / `every` / `none`) and the set
  proxy's property access use it; with no shape at all (a `sh:class` nothing targets) the
  predicate callback gets the base `Shape`, which allows `equals` / `id`. A function, not a
  member, so it reserves no name on the query proxies (the `dsl-property-name-collisions` guard).
- **`isRegisteredPackage(name)`, `getRegisteredPackageNames()` (050 §2).** Exported from
  `@_linked/core/utils/Package`; they read the `_linked._packages` tree `linkedPackage()` writes
  (own keys only, so `isRegisteredPackage('toString')` is false).
- **`registerInstalledOntologies` (062 §3).** `options.importModule` now gets the register
  module's absolute path with `/` separators (`slashedPath`, `C:/…` on Windows), a module id
  Vite's `ssrLoadModule` resolves; documented on the option. The built path already used
  `pathToFileURL`.
- **Create Now** `src/utils/shapeUtils.ts`: `isRegisteredPackageName` and
  `registeredPackageNamesForSlug` use the two new functions instead of
  `globalThis._linked._packages` (CN report 192).

### Verification

Core suite (`npm test`, jest + `tsc -p tsconfig-tests.json`), after `npx linked build`:

```
Test Suites: 16 skipped, 137 passed, 137 of 153 total
Tests:       534 skipped, 2544 passed, 3078 total
```

(The skipped suites are the live `[fuseki]` ones, which need a store of the run's own.) The new
tests fail without their fix: `tighten-only` "a property-less value shape registered after the
override is compared once it is" (1 failed, 13 passed without the `Package.ts` change), and all 5
of `data-only-relation-some.test.ts` without the `SelectQuery.ts` change.

`npx linked build` of core: `✔ Build successful`. `npx linked build-all` in the CN worktree:
`Successfully built: @_linked/core, @_linked/maps, @_linked/access, @semantu/execution-gateway,
@_linked/documents`.

CN `npm run test:regular`: quoted in CN report 192. It runs after this commit lands: in a worktree
with only core checked out, CN's typecheck sees two copies of core (the worktree's, and the main
checkout's through `@_linked/server` and `@_linked/fuseki`), and the gate fails with 77
`typeof X is not assignable to typeof Shape` errors unrelated to the change.

### Deviations

- **Order of verification.** Core landed before CN's regular set ran (see Verification); the set
  ran against this landed commit.
- **051 needed no change.** The caches were already one helper (`RegistryCache`), and
  `predicateTermCacheSize` no longer exists. The doc's open question (other registry-version
  caches) is answered by the same helper: every derived cache in core uses it.
- **062 §1, §2, §4 left in the trimmed doc.** §1 (a package that drops `loadData` is never
  pruned) needs the choice the doc asks (empty set vs orphan) across three sync modes; §2 needs a
  measurement first, and the `n3` import is already dynamic (a lazy chunk), with two more dynamic
  edges from `checkShapeHierarchy`, so moving `subClassClosure` alone changes nothing (added to
  the doc); §4 is a dependency change. §3 is fixed here.
- **050 open question 1** (class-only `.some()`: guess or fail): resolves through
  `resolveRelationShape` like other `sh:class`-only relations (it warns when several shapes
  target the class), and falls back to the base `Shape` when none does, rather than failing.
- **050 §2 API shape:** names, not `getRegisteredPackages()` returning `PackageMetadata`: the
  caller needs names only, and the metadata objects are the live registry entries.
  `getPackageBaseUri` and open question 2 (`getNodeShapeUri` reporting its fallback) were not
  added: with `isRegisteredPackage` the caller can tell already.

### Follow-ups

- `.select()`, `.where()`, `.selectAll()` on a set of data-only members still throw the same way
  (measured): backlog 084.
- 062 §1, §2, §4: backlog 062 (trimmed).

## Details

- The callback change keeps the order: the class's own `shapeCallbacks` first, then the node
  callbacks. Nothing depended on the node callbacks being skipped; the full suite passes.
- `memberShapeClass` checks every member has a `nodeShape` before asking
  `getLeastSpecificShape()`: a `sh:class`-only relation's set holds a bare `Shape` target, whose
  `nodeShape` is `undefined`, and `getLeastSpecificShapeClasses` read `.id` off it.
- Property access on a data-only set (`t.members.name`) used to throw `unresolvedValueShapeError`
  ("Shape class not found"), because the fallback went through `getQueryShapeClass` (authored
  only); it now resolves through the adapter, as single-valued access already did.
- Tests: `src/tests/data-only-relation-some.test.ts` (new: `sh:node` some with `equals` and with
  a member property, `sh:class` every/none, an untargeted `sh:class`, set property access);
  `tighten-only.test.ts` (one test); `core-utils.test.ts` (registry functions);
  `ontology-register-installed.test.ts` (`slashedPath` with `path.win32` and `path.posix`).
