---
date: 2026-11-01
summary: >
  `t.$type()` in the select DSL: a node's `rdf:type` values (stored and inferred, as the store
  answers), multi-valued `{id}`, as a field, group key (one group per type), where (`equals`,
  `some`, `none`), sort key and on nested paths. DSL-JSON 1.6 `$type` segment; `equals` on any
  multi-valued relation; `$type`/`$graph` reserved. Minor.
packages: [core]
---

# 104 — Node type in the select DSL (`$type()`)

## PR

### Summary

The owner's decision: node metadata in the select DSL gets a `$` prefix ("`$`-prefixed members
are facts about the node, not shape fields", stated once in the README and `dsl-json.md`).
`$type()` is built; `$graph()` is reserved for later.

```ts
Term.select((t) => ({kind: t.$type(), n: Expr.count()})).from(g).groupBy('kind')
Thing.select((t) => [t.name, t.$type()])            // {id, name, $type: [{id}, …]}
Thing.select().where((t) => t.$type().equals({id: C})).exists()
```

- **What it is:** a property shape of its own, `https://linked.cm/shape/core/Shape/$type`
  (`NODE_TYPE_PROPERTY_ID`, path `rdf:type`, value shape `Shape`, IRI, multi-valued), attached
  to no node shape (not in `selectAll`, shape sync or a shape's property list), found by
  `findPropertyShapeById` and, for the label `$type`, by the query-side label lookups
  (`getQueryPropertyShape`). The IR is unchanged in kind: a property whose path is `rdf:type`,
  so lowering, OPTIONAL traversal, groupBy, report 101's sort rules, result mapping to `{id}` and
  live-query dependencies are the existing ones. SPARQL variable `?a0__type`.
- **API:** `QueryShape.$type()` and `QueryShapeSet.$type()`, typed
  `$type<Self>(this: Self): QShapeSet<Shape, Self, '$type'>` (rows: `$type: {id: string}[]`, or
  under the alias). New on `QueryShapeSet`: `equals(value)`, the same as
  `some((m) => m.equals(value))`, an EXISTS of its own. Label selects take `'$type'`.
- **groupBy:** one group per type value; a node with two types is in two groups, so the counts
  add up to more than the number of nodes (README, JSDoc, live test: Person 3, Employee 1,
  Robot 1 over three nodes).
- **Inference:** `$type()` answers what the store answers for `rdf:type`; on CN's Fuseki (and
  the inferring test image) the stored types and every superclass (live test: Erik stored as
  Employee answers Employee and Person). `InMemoryDataset` answers it as a field with the stored
  types and refuses it in a where, group key or sort, as for any path.
- **Wire:** DSL-JSON 1.6 (after rebasing onto the transactions work, which took 1.5): the `$type`
  path segment in fields, where (`{"$type": {"@id": …}}`, `"$type.none"`), sortBy and group
  keys. No `supports` feature: a store reading IR sees an `rdf:type` property any RDF store reads,
  and an older reader refuses the unknown path ("Property '$type' not found") instead of
  answering something else.
- **Reserved:** `$type`, `$graph` in `RESERVED_QUERY_DSL_NAMES` (drift test passes);
  `registerPropertyShape` refuses a property with either label; a shape loaded as data gets a
  warning that the property cannot be read.

### Changes

- `src/shapes/nodeShapeData.ts`: `NODE_TYPE_LABEL`, `NODE_TYPE_PROPERTY_ID`,
  `nodeTypePropertyShape()` (a copy of the root `Shape`'s `type` under its own IRI and label,
  `RegistryCache`d), `getQueryPropertyShape`; `findPropertyShapeById` answers the id. Exported
  from `index.ts`.
- `src/queries/SelectQuery.ts`: `$type()` on both proxies, `QueryShapeSet.equals`, shared
  `nodeEquals` for `QueryShape.equals`.
- `src/queries/PropertyPath.ts`, `FieldSet.ts`: query-side label lookups resolve `$type`
  (`walkPropertyPath` included). `QueryBuilder.ts`: label/FieldSet selects call `p.$type()`.
- `src/shapes/SHACL.ts`: refused labels. `reservedQueryNames.ts`: the names, the `$` warning.
- `src/queries/wireVersion.ts`: 1.6.
- Tests: new `src/tests/select-node-type.test.ts` (16 lowering/wire/typing/in-memory, 7 live);
  three goldens in `sparql-select-golden.test.ts`; five spec fixtures in
  `dsl-json-spec-fixtures.ts`; `shapeless-delete.test.ts` reads `WIRE_VERSION`.
- Docs: README "Node types (`$type()`)" and the feature list; `documentation/dsl-json.md`
  (Paths, Reserved words, version line); `documentation/intermediate-representation.md`
  (`property_expr`). `.changeset/select-node-type.md`: **minor**.

### Verification

- New tests before the change: `Tests: 19 failed, 2 passed, 21 total`, `[fuseki] live tests: 5
  total — 0 passed, 5 failed, 0 skipped`; goldens `Tests: 3 failed, 93 passed, 96 total`.
- Final, whole core suite against an own Fuseki (`FUSEKI_BASE_URL=http://localhost:3971 npm
  test`): `Tests: 122 skipped, 3252 passed, 3374 total`, `[fuseki] live tests: 477 total —
  475 passed, 0 failed, 2 skipped`; typecheck clean. `transactions.test.ts` asserted wire 1.5; it
  now reads `WIRE_VERSION`.
- `npx linked build`: `✔ Build successful`.
- CN main checkout, core landed and built there: `npm run typecheck:gate`: `No new type errors.
  0 pre-existing errors still in the baseline.`

### Deviations

- Wire version 1.6, not 1.4: the transactions work landed 1.5 first.
- `equals` on a set was briefly an expression on the path (review round 1, so it would work
  inside another set's `some`); round 2 showed it shared the projection's variable (a projected
  `$type()` lost its other types, `equals(A).and(equals(B))` matched nothing), so it is an EXISTS
  again. Inside another set's callback, write the path from the outside
  (`p.friends.$type().equals(C)`).

### CN impact

No CN change. No CN code uses `$type`, `$graph` or a property with those labels (grep of `src`
and `packages`).

### Follow-ups

- A quantifier inside a quantifier (`p.friends.some((f) => f.$type().equals(C))`,
  `f.friends.some(…)` inside `some`): older limit, not recorded yet as backlog; the outside path
  covers `$type`.
- A DSL-JSON plural path in a where (`{"$type": {"@id": …}}`, `{"friends": {"@id": …}}`) lowers
  to a required join on the projection's variable, so a projected field next to it keeps only the
  matching value (older, all plural paths).
- A DSL-JSON value object with an unknown `$`-key lowers to a string literal (older).
- `$graph()`.

## Details
The owner's decision: node metadata in the select DSL gets a `$` prefix (core already uses `$`
for non-field concepts: `$add`/`$remove` in update values). `t.$type()` now, `t.$graph()` later.

```ts
Term.select(t => ({kind: t.$type(), n: Expr.count()})).from(g).groupBy('kind')
Thing.select(t => [t.name, t.$type()])                  // a node's types, multi-valued, as {id}
Thing.select().where(t => t.$type().equals({id: C})).exists()
```

### Ideation

What exists: the root `Shape` already registers a property shape `type` (path `rdf:type`,
value shape `Shape`, IRI, multi-valued; `src/utils/Package.ts`). Selecting `p.type` lowers to
`OPTIONAL { ?a0 rdf:type ?a0_type }`, groups, sorts and filters with `some` already. What is
missing: a name no subclass can shadow (`NodeShape.type` is its own property, a domain shape may
declare `type` for something else), a DSL-JSON form, `equals` directly on the set, docs.

#### Decision 1 of 4: what `$type()` is underneath

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

#### Decision 2 of 4: DSL-JSON

A `$type` path segment: `"fields": ["name", "$type"]`, `"bestFriend.$type"`,
`{"$type": {"customKey": "kind"}}`, `"where": {"$type": {"@id": C}}`, `"sortBy": [{"$type":
"ASC"}]`. Resolution of `$type` never consults the shape, so it means the node's types on every
shape. Wire version 1.5 → **1.6** after rebasing onto the transactions work (1.5; planned as 1.3 → 1.4) (minor: an older reader does not know the segment and throws
"Property '$type' not found", it does not answer something else).

#### Decision 3 of 4: a `supports` feature?

A store answering IR sees a property whose path is `rdf:type`, which any RDF store can read; a
store answering DSL-JSON with an older core refuses the unknown path loudly. No store answers it
wrongly in silence, so **no feature** (a declared list exists for features a store would silently
drop, `queryFeatures.ts`).

#### Decision 4 of 4: `equals` on a set

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
- In-memory dataset: `InMemoryDataset` (landed with the transactions work, report 103) reads a
  property through `findPropertyShapeById`, so it answers `$type()` as a field with the stored
  types, and refuses an EXISTS, grouping and sorting as it does for any path. Tested, documented.

### Plan

#### Contracts

- `QueryShape.$type()` / `QueryShapeSet.$type()`: `QShapeSet<Shape, …, '$type'>`; result key
  `$type` unless aliased; values `{id}[]`.
- `QueryShapeSet.equals(value)`: an expression `path = value` on the multi-valued path (some member
  is `value` in a where).
- `nodeTypePropertyShape()` (exported from `shapes/nodeShapeData.ts`): the property shape;
  `NODE_TYPE_LABEL = '$type'`.
- `findPropertyShapeById(id)` answers it; `getQueryPropertyShape(nodeShape, label)` answers it for
  `$type` and otherwise delegates to `getPropertyShape`.
- `WIRE_VERSION = '1.6'`.

#### Files

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

#### Pitfalls

- The property shape has no `parentNodeShape`; code that derives an owner from it
  (`queryDependencies.ts` owner lookups, cast detection in `pathToStringWithCasts`) must not
  insert an `as(…)` or fail.
- `$type` on the root of a shape scan: the root's own `rdf:type <Class>` triple and the OPTIONAL
  `rdf:type ?t` are separate patterns; the latter returns every type.

### Tasks

#### Phase 1: failing tests

- `select-node-type.test.ts`: SPARQL for field, nested field, groupBy, where equals/some/none,
  orderBy; DSL-JSON `toJSON`/`fromJSON` round trip; reserved names drift; type test of the
  result; live block over Fuseki (stored and inferred types, two-type node in two groups, sort
  missing last).
- Validation: the new tests fail (`$type` is not a function / not found).

#### Phase 2: implementation

- Property shape and lookups, proxy methods, `equals` on sets, wire 1.6, reserved names.
- Validation: new tests pass; whole core suite with live Fuseki; `npx linked build`.

#### Phase 3: docs and changeset

- README, dsl-json.md, changeset.
- Validation: dsl-json spec fixtures test passes; CN main checkout `npm run typecheck:gate`.

Phases run in order (each depends on the previous).

### Implementation

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

### Review

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

### Iteration 1 — Ideation

#### Gap 1 of 2: `equals` on a set inside another set's callback (superseded in iteration 2)

- A. Let `some`/`every`/`none` callbacks return an `ExistsCondition` (nested exists in the IR
  predicate): a lowering change for an older limit (`f.friends.some(…)` inside `some`).
- B. Make `QueryShapeSet.equals` an expression on the path, as `QueryPrimitiveSet.equals` is: at
  the top of a where it is a required traversal plus a filter (some value matches, the form a
  DSL-JSON plural path already lowers to), and inside a callback it is an ordinary predicate.

Chosen: B (one form for both set kinds, no lowering change). `equals(x).not()` then means "some
member is not x"; "none is x" is `none(…)`, documented.

#### Gap 2 of 2: `$type` by label, and properties labelled `$type`

Label selects call `p.$type()` for `$type`; registering a property labelled `$type` or `$graph`
throws, as for `and`/`or`/`not` (a label with no way in).

### Iteration 1 — Plan

- `SelectQuery.ts`: `nodeEquals(qbo, value)` shared by `QueryShape.equals` and
  `QueryShapeSet.equals`, returning an `ExpressionNode`.
- `QueryBuilder.ts`: label and FieldSet selects map `$type` to `p.$type()`.
- `SHACL.ts`: `NODE_METADATA_LABELS` refused in `registerPropertyShape`.
- `nodeShapeData.ts`: R3, R4. Tests and docs for each.

### Iteration 1 — Phases

#### Phase 4: review fixes

- As above; tests: a friend's type inside `some()` (lowering and live), label select, refused
  labels, NodeShape's own `type` next to `$type()`; goldens and spec fixtures for the new where
  form.
- Validation: whole suite with live Fuseki; build; CN typecheck gate.

### Review, round 2

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R10 | medium | Gap 1's expression form shared the path variable with the projection and with other conditions: `select([p.name, p.$type()]).where(p => p.$type().equals(R))` returned `$type: [R]` only, and `equals(R).and(equals(Person))` matched nothing | Fixed (iteration 2) |
| R11 | low | A shape loaded as data with a `$type` label only warns, and the warning pointed at `select(['$type'])`, which reads the node's types | Fixed: own message for `$` names |

### Iteration 2 — Ideation

#### Gap 1 of 1: `equals` on a set must not share the path variable

- A. Back to `some(m => m.equals(v))`: an EXISTS of its own, so the projection keeps every value,
  two conditions combine, and `.not()` is "none". Inside another set's callback it is not
  accepted (a quantifier inside a quantifier, an older limit); the outside path
  (`p.friends.$type().equals(C)`) says the same.
- B. Accept a quantifier inside a quantifier: `ExistsCondition.predicate` becomes
  `ExpressionNode | ExistsCondition`, read by serialization, feature detection, dependencies and
  lowering. A wider change for an older limit.
- C. The expression form with a fresh alias: the lowering has no way to ask for one per
  expression.

Chosen: A; B recorded as a follow-up.

### Iteration 2 — Plan and phases

#### Phase 5: `equals` as an EXISTS; data-shape warning; in-memory store

- `QueryShapeSet.equals` returns `some(…)`; JSDoc names the outside path for nested use.
- `warnOnReservedPropertyLabel`: a `$` name gets its own message.
- Tests: the field keeps every type under an `equals` where, `A and B` (lowering and live), a
  member's type from the outside (lowering and live), the warning, InMemoryDataset field and
  refusal. Goldens back to EXISTS.
- Rebased onto dev (transactions, wire 1.5): wire version 1.6.
- Validation: whole suite with live Fuseki; build; CN typecheck gate.
