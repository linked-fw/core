---
summary: >
  Three separate walks answer "what does this shape inherit", and two of them read the JS
  prototype chain and fall back to own-properties-only when a shape has no class. A shape
  registered from data therefore cannot resolve an inherited property — the failure #211 set
  out to fix, for the sub-case where there is no compiled class.
status: Done
---

# 040 — inheritance walks that ignore `nodeShape.extends`

> **Done.** `getSuperShapes` is now the single canonical walk; `getPropertyShapes` and
> `getPropertyShape` both delegate to it, so the singular and plural lookups cannot
> disagree and a shape known only as data resolves what it inherits through `extends`.
> Because `getPropertyShapeByLabel` delegates to `getPropertyShape` (PR #211), the query
> proxies get the fix for free. The description below is kept as the record of what was
> wrong.

## The behaviour

Three functions answer the same question, in three different ways:

| Function | Where | How it walks |
|---|---|---|
| `getSuperShapesClasses` / `hasSuperClass` | `utils/ShapeClass.ts` | `prototype instanceof` |
| `getPropertyShapes(shape, true)` | `shapes/nodeShapeData.ts` | prototype chain via `getShapeClass`, else **own only** |
| `getPropertyShape(shape, label, true)` | `shapes/nodeShapeData.ts` | prototype chain via `getShapeClass`, else **own only** |

The last two share a fallback:

```ts
let shapeClass = getShapeClass(nodeShape.id);
if (!shapeClass) {
  return ownPropertyShapes(nodeShape); // inherited properties are simply absent
}
```

`NodeShapeData.extends` is never consulted. For a shape declared by a `@linkedShape` class the
prototype chain and `extends` agree — `applyLinkedShape` derives the latter from the former — so
the gap is invisible. For a shape that exists only as data it is not: the walk stops at the
shape's own properties and everything it inherits is missing, with no error.

## Why it matters

This is the failure mode [#211](https://github.com/linked-fw/core/pull/211) set out to fix —
*"Create Now registers imported project Shapes at runtime … relationship queries and CMS
operations for imported Shapes fail or return empty results"* — for the sub-case where the shape
has no compiled class. #211 correctly removed the duplicated chain walk in
`getPropertyShapeByLabel` by delegating to `getPropertyShape`, but `getPropertyShape` carries the
same own-only fallback, so the delegation inherits the gap rather than closing it.

Create Now's data manager reads project-authored shapes straight from materialized SHACL, where
`extends` is the only record of inheritance there is. A child shape whose parent holds the
label property renders a table with no label column, and no error is raised.

## Two shapes of the same bug

1. **A missing walk.** `extends` is not read, so data-only inheritance does not exist.
2. **Walks that can disagree.** Because there is more than one, they can return different chains
   for the same shape. That is not hypothetical: a caller that lists property labels from one walk
   and resolves each label through another will request a property the second walk cannot find,
   and the query proxy throws `"<Shape>.<prop> is accessed in a query, but it does not have a
   @linkedProperty decorator"` — a message that points at the decorator rather than at the walk.

## Direction

Collapse to one canonical walk that both strategies feed:

- a class-backed shape walks its prototype chain — authoritative, and it includes the framework
  `Shape` root, whose own `label` / `type` property shapes really are inherited and which
  `applyLinkedShape` deliberately does not record as `extends` (it is not a domain shape and must
  not appear as an `extends` triple in materialized SHACL);
- a shape known only as data walks `extends` through the shape registry.

Then `getPropertyShapes`, `getPropertyShape` and `getSuperShapesClasses` all delegate to it, and
cannot drift apart.

## Related

- The Create Now plan that surfaced this: `docs/plans/042-shape-metamodel-collapse-and-data-manager.md`
  in the Create Now repo. Its metamodel work unified `getSuperShapes` with `getPropertyShapes`;
  the follow-up commit here brought `getPropertyShape` (singular) onto the same walk, which is
  what closed this item.
- [#211](https://github.com/linked-fw/core/pull/211) — removed the duplicated walk at the
  `getPropertyShapeByLabel` call site.
- Both call sites of `getPropertyShapeByLabel` (`queries/SelectQuery.ts`, `shapes/Shape.ts`) do
  guard the `undefined` that #211's signature now admits, so there is no crash to fix there.
