---
'@_linked/core': patch
---

Errors for a shape that does not resolve name the scope only while a scoped `ShapeCatalog` is active (`withShapeCatalog`), as `Shape class not found for <Place> (property 'home' of '<Person>' points at it; not among the shapes in scope 'p1#main')`. Against the global registry the message ends after "points at it" (`… (property 'home' of '<Person>' points at it)`), and an error for a query's own shape is just its opening sentence. The opening of each message and the `shapeIri`, `property`, `propertyIri`, `ownerShapeIri` and `catalog` fields are unchanged.
