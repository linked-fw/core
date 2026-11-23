---
summary: Per-key sort directions (a `thenBy`) for the grouped builder's `orderBy` and a nested select's `.orderBy()`, which still take one direction for all their keys.
packages: [core]
---

# 109 — Per-key directions in grouped and nested-select sorting

## Context

Report 116 added `SelectBuilder.thenBy(fn, direction)`: a select's sort keys can now each have
their own direction (`orderBy(p => p.birthDate, 'DESC').thenBy(p => p.name)`). Two other sorts were
left out of that step on purpose (plan 006 (report 125), decision 5: "the grouped builder is out of scope"):

- **Grouped select** — `GroupedSelectBuilder.orderBy(fieldOrFields, direction)`
  (`src/queries/GroupedSelectBuilder.ts`) sorts groups by result fields; the array form shares one
  direction, and a second call replaces the first. The IR (`DesugaredGroup.orderBy`) and the wire
  (`groupOrderBy: [{field, direction}]`) already carry a direction per field, so only the builder
  lacks a way to mix them.
- **Nested select** — `p.friends.select(...).orderBy(f => [f.a, f.b], dir)` (`FieldSet.orderBy`,
  `src/queries/FieldSet.ts`) orders the inner window of a nested select. Its entries
  (`FieldSetInnerOrderBy`, `IRInnerOrderBy`, the wire `orderBy: [{path: dir}]`) also carry a direction
  each; only the builder method takes one for all.

## Open questions

- Same `thenBy` name on both (one key per call, refused without a preceding `orderBy`), or a
  `[{field, direction}]` overload on the grouped builder whose keys are field names, not callbacks?
- A nested select's inner ORDER BY keys are single properties of the member shape (bound-first,
  so missing values last); should a per-key form also accept nested paths and expressions, as
  the top-level `thenBy` does?
