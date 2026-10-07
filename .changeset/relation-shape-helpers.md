---
'@_linked/core': minor
---

Add relation-shape helpers. `getTargetClassId(shape, shapes?)` (non-throwing; inherits through `extends`) and `getShapesForTargetClass(classIri, shapes?)` in `utils/ShapeClass`: the least specific shapes whose effective targetClass (own, or inherited through `extends`) is exactly `classIri` — any shape that extends another match is dropped, leaving the roots — sorted by id (registry default cached per registry version); if an `extends` cycle would drop them all, every match is kept, sorted by id. New `@_linked/core/shapes/relationShape` module with `isRelation`, `rangeClassOf` and `resolveRelationShape`, which resolves a `sh:class`-only relation to a shape at read time and warns once per class and candidate set when more than one unrelated root qualifies. A relation never upgrades itself to a sub-shape: with `Person` and `Employee extends Person` both targeting the class, a `sh:class` relation resolves to `Person` (no warning); a declared `sh:node` always resolves to exactly that shape.

Behaviour change: validation now treats a property with `sh:class` as node-valued, like one with `sh:node`. Because creates and updates are validated, a write that gives a bare literal (e.g. a string) for a `sh:class` property is now rejected; pass a reference (`{id}`) instead.
