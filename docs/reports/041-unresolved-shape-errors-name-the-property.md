---
summary: >
  Errors for a shape IRI that does not resolve name the property that points at it, the shape that
  declares that property and, while a scoped ShapeCatalog is active, the scope. They are thrown as
  `UnresolvedShapeError` (still a plain `Error`, branded) with `shapeIri`, `property`,
  `propertyIri`, `ownerShapeIri` and `catalog` fields, so a host maps them without parsing.
  `fromJSON` no longer reads sub-fields against the parent shape when a relation's shape is
  missing. 2.35.1, wording settled in 2.36.1. Replaces backlog 056.
packages: [core]
---

# 041 — Unresolved-shape errors name the property, its shape and the scope

Source: backlog 056 (removed with this report), from Create Now plan 068 phase 3 (CN report 098).

## Problem

Inside a `ShapeCatalog` (report 037), a property whose `sh:node` names a shape the catalog does not
hold made query building throw `Shape class not found for <shape>` and `fromJSON` throw
`Cannot resolve shape for '<shape>'`. Neither named the property or the catalog, so a host (CN's
`namedShapeError`) had to guess from the message.

## What was built

- **`UnresolvedShapeError`** (`src/utils/unresolvedShape.ts`, exported with the
  `UnresolvedShapeDetails` type). Extends `Error`, keeps `name === 'Error'`, adds read-only fields
  `shapeIri`, `property?` (the property label), `propertyIri?`, `ownerShapeIri?`, `catalog?` (the
  active catalog's `name`). Branded with `brandLinkedError` (since 2.36.2, report 039), so
  `isLinkedError(err, UnresolvedShapeError)` matches one thrown by another copy of core.
- **Message.** Every message keeps its old leading sentence, so host matchers on
  `Shape class not found for (\S+)` or `Cannot resolve shape for '([^']+)'` still work. A
  parenthetical is added only when there is something to say (`describeUnresolved`):
  - scoped catalog active (`withShapeCatalog`):
    `Shape class not found for <Place> (property 'home' of '<Person>' points at it; not among the shapes in scope 'p1#main')`
  - global registry: `… (property 'home' of '<Person>' points at it)`
  - a query's or mutation's own shape: just `Cannot resolve shape for '<iri>'`, plus the scope
    clause inside a catalog.
  The "declares no shape" case (no `valueShape`) names the owning shape.
- **Throw sites.** `SelectQuery.generatePathValue` and the shape-set proxy, `MutationQuery` (top
  level and nested), `walkPropertyPath` (`PropertyPath.ts`), `FieldSet.for` nested fields,
  `resolveShape` / `FieldSet.resolveShapeInput`.
- **`validate`.** The violation for an unresolved nested shape names the owning shape and, in a
  scope, the scope; it stays a `ShapeValidationError`.
- **`fromJSON` / `FieldSet.fromJSON`.** When a relation's value shape does not resolve, its
  sub-fields used to be read against the parent shape silently; they now throw the same error.

The 2.35.1 wording said `catalog '<name>' does not hold it` and appeared also for the global
registry; 2.36.1 changed it to the scope-only form above. Fields were unchanged.

## Public API

- 2.35.1 (patch, core#350): `UnresolvedShapeError`, `UnresolvedShapeDetails`; the stricter `fromJSON`.
- 2.36.1 (patch, core#353): message wording only.

```ts
import {UnresolvedShapeError, isLinkedError} from '@_linked/core';
try { await Person.select((p) => p.home.name); }
catch (err) {
  if (isLinkedError(err, UnresolvedShapeError)) {
    report(`${err.property} of ${err.ownerShapeIri} needs ${err.shapeIri}`, err.catalog);
  }
}
```

## Decisions

- **Backlog 056 §1 (lexical forms in `validate`) closed, not implemented.** Core refuses strings
  for typed datatypes on purpose (see the `xsd:date`/`xsd:dateTime` note above the datatype checks
  in `src/shapes/validation.ts`); Create Now keeps its own lexical rule (`src/utils/shapeValidity.ts`).
- The backlog's proposed wording (`Property '<label>' of '<shape>' points at '<target>', which
  catalog '<name>' does not hold`) was not used, to keep existing prefixes matchable.

## Files

| File | Responsibility |
|---|---|
| `src/utils/unresolvedShape.ts` | the error class, detail builders (`unresolvedValueShapeDetails`, `topLevelDetails`), `describeUnresolved`, `unresolvedShapeError` / `unresolvedValueShapeError` |
| `src/queries/SelectQuery.ts`, `MutationQuery.ts`, `PropertyPath.ts`, `FieldSet.ts`, `resolveShape.ts` | throw it |
| `src/shapes/validation.ts` | the nested-shape violation message |

## Tests

- `src/tests/unresolved-shape-errors.test.ts`: nested select (single and set valued),
  `walkPropertyPath`, `FieldSet`, nested create and update, `fromJSON` for a select path, nested
  sub-fields, a create and an unknown top-level shape; the scoped wording; the global-registry
  cases end after "points at it", have no `catalog` field, and a top-level shape gets no
  parenthetical.
- `src/tests/shape-validation-report.test.ts`: the validation message.
- At 2.36.1: 2322 tests passed.

## Known limits

- `catalog` is absent for an unnamed catalog; the message then says `not among the shapes in scope`
  without a name.

## Follow-ups

- Create Now reads the fields instead of parsing the message (`namedShapeError`); done on CN's
  side with core 2.36.1. No core follow-up.

## PRs

- https://github.com/linked-fw/core/pull/347 — backlog 056 filed
- https://github.com/linked-fw/core/pull/350 — the error and its fields (2.35.1)
- https://github.com/linked-fw/core/pull/353 — scope-only wording; 056 closed (2.36.1)
