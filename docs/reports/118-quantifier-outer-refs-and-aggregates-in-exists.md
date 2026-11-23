---
summary: >
  A quantifier (some/every/none) whose callback reads the outer subject or an enclosing member reads
  that node, never its own member, in a top-level where, a mutation's where, an ask and inside an
  inline filter; a quantifier on the outer subject's relation starts there. An aggregate inside a
  quantifier, an inline filter or a minus() is refused at lowering instead of emitting
  FILTER(COUNT(…)). Patch. Closes backlog 079 (answering it folded into 042) and items 1–2 of 111.
packages: [core]
---

# 118 — Quantifiers reading the outer subject; aggregates inside EXISTS refused

## PR

### Summary

Plan 006, step S2: decision 3 (backlog 079) and decision 14 (backlog 111 items 1 and 2).

1. **Aggregates inside a per-member condition are refused.**
   `Person.select().where((p) => p.friends.some((f) => f.friends.size().equals(1)))` emitted
   `FILTER(EXISTS { … FILTER(COUNT(DISTINCT ?a1_friends) = 1) })`, which is not valid SPARQL. The
   same held for `every`/`none`, nested quantifiers, an inline filter
   (`p.friends.where((f) => f.friends.size().equals(1))`, a FILTER inside an OPTIONAL block) and
   `minus((p) => p.friends.size().equals(1))`. Lowering now refuses each with an error that names
   the construct and points at the top-level form (`.where((p) => p.friends.size().equals(1))`, a
   GROUP BY/HAVING over the subject) or selecting the count. Answering it (a sub-SELECT with
   GROUP BY/HAVING per member) is folded into backlog 042, the same missing capability; backlog
   079 is removed.
2. **A quantifier reads the outer subject.** `p.friends.some((f) => f.name.equals(p.name))` lowered
   to `FILTER(?a1_name = ?a1_name)` inside the EXISTS (a silent self-comparison). The quantifier's
   callback is now a trace scope of its own, so `p.name` reads the person: `?a0 :name ?a0_name`
   inside the EXISTS, `FILTER(?a1_name = ?a0_name)`, for `some`, `every` and `none` (NOT EXISTS),
   in a select's, a mutation's and an ask's where, and inside an inline filter (case 2, refused
   before). Nested quantifiers may read the outer subject or an enclosing quantifier's member
   (`p.friends.some((f) => f.friends.some((g) => g.name.equals(f.name)))`). A path below the outer
   subject (`p.bestFriend.name`) is traversed inside the EXISTS from the subject; a quantifier on
   the outer subject's relation written inside another one
   (`p.friends.some((f) => p.bestFriend.friends.some((x) => x.equals(f)))`) starts at the subject
   (it started at the member). Such a query has no DSL-JSON form yet: `toJSON()` refuses it.

### Changes

- `src/queries/traceScopes.ts`: every quantifier callback opens a scope (not only inside an inline
  filter); a path rooted at an enclosing scope is `{kind: 'enclosing', up}` (scopes up from the
  innermost), no longer refused at trace time. `inTraceScope` removed (unused).
- `src/expressions/ExpressionNode.ts`: `tracedOuterExpression` takes `'outer' | {up} | 'unscoped'`
  (placeholder `__enclosing_ref_<up>_N__`); `OuterReferenceResolver` takes `scopesUp`;
  `ExistsCondition.outerRoot` (where a quantifier's path starts when it is not the enclosing
  callback's subject), carried by `not`/`and`/`or` and re-rooted by `reRootOuterReferences`
  (preloaded components).
- `src/queries/SelectQuery.ts`: quantifier callbacks always traced in a scope; `quantified()` sets
  `outerRoot`; the outer-aggregate refusal message covers quantifiers.
- `src/queries/IRLower.ts`: `lowerExistsCondition` builds a resolver for its predicate (query-root
  paths along the nodes bound where it is tested, then traversals of its own inside the EXISTS;
  enclosing members by scope depth) and starts at `outerRoot`; the inline-filter handler passes
  its ancestors and member; `refuseAggregateIn` for quantifiers, inline filters and `minus()`.
- `src/sparql/irToAlgebra.ts`: `bindOuterReadsInExists` gives a property the EXISTS reads of a node
  it does not bind a variable of its own and a triple inside the EXISTS; `collectExistsReads` holds
  an EXISTS in a nested filtered block to the same in-scope rule as the block's outer reads.
- `src/queries/DslJsonExpression.ts`: encoding refuses an enclosing reference and an `outerRoot`.
- Docs: README (set filtering: outer subject, enclosing member, aggregate refusal; the inline-filter
  paragraph), `documentation/sparql-algebra.md` (steps 4 and 5), `documentation/dsl-json.md`.
  `.changeset/quantifier-outer-refs-and-aggregates.md`: **patch**.
- Tests: new `src/tests/quantifier-outer-refs-and-aggregates.test.ts` (20 lowering/refusal tests,
  5 live); two goldens in `src/tests/sparql-select-golden.test.ts`; one test in
  `src/tests/inline-filter-outer-refs-and-filtered-size.test.ts` changed (see Deviations).
- Backlog: 079 removed, its "answer it" half in 042; 111 items 1–2 removed (3–5 kept, numbers
  kept); 112 items 5–6 added. Plan 006 Progress: S2 ticked.

### Verification

After rebasing onto `ccr-88cd3a37-okakn0` (S3 and the S1 review fixes landed first):

```
$ time npx tsc -p tsconfig-tests.json --noEmit
real	0m7.694s                (no diagnostics)

$ time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs \
    src/tests/quantifier-outer-refs-and-aggregates.test.ts \
    src/tests/inline-filter-outer-refs-and-filtered-size.test.ts \
    src/tests/sparql-select-golden.test.ts src/tests/ir-select-golden.test.ts \
    src/tests/sparql-ask-golden.test.ts src/tests/sparql-count-golden.test.ts
Test Suites: 6 passed, 6 total
Tests:       13 skipped, 262 passed, 275 total
real	0m5.871s
```

The skipped tests are the `[fuseki]` blocks (no Docker). The specs of the touched files (DSL-JSON,
mutation, select, desugar suites) through the whole suite:

```
$ time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs
FAIL src/tests/ontology-load-files.test.ts
FAIL src/tests/two-copies-built.test.ts
FAIL src/tests/two-copies-entry-points.test.ts
Test Suites: 3 failed, 19 skipped, 161 passed, 164 of 183 total
Tests:       51 failed, 639 skipped, 2952 passed, 3642 total
real	0m20.126s
```

The three failing suites need a build (`lib/esm/index.js is missing: run npx linked build before
this test`), as before this change.

Against oxigraph (npm `oxigraph` 0.5.13 in `/tmp/s2-oxigraph`, outside the repo): the generated
SPARQL and core's result mapping on 16 persons (the dataset of the new test file: anna and bob have
a namesake friend; carl's friend dave has a friend named Carl, who is dave's best friend; dirk has
no name; eve's friend fay has a friend named Eve and eve as best friend; hal's friend jo is a friend
of hal's best friend ida). Ids of the persons returned, or `[person, members]`:

```
someNamesake                ["anna","bob"]
everyNamesake               ["ann","bob","bob2","carl2","dirk","erik","eve2","jo"]
noneNamesake                ["ann","bob2","carl","carl2","dave","dirk","erik","eve","eve2","fay","gus","hal","ida","jo"]
friendOfFriendNamesake      ["carl","eve"]
friendWithNamesakeFriend    ["anna","carl","dirk"]
friendNamedLikeBestFriend   ["dave","fay"]
projectedName               [["anna","Anna"],["bob","Bob"]]
inlineFilterQuantifier      [… ["carl",["dave"]] … ["eve",["fay"]] …, all 16 kept]
nestedBlockQuantifier       [… ["carl2",["dave"]] …, all 16 kept]
inlineFilterNoneEnclosing   [["anna",["ann"]],["bob",["bob2"]],["carl",["dave"]],["dave",["carl2"]],["eve",["fay"]],["fay",["eve2"]],["gus",["eve"]],["hal",["jo"]],["ida",["jo"]], others []]
sortedPaged                 ["carl","eve","ann"]
subSelect                   [… ["gus",[["eve",["fay"]]]] …, every other inner list []]
friendIsBestFriend          ["dave"]
friendsBestFriendIsMe       ["eve"]
friendAlsoBestFriendsFriend ["hal"]
afterDeleteWhereSome        ["ann","bob2","carl","carl2","dave","dirk","erik","eve","eve2","fay","gus","hal","ida","jo"]
```

- `someNamesake` / `everyNamesake` / `noneNamesake`: `p.friends.some|every|none((f) =>
  f.name.equals(p.name))`. `none` is the complement of `some`; `every` holds vacuously for persons
  without friends and for dirk (no name: no friend contradicts it, as for a member without the
  property, unchanged).
- `friendOfFriendNamesake`: `f.friends.some((g) => g.name.equals(p.name))` nested (outer subject two
  scopes up); `friendWithNamesakeFriend`: `g.name.equals(f.name)` (enclosing member).
- `friendNamedLikeBestFriend`: `f.name.equals(p.bestFriend.name)` (a path below the subject).
- `projectedName`: `select((p) => p.name).where(…some namesake…)`: the projected name is the
  person's full value, not tied to the EXISTS (its own variable).
- `inlineFilterQuantifier`: `p.friends.where((f) => f.friends.some((g) => g.name.equals(p.name)))`;
  `nestedBlockQuantifier`: the same under `p.bestFriend.friends` (the best friend's block);
  `inlineFilterNoneEnclosing`: `p.friends.where((f) => f.friends.none((g) => g.name.equals(f.name)))`.
- `sortedPaged`: `orderBy` on such a filtered path, `limit(3)`: carl (key Dave) and eve (key Fay)
  first, the rest by IRI.
- `subSelect`: `p.friends.select((f) => f.friends.where((g) => g.friends.some((h) =>
  h.name.equals(f.name))).name)` (a sub-select's member as the outer node).
- `friendIsBestFriend`: `p.friends.equals(p.bestFriend)`; `friendsBestFriendIsMe`:
  `p.friends.some((f) => f.bestFriend.equals(p))`; `friendAlsoBestFriendsFriend`:
  `p.friends.some((f) => p.bestFriend.friends.some((x) => x.equals(f)))`.
- `afterDeleteWhereSome`: `DeleteBuilder.from(Person).where(…some namesake…)` run as an update:
  anna and bob are gone.

The new file's `[fuseki]` block was also run against oxigraph (its store helpers swapped for an
oxigraph store, in the scratch directory): 5 of 5 pass.

### Deviations

- **Changed test (contract C1 spirit):** report 115's `a quantifier inside the filter reads only its
  own member` expected the refusal decision 14 lifts; it now asserts the resolved comparisons. Its
  aggregate refusal regex follows the new message. No golden changed.
- **Beyond the two shapes of backlog 111:** a quantifier on the outer subject's relation written
  inside another quantifier started at the member (silent wrong answer); it now starts at the
  subject (`ExistsCondition.outerRoot`). A member compared with the outer subject inside a
  quantifier (`f.bestFriend.equals(p)`) compared with the member; it reads the subject now.
  Ledger rows 4, 5.
- **Refusal beyond EXISTS:** an aggregate inside an inline filter (decision 3's "nested where
  blocks") and inside `minus()` (not named by the decision, same invalid FILTER) are refused too.
  Ledger row 3.
- **DSL-JSON:** a top-level quantifier reading the outer subject used to serialize (as the
  self-comparison); `toJSON()` refuses it now, so such a query cannot be live or remote until
  backlog 111.3. Ledger row 6.
- One implementation commit for both phases: they share `lowerExistsCondition`.

### Follow-ups

- Answering an aggregate inside a quantifier, an inline filter or a minus(): backlog
  `docs/backlog/042-ask-and-count-with-aggregate-filters.md` (section "Aggregates inside a
  per-member condition").
- DSL-JSON form for outer references (now including quantifiers), deeper hops, routed complex-path
  outer reads (now including a quantifier's): backlog
  `docs/backlog/111-outer-references-quantifiers-and-wire.md` items 3–5.
- Found on the way, older: an `||` inside a quantifier drops members without one of its properties
  (EXISTS property triples are required; outer reads inherit it); an inline filter in a where path
  or a quantifier's callback is dropped: backlog
  `docs/backlog/112-inline-filter-and-size-lowering-edges.md` items 5–6 (plan step S9).

## Details

### Phases

1. **079 (decision 3).** `refuseAggregateIn(construct, expr)` in `IRLower.ts` (uses
   `containsAggregate` from `irExpressions.ts`, which walks nested EXISTS filters too) after a
   quantifier's predicate is lowered, after an inline filter is lowered, and after a minus() where.
   Validation: the refusal tests (some/every/none, conjunction, min, nested, ask, delete-where,
   inline filter, minus) and the unchanged top-level HAVING, also chained beside a quantifier.
2. **111 items 1–2 (decision 14).** Trace scopes for every quantifier, the enclosing-scope
   reference, the predicate resolver, own variables inside the EXISTS, `outerRoot`. Validation:
   lowering tests, two goldens, oxigraph run above.

### How an outer read inside a quantifier lowers

- **Trace.** `QueryShapeSet.buildPredicateExpression` runs the callback under
  `withTraceScope(memberProxy)`. `traceScopeOf` gives `own` (rooted at the innermost scope),
  `enclosing {up}` (rooted at a scope below it on the stack), `outer {prefix}` (rooted at the query's
  proxy, or a sub-select's, mapped to its path from the root) or `unscoped`. `quantified()` applies
  the same to the relation the quantifier is called on (`outerRoot`).
- **Lower.** `lowerExistsCondition(condition, ctx, options)`:
  - start: `options.rootAlias`, or `options.resolveOuter(prefix)` / `resolveOuter([], up)` for an
    `outerRoot`;
  - predicate options: `rootAlias` = the member, `resolveOuter` = a resolver that takes a root path
    through `boundOuterPrefix` (the query's own where: `{alias: root, consumed: 0}`; an inline
    filter: the traversals leading to the filtered one, `walkAncestors`) and traverses the rest by
    a resolver of this EXISTS's own (`outerResolve`, so `p.friends.name` never reuses the member's
    `?a1`), or an enclosing member from `scopeAliases[len - 1 - up]`;
  - the EXISTS pattern is the member path's traversals plus the outer ones.
  The inline-filter handler keeps report 115's strict resolver for the filter's own expression
  (hops above only) and passes `boundOuterPrefix`/`scopeAliases` for quantifiers inside it.
- **Compile.** `convertExpression` (`exists_expr`) runs `bindOuterReadsInExists` first: a
  `property_expr` whose source the EXISTS pattern does not bind (`collectBoundAliases`) is keyed
  `alias@<first local alias>` and bound by `VariableRegistry.createAs` plus a triple inside the
  EXISTS. Sharing the outer variable would tie the EXISTS to the outer row (a projected `p.name`
  would keep only matching names) and, when the EXISTS registered it first, move the only triple
  of a later sort key or projection into the EXISTS (an ORDER BY on an unbound variable).
- **Scope check.** An EXISTS inside a nested filtered block (`p.bestFriend.friends.where((f) =>
  f.friends.some((g) => g.name.equals(p.name)))`) is evaluated in the block's LeftJoin condition,
  where only the parent and the node its hop leaves from are bound: `collectExistsReads` adds the
  ancestors the EXISTS reads to the block's `nodes`, and `assertOuterReadsInScope` refuses a node
  further up (`p.bestFriend.bestFriend.friends.where(…)`), as for the filter's own reads.

### Refusals (messages)

| Query | Where | Message starts |
|---|---|---|
| `p.friends.some((f) => f.friends.size().equals(1))` (also every/none/nested/min/max, ask, mutation) | lowering | An aggregate (size, min, max, …) inside a quantifier (some/every/none) is not supported |
| `p.friends.where((f) => f.friends.size().equals(1))` | lowering | … inside an inline filter (`.where()` on a relation) is not supported |
| `.minus((p) => p.friends.size().equals(1))` | lowering | … inside minus() is not supported |
| `p.friends.some(() => p.friends.size().equals(1))` | tracing (lower) | An aggregate (size, min, max) over the outer subject's paths inside an inline filter or a quantifier |
| `p.bestFriend.bestFriend.friends.where((f) => f.friends.some((g) => g.name.equals(p.name)))` | compile | An inline filter reads a node more than one hop above the relation it filters |
| `toJSON()` of any of the above outer reads | encode | An inline filter or a quantifier that reads the outer subject … has no DSL-JSON form yet |

### Known limitations

- Backlog 112.5: property triples inside an EXISTS are required, so `f.name.equals(p.name).or(…)`
  matches nothing for a subject without a name, as `f.name.equals('x').or(f.hobby…)` drops a
  member without a name (older, same rule).
- Backlog 111.5: an outer read's own variable inside an EXISTS is not seen by
  `routedPathsTheStoredWay` (complex-path, non-literal outer reads across graphs only).

### Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 1 | tasks, design | Where an outer read inside an EXISTS is bound | A variable of its own and a triple inside the EXISTS (EXISTS sees the outer node by substitution) | Reuse the outer query's variable | Reuse tied the EXISTS to the outer row and could move a sort key's only triple into the EXISTS (seen in a probe) |
| 2 | tasks, design | A path below the outer subject (`p.bestFriend.name`, `p.friends.name`) | Along nodes bound where the EXISTS is tested (root; an inline filter's hops above), the rest traversed inside the EXISTS by traversals of its own | Refuse it; or reuse the member path's traversals | EXISTS can traverse from a bound node, so it is answerable; sharing the member's traversal would be the self-comparison again |
| 3 | implementation | Decision 3 names EXISTS and "nested where blocks"; inline filters and minus() emit the same `FILTER(COUNT)` | Refuse all three with one helper naming the construct | Refuse only quantifiers | No invalid SPARQL reaches a store; a refusal is never a wrong answer |
| 4 | implementation | A quantifier on the outer subject's relation inside another (`p.bestFriend.friends.some(…)` in `f`'s callback) started at the member | `ExistsCondition.outerRoot`, resolved through the same resolver | Refuse it | Silent wrong answer in the code S2 touches; nested quantifiers are in the step's brief |
| 5 | review | `f.bestFriend.equals(p)` inside a quantifier compared with the member (after the S1 review fix made it trace) | Covered by the quantifier scope; tests and oxigraph | — | Same bug class as item 1 |
| 6 | implementation | A top-level quantifier reading the outer subject serialized (wrongly) and now has no wire form | `toJSON()` refuses (backlog 111.3) | Invent a wire form | A wire syntax is a design choice outside the decisions; refusing is never wrong |
| 7 | review | Two older silent wrong answers found (`||` in a quantifier; an inline filter in a where path dropped) | Backlog 112 items 5–6, which plan step S9 consumes | Fix here | Outside S2's scope; S9 is the step for older lowering edges (decision 15) |
| 8 | implementation | Backlog 111 items 1–2 removed; renumber 3–5? | Keep numbers (reports cite 111.3/111.5) | Renumber | Stable references |
| 9 | wrapup | Phases share `lowerExistsCondition` | One implementation commit | Split by hand | The split would not build on its own between the two |
| 10 | rebase | The S1 review fixes landed `reRootOuterReferences` (preloaded components) and the same `nodeEquals` fix | Kept theirs; `reRootOuterReferences` also re-roots `outerRoot`; tests for a preloaded component's quantifiers | — | Merge without losing either behaviour |
