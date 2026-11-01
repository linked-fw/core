---
summary: >
  `t.$type()` in the select DSL: the node's `rdf:type` values (stored and inferred, as the store
  answers), multi-valued `{id}`, as a field, groupBy key, where (`equals`/`some`/`none`), orderBy
  and on nested paths; DSL-JSON `$type` path segment (wire 1.4); `$type`/`$graph` reserved.
status: Review
packages: [core]
---

# 104 — Node type in the select DSL (`$type()`)

The owner's decision: node metadata in the select DSL gets a `$` prefix (core already uses `$`
for non-field concepts: `$add`/`$remove` in update values). `t.$type()` now, `t.$graph()` later.

```ts
Term.select(t => ({kind: t.$type(), n: Expr.count()})).from(g).groupBy('kind')
Thing.select(t => [t.name, t.$type()])                  // a node's types, multi-valued, as {id}
Thing.select().where(t => t.$type().equals({id: C})).exists()
```

## Ideation

What exists: the root `Shape` already registers a property shape `type` (path `rdf:type`,
value shape `Shape`, IRI, multi-valued; `src/utils/Package.ts`). Selecting `p.type` lowers to
`OPTIONAL { ?a0 rdf:type ?a0_type }`, groups, sorts and filters with `some` already. What is
missing: a name no subclass can shadow (`NodeShape.type` is its own property, a domain shape may
declare `type` for something else), a DSL-JSON form, `equals` directly on the set, docs.

### Decision 1 of 4: what `$type()` is underneath

- A. A new IR node (`node_type_expr`) lowered specially in SPARQL. New concept in IR, lowering,
  result mapping, dependencies.
- B. A dedicated property shape `https://linked.cm/shape/core/Shape/$type` (path `rdf:type`,
  value shape `Shape`, IRI, no maxCount), not attached to any node shape (so `selectAll`, shape
  sync and the shape's own property list never see it), found by `findPropertyShapeById` and by
  label `$type` in the query-side label lookups. Everything downstream (traversals, OPTIONAL,
  groupBy, orderBy with report 101's rules, exists, result mapping to `{id}`) is the existing
  path for an IRI-valued multi-valued property.
- C. Reuse the root `type` property shape object itself. Its id ends in `type`, so DSL-JSON
  (which serializes segments by the id's last part) would write `type`, and reading it back on a
  shape that overrides `type` resolves the wrong property.

**Chosen: B.** Least new machinery; the IR is unchanged in kind (a property id whose path is
`rdf:type`), so every store that reads IR answers it as it answers any IRI property.

### Decision 2 of 4: DSL-JSON

A `$type` path segment: `"fields": ["name", "$type"]`, `"bestFriend.$type"`,
`{"$type": {"customKey": "kind"}}`, `"where": {"$type": {"@id": C}}`, `"sortBy": [{"$type":
"ASC"}]`. Resolution of `$type` never consults the shape, so it means the node's types on every
shape. Wire version 1.3 → **1.4** (minor: a 1.3 reader does not know the segment and throws
"Property '$type' not found", it does not answer something else).

### Decision 3 of 4: a `supports` feature?

A store answering IR sees a property whose path is `rdf:type`, which any RDF store can read; a
store answering DSL-JSON with an older core refuses the unknown path loudly. No store answers it
wrongly in silence, so **no feature** (a declared list exists for features a store would silently
drop, `queryFeatures.ts`).

### Decision 4 of 4: `equals` on a set

`t.$type().equals({id: C})` needs `equals` on the set. Added to `QueryShapeSet` generally, so
`p.friends.equals({id})` works the same way; `equals` is reserved already. First built as
`some(m => m.equals(v))`; changed in iteration 1 to an expression on the path (as
`QueryPrimitiveSet.equals`), see Gap 1.

Other points, settled without alternatives:

- Mutations do not accept `$type` (types are written by `create`/the shape); the label lookup
  that resolves `$type` is query-side only.
- Inference: `$type()` answers whatever the store answers for `rdf:type`; CN's Fuseki infers
  classes through `rdfs:subClassOf`, so stored and inferred types come back. Documented.
- groupBy: a key per type value; a node with two types is in two groups (one row per type), so
  group counts add up to more than the number of nodes. Documented.
- Reserved names: `$type`, `$graph` in `RESERVED_QUERY_DSL_NAMES`.
- In-memory dataset: core ships none (SparqlDataset is the only `IDataset`); nothing to add.

## Plan

### Contracts

- `QueryShape.$type()` / `QueryShapeSet.$type()`: `QShapeSet<Shape, …, '$type'>`; result key
  `$type` unless aliased; values `{id}[]`.
- `QueryShapeSet.equals(value)`: an expression `path = value` on the multi-valued path (some member
  is `value` in a where).
- `nodeTypePropertyShape()` (exported from `shapes/nodeShapeData.ts`): the property shape;
  `NODE_TYPE_LABEL = '$type'`.
- `findPropertyShapeById(id)` answers it; `getQueryPropertyShape(nodeShape, label)` answers it for
  `$type` and otherwise delegates to `getPropertyShape`.
- `WIRE_VERSION = '1.4'`.

### Files

- `src/shapes/nodeShapeData.ts`: the property shape, lookup by id and by label.
- `src/queries/SelectQuery.ts`: `$type()` on `QueryShape` and `QueryShapeSet`; `equals` on
  `QueryShapeSet`.
- `src/queries/PropertyPath.ts`, `src/queries/FieldSet.ts`: query-side lookups use
  `getQueryPropertyShape`.
- `src/queries/reservedQueryNames.ts`, `src/queries/wireVersion.ts`.
- Docs: README (a `$` paragraph and `$type()`), `documentation/dsl-json.md` (paths, reserved
  words, version), `documentation/intermediate-representation.md` if it lists properties.
- Tests: new `src/tests/select-node-type.test.ts` (lowering, DSL-JSON round trip, typing, live
  Fuseki with inference); golden in `sparql-select-golden.test.ts`.
- `.changeset/select-node-type.md` (minor).

### Pitfalls

- The property shape has no `parentNodeShape`; code that derives an owner from it
  (`queryDependencies.ts` owner lookups, cast detection in `pathToStringWithCasts`) must not
  insert an `as(…)` or fail.
- `$type` on the root of a shape scan: the root's own `rdf:type <Class>` triple and the OPTIONAL
  `rdf:type ?t` are separate patterns; the latter returns every type.

## Tasks

### Phase 1: failing tests

- `select-node-type.test.ts`: SPARQL for field, nested field, groupBy, where equals/some/none,
  orderBy; DSL-JSON `toJSON`/`fromJSON` round trip; reserved names drift; type test of the
  result; live block over Fuseki (stored and inferred types, two-type node in two groups, sort
  missing last).
- Validation: the new tests fail (`$type` is not a function / not found).

### Phase 2: implementation

- Property shape and lookups, proxy methods, `equals` on sets, wire 1.4, reserved names.
- Validation: new tests pass; whole core suite with live Fuseki; `npx linked build`.

### Phase 3: docs and changeset

- README, dsl-json.md, changeset.
- Validation: dsl-json spec fixtures test passes; CN main checkout `npm run typecheck:gate`.

Phases run in order (each depends on the previous).

## Implementation

- Phase 1: `select-node-type.test.ts` and three goldens written first. Before the change:
  `Tests: 19 failed, 2 passed, 21 total`, `[fuseki] live tests: 5 total — 0 passed, 5 failed`;
  goldens `3 failed, 93 passed, 96 total`.
- Phase 2: as planned. `$type()` on both proxies is a generic `this`-typed method
  (`$type<Self>(this: Self): QShapeSet<Shape, Self, '$type'>`): a `Source` of `QueryShape<S, …>`
  made `QueryShapeSet<S>` stop being assignable to `QueryShapeSet<Shape>` (variance through
  `selectAll`). `shapeless-delete.test.ts` asserted the wire version 1.3; it now reads
  `WIRE_VERSION`.
- Phase 3: README, `dsl-json.md` (Paths, Reserved words) with five spec fixtures,
  `intermediate-representation.md` (`property_expr`), changeset.
- Whole suite after phase 3 (Fuseki on 3971): `Tests: 122 skipped, 3199 passed, 3321 total`,
  `[fuseki] live tests: 472 total — 470 passed, 0 failed, 2 skipped`; typecheck clean.

## Review

Independent read-only review. Everything in the request worked (fields root/nested/keyed,
groupBy, where, exists, minus, orderBy paged MIN, casts, sub-selects, DSL-JSON round trips,
live-query dependencies on `rdf:type`, mutations refuse `$type`).

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R1 | medium | `p.friends.some(f => f.$type().equals(X))` threw: `equals` returned an `ExistsCondition`, which a `some` callback does not take | Fixed (Gap 1) |
| R2 | medium | `select(['name', '$type'])` crashed (the label mapped to the bound method); a property labelled `$type` had no way in, yet only a warning | Fixed (Gap 2) |
| R3 | low | The property-shape copy kept the root's `parentNodeShape` (comment and plan said otherwise) | Fixed: dropped |
| R4 | low | Module-level cache never refreshed on a registry reset | Fixed: `RegistryCache` |
| R5 | low | `QueryShapeSet.equals` did not take a `PendingQueryContext` | Fixed (shared `nodeEquals`) |
| R6 | low | `walkPropertyPath` (exported) resolves `$type` | In the changeset |
| R7 | low | Test "a shape that declares its own `type`" used Employee (no own `type`) | Fixed: NodeShape |
| R8 | low | README "only possible on a nested path"; changeset "now" for a new `equals` | Fixed |
| R9 | low | A DSL-JSON object with an unknown `$`-key as a value lowers to a string literal (older) | Not changed; follow-up |

## Iteration 1 — Ideation

### Gap 1 of 2: `equals` on a set inside another set's callback

- A. Let `some`/`every`/`none` callbacks return an `ExistsCondition` (nested exists in the IR
  predicate): a lowering change for an older limit (`f.friends.some(…)` inside `some`).
- B. Make `QueryShapeSet.equals` an expression on the path, as `QueryPrimitiveSet.equals` is: at
  the top of a where it is a required traversal plus a filter (some value matches, the form a
  DSL-JSON plural path already lowers to), and inside a callback it is an ordinary predicate.

Chosen: B (one form for both set kinds, no lowering change). `equals(x).not()` then means "some
member is not x"; "none is x" is `none(…)`, documented.

### Gap 2 of 2: `$type` by label, and properties labelled `$type`

Label selects call `p.$type()` for `$type`; registering a property labelled `$type` or `$graph`
throws, as for `and`/`or`/`not` (a label with no way in).

## Iteration 1 — Plan

- `SelectQuery.ts`: `nodeEquals(qbo, value)` shared by `QueryShape.equals` and
  `QueryShapeSet.equals`, returning an `ExpressionNode`.
- `QueryBuilder.ts`: label and FieldSet selects map `$type` to `p.$type()`.
- `SHACL.ts`: `NODE_METADATA_LABELS` refused in `registerPropertyShape`.
- `nodeShapeData.ts`: R3, R4. Tests and docs for each.

## Iteration 1 — Phases

### Phase 4: review fixes

- As above; tests: a friend's type inside `some()` (lowering and live), label select, refused
  labels, NodeShape's own `type` next to `$type()`; goldens and spec fixtures for the new where
  form.
- Validation: whole suite with live Fuseki; build; CN typecheck gate.
