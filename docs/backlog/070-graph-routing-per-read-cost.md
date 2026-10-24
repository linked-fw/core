---
summary: >
  `graphRoutingFor(dataset)` rebuilds the resolved route table and the owner scan (every
  registered shape's property shapes, for `contains`) on every read, write, `.into()` check and
  live-query dependency. Cache it per dataset and registration version, invalidated on route,
  shape and data-root changes; measure first.
packages: [core]
---

# 070 — Graph routing: per-read cost of the route table and the owner scan

Source: CN plan 071 §Graph routing, core report 051 (graph routing, review lows) and its review
fixes.

## Problem

Every call to `graphRoutingFor(dataset)` (`utils/graphRouting.ts`):

- resolves every stored route of the dataset under its data root (`resolvedTable`), and
- on the first read set it computes, scans every registered node shape and its property shapes
  to find the owners of each value shape (`ownersOf`), then walks super- and sub-shapes for the
  read set.

`SparqlDataset` calls it once per select, ask, count, create, update and delete (and the write
path twice: `resolveWriteGraph`, then the compile options); `queryDependencies` and
`mutationEffects` call it for every live template and change. The read sets are cached only for
the life of one routing object, so the work is repeated on each query. With a few hundred shapes
it is one pass over the registry per query; nothing measured it yet.

A delete by id adds one more scan (report 055): `referringGraphsForShape` walks every node shape's
property shapes to find the shapes that may link to the deleted shape, once when the delete is
compiled and once more in `mutationEffects`. A value shape → referring shapes index, built once per
cached routing object (like `ownersOf`), removes both.

## First questions

- Cache the routing object per dataset, keyed by a version that changes when a route is set or
  unset (`setShapeGraphs`, `unsetShapeGraph`), when the shape registry changes (core already has
  registry versions, `utils/registryCache.ts`) and when the dataset's data root changes
  (`dataRootOf` is read late on purpose: CN's store learns its root after construction).
- Measure first: compile-time share of a routed point read and a routed create with the current
  code, against the same with a cached routing (decision 9's fixture, report 051).
