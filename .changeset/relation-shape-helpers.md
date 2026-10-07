---
'@_linked/core': minor
---

Add helpers for relation properties declared with `sh:class` alone, so callers can find the shape a relation's values go through.

New in `@_linked/core/utils/ShapeClass`:

- `getTargetClassId(shape, shapes?)`: the class a shape's instances are typed with. It returns the shape's own `targetClass`, or else the first one it finds through `extends`, or `undefined`. It accepts a shape IRI, a `{id}`, shape data or wire metadata, or a shape class, and it never throws.
- `getShapesForTargetClass(classIri, shapes?)`: the least specific shapes whose own or inherited `targetClass` is exactly `classIri`, sorted by id. A shape that extends another match is left out. If an `extends` cycle would leave out every match, all matches are kept.

New module `@_linked/core/shapes/relationShape`:

- `isRelation(property)`: true when the property has `sh:node`, has `sh:class`, or has an IRI or blank-node `sh:nodeKind`.
- `rangeClassOf(property, shapes?)`: the declared `sh:class`, or else the `targetClass` of the property's `sh:node` shape.
- `resolveRelationShape(property, shapes?)`: returns `{shapeId?, candidates, source: 'node' | 'class' | 'none'}`. A declared `sh:node` always wins. Otherwise the shapes from `getShapesForTargetClass` are the candidates, and the first one is used. If more than one unrelated root qualifies, it logs one warning per class and candidate set.

Pass `shapes` (for example, an app's own shape catalog) to resolve among that set. Without it, lookups use the shape registry.

```ts
import {getTargetClassId, getShapesForTargetClass} from '@_linked/core/utils/ShapeClass';
import {isRelation, resolveRelationShape} from '@_linked/core/shapes/relationShape';

getTargetClassId('https://example.org/shapes/Employee'); // inherited through extends
getShapesForTargetClass('https://schema.org/Person', catalog); // the root shapes only

if (isRelation(property)) {
  const {shapeId, source} = resolveRelationShape(property, catalog);
  // shapeId is undefined when no shape targets the class
}
```

A relation never upgrades itself to a sub-shape. Suppose `Person` and `Employee extends Person` both target `schema:Person`. A `sh:class schema:Person` relation then resolves to `Person`, with no warning. To use `Employee`, declare `sh:node`.

**Behaviour change:** validation now treats a property with `sh:class` as node-valued, the same way it treats one with `sh:node`. Creates and updates are validated, so a write that passes a bare literal (such as a string) for a `sh:class` property is now rejected. Pass a reference (`{id}`) instead.
