---
'@_linked/core': minor
---

Add relation-shape helpers. `getTargetClassId(shape, shapes?)` (non-throwing; inherits through `extends`) and `getShapesForTargetClass(classIri, shapes?)` (exact targetClass match, most specific first then by id; registry default cached per registry version) in `utils/ShapeClass`. New `@_linked/core/shapes/relationShape` module with `isRelation`, `rangeClassOf` and `resolveRelationShape`, which resolves a `sh:class`-only relation to a shape at read time and warns once per class when several shapes qualify. Validation now treats a property with `sh:class` as node-valued, like one with `sh:node`.
