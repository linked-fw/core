---
'@_linked/core': patch
---

A second copy of core in one runtime now sees the same module state and accepts the other copy's
values. The query-context map and its listeners, `LinkedFileStorage`'s stores, `LinkedErrorLogging`'s
logger, `Prefix`'s maps, ontology registrations and `autoLoadOntologyData`, the default page limit
(`DEFAULT_LIMIT` follows `setDefaultPageLimit` from any copy; new `getDefaultPageLimit()`), package
publish roots, node-shape callbacks, catalog adapters and `Shape.typesToShapes` are kept with
`sharedState`. New `brandLinkedClass(Cls, pkg, name)` and `isLinkedInstance(value, Cls)` extend the
error brands to any class: core brands `Shape`, `ShapeSet`, `CoreSet`, the six query builders,
`PendingQueryContext`, `FieldSet`, `PropertyPath`, `ExpressionNode`, `ExistsCondition` and the five
query-proxy classes, and its own class checks use `isLinkedInstance`. `UnresolvedShapeError` is now
branded, so `isLinkedError(err, UnresolvedShapeError)` matches one thrown by another copy.
