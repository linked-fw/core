---
summary: >
  The shape graph sync removes from the default graph only the shapes of packages the process
  registers. Shapes an earlier default-graph sync wrote for a package (or a shape) no longer in
  code stay there. Decide whether an opt-in sweep (`orphanScope: 'all'`) should also delete every
  default-graph `NodeShape` with a `core:shapeHash`.
packages: [core]
---

# 068 — Default-graph shapes of removed packages

Source: CN plan 071 §Shape graphs, core report 052 (shape graphs).

## Problem

`syncShapeGraphs` cleans the default graph once: every shape of the packages it writes that the
default graph still holds with a `core:shapeHash` is deleted there (with its owned subtree). That
covers the shapes the process registers, which is what the earlier sync wrote for it. Two cases
are left:

- A package (or a shape) removed from code before the app moved to shape graphs: its old
  default-graph shapes stay, because no package of the run names them. The earlier sync left them
  too unless it ran with an orphan scope.
- A dataset with several writers (CN's app data): another writer's default-graph shapes are
  deliberately not touched; they move when that writer moves to shape graphs.

## First questions

- Should `orphanScope: 'all'` also delete every default-graph `NodeShape` that has a
  `core:shapeHash` and is not in a shape graph? Only safe for a dataset with one writer, as the
  existing orphan scope.
- Or is a one-off script (CN's reset, `scripts/…`) the better home, once every writer is on shape
  graphs?
