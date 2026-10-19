---
"@_linked/core": patch
---

Errors for a shape that does not resolve name the property that points at it, the shape that declares that property, and the active catalog: `Shape class not found for <Place> (property 'home' of '<Person>' points at it; catalog 'p1#main' does not hold it)`. The errors stay plain `Error`s (and `ShapeValidationError` for `validate`), now thrown as `UnresolvedShapeError` with `shapeIri`, `property`, `propertyIri`, `ownerShapeIri` and `catalog` fields. `fromJSON` no longer reads a relation's sub-fields against the parent shape when the relation's value shape does not resolve; it throws the same error.
