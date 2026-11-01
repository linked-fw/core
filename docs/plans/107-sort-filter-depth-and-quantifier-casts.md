---
summary: >
  Backlog 093: a filter below a sort path's (or a projection's) first segment keeps every
  instance (the filtered block nests in the OPTIONAL hops above it); a quantifier on a cast
  relation keeps its cast on the wire (`pets.as(Dog).some`), with casts in condition and sort
  paths; an unresolvable member shape no longer falls back to the outer shape; three decode edges.
status: Implementation
packages: [core]
---

# 107 — Sort filter depth and quantifier casts

Source: backlog 093 (report 105's review). Sorting follows report 101: an instance is never
dropped, missing values sort last both ways.

## Ideation (automatic mode, decisions taken on the owner's behalf)

Priority: maintainability, then scalability, then performance.

### Planning blockers

None: every item has a route within the existing lowering and wire code.

### Decision 1 of 5: a filter below the first segment (sort keys and projections)

Today `collectRequiredTraversalAliases` marks a filtered traversal's ancestors required, so the
hops before it are inner joins and `p.bestFriend.friends.where(…).hobby` drops persons without a
best friend (projection and sort alike); report 105 refused it for sort keys.

- A. Keep the refusal, clearer message.
- B. A filtered traversal no longer makes its ancestors required. The ancestors become ordinary
  OPTIONAL traversals (they are projected or sort-path aliases already), and the filtered block
  is nested inside the OPTIONAL subtree of its parent, as it is nested inside a filtered parent
  block today. A parent that is required for another reason (the where) keeps the block at the
  top level.

Chosen: **B**. It is the algebra the rule asks for, one rule for projections and sort keys, and
the refusal goes. On the wire `whereIndex` may name any segment that is a relation; an index out
of range or on a literal leaf is refused (it used to fall back to the root shape).

### Decision 2 of 5: the cast of a quantifier's relation

`p.pets.as(Dog).some(…)` builds an `ExistsCondition` from property ids only; the cast lives in
nothing but the predicate's property ids, so the encoder writes `pets.some` and the decoder reads
the condition against `Pet`.

- A. Write the cast inside the condition's paths (`{"pets.some": {"as(Dog).guardDogLevel": 2}}`).
- B. Carry the member shape on the `ExistsCondition` (`memberShapeId`, set by `some`/`every`/`none`)
  and write it on the relation key when it is not the relation's own shape:
  `{"pets.as(Dog).some": {"guardDogLevel": 2}}`, as the DSL is written.

Chosen: **B** (reads as written; the condition's paths stay relative to the member). Condition and
sort paths become cast-aware too (`where(p => p.pets.as(Dog).guardDogLevel.equals(2))`,
`orderBy(p => p.firstPet.as(Dog).guardDogLevel)` lost the cast the same way): the cast-path helpers
move from `FieldSet` into `queries/castPaths.ts`, used by fields, conditions and sort keys. An
unknown cast label is refused (it fell back to the current shape). Wire 1.8.

### Decision 3 of 5: an unresolvable member shape

Resolve the member shape as the DSL does (`resolveRelationShape`: `sh:node`, else the shape
targeting the `sh:class`), else the base `Shape`, never the outer shape: a label lookup then
throws as `walkPropertyPath` does, while `equals`/`id` keep working (the DSL allows them there).

### Decision 4 of 5: an exists that is not the first operand

and/or are commutative in a filter, so the decoder moves the first quantifier to the front and
chains the rest in order. An empty condition `{}` (`{"pets.none": {}}`) is refused with a clear
message (it lowered to `FILTER()`): there is no empty condition in the DSL.

### Decision 5 of 5: `not().not()` on a chained quantifier

`ExistsCondition.not()` unwraps a chained expression that is already a `not_expr` instead of
wrapping it again, so `x.not().not()` is `x` again (same meaning, same SPARQL).

## Plan

### Contracts

- A filtered traversal (`where` on any relation segment) never makes the hops above it required.
- `ExistsCondition` gains `memberShapeId?: string` (kept by `not`/`and`/`or`).
- DSL-JSON 1.8: a quantifier key may carry a trailing cast (`rel.as(Label).some|every|none`); paths
  in conditions and `sortBy` carry `as(Label)` casts as fields do; a `sortBy` filter may sit on any
  relation segment (`whereIndex`).
- `castPaths.ts`: `pathToStringWithCasts(root, segments)`, `walkPathWithCasts(root, path)`; unknown
  cast labels throw.

### Files

- `src/sparql/irToAlgebra.ts`: required aliases, filtered blocks nested in OPTIONAL subtrees.
- `src/queries/IRDesugar.ts`: refusal replaced by an index check.
- `src/queries/QueryBuilderSerialization.ts`: `whereIndex` validation, cast-aware sort paths.
- `src/queries/castPaths.ts` (new), `src/queries/FieldSet.ts` (uses it).
- `src/expressions/ExpressionNode.ts`: `memberShapeId`, `not()` unwrap.
- `src/queries/SelectQuery.ts`: `some`/`every`/`none` set `memberShapeId`.
- `src/queries/DslJsonExpression.ts`: cast keys, cast-aware condition paths, member shape,
  exists order, empty condition.
- `src/queries/wireVersion.ts`: 1.8. Docs: README (Sorting), `documentation/dsl-json.md`,
  `documentation/sparql-algebra.md` if it states the required-hop rule.

### Pitfalls

- A filtered block nested in an OPTIONAL subtree must still get the filter's property triples and
  its own children (the existing first pass); only where it is attached changes.
- Paged sort keys through a multi-valued traversal use a key sub-SELECT built from the page
  pattern; the nested block must survive its pruning.
- Encoding a condition needs the scope shape (the member shape inside a quantifier).

## Tasks

### Phase 1: failing tests

New `src/tests/sort-filter-depth-and-quantifier-casts.test.ts`: lowering, wire and live tests for
all items. Validation: they fail against the unchanged sources, output quoted.

### Phase 2: implementation

Items 1–4. Validation: the new tests pass; the old refusal tests are replaced; goldens; whole core
suite with live Fuseki; `npx linked build`.

### Phase 3: review and fixes

Independent review; fix medium and up. Validation: whole suite again; CN typecheck gate and smoke.

Dependency: phases in order; within phase 2 item 1 is independent of items 2–4.

## Progress

### Phase 1: failing tests (done)

New `src/tests/sort-filter-depth-and-quantifier-casts.test.ts` (15 lowering/wire/decode, 5 live).
Against the unchanged sources: `Tests: 18 failed, 2 passed, 20 total`, `[fuseki] live tests: 5
total — 0 passed, 5 failed, 0 skipped`. The two passes: "a relation without a cast writes none"
(unchanged behaviour) and "an unknown cast label is refused" (it failed on `walkPropertyPath`
before, with another message).

### Phase 2: implementation (done)

All items as planned. Deviations:

1. `quantified()` is a module function, not a `QueryShapeSet` member: a member reserves a DSL
   name (`dsl-property-name-collisions` caught it).
2. Condition `@path` values (S-exprs) are cast-aware too, through an optional `shape` on
   `encodeValueExpr`; a computed field or sort expression still writes label paths (it has no
   cast case in its tests; recorded as a follow-up if one appears).
3. Report 105's tests of the old refusal now assert the support (later segment) and the
   `whereIndex` refusal (literal segment, out of range).

Validation: the new tests pass (`Tests: 20 passed`, `[fuseki] live tests: 5 total — 5 passed`);
whole suite with live Fuseki: `[fuseki] live tests: 491 total — 489 passed, 0 failed, 2 skipped`,
one suite failing on the reserved-name drift (deviation 1, fixed); `npx linked build`: `✔ Build
successful`.
