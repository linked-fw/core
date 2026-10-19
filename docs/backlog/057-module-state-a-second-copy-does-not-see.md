---
summary: >
  Core state that a second copy of core does not share, and `instanceof` checks on core classes
  that a value from another copy fails. The shape registries, storage routing, query dispatch and
  live-query store are already on `globalThis`; these 14 values are not. Highest impact: the
  query-context map and its listeners, `LinkedFileStorage`'s stores, `nodeShapeCallbacks` and
  `packageBaseUri`. Fix with `sharedState` (same package).
packages: [core]
---

# 057 — Module state a second copy of core does not see

Source: the dual-copy survey in linked-fw/cli
([shared state and error brands](https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md)).
`sharedState`, `brandLinkedError` and `isLinkedError` exist; core's own error classes are
branded. What is left in core:

## Must be shared

| File | State | Written by → read by |
|---|---|---|
| `queries/QueryContext.ts:4` | `queryContext` Map | `setQueryContext` (app, auth) → `getQueryContext`, lowering. A context set on one copy never resolves on the other. |
| `queries/QueryContext.ts:37` | `contextListeners` Set | `subscribeQueryContext` (React layer) ← `setQueryContext`. Re-runs on context change are lost. |
| `utils/LinkedFileStorage.ts:33-41` | statics `defaultStore`, `url`, `stores`, `purposes` | `setDefaultStore` / `setStore` / `registerPurpose` (server config) → uploads. "No store" on the other copy. |
| `utils/LinkedErrorLogging.ts:10` | static `logger` | `setDefaultLogger` (`@_linked/sentry`) → `log()`. Errors miss Sentry. |
| `utils/Prefix.ts:7-8` | statics `uriToPrefix`, `prefixToUri` | `Prefix.add` at ontology import → SPARQL serialisation (loses prefixes; IRIs stay correct). |
| `utils/Package.ts:35-36` | `ontologies` Set, `_autoLoadOntologyData` | `linkedOntology()` / `autoLoadOntologyData()`. |
| `utils/Package.ts:211` | `export var DEFAULT_LIMIT` | `setDefaultPageLimit` → consumers' live binding. |
| `shapes/SHACL.ts:71` | `packageBaseUri` Map | `linkedPackage()` → `getPackageUri` / `getNodeShapeUri`. A private package's root falls back to linked.cm on the other copy. |
| `shapes/SHACL.ts:752` | `nodeShapeCallbacks` Map | `addNodeShapeCallback` → `getAndClearCallbacks`. The callback never fires if the target registers through the other copy. |
| `utils/ShapeClass.ts:230,410` | `adapterCatalogs`, `catalogAdapters` WeakMaps | `getOrCreateShapeAdapter`. An adapter built by one copy loses its catalog in the other. |
| `shapes/Shape.ts:76` | static `typesToShapes` | `Shape.registerByType`; nothing in core reads it. |

Statics that callers read as `Cls.x` keep their API as a static getter over the shared container.

## `instanceof` on core classes across copies

About 75 sites over 9 classes check a value that can come from another copy: `Shape` / `QueryShape`
(`QueryContext.ts:114,127`), `PendingQueryContext` (lowering and every builder), `FieldSet` /
`PropertyPath`, `ExpressionNode` / `ExistsCondition`, the query-builder proxies, and
`prototype instanceof Shape` in `ShapeClass.ts:905,969,983`. Other packages do the same:
`@_linked/react` (`instanceof QueryBuilder`, `ShapeSet`, `Shape`, 9 sites) and
`@_linked/server-utils` `JSONWriter.ts` / `LincdServerProxy.ts` (`instanceof Shape`, `ShapeSet`,
`CoreSet`). These are not errors, so `isLinkedError` does not cover them. The same brand, set on
the class and read along the prototype chain, gives an `isLinkedInstance(value, Cls)`; brand the
public classes and switch the cross-package checks first.

## Safe per copy (leave)

`RegistryCache` instances (keyed on the shared `registryVersion`), `cached.ts` / `live/keys.ts`
memos, warn-once flags, recursion-depth guards. `ExpressionNode._refCounter` stays per copy, but
two copies can mint the same `__ref_N__` placeholder if their expressions meet in one query.
