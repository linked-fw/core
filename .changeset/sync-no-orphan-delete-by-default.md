---
'@_linked/core': minor
---

`syncShapes()` no longer deletes store shapes it did not register, unless asked to.

The default `orphanScope` is now `'none'`: a sync delete→recreates the shapes registered in the
current process and leaves every other NodeShape in the dataset alone. Previously it defaulted to
`'all'` and treated every store shape not registered in the process as an orphan to cascade-delete.

That made partial loading destructive. Shapes are deep-importable one file at a time, and an
app-data dataset also holds shapes other writers put there, so "not registered here" does not mean
"removed from code". Measured on a dataset holding the 36 `@_linked/schema` shapes: a process that
imported only `@_linked/schema/shapes/Thing` (11 registered) deleted the other 25, under both
`'all'` and `'ownedNamespaces'`; a process that imported no shapes deleted all 36.

**Migrating:** a caller that relies on the sync removing shapes deleted from code must now pass
`{orphanScope: 'all'}` (sole writer, every shape loaded) or `{orphanScope: 'ownedNamespaces'}`
explicitly: `await syncShapes(ds, {orphanScope: 'all'})`.
