---
'@_linked/core': patch
---

A shape authored in a project now resolves in queries, as documented.

`registerRuntimeShape` deliberately synthesizes no class — consumers needing a
constructor are meant to get one from `getOrCreateShapeAdapter`. The query
layer never adopted that: five call sites resolved shapes with `getShapeClass`
alone, which answers `undefined` for every data-only shape.

The failures landed well away from the lookup:

```
Error: Shape class not found for https://linked.cm/shape/my-project/Author
TypeError: Cannot read properties of undefined (reading 'shape')
```

The second came from a sub-select, where the undefined class was handed to
`FieldSet.forSubSelect` and only failed when it read `.shape` off it.

`MutationQuery` (update callbacks, nested value shapes) and `SelectQuery`
(value-shape resolution, `select()` and `selectAll()` sub-selects) now fall
back to the adapter. `getShapeClass` is unchanged and still reports only
shapes with a real authored class.
