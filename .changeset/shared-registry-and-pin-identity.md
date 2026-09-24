---
'@_linked/core': patch
---

Dataset routing state is shared, and pins are keyed on shape identity.

**`LinkedStorage.shapeToDataset` and `defaultDataset` now live on the shared global**,
beside the shape registries. They were the one part of the routing model still held per
module copy, which left the package in a worse state than either extreme: a second copy
reported a fully populated shape registry while answering `isInitialised()` with `false`
and resolving every shape to the default dataset.

This also covers the previous release, which moved the shape registries to the shared
global and shipped without a changeset.

**New: `LinkedStorage.unsetDatasetForShape(classOrIri)`.** Removing a pin by deleting
from `getShapeToDatasetMap()` removes one class object, but resolution falls back to
matching on shape IRI — so another class claiming the same shape silently resurrects the
pin. The new method removes every entry for that identity:

```ts
LinkedStorage.unsetDatasetForShape(Project);                    // by class
LinkedStorage.unsetDatasetForShape('https://…/shape/x/Project'); // or by IRI
```

Pinning two different classes to one IRI with different datasets now **warns**, instead
of resolving by `Map` insertion order.

**New: `resolveShapeConstructor(iri)`**, the one way to get a constructor for a shape
IRI whether or not it has an authored class. Five call sites in the query layer spelled
this out by hand in four different ways.

`selectAll()` on an unregistered IRI now throws naming the shape, rather than failing
later with `Cannot read properties of undefined (reading 'shape')`.
