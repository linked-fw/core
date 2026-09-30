---
summary: >
  Since #285, `syncShapes()` never prunes by default (`orphanScope: 'none'`), because "not
  registered in this process" turned out not to mean "deleted from code" and the old default
  deleted 25 of 36 shapes (or 36 of 36) on boot. The cost is that a shape renamed or removed in
  code now lingers in the store forever. Proposal (option C): every writer tags the NodeShapes it
  materializes with its own id, and a new `orphanScope: 'owned'` prunes only shapes carrying that
  writer's tag that are no longer in its code. Exploratory; several open questions, the hardest
  being what "removed" means for a process that loads only part of its shapes.
packages: [core, server]
---

# 046 — Provenance-scoped shape pruning

**Status: open, not started.** Follow-up named in [#285](https://github.com/linked-fw/core/pull/285)
and [linked-fw/server#117](https://github.com/linked-fw/server/pull/117).

## Where this starts

Boot sync (`LinkedServer.materializeShapesIntoStore` → `syncShapes(appData)`) used to default to
`orphanScope: 'all'`: every NodeShape in the store that was not registered in the current process
was cascade-deleted. The registry only holds what the process happened to import, which is
routinely a subset of the dataset. Measured on a dataset holding the 36 `@_linked/schema` shapes,
fresh node process per step (from #285):

```
load=thing registered=11 sync=default | before=36 after=11 deleted=25
load=none  registered=0  sync=default | before=36 after=0  deleted=36
```

`'ownedNamespaces'` does not help, because a namespace is the whole package: a deep import of one
shape file still claims all of it.

#285 / server#117 made `'none'` (upsert only) the default. `'all'` and `'ownedNamespaces'` stay
opt-in, and `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true` opts the server into `'all'`.

## The gap this leaves

With `'none'`, nothing is ever removed:

- a shape **renamed** in code is written under its new IRI, and the old IRI stays in the store with
  its property shapes, lists and paths;
- a shape **deleted** from code stays;
- consumers that list shapes from the store (e.g. Create Now's shape catalog, `/api/shapes`) keep
  showing them.

Today the only cleanup is a manual `orphanScope: 'all'` run from a process that has loaded every
shape the dataset should hold — which is exactly the precondition that is hard to guarantee.

## Proposal — option C: the writer owns what it wrote

1. **Tag on write.** Every writer tags each NodeShape it materializes, e.g.
   `<shape> linked:materializedBy <writerId>`. `writerId` identifies the writer, not the process:
   an app, a package, or a CN capability (`bindShape` / `enableCapability`).
2. **New mode `orphanScope: 'owned'`** (taking a `writerId`). Pruning candidates are only the store
   shapes tagged with *this* writer's id that are not in its current code. Untagged shapes and
   shapes tagged by other writers are never touched.
3. `'none'` stays the default until `'owned'` has been measured on real datasets; the server could
   then switch `materializeShapesIntoStore` to `'owned'` with the app as writer.

Compared with the existing modes: `'all'` assumes a single, complete writer; `'ownedNamespaces'`
assumes a writer owns whole packages; `'owned'` assumes only that a writer owns what it wrote.

## Open questions

- **What "removed" means for a partial loader.** A writer that deep-imports 11 of 36 shapes has
  written only those 11, but on a later boot it may import a different subset (a lazy route, a
  script, a test). Without a statement of the writer's *complete* shape set, "tagged by me, not
  loaded now" is the same false inference `'all'` made. Does this need a build-time manifest of
  every shape a writer can register (the cli already loads every compiled shape module in its
  "Checking shape references" / "Checking shapes/index" steps, so it could emit one), and should
  `'owned'` refuse to prune without it?
- **Several writers, one shape.** Two apps sharing a dataset may both materialize
  `schema/Person`. The tag must be a set (one triple per writer), and a shape is pruned only when
  the last writer drops it. Pruning by one writer should remove only its own tag otherwise.
- **Existing untagged shapes.** Every shape in every dataset today is untagged. Leaving them alone
  is safe but means today's leftovers are never cleaned; adopting them (tag everything the first
  `'owned'` sync sees in code) cannot tell a live shape from a stale one. Is a one-off migration
  (explicit `'all'` from a known-complete process, then tag) the answer?
- **Writer-id stability.** What is the id — package name, app IRI, deployment? It must survive
  renames of the app, branches (arch-06), and redeploys; a changed id orphans every shape the old
  id tagged, and they would then never be pruned.
- **Graph placement vs the delete→recreate cascade.** `syncShapes` deletes each code shape with its
  owned subtree and recreates it. A tag stored as a property of the NodeShape is deleted by that
  cascade, so writer A's sync would erase writer B's tag. Either the create must merge existing
  tags, or tags live outside the shape's owned subtree (a separate graph or a sidecar resource),
  which then needs its own cleanup when the shape is pruned.
- **Rename migration.** Renaming a shape is delete + create under a new IRI; any instance data
  typed with the old `sh:targetClass` or referencing the old shape IRI is unaffected by pruning the
  shape but may be orphaned in meaning. Should a rename be declared (old IRI → new IRI) so the
  sync can migrate or at least report it, rather than prune silently?

## Related

- [#285](https://github.com/linked-fw/core/pull/285) — `syncShapes` defaults to `'none'`.
- [linked-fw/server#117](https://github.com/linked-fw/server/pull/117) — the server passes the mode
  explicitly and logs it.
- `src/shapes/syncShapes.ts` — `SyncShapesOptions.orphanScope`, the sweep in step 3.
- [025](025-storage-config-and-graph-management.md) — storage config and graph management (graph
  placement of the tags).
