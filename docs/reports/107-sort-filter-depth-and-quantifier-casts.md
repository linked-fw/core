---
date: 2026-11-01
summary: >
  A filter on any segment of a sort path or a projection keeps every instance (missing values
  last); a filter before a cast is kept; a quantifier on a cast relation keeps its cast on the wire
  (`pets.as(Dog).some`), condition and sort paths carry casts; a quantifier's condition reads the
  member shape, never the outer one; decode edges. Wire 1.8. Minor. Closes backlog 093.
packages: [core]
---

# 107 — Sort filter depth and quantifier casts

## PR

### Summary

Backlog 093 (report 105's review). Sorting follows report 101: never drops an instance, missing
values last in both directions.

1. **A filter below the first segment** (`orderBy((p) => p.bestFriend.friends.where((f) =>
   f.name.equals('Dirk').not()).hobby)`) is supported, no longer refused. The hops above a filter
   are never required: the filtered OPTIONAL block nests inside the OPTIONAL subtree of the hop
   above it. An instance without a best friend, or whose best friend has no friend the filter
   keeps, is kept and sorts last, paged or not. Projections get the same rule:
   `select((p) => p.bestFriend.friends.where(…).name)` no longer drops persons without a best
   friend (visible change, in the changeset). Wire: `whereIndex` may name any segment; an index
   naming none is refused (in a field too, where it was dropped).
2. **Casts on the wire:** `p.pets.as(Dog).some((d) => d.guardDogLevel.equals(2))` encodes as
   `{"pets.as(Dog).some": {"guardDogLevel": 2}}` (was `pets.some`, which failed to decode).
   `ExistsCondition.memberShapeId` carries the member shape; condition paths
   (`firstPet.as(Dog).guardDogLevel`) and `sortBy` paths carry casts as fields do
   (`queries/castPaths.ts`, moved out of `FieldSet`); an unknown cast label is refused. Found by
   review: `.where(…).as(X)` dropped the filter in the DSL itself; `as()` keeps it now. DSL-JSON 1.8.
3. **Member shape:** a quantifier's condition decodes on the shape the DSL uses (`sh:node`, the
   shape targeting `sh:class`, the cast), else core's root `Shape` (member `equals`/`$type` work,
   other paths throw), never the outer shape.
4. **Decode edges:** a quantifier may be any operand of `and`/`or` (it leads, the rest chain in
   order); an empty condition `{}` is refused (was `FILTER()`); `not().not()` on a chained
   quantifier gives the same SPARQL as the condition.

### Changes

- `src/sparql/irToAlgebra.ts`: `collectRequiredTraversalAliases` reads the where only; filtered
  blocks built recursively and nested in a filtered parent, an OPTIONAL parent or a paginated
  sub-SELECT block; `buildOptionalTraversalSubtree` is a closure.
- `src/queries/IRDesugar.ts`: the first-segment refusal removed.
- `src/queries/QueryBuilderSerialization.ts`: `filteredSegmentShape`, cast-aware `sortBy` paths.
- `src/queries/castPaths.ts` (new), `src/queries/FieldSet.ts` (uses it; field `whereIndex` check).
- `src/expressions/ExpressionNode.ts`: `ExistsCondition.memberShapeId`, `not()` unwraps a negated
  chained expression.
- `src/queries/SelectQuery.ts`: `quantified()` sets the member shape; `as()` keeps `wherePath`.
- `src/queries/DslJsonExpression.ts`: cast keys and paths, `memberShapeOf`/`relationMemberShape`,
  exists order, empty condition. `src/shapes/nodeShapeData.ts`: `ROOT_SHAPE_IRI` exported.
- `src/queries/wireVersion.ts`: 1.8.
- Tests: new `src/tests/sort-filter-depth-and-quantifier-casts.test.ts` (19 lowering/wire/decode,
  6 live); `select-sort-and-leaf-edges.test.ts` (refusal tests now assert the support and the index
  check); `select-node-type.test.ts` (wire 1.8).
- Docs: README "Sorting, limiting, one", `documentation/dsl-json.md` (version, `sortBy`, casts,
  quantifier member shape, empty condition), `documentation/sparql-algebra.md` (step 10).
  `.changeset/sort-filter-depth-and-quantifier-casts.md`: **minor**. Backlog 093 removed; backlog
  107 added.

### Verification

- New tests before the change: `Tests: 18 failed, 2 passed, 20 total`, `[fuseki] live tests: 5
  total — 0 passed, 5 failed, 0 skipped`.
- Final, whole core suite against an own Fuseki (`FUSEKI_BASE_URL=http://localhost:3993
  FUSEKI_ADMIN_PASSWORD=admin npm test`, after `npx linked build`): `Test Suites: 4 skipped, 168
  passed, 168 of 172 total`, `Tests: 122 skipped, 3313 passed, 3435 total`, `[fuseki] live tests:
  492 total — 490 passed, 0 failed, 2 skipped`; typecheck clean. One earlier run had
  `shape-graphs-fuseki` fail once (a Jena SHACL report, untouched code); it passes alone (`5
  passed`) and in the final run.
- `npx linked build`: `✔ Build successful`.
- The host app's main checkout, core landed and built there: `npm run typecheck:gate`: `No new type errors.
  0 pre-existing errors still in the baseline.` `npm run test:feature --
  data,apps,ontologies --tier smoke`: typecheck:gate PASS, `unit (vitest, 137 files) PASS`
  (`1433 passed | 2 skipped`), gateway package PASS (`67 passed`), `playwright (11 specs, smoke)
  PASS` (`12 passed`), total PASS.

### Deviations

- A filter on a literal segment exists (`p.hobby.where(…)`), so the wire refuses only an index
  that names no segment, not a literal one (planned: refused).
- Review fixes R1 (sub-SELECT parent) and R3 (filter before a cast) are older bugs, fixed here.
- A computed field's or sort expression's `@path` values still write label paths (no shape at
  hand there); conditions write casts.

### Host app impact

`FieldSet.pathToStringWithCasts`/`walkPathWithCasts` had no caller in the host app. Its AI data queries' `sortBy` and where envelopes use no deep filters or casts; an
LLM `where: {}` now fails with a clear message instead of invalid SPARQL.

### Follow-ups

- Backlog 108: an inline filter that reads the outer subject compares the member with itself; a
  filtered `size()` ignores its filter.

## Details

Source: backlog 093 (report 105's review). Sorting follows report 101: an instance is never
dropped, missing values sort last both ways.

### Ideation (automatic mode, decisions taken on the owner's behalf)

Priority: maintainability, then scalability, then performance.

#### Planning blockers

None: every item has a route within the existing lowering and wire code.

#### Decision 1 of 5: a filter below the first segment (sort keys and projections)

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

#### Decision 2 of 5: the cast of a quantifier's relation

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

#### Decision 3 of 5: an unresolvable member shape

Resolve the member shape as the DSL does (`resolveRelationShape`: `sh:node`, else the shape
targeting the `sh:class`), else the base `Shape`, never the outer shape: a label lookup then
throws as `walkPropertyPath` does, while `equals`/`id` keep working (the DSL allows them there).

#### Decision 4 of 5: an exists that is not the first operand

and/or are commutative in a filter, so the decoder moves the first quantifier to the front and
chains the rest in order. An empty condition `{}` (`{"pets.none": {}}`) is refused with a clear
message (it lowered to `FILTER()`): there is no empty condition in the DSL.

#### Decision 5 of 5: `not().not()` on a chained quantifier

`ExistsCondition.not()` unwraps a chained expression that is already a `not_expr` instead of
wrapping it again, so `x.not().not()` is `x` again (same meaning, same SPARQL).

### Plan

#### Contracts

- A filtered traversal (`where` on any relation segment) never makes the hops above it required.
- `ExistsCondition` gains `memberShapeId?: string` (kept by `not`/`and`/`or`).
- DSL-JSON 1.8: a quantifier key may carry a trailing cast (`rel.as(Label).some|every|none`); paths
  in conditions and `sortBy` carry `as(Label)` casts as fields do; a `sortBy` filter may sit on any
  relation segment (`whereIndex`).
- `castPaths.ts`: `pathToStringWithCasts(root, segments)`, `walkPathWithCasts(root, path)`; unknown
  cast labels throw.

#### Files

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

#### Pitfalls

- A filtered block nested in an OPTIONAL subtree must still get the filter's property triples and
  its own children (the existing first pass); only where it is attached changes.
- Paged sort keys through a multi-valued traversal use a key sub-SELECT built from the page
  pattern; the nested block must survive its pruning.
- Encoding a condition needs the scope shape (the member shape inside a quantifier).

### Tasks

#### Phase 1: failing tests

New `src/tests/sort-filter-depth-and-quantifier-casts.test.ts`: lowering, wire and live tests for
all items. Validation: they fail against the unchanged sources, output quoted.

#### Phase 2: implementation

Items 1–4. Validation: the new tests pass; the old refusal tests are replaced; goldens; whole core
suite with live Fuseki; `npx linked build`.

#### Phase 3: review and fixes

Independent review; fix medium and up. Validation: whole suite again; the host app's typecheck gate and smoke.

Dependency: phases in order; within phase 2 item 1 is independent of items 2–4.

### Progress

#### Phase 1: failing tests (done)

New `src/tests/sort-filter-depth-and-quantifier-casts.test.ts` (15 lowering/wire/decode, 5 live).
Against the unchanged sources: `Tests: 18 failed, 2 passed, 20 total`, `[fuseki] live tests: 5
total — 0 passed, 5 failed, 0 skipped`. The two passes: "a relation without a cast writes none"
(unchanged behaviour) and "an unknown cast label is refused" (it failed on `walkPropertyPath`
before, with another message).

#### Phase 2: implementation (done)

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


### Review

Independent read-only review, round 1 (probes against this commit and the one before).

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R1 | medium | A filtered block (or an OPTIONAL child) under a paginated nested select's alias attached at the top level: an empty window left `?a1` unbound and the block bound it to anyone (older) | Fixed: the sub-SELECT block holds its children |
| R2 | medium | A field's wire `whereIndex` out of range dropped the filter (the sort key's was checked) | Fixed: one check (`filteredSegmentShape`) for both |
| R3 | medium | `.where(…).as(X)` dropped the filter, in the DSL (older) | Fixed: `as()` keeps the segment's filter |
| R4 | low | Sort-filter shapes resolved through `sh:node` only | Fixed: `relationMemberShape` for encode and decode |
| R5 | low | An inline filter reading the outer subject (`where(f => f.name.equals(p.name))`) compares the member with itself (older) | Follow-up (backlog 108) |
| R6 | low | `p.bestFriend.friends.where(…).size()` ignores the filter (older) | Follow-up (backlog 108) |
| R7 | low | Stale test title (wire 1.7), stale comment on filtered traversals | Fixed |
| R8 | low | `FieldSet` cast statics removed in a minor | Kept: internal, no caller in the host app; in the changeset |
| R9 | low | Missing tests (required parent, sub-SELECT parent, field index, filter before cast) | Added |

Deviation found on the way: a filter on a literal segment exists (`p.hobby.where((h) => …)`, the
`whereHobbyEquals` fixture), so the wire refuses only an index that names no segment; a literal
segment's filter reads the path's root, as the encoder writes it.

### Iteration 1

Gaps R1–R4, R7, R9, each with one route (no alternatives worth weighing): the sub-SELECT blocks are
attached after the filtered-block builders exist and wrap their own children; `as()` copies
`wherePath`; `filteredSegmentShape` is shared by `sortBy` and fields. Validation: the whole suite
below.
