---
'@_linked/core': patch
---

Lowering a create or update no longer deletes the `shape` key from the caller's nested values.
`LiveQueryStore` lowers an executed mutation a second time to derive its effects, and a nested value
of a property that declares no shape (a property shape's `sh:path` when it is not a plain IRI) could
then no longer be validated: it logged `could not derive the effects of a mutation; live queries were
not refetched ShapeValidationError: Cannot validate the value of 'path'` and skipped the live-query
refetch. `syncShape` / `syncShapes` hit this for every shape with an inverse, sequence or alternative path.
