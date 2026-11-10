---
date: 2026-11-01
summary: >
  Sort keys: a computed expression sorts, a sort path's filter holds (first segment), and a paged
  key read through a multi-valued traversal no longer sorts an instance as missing when one member
  lacks it. `p.friends.nickNames`; a quantifier inside a quantifier; triples reads refused
  independent of dataset order; `$`-prefixed labels throw, every other reserved name warns. Wire
  1.7. Minor. Closes backlog 092; new backlog 093.
packages: [core]
---

# 105 — Sort and leaf path edges

## PR

### Summary

Backlog 092 (report 101) and three follow-ups (reports 102, 104). Sorting follows report 101's
rules: missing values last in both directions, MIN ascending / MAX descending per subject when
paging, IRI tie-break.

1. **Computed `orderBy`** (`orderBy((p) => p.hobby.strlen())`) sorts. Unpaged, the expression is
   bound (`BIND(STRLEN(?a0_hobby) AS ?order_0)`) and sorted bound first; paged, `MIN`/`MAX` of
   the expression. An expression holding an aggregate is refused like an aggregate; a callback
   returning anything else (a string, `undefined`) is refused, never ignored. Wire:
   `{"value": <expr>, "direction": "DESC"}`.
2. **Filter on a sort path** holds: `orderBy((p) => p.friends.where((f) => f.name.equals('Anna')).hobby)`
   sorts by the hobbies of the friends named Anna; the others are kept, last. The key's
   traversal is its own filtered OPTIONAL block; a sort key also no longer shares a traversal a
   filtered projection holds. A filter below the first segment is refused (it would make the hops
   before it required; backlog 093). Wire: `{"friends.hobby": {"direction", "where", "whereIndex": 0}}`.
   **Found on the way (report 101's rule):** Jena answers `MIN(?h)` over a group with an unbound
   row as unbound, so a paged `orderBy((p) => p.friends.hobby)` sorted Anna (one friend with a
   hobby, one without) as missing. A key read through a multi-valued traversal is now computed
   by a sub-SELECT of its own over the rows that bind it, joined OPTIONAL to the page.
3. **`p.friends.nickNames`** no longer throws (the members' primitive sets are merged); it is the
   same select as `p.friends.select((f) => f.nickNames)`.
4. **`LinkedStorage.triplesQuery`** checks every dataset the read goes to (`assertTriplesTarget`:
   method present, `triplesPattern` declared) before it asks the first.
5. **Nested quantifiers are supported:** `p.friends.some((f) => f.$type().equals({id: C}))`,
   chained (`….and(f.name.equals('Carl'))`), `every`/`none`, `f.friends.some(…)`: an EXISTS
   inside the EXISTS. `ExistsCondition.predicate` takes a quantifier; DSL-JSON nests it
   (`{"friends.some": {"$type": {"@id": …}}}`, documented before but undecodable). Review found
   `ExistsCondition.not()` negated the head only (`not(A and B)` was `(not A) and B`); it now
   applies De Morgan over the chain. A quantifier's condition is decoded on the member shape.
6. **Reserved names:** a property label starting with `$` throws at registration (any `$` name);
   every other reserved name warns. That includes `and`/`or`/`not`, which threw since DSL-JSON
   phase 6; a condition on such a property is now written as an S-expr
   (`["=", {"@path": "and"}, "x"]`). README and `dsl-json.md` say exactly this.

### Changes

- `src/queries/SelectQuery.ts`: `SortKey`, `SortByPath.keys`; `evaluateSortCallback` /
  `sortKeyOf` (expressions, filters, refusals); `some`/`every`/`none` take a quantifier;
  `callPropertyShapeAccessor` merges primitive sets; JSDoc.
- `src/queries/QueryBuilderSerialization.ts`: the three `sortBy` entry forms; directions in any case.
- `src/queries/IRDesugar.ts`, `IRLower.ts`: sort keys (own traversals where filters differ,
  expression keys), first-segment refusal, nested EXISTS lowering.
- `src/sparql/irToAlgebra.ts`: unpaged expression BIND; `pageBySubject` key sub-SELECTs for keys
  through a multi-valued traversal.
- `src/expressions/ExpressionNode.ts` (`predicate` type, `not()`), `src/queries/DslJsonExpression.ts`
  (nested quantifiers, member shape, combinator labels as S-expr), `QueryBuilder.ts` (where trees).
- `src/queries/queryDispatch.ts`, `src/utils/LinkedStorage.ts`: `assertTriplesTarget`.
- `src/shapes/SHACL.ts`, `src/queries/reservedQueryNames.ts`: the reserved-name rule.
- `src/queries/wireVersion.ts`: 1.7.
- Tests: new `src/tests/select-sort-and-leaf-edges.test.ts` (16 lowering/wire, 10 live); three
  goldens in `sparql-select-golden.test.ts`; `triples-read.test.ts` (order); `reserved-labels.test.ts`
  rewritten (throws for `$`, warns for `and`/`or`/`not`/`size`, S-expr round trip);
  `select-node-type.test.ts` (wire 1.7).
- Docs: README (Sorting; Node types), `documentation/dsl-json.md` (version, `sortBy`,
  quantifiers, reserved words), `documentation/sparql-algebra.md` (step 10).
  `.changeset/sort-and-leaf-path-edges.md`: **minor**. Backlog 092 removed; backlog 093 added.

### Verification

- New tests before the change (sources stashed): `Tests: 27 failed, 130 passed, 157 total` over
  the new file, the goldens, `triples-read` and `reserved-labels`; `[fuseki] live tests: 8 total
  — 1 passed, 7 failed` (the one pass, the filtered sort, passed by the MIN accident above).
- Final, whole core suite against an own Fuseki (`FUSEKI_BASE_URL=http://localhost:3981 npm
  test`, after `npx linked build`): `Test Suites: 4 skipped, 167 passed, 167 of 171 total`,
  `Tests: 122 skipped, 3286 passed, 3408 total`, `[fuseki] live tests: 486 total — 484 passed, 0
  failed, 2 skipped`; typecheck clean. An earlier run while another agent loaded the machine had
  six live suites time out (5 s); they pass alone (`38 passed`) and in this run.
- `npx linked build`: `✔ Build successful`.
- The host app's main checkout, core landed and built there: `npm run typecheck:gate`: `No new type errors.
  0 pre-existing errors still in the baseline.` `npm run test:feature --
  data,apps,ontologies --tier smoke`: typecheck:gate PASS, `unit (vitest, 137 files) PASS`
  (`1433 passed | 2 skipped`), gateway package PASS (`66 passed`), `playwright (11 specs, smoke)
  PASS` (`12 passed`), total PASS.

### Deviations

- The paged MIN/MAX fix (item 2) was not asked for; it is report 101's rule, broken on Jena.
- A sort filter below the first segment is refused rather than supported (backlog 093).
- `and`/`or`/`not` labels now warn instead of throwing (the owner's rule, taken literally).
- Sort directions on the wire are now validated (any case); they were passed through.

### Host app impact

None expected: the host app's `sortBy` uses the path form (its AI data queries and the instance
list's `{"": "ASC"}`), unchanged. `SortByPath` (`paths` → `keys`) is not exported
from the package root.

### Follow-ups

- Backlog 093: filters below a sort path's first segment (and the same required hops in
  projections); a quantifier on a cast relation loses its cast on the wire; unresolvable member
  shape falls back to the outer shape; small decode edges.

## Details

Source: backlog 092 (report 101), report 102 follow-up (triples refusal order), report 104
follow-ups (nested quantifier, reserved names). Sorting follows report 101: missing values last
in both directions, MIN ascending / MAX descending per subject when paging, IRI tie-break.

### Ideation (automatic mode, decisions taken on the owner's behalf)

Priority: maintainability, then scalability, then performance.

#### Decision 1 of 6: a computed `orderBy`

- A. Refuse it, as `orderBy(p => p.friends.size())` is refused. Ten lines; no way to sort by an
  expression at all.
- B. Sort by it. The pieces exist: an IR order item is already an expression, expressions
  encode/decode on the wire (`encodeValueExpr`/`decodeValueExpr`, as computed fields do), and
  the paged sub-SELECT already takes `MIN(expr)`. Missing: the builder, the wire entry, the
  bound-first key for a non-variable expression.

Chosen: **B**. Wire: a `sortBy` entry `{"value": <expr>, "direction": "ASC"|"DESC"}` (two keys,
so never confused with the one-key `{path: dir}`; `value` is already a reserved DSL-JSON word, as
for computed fields). Wire 1.7. Missing last: an unpaged expression key is bound to a variable
(`BIND(expr AS ?order_i)`), which gets the bound-first key; paged, the `MIN`/`MAX` alias has it
already. An expression holding an aggregate keeps the aggregate refusal.

#### Decision 2 of 6: a filter on a sort path

- A. Refuse a filtered sort path.
- B. Honour it: the sort key's traversal carries the filter, as a filtered projection's does, in
  an OPTIONAL filtered block (an instance without a matching member is kept, sorts last).

Chosen: **B**. A sort key never shares a traversal whose filter differs from its own: a filtered
sort path, or a sort path whose traversal a filtered projection already holds, gets traversals of
its own. Unfiltered sort paths keep sharing (the common case, no extra join). Wire: the path entry
takes an options object, as a field does: `{"friends.hobby": {"direction": "ASC", "where": {…},
"whereIndex": 0}}`. A sort path with filters on two segments is refused (by `where()` already).

#### Decision 3 of 6: `p.friends.nickNames`

Merge a member's primitive set into the result's (`QueryPrimitiveSet` has no `concat`). No choice
to make.

#### Decision 4 of 6: triples refusal independent of dataset order

Check every dataset the read could go to (method present, features declared) before the first is
asked: `assertTriplesTarget` split out of `resolveTriples`, run over all datasets first.

#### Decision 5 of 6: a quantifier inside a quantifier

- A. Refuse with a clear message.
- B. Support it: `ExistsCondition.predicate` becomes `ExpressionNode | ExistsCondition`. Lowering
  recurses (an `exists_expr` inside an `exists_expr` filter is ordinary IR), the wire nests the
  condition (`{"friends.some": {"$type.some": …}}` / `{"friends.some": {"$type": {"@id": C}}}`).

Chosen: **B**, it falls out of the same code paths. `every(f => <quantifier>)` is
`NOT EXISTS(member, NOT inner)`, which encodes as `none` of the negated inner (the same set).

#### Decision 6 of 6: reserved names

The owner's rule: a `$`-prefixed label throws at registration (any `$` name, not only `$type` and
`$graph`: they cannot come from an RDF label); every other reserved name warns. That includes
`and`/`or`/`not`, which threw: they now warn, and the encoder writes a condition on such a
property in the S-expr form (`["=", {"@path": "and"}, …]`), which has no key to collide with.

### Plan

#### Contracts

- `SortByPath`: `{keys: SortKey[]; directions}`, `SortKey = {path: PropertyPath; where?:
  WherePath; whereIndex?: number} | {expression: ExpressionNode}`.
- DSL-JSON `sortBy` entries: `{path: dir}` | `{path: {direction, where?, whereIndex?}}` |
  `{value: <expr>, direction}`. Wire 1.7.
- `ExistsCondition.predicate: ExpressionNode | ExistsCondition`.
- `registerPropertyShape`: throws for `label.startsWith('$')`; warns for every other reserved
  name.

#### Files

- `src/queries/SelectQuery.ts`: `evaluateSortCallback` (expressions, filters), `some/every/none`
  predicates, `callPropertyShapeAccessor`.
- `src/queries/QueryBuilderSerialization.ts`: sortBy encode/decode.
- `src/queries/IRDesugar.ts`, `IRLower.ts`: sort keys (expression, filtered path with own
  traversals); nested exists lowering.
- `src/sparql/irToAlgebra.ts`: bound-first for an expression key (BIND).
- `src/expressions/ExpressionNode.ts`, `src/queries/DslJsonExpression.ts`, `QueryBuilder.ts`
  (features over nested predicates).
- `src/utils/LinkedStorage.ts`, `src/queries/queryDispatch.ts`.
- `src/shapes/SHACL.ts`, `src/queries/reservedQueryNames.ts`.
- `src/queries/wireVersion.ts`: 1.7.
- Docs: README (Sorting; Node types; reserved names), `documentation/dsl-json.md`,
  `documentation/sparql-algebra.md` if it states the order rule.

#### Pitfalls

- An unpaged expression BIND must sit after the OPTIONALs it reads, before graph scoping wraps the
  algebra (scoping wraps whatever it gets, so either works; put it last in the pattern).
- A fresh sort traversal must not be marked required (filtered blocks are OPTIONAL already).
- Count/ask ignore `sortBy`; nothing to do there.

### Tasks

#### Phase 1: failing tests

New `src/tests/select-sort-and-leaf-edges.test.ts` (lowering, wire, live) for items 1, 2, 3, 5;
triples-order and reserved-name tests next to their existing ones. Validation: they fail, quoted.

#### Phase 2: implementation

All six items. Validation: the new tests pass; goldens; whole core suite with live Fuseki;
`npx linked build`.

#### Phase 3: review and fixes

Independent review; fix medium and up. Validation: whole suite again; the host app's typecheck gate and smoke.

Dependency: phases in order; items within phase 2 are independent.

### Progress

#### Phase 1: failing tests (done)

New `src/tests/select-sort-and-leaf-edges.test.ts`, three goldens in `sparql-select-golden.test.ts`,
a triples-order test in `triples-read.test.ts`, `reserved-labels.test.ts` rewritten. Against the
unchanged sources: `Tests: 27 failed, 130 passed, 157 total`, `[fuseki] live tests: 8 total — 1
passed, 7 failed`. The one live pass (the filtered sort) passed by accident: see Deviation 1.

#### Phase 2: implementation (done)

All six items as planned. Deviations:

1. **Paged MIN/MAX over a group with an unbound value (found here, report 101's rule).** Jena
   answers `MIN(?h)` as unbound when one row of the group lacks `?h` (probe:
   `MIN(?h) [["urn:b","Chess"],["urn:a",null]]`, `SAMPLE(?h)` answers `Archery`). So a paged
   `orderBy((p) => p.friends.hobby)` sorted Anna (friends Carl with a hobby, Dirk without) as
   missing. A key read through a multi-valued traversal is now computed by a sub-SELECT of its
   own over the rows that bind it (`BIND` + `FILTER(BOUND)`), joined OPTIONAL to the page.
2. The two-segment filter refusal I planned is `where()`'s own ("cannot call where() from within a
   where() clause"); no second check.
3. Sort directions from the wire are read in any case (they were passed through unchecked).

Validation: the new tests pass; whole suite with live Fuseki (first run): `[fuseki] live tests:
485 total — 483 passed, 0 failed, 2 skipped`; the four failing suites needed `lib/` (not built in
the new worktree) or asserted wire 1.6.

### Review

Independent read-only review, round 1.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R1 | high | `ExistsCondition.not()` flipped the head only, so `not(A and B)` was `(not A) and B`; `every()` over a chained inner quantifier went through it (older at top level) | Fixed (Gap 1) |
| R2 | medium | A sort filter on a later segment (`p.friends.friends.where(…)`) made the first hop required: instances dropped | Fixed (Gap 2): refused |
| R3 | medium | A wire `whereIndex` out of range (or on a leaf) dropped the filter silently | Fixed (Gap 2): any index but 0 refused |
| R4 | medium | A quantifier's condition decoded against the root shape, not the member's (older; reaches nested quantifiers now) | Fixed (Gap 3) |
| R5 | low | Stale JSDoc on `QueryShapeSet.equals` (no quantifier inside a callback) | Fixed |
| R6 | low | Two structural casts (`valueShape`, `subject`) | Kept: no null hidden |

### Iteration 1 — Ideation

#### Gap 1 of 3: negating a chained quantifier

- A. A flag "the whole condition is negated", read by lowering, encoding, chaining.
- B. De Morgan in `not()`: the chain folds left, so negate every part and swap every `and`/`or`.

Chosen: B (no new state; lowering and the wire unchanged).

#### Gap 2 of 3: filters further down a sort path

- A. Make the hops before a deeper filter OPTIONAL with the filtered block nested in them (new
  algebra nesting, also wanted by projections, which have the same required hops).
- B. Refuse any filter that is not on the first segment, DSL and wire alike (one check in
  desugaring).

Chosen: B; A recorded as a follow-up.

#### Gap 3 of 3: member shape for quantifier conditions

Decode the condition against the relation's value shape (fallback: the outer shape).

### Iteration 1 — Plan and phases

#### Phase 3: review fixes

- `ExpressionNode.ts` `ExistsCondition.not()`; `IRDesugar.ts` refusal; `DslJsonExpression.ts`
  `memberShapeOf`; JSDoc. Tests: every over a chained inner quantifier (lowering, wire, live),
  later-segment and wire-index refusals, pets round trip. README and dsl-json.md state the
  first-segment rule.
- Validation: whole suite with live Fuseki after `npx linked build`; the host app's typecheck gate and smoke.
