---
summary: >
  `.select()`, `.where()` and `.selectAll()` on a plural relation whose value shape has no authored
  class (a data-only `sh:node`, or `sh:class` only) still throw "Cannot read properties of
  undefined (reading 'shape')": they take the members' shape from `getLeastSpecificShape()`, which
  knows authored classes only. `.some()` / `.every()` / `.none()` and property access were fixed in
  report 081 through a relation-aware lookup these can reuse.
packages: [core]
---

# 084 — Sub-queries on a set of data-only members

Source: report 081 (the `.some()` fix of backlog 050), measured with a throwaway jest test.

## Problem

On a data-only `Team` with `members` (plural, `sh:node` → data-only `Member`):

- `t.members.select((m) => [m.name])` and `t.members.selectAll()` throw `Cannot read properties of
  undefined (reading 'shape')` (`FieldSet.forSubSelect` / `getUniquePropertyShapes` get
  `undefined`).
- `t.members.where((m) => m.name.equals('x'))` throws the same from `processWhereClause`.

`QueryShapeSet.where`, `select` and `selectAll` (`src/queries/SelectQuery.ts`) read
`this.getOriginalValue().getLeastSpecificShape()`, which resolves through `getQueryShapeClass`
(authored classes only, outside a catalog). The single-node `QueryShape.select` already falls back
to `resolveShapeConstructor`.

## First questions

- Use the module function `memberShapeClass(set)` (added for `.some()`) in all three, and in
  `as()`'s comparison? A test per entry point, data-only `sh:node` and `sh:class` only.
- For a `sh:class` relation with no shape targeting the class, should `select` / `selectAll` say
  "declare `sh:node`" rather than fall back to the base `Shape`?
