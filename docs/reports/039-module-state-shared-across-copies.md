---
summary: >
  A second copy of core in one runtime now shares core's module state (17 values in 10
  `sharedState` containers) and accepts the other copy's values: `brandLinkedClass` /
  `isLinkedInstance(value, Cls)` extend the error brands to any class, 19 public classes are
  branded, core's own 63 class checks use them, and `UnresolvedShapeError` is branded. Built on
  `sharedState` / `brandLinkedError` / `isLinkedError` (2.36.0, minor); the copy sharing shipped in
  2.36.2, the memoised brand lookup in 2.36.3, and a cheap failed check (backlog 058, query
  building back within 2% of 2.36.1) in the patch after it.
packages: [core]
---

# 039 — Module state shared across copies; class brands and `isLinkedInstance`

Source: backlog 057 (removed with this report), from the dual-copy survey in linked-fw/cli
([shared state and error brands](https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md),
cli report 020). Core 2.36.0 had added `sharedState`, `brandLinkedError` and `isLinkedError` and
branded core's own errors (next section); 2.36.2 and 2.36.3 finish core's part of that convention.

## Base: `sharedState` and error brands (2.36.0)

The core half of linked-fw/cli backlog 017. Both helpers are exported from the package root:

```ts
sharedState<T extends object>(pkg: string, name: string, init: () => T): T  // utils/sharedState.ts
sharedStateKey(pkg: string, name: string): symbol                           // Symbol.for('<pkg>:<name>')
brandLinkedError<C>(Cls: C, pkg: string, name: string): C                   // utils/linkedError.ts
isLinkedError<C>(err: unknown, Cls: C): err is InstanceType<C>
linkedErrorBrand(pkg: string, name: string): symbol
```

- `sharedState` returns `globalThis[Symbol.for('<pkg>:<name>')]`, calling `init` only when the
  first copy asks; every later copy gets the same object.
- `brandLinkedError` puts `Symbol.for('<pkg>:<name>')` on the class's prototype. `isLinkedError`
  matches an instance from any copy of the defining module, and a subclass instance against its
  base; an unbranded class falls back to `instanceof` and does not inherit its base's brand.
- 2.36.0 branded `UnresolvedContextError` and `ShapeValidationError`; the two catch sites for
  `UnresolvedContextError` (`QueryBuilder`, `LiveQueryStore`) use `isLinkedError`.
- Test: `src/tests/shared-state-and-error-brands.test.ts` (8 tests at the time) evaluates a second
  copy of each module with `jest.isolateModulesAsync` and shows one shared value, `init` called
  once, names kept apart, and cross-copy, subclass, unbranded and hand-set brand matching.
- The survey of core state a second copy did not yet see was filed as backlog 057, which the
  sections below implement.

```ts
import {sharedState, brandLinkedError, isLinkedError} from '@_linked/core';
const state = sharedState('@_linked/my-pkg', 'Registry', () => ({items: new Map()}));
export class MyError extends Error {}
brandLinkedError(MyError, '@_linked/my-pkg', 'MyError');
if (isLinkedError(err, MyError)) { /* also true for one thrown by another copy */ }
```

## Problem

A framework module can be evaluated twice in one runtime: under `linked start` once by Vite's SSR
module runner and once by Node, and in a browser when two bundles each carry a copy. The shape
registries, storage routing, query dispatch and live-query store were already on `globalThis`.
The rest of core's module state was not, so a value written through one copy was invisible to
the other (a query context set by auth never resolved, a file store configured by the server was
"no store", Sentry never saw errors), and every `instanceof` on a core class failed for a value
made by the other copy.

## What is shared now

Each container is `globalThis[Symbol.for('@_linked/core:<name>')]`, created by the first copy that
asks. Statics callers read as `Cls.x` keep their API as static getters (and setters where they were
assignable) over the container.

| `sharedState` name | File | Values |
|---|---|---|
| `QueryContext` | `queries/QueryContext.ts` | `contexts` (the context map), `listeners` (`subscribeQueryContext`) |
| `LinkedFileStorage` | `utils/LinkedFileStorage.ts` | `defaultStore`, `url`, `stores`, `purposes` |
| `LinkedErrorLogging` | `utils/LinkedErrorLogging.ts` | `logger` |
| `Prefix` | `utils/Prefix.ts` | `uriToPrefix`, `prefixToUri` |
| `Package` | `utils/Package.ts` | `ontologies`, `autoLoadOntologyData`, `defaultLimit`, `limitBindings` |
| `SHACL.packageBaseUri` | `shapes/SHACL.ts` | the package → publish-root map |
| `SHACL.nodeShapeCallbacks` | `shapes/SHACL.ts` | callbacks waiting for a node shape |
| `ShapeClass.adapterCatalogs` | `utils/ShapeClass.ts` | adapter class → the catalog that built it |
| `ShapeClass.catalogAdapters` | `utils/ShapeClass.ts` | catalog → its adapters by IRI |
| `Shape.typesToShapes` | `shapes/Shape.ts` | `typesToShapes` (static getter and setter; assigning replaces the shared map) |

17 values in all (the backlog's 14 rows counted `LinkedFileStorage`'s statics and the adapter
WeakMaps as one each).

Left per copy, as the convention says: `LinkedFileStorage.loggedFallbacks` (log-once flags),
`RegistryCache` instances, `cached.ts` / `live/keys.ts` memos, warn-once flags, recursion guards,
and `ExpressionNode._refCounter` (two copies can still mint the same `__ref_N__` placeholder if
their expressions meet in one query; no case of that is known).

### `DEFAULT_LIMIT`

`export var DEFAULT_LIMIT` is an ESM live binding, which another module cannot redirect. Each copy
registers a setter for its own binding in `limitBindings`; `setDefaultPageLimit` stores the limit
in the container and calls every copy's setter, so `import {DEFAULT_LIMIT}` from either copy
follows a call through either. New `getDefaultPageLimit()` reads the container directly and is the
form to prefer. A container created by an older copy lacks `defaultLimit` / `limitBindings`; the
module fills them in (`??=`) rather than assuming the layout.

## Class brands and `isLinkedInstance`

`utils/linkedError.ts` gains two exports (also on the package index):

```ts
brandLinkedClass<C extends Function & {prototype: object}>(Cls: C, pkg: string, name: string): C
isLinkedInstance<T>(value: unknown, Cls: Function & {prototype: T}): value is T
```

- `brandLinkedClass` is `brandLinkedError` for any class, and `brandLinkedError` now delegates to
  it: the class gets the same static key (`Symbol.for('@_linked/core:errorBrand')`) naming its brand
  `Symbol.for('<pkg>:<name>')`, and the prototype carries the brand. So a branded error is also a
  linked instance, and the brands interoperate with copies that predate this release.
- `isLinkedInstance` returns `value instanceof Cls` when that is true. Otherwise, for a branded
  `Cls`, it walks `Object.getPrototypeOf` from the value and checks each prototype for the brand
  with `hasOwnProperty`. It never reads the brand off the value itself, because the query-builder
  proxies' `get` trap throws on undecorated keys; `getPrototypeOf` on a proxy is what `instanceof`
  already uses. An unbranded `Cls` (or an unbranded subclass of a branded one) falls back to plain
  `instanceof`, so a user's shape class is not matched by its base's brand.
- `isLinkedInstance(Sub.prototype, Cls)` answers `Sub.prototype instanceof Cls`, i.e. "does `Sub`
  extend `Cls`".
- The class parameter is typed `Function & {prototype: T}`, not `abstract new (...) => T`: the
  latter rejects classes with a `private` constructor (`FieldSet`, the builders), which are among
  the classes to check.

Usage in another package:

```ts
import {isLinkedInstance, Shape, QueryBuilder} from '@_linked/core';
if (isLinkedInstance(input, Shape)) return input.id;
if (isLinkedInstance(requiredData, QueryBuilder)) { /* … */ }
```

### Branded classes (19)

`Shape`, `CoreSet`, `ShapeSet`, `SelectBuilder` (exported also as `QueryBuilder`), `CreateBuilder`,
`UpdateBuilder`, `DeleteBuilder`, `AskBuilder`, `CountBuilder`, `PendingQueryContext`, `FieldSet`,
`PropertyPath`, `ExpressionNode`, `ExistsCondition`, `QueryBuilderObject`, `QueryShape`,
`QueryShapeSet`, `QueryPrimitive`, `QueryPrimitiveSet`. Each is branded `'@_linked/core'` with its
class name, on the line after the class.

### Core's own checks switched

All 60 `x instanceof <core class>` sites in `src/` (outside tests) now call `isLinkedInstance`, in
`QueryBuilder`, `IRLower`, `QueryContext`, `UpdateBuilder`, `FieldSet`, `DslJsonExpression`,
`AskBuilder`, `SelectQuery`, `lower`, `ProxiedPathBuilder`, `MutationSerialization`,
`DeleteBuilder`, `CountBuilder`, `Shape`, `cached`, `Expr` and `ExpressionNode`; plus the three
`prototype instanceof` subclass tests in `ShapeClass.ts` (`hasSuperClass`,
`filterShapesToMostSpecific`, `filterShapesToLeastSpecific`). The fast path is still `instanceof`,
so a same-copy value costs one extra call.

### Errors

`UnresolvedShapeError` (`utils/unresolvedShape.ts`, core#350) is now branded, so
`isLinkedError(err, UnresolvedShapeError)` matches one thrown by another copy. Core's three error
classes (`UnresolvedShapeError`, `UnresolvedContextError`, `ShapeValidationError`) are all branded.

## Known limits

- **Cost of a failed check.** A failed `isLinkedInstance` on a plain object or array costs about
  15 ns and on a query proxy about 45 ns (jest, CPU time), against about 3 ns for a failed
  `instanceof` (a pass is the `instanceof` fast path). Fine once per value a builder sees; do not
  use it per result row.
- **Query-building cost.** `src/tests/query-compile-timing.test.ts`, ms per 1000 queries, 10
  alternating runs each (the timing file only, no Fuseki):

  | Case | 2.36.1 (before) best / median | 2.36.2 (prototype walk) best / median | 2.36.3 (memo) best / median |
  |---|---|---|---|
  | select | 49.07 / 51.53 | 67.44 / 77.11 (+50%) | 55.01 / 60.28 (+17%) |
  | create | 121.07 / 125.84 | 149.96 / 164.12 (+30%) | 137.21 / 151.14 (+20%) |

  Backlog 058 (removed with this update) found the remaining cost. It was not the walk or the
  memo: the miss path read the built-ins `Object.getPrototypeOf`, `Object.prototype` and
  `Object.prototype.hasOwnProperty` by their global names on every call. Inside a `vm` context,
  which is where jest runs each test file, every global-name read goes through the context's
  interceptor at about 150 ns, so a failed check cost about 500 ns there. The fix, in `utils/linkedError.ts`:

  - the built-ins are read once into module constants;
  - a value whose prototype is `Object.prototype`, `Array.prototype` or `Function.prototype`
    (most misses: mutation data, arrays, callbacks) returns `false` before any lookup, since a
    brand is only ever defined on a class's own prototype;
  - the per-prototype memo is keyed by the class rather than its brand, so a repeat check never
    reads the class's static brand.

  And in `FieldSet.convertTraceResult`, the `FieldSet` and `ExpressionNode` checks moved after the
  query-proxy branch: every leaf of a select callback is a proxy, none of the duck-typed branches
  before them can match a `FieldSet` or an `ExpressionNode`, and a failed check on a proxy is the
  dearest kind. No call site went back to plain `instanceof`, so every check still accepts the
  other copy's value.

  After the fix, same method, 10 alternating runs, the same session for all three:

  | Case | 2.36.1 best / median | 2.36.3 best / median | this fix best / median |
  |---|---|---|---|
  | select | 48.69 / 50.36 | 53.56 / 54.94 (+9.1%) | 49.80 / 50.45 (+0.2%) |
  | create | 117.90 / 126.41 | 135.10 / 137.42 (+8.7%) | 121.55 / 126.96 (+0.4%) |

  The machine was under load (load average 4 to 10), so 2.36.3's gap reads smaller than in the
  table above; a repeat of the 2.36.1 / fix pair gave select 49.93 / 49.84 (-0.2%) and create
  123.27 / 125.19 (+1.6%) medians. In a CPU profile of the create case, `isLinkedInstance` is now
  about 1% of the time.
- **Test isolation.** `jest.resetModules` / `jest.isolateModules` no longer reset core's shared
  state: it lives on `globalThis`, which a module reset keeps. A test that needs clean state resets
  it explicitly (`LinkedFileStorage.resetForTests()`, `setQueryContext(name, null)`, assigning
  `Shape.typesToShapes`, …). Each jest test file still gets its own `globalThis`.
- **Container names must not equal a brand name.** Both are `Symbol.for('<pkg>:<name>')`; a
  container under a class's brand key puts the brand on `globalThis`, so anything inheriting from
  it would pass `isLinkedInstance`. Hence `Shape.typesToShapes`, not `Shape`; the two-copies test
  checks no container sits under a brand key.

## Tests

- `src/tests/two-copies-built.test.ts` (new, 39 tests): loads the **built** `lib/esm` twice in one
  test runtime, the second time as a whole new module graph with `jest.isolateModulesAsync`, and
  shows for each container that a write through one copy is read by the other (query context set
  with the other copy's shape target, a pending context resolving later, listeners, file stores and
  purposes, the logger, prefixes, the page limit on the getter and on both `DEFAULT_LIMIT`
  bindings, ontology auto-load, publish roots, node-shape callbacks, catalog adapters,
  `typesToShapes`, including replacing it by assignment), and that no container sits under a brand key. It then checks each of the 19 classes and 3 errors across copies with
  `isLinkedInstance` / `isLinkedError`, subclass and prototype matching, the unbranded fallback,
  and `asContextRef` accepting the other copy's `PendingQueryContext`. It needs `linked build`
  first (CI builds before it tests) and fails with that message when `lib/esm` is missing.
  Against `main`'s code the file (then 37 tests) fails 36 of 37 (only "are distinct copies" passes).
- `src/tests/two-copies-entry-points.test.ts` (11 tests, with backlog 058): this copy's source and
  the built `lib/esm` as the other copy. Each public entry point that takes a caller's
  `PendingQueryContext`, `FieldSet` or `ExpressionNode` (`asContextRef`, `SelectBuilder.for`,
  `UpdateBuilder.for`, `DeleteBuilder.from`, `AskBuilder.forNode`, `CountBuilder.of`, a mutation
  field value serialized and lowered, a select subject lowered, `select(FieldSet)`,
  `toIRExpression` / `Expr`, a `where` clause) gives the same result for the other copy's value
  as for its own. With plain `instanceof` at `SelectBuilder.for`, `select(FieldSet)`,
  `toIRExpression` and `isExpressionNode`, 4 of the 11 fail.
- `src/tests/shared-state-and-error-brands.test.ts`: 6 new `isLinkedInstance` cases (a second
  copy of `linkedError`, a private-constructor class, subclass and prototype matching, the
  unbranded fallback, a proxy whose `get` throws on symbols, primitives).
- Full suite: 107 suites passed, 2367 tests passed (120 skipped), 304 live Fuseki tests passed;
  `typecheck` and `check:dts` clean.

## Documentation

- `README.md`: the shared-state section now covers `isLinkedInstance` / `brandLinkedClass`, the
  branded classes, and which module state core shares.
- Changeset `.changeset/core-057-shared-state.md` (patch).

## Follow-ups

- **`@_linked/react` backlog 001** switches react's 9 `instanceof` sites (`Shape`, `ShapeSet`,
  `QueryBuilder`) to `isLinkedInstance`; done in parallel in that repo.
- **`@_linked/server-utils`** `JSONWriter.ts` / `LincdServerProxy.ts` still use
  `instanceof Shape` / `ShapeSet` / `CoreSet`; switch when that package is next touched.
- **linked-fw/cli `docs/architecture/shared-state-and-error-brands.md`**: §4 and the core row of
  the status table still point at core backlog 057; they should point at this report and list
  `isLinkedInstance` as available from the release this change ships in.
- `ExpressionNode._refCounter` placeholder collisions across copies stay a known, unobserved risk.

## PRs

- https://github.com/linked-fw/core/pull/349 — `sharedState`, error brands (2.36.0)
- https://github.com/linked-fw/core/pull/355 — shared module state, `isLinkedInstance`, class brands (2.36.2)
- https://github.com/linked-fw/core/pull/357 — memoised `isLinkedInstance` lookup (2.36.3)
- https://github.com/linked-fw/core/pull/360 — cheap failed `isLinkedInstance` check (backlog 058)
