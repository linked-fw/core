---
summary: >
  Silent wrong answers in select lowering fixed or refused: a where on a paged relation, a
  traversal inside an inline filter, `||` inside a quantifier (and across a traversal at the top
  level), a quantifier on a filtered relation, an inline filter on a path read as a value (refused),
  a computed field through a relation. Patch. Backlog 112 reduced to items 4, 6 (the refused
  half) and 7; item 3 moved to S8; backlog 113 added.
packages: [core]
---

# 122 — Inline filter, quantifier and computed-field lowering edges

## PR

### Summary

Plan 006, step S9 (backlog 112, decision 15) plus decision 22 and the master's two extra examples
for item 6. Every item of backlog 112 that gave a silent wrong answer now answers correctly or is
refused with a named error.

| Item | Before | Now |
|---|---|---|
| 112.1 a where beside a relation a field reads | filtered path: already right since report 115's review (checked); **paged sub-select**: the where's `?a1 :hobby` reused the page's `?a1` outside the page (bob's page showed carl, noname instead of ann) | fixed: a where or sort key on a paged relation reads a traversal of its own |
| 112.2 a traversal inside an inline filter | `?a1 :bestFriend ?a2` a required top-level triple, `?a1` unbound there: every person got the same friends | fixed: the filter's own traversals are OPTIONAL subtrees inside its block, never shared, not projected |
| 112.3 `size()` in a nested select | groups by `?a0` | moved to step S8 (decision 21 owns the lone sub-select aggregate; see Follow-ups) |
| 112.4 a filtered size compared | refused (report 115) | unchanged, stays in backlog 112 (feature) |
| 112.5 `||` inside a quantifier | EXISTS joined every triple: a nameless chess player never matched `f.name.equals('x').or(chess)`; `isNotDefined()` never held | fixed: what one branch reads is OPTIONAL inside the EXISTS (properties, traversals beyond the member, outer reads) |
| 112.6 an inline filter in a where path / quantifier | filter dropped | `p.friends.where(F).some/every/none(P)` fixed (`F and P`); a filtered path read as a value (where, inside a quantifier, computed field, sort expression, `min`/`max`, a hop above a quantifier) refused |
| decision 22 `{e: p.bestFriend.name.concat('!')}` | `bestFriend` required: persons without one lost | fixed: OPTIONAL, `e: null` |
| found here: `p.name.equals('Bob').or(p.bestFriend.hobby.equals('Golf'))` | `bestFriend` required: Bob without one lost | fixed: a traversal only some branches read is OPTIONAL |

### Changes

- `src/queries/IRLower.ts`: `LoweringContext.hasPagination`, `conditionResolver` (the where's and
  having's resolver: shares the projection's traversals except a paged or filtered one); the sort-key
  resolver checks pagination too. The inline-filter handler resolves the filter's paths through a
  resolver of its own (never shared) and skips a traversal already filtered (an equal filter shares
  one). `lowerExistsCondition` sets `exists_expr.member` when the pattern holds more than the member
  path.
- `src/queries/IntermediateRepresentation.ts`: `IRExistsExpression.member?` (additive).
- `src/sparql/irToAlgebra.ts`: `collectRequiredAliases` (traversals a top-level where requires,
  `||`-aware); where-only traversals otherwise become OPTIONAL subtrees; computed projections'
  traversals OPTIONAL; filter-owned traversals placed inside the block (`buildFilterOwnedSubtree`),
  excluded from the top-level pattern and the projection; `buildExistsBody` splits an EXISTS into
  required and OPTIONAL parts.
- `src/queries/SelectQuery.ts`: `assertNoInlineFilterOnPath` (in `toExpressionNode`, `min`/`max`, and
  above a quantified relation); `quantified` folds the relation's own inline filter into the
  predicate (`withMemberFilter`).
- Tests: new `src/tests/inline-filter-and-size-lowering-edges.test.ts` (22 lowering/refusal/wire
  tests, 11 `[fuseki]`); six goldens in `src/tests/sparql-select-golden.test.ts` ("inline filter,
  quantifier and computed-field lowering edges"). No existing golden changed.
- Docs: README (inline filter below its member; `||` and `isNotDefined()` in a quantifier and a
  top-level where; quantifier on a filtered relation and the refusal; computed field through a
  relation), `documentation/sparql-algebra.md` (steps 4, 5), `documentation/intermediate-representation.md`
  (`exists_expr.member`). `.changeset/inline-filter-and-size-lowering-edges.md`: **patch**.
- Backlog 112 reduced (items 4, 6's refused half, new 7); backlog 113 added; plan 006: S9 ticked,
  a note under S8.

### Verification

After rebasing onto `ccr-88cd3a37-okakn0` (2e2f82e, the S2 cast fix):

```
$ time npx tsc -p tsconfig-tests.json --noEmit
real	0m8.474s                (exit 0, no diagnostics)

$ time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs \
    src/tests/inline-filter-and-size-lowering-edges.test.ts src/tests/sparql-select-golden.test.ts \
    src/tests/ir-select-golden.test.ts src/tests/sparql-ask-golden.test.ts src/tests/sparql-count-golden.test.ts \
    src/tests/inline-filter-outer-refs-and-filtered-size.test.ts \
    src/tests/quantifier-outer-refs-and-aggregates.test.ts src/tests/duplicate-projection-fields.test.ts
Test Suites: 8 passed, 8 total
Tests:       24 skipped, 322 passed, 346 total
real	0m11.526s

$ time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs \
    src/tests/sparql-algebra.test.ts src/tests/sparql-mutation-golden.test.ts src/tests/mutation-where-union.test.ts \
    src/tests/query-dependencies.test.ts src/tests/dsl-json-expression.test.ts src/tests/dsl-json-roundtrip.test.ts \
    src/tests/live-query-store.test.ts src/tests/intermediate-representation.types.test.ts
Test Suites: 1 skipped, 7 passed, 7 of 8 total
Tests:       13 skipped, 281 passed, 294 total
real	0m7.944s
```

(The new test file gained one DSL-JSON round-trip test after this run: `Tests: 11 skipped, 22
passed, 33 total`.) Skipped tests are `[fuseki]` blocks (no Docker). The whole regular set once, as a
wider check: `Tests: 51 failed, 652 skipped, 2986 passed` in 43 s; the 51 are the three suites that
need `lib/` (`two-copies-built`, `two-copies-entry-points`, `ontology-load-files`), as before.

**oxigraph** (npm `oxigraph` 0.5.13 in `/tmp/s9-oxigraph`, not a dependency): the new test file with
its `[fuseki]` store helpers swapped for an in-memory oxigraph store, run here and on the base
(a detached worktree of `ccr-88cd3a37-okakn0`, removed after):

```
this branch:  Tests: 33 passed, 33 total
   ✓ a where on a paged relation: bob qualifies, his page is his first friend
   ✓ an inline filter's own traversal: friends whose best friend is Erik
   ✓ … or who play golf: a friend without a best friend still matches the other branch
   ✓ a filtered size through the filter's own traversal
   ✓ || in a quantifier: zed matches through his unnamed chess-playing friend
   ✓ isNotDefined() in a quantifier
   ✓ || with a traversal in a quantifier
   ✓ || with an outer read in a quantifier: zed (no namesake) through chess
   ✓ a quantifier on a filtered relation: zed's Carl plays no chess
   ✓ a computed field keeps every person
   ✓ a top-level ||: bob has no best friend and is kept by his name
base, live block only:  Tests: 11 failed, 22 skipped, 33 total
```

What the base answered, for the same dataset (bob's friends carl Chess bf erik / ann Golf /
noname Chess bf carl; zed's friends noname and carl2 Carl; see the test file):

- paged + where: bob's friends `["carl","noname"]` (the where's Chess players, nameless), not his
  page `["ann"]`;
- `friends.where(f => f.bestFriend.name.equals('Erik'))`: every person, ann and dirk included, got
  `["carl","erik","noname"]` (expected: anna, bob, noname get `["carl"]`, others `[]`);
- `some(f => f.name.equals('x').or(chess))`: zed missing; `some(f => f.name.isNotDefined())`: `[]`
  (expected bob, erik, zed);
- `{e: p.bestFriend.name.concat('!')}`: only carl, erik, noname rows (five persons lost);
- `p.name.equals('Bob').or(p.bestFriend.hobby.equals('Golf'))`: bob missing.

### Deviations

- **Beyond backlog 112:** a top-level where's traversal only some `||` branches read is OPTIONAL now
  (the backlog text assumed the top level was right; only its property triples were). Same rule as
  the EXISTS fix; no golden changed. A side effect: a where aggregate's traversals
  (`.where((p) => p.bestFriend.friends.size().equals(0))`) are OPTIONAL too, so an instance without
  the hop counts 0 instead of being dropped (report 115's count rule). Ledger rows 5, 6.
- **IR:** `IRExistsExpression.member?` added (additive; absent when the EXISTS holds only the member
  path, so no IR golden changed). Ledger row 4.
- **Item 6 refusal reaches computed fields, sort expressions and `min`/`max`** over a filtered path
  (all dropped the filter the same way); and a filter on a hop above a quantified relation. Ledger
  row 7.
- **Item 3 not done here:** step S8 owns the lone sub-select aggregate (decision 21) and runs
  concurrently in the same mapping code. Ledger row 3.
- One implementation commit: the items share `selectToAlgebra`'s optional/required bookkeeping.

### Follow-ups

- Comparing a filtered size (112.4), answering the refused filtered-path forms (112.6: needs the
  `not`/`or` semantics and a DSL-JSON form), a where narrowing a relation a field or count also reads
  (112.7, design): `docs/backlog/112-inline-filter-and-size-lowering-edges.md`.
- `size()` per member in a nested select (112.3), and counts through a hop or filter beside a sibling
  field missing from the member rows: plan 006 step S8 (note under its section).
- `||` in a delete/update where joins every triple as required (older, mutations):
  `docs/backlog/113-mutation-where-or-branches.md`.

## Details

### Phases (tasks mode, as run)

1. **Item 1 (paged).** Probe on oxigraph: the filtered-path half was already right (report 115's
   review); the paged half was wrong. `conditionResolver` for where/having, pagination check in the
   sort-key resolver. Gate: golden + oxigraph.
2. **Item 2.** Filter-private resolver in the inline-filter handler; `irToAlgebra` places
   filter-owned traversals in the block. Equal filters on two fields are lowered once (else the
   second lowering left orphan traversals). Gate: oxigraph (filtered path, `||`, filtered size,
   paged sort key, nested block, outer read, sub-select).
3. **Item 3.** Probed: identical IR to `p.friends.friends.size()` except the key; S8's decision 21
   (lone sub-select aggregate grouping and mapping) owns it.
4. **Item 5.** `buildExistsBody`; `exists_expr.member`. Gate: oxigraph (`||`, outer read,
   `isNotDefined`, traversal, `every`, `none`, delete-where SPARQL).
5. **Item 6 + master's examples.** `quantified` folds the filter; `assertNoInlineFilterOnPath`.
6. **Decision 22 and the top-level `||` traversal.** Both through `directProjectionAliases` (OPTIONAL
   subtrees) and `collectRequiredAliases`.
7. Tests, goldens, docs, backlog, report; rebase over the S2 cast fix (golden file conflict at the
   end of `sparql-select-golden.test.ts`, both blocks kept).

### How each fix works

- **Paged relation.** The where is lowered after the projection; `conditionResolver` asks
  `existingTraversal(from, property)`; when that traversal carries inner pagination (or a filter)
  it creates one of its own, memoized per where, so `p.friends.hobby.equals(x).and(p.friends.name…)`
  still shares one. The page's sub-SELECT stays as it was; the where's traversal is required beside
  it.
- **Filter-owned traversals.** IRLower: the filter's paths resolve through `ctx.createTraversal`
  (memoized per filter). irToAlgebra: a traversal is filter-owned when it hangs (transitively) off a
  filtered alias and no projection, sort key or where reads it; its triple leaves the required BGP,
  it is not projected (it would split DISTINCT rows and GROUP BY of a filtered count), and
  `buildFilteredBlock` attaches it as `OPTIONAL { ?a1 :bestFriend ?a2 . OPTIONAL { ?a2 :name ?a2_name } }`,
  the filter's property triples on owned aliases moved inside their subtree (on an unbound `?a2` an
  OPTIONAL would range over every node).
- **EXISTS.** `collectRequiredBindingKeys(filter)` splits the property triples (and the outer-read
  triples from `bindOuterReadsInExists`) into required (joined) and optional (OPTIONAL after the
  required part). With `member` set, the traversals up to the member and to every required key's
  alias are joined; the rest become OPTIONAL subtrees with their optional triples inside. Without
  `member`, every traversal stays required (the member path), as before.
- **Quantifier on a filtered relation.** `every(P)` is built as `NOT EXISTS(… FILTER(!P))`, so
  folding `F and predicate` gives `some: F∧P`, `every: ¬∃(F∧¬P)`, `none: ¬∃(F∧P)`. An
  ExpressionNode filter `and` an ExistsCondition predicate is built as `predicate.and(F)`.
- **Refusal.** `assertNoInlineFilterOnPath` walks the traced object's `subject` chain for a
  `wherePath`. Callbacks get fresh proxies, so a filter's own `f.name` never sees the outer filter.
- **Computed field / top-level `||`.** Every non-path projection (not only aggregates) and every
  where alias joins `directProjectionAliases`; `optionalTraversalAliases` still excludes the aliases
  `collectRequiredAliases(where)` (plus ancestors) requires, so `p.bestFriend.name.equals('Erik')`
  keeps `bestFriend` required.

### Refusals (messages)

| Query | Where | Message starts |
|---|---|---|
| `where((p) => p.friends.where(F).hobby.equals('y'))`, inside a quantifier, a computed field, a sort expression | build (lowering) | An inline filter (`.where()` on a relation) on a path read in an expression (a where, a quantifier, a computed field or sort key) is not supported: the filter would be dropped |
| `p.friends.where(F).name.max()` | build | … on a path aggregated with min() or max() … |
| `p.friends.where(F).friends.some(…)` | build | … on a path leading to a quantifier (some/every/none) … |

### Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 1 | item 1 ⚠ | A where on a paged relation: test the subject, or narrow the page as an unpaged sub-select's list is narrowed (it shares the where's traversal) | Its own traversal: the where tests the subject, the page is unchanged | Narrow the page (filter inside the sub-SELECT), or refuse | No silent wrong answer either way; narrowing a page needs a design for filter-then-limit; the sharing question is open (112.7) |
| 2 | item 2 | Share the filter's traversals with a projection of the same path? | Never (filter-private) | Share as before | Sharing let the filter's OPTIONAL bind the projection's node to anything, or a multi-valued filter path narrow the projection |
| 3 | item 3 | Fix the per-member count here | Leave to S8 (decision 21, concurrent, same mapping code), noted under S8 | Fix the grouping here | Avoids two agents editing the lone-aggregate grouping; S8's contract already promises it |
| 4 | item 5 | How irToAlgebra knows the member path inside an EXISTS | `exists_expr.member` (additive IR field, set only when there are other traversals) | Infer from the pattern; wrap traversals in IR `optional` | The pattern cannot tell member-path from outer traversals; the field leaves existing IR goldens unchanged |
| 5 | scope | Top-level where: traversals only some `||` branches read were required (older) | Fixed with the same rule | Backlog | Same mechanism the item names as the reference; silent wrong answer |
| 6 | scope | A where aggregate's traversals become OPTIONAL with it (count 0 kept) | Accept | Keep them required | Matches report 115's count rule (decision 2); no golden encoded the drop |
| 7 | item 6 | Answer `p.friends.where(F).hobby.equals('y')` or refuse | Refuse (also computed fields, sort expressions, min/max, a hop above a quantifier); answer only `where(F).some/every/none` | Answer via a filtered traversal group | Under `not`/`or` the semantics are a design choice, and expression refs have no DSL-JSON form for a filter (decision 15) |
| 8 | item 4 | Compared filtered size | Keep in backlog | Implement | Did not fall out of the other fixes (decision 15) |
| 9 | follow-up | `||` in mutation wheres (older, required triples) | Backlog 113 | Fix here | Different builders (delete/update where), outside 112 |
| 10 | follow-up | A where narrows a shared projected/counted relation (`n: 1` for bob's three friends) | Backlog 112.7 as a design question | Change sharing here | Long-standing path semantics; changing it moves many rows |
| 11 | wrapup | Phases share `selectToAlgebra` bookkeeping | One implementation commit | Split by hand | The splits would not build or pass independently |
