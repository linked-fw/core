---
summary: >
  A second copy of core in one runtime now shares core's module state (17 values in 10
  `sharedState` containers) and accepts the other copy's values: `brandLinkedClass` /
  `isLinkedInstance(value, Cls)` extend the error brands to any class, 19 public classes are
  branded, core's own 63 class checks use them, and `UnresolvedShapeError` is branded. Patch.
packages: [core]
---

# 039 — Module state shared across copies; class brands and `isLinkedInstance`

Source: backlog 057 (removed with this report), from the dual-copy survey in linked-fw/cli
([shared state and error brands](https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md),
cli report 020). Core 2.36.0 had added `sharedState`, `brandLinkedError` and `isLinkedError` and
branded core's own errors; this finishes core's part of that convention.

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
| `Shape` | `shapes/Shape.ts` | `typesToShapes` |

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

## Tests

- `src/tests/two-copies-built.test.ts` (new, 37 tests): loads the **built** `lib/esm` twice in one
  test runtime, the second time as a whole new module graph with `jest.isolateModulesAsync`, and
  shows for each container that a write through one copy is read by the other (query context set
  with the other copy's shape target, a pending context resolving later, listeners, file stores and
  purposes, the logger, prefixes, the page limit on the getter and on both `DEFAULT_LIMIT`
  bindings, ontology auto-load, publish roots, node-shape callbacks, catalog adapters,
  `typesToShapes`). It then checks each of the 19 classes and 3 errors across copies with
  `isLinkedInstance` / `isLinkedError`, subclass and prototype matching, the unbranded fallback,
  and `asContextRef` accepting the other copy's `PendingQueryContext`. It needs `linked build`
  first (CI builds before it tests) and fails with that message when `lib/esm` is missing.
  Against `main`'s code the same file fails 36 of 37 (only "are distinct copies" passes).
- `src/tests/shared-state-and-error-brands.test.ts`: 6 new `isLinkedInstance` cases (a second
  copy of `linkedError`, a private-constructor class, subclass and prototype matching, the
  unbranded fallback, a proxy whose `get` throws on symbols, primitives).
- Full suite: 107 suites passed, 2365 tests passed (120 skipped), 304 live Fuseki tests passed;
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
