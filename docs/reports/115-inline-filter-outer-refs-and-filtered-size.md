---
summary: >
  An inline filter that reads the outer subject compares with the outer node (a variable of its
  own, bound beside the filtered block), never with its own member; reads that cannot be answered
  are refused, and such a query has no DSL-JSON form yet. A filtered size() counts only the
  members its filter keeps, and counted hops stay OPTIONAL (count 0). Patch. Closes backlog 108;
  backlog 111 and 112 added.
packages: [core]
---

# 115 — Inline filter outer references and filtered size

## PR

### Summary

Plan 006, step S1 (backlog 108, report 107's review R5/R6), decisions 1 and 2.

1. **Outer references.** `Person.select((p) => p.bestFriend.friends.where((f) =>
   f.name.equals(p.name)).name)` lowered to `FILTER(?a2_name = ?a2_name)`: `p.name` resolved
   against the filter's own member. It now reads the outer node: `FILTER(?a2_name = ?a0_name)`,
   with `?a0_name` a variable of its own bound by `OPTIONAL { ?a0 :name ?a0_name }` just before the
   filtered block, on the same left side (inside the best-friend OPTIONAL). A filter may read the
   node its relation leaves from and the hop before it (`p.name`, `p.bestFriend.name`; in a
   sub-select, the sub-select's member). Refused, never compared with the member: a path that is
   not a hop above the filtered relation (`p.bestFriend.name` under `p.friends`, `p.friends.name`
   under `p.friends`), a node further up than the block's scope, a quantifier inside the filter
   reading outside its own member, an aggregate over the outer subject. Such a query has no
   DSL-JSON form yet: `toJSON()` refuses it.
2. **Filtered `size()`.** `select((p) => p.bestFriend.friends.where(…).size())` counted every
   friend (`COUNT(DISTINCT ?a1_friends)`, filter dropped) with `bestFriend` required. It now counts
   the filtered traversal's nodes (`COUNT(DISTINCT ?a2)`, the filter in its OPTIONAL block), the
   hops above stay OPTIONAL (an instance without them counts 0), and the traversals only a count
   reads are no longer projected (they became GROUP BY keys and split the count). The same keeps
   persons without friends in an unfiltered `p.friends.friends.size()` (two goldens changed). A
   filtered size compared in a where (`where((p) => p.friends.where(…).size().equals(1))`) counted
   every member; it is refused now.

### Changes

- `src/queries/traceScopes.ts` (new): a scope stack for callbacks. While an inline filter's
  callback runs (and a quantifier's inside one), a traced path rooted at another proxy is an outer
  reference, with its path from the query root (a sub-select's proxy maps to the relation it
  selects from).
- `src/queries/SelectQuery.ts`: `toExpressionNode` marks outer references; `QueryShapeSet.where`
  and the quantifier callbacks open scopes; `SetSize.toCountExpr` refuses a filtered size and an
  outer aggregate (`assertOwnAggregatePath`, also for `min`/`max`).
- `src/expressions/ExpressionNode.ts`: `tracedOuterExpression`, `isOuterReference`;
  `resolveExpressionRefs` takes an optional outer resolver and refuses an outer reference without
  one.
- `src/queries/IRLower.ts`: the inline filter handler resolves outer references along the
  traversals leading to the filtered one (`outerResolverFor`); `lowerWhere`/`lowerExistsCondition`
  pass it to the filter and its chained conditions, not into a quantifier.
- `src/sparql/irToAlgebra.ts`: outer reads get variables of their own
  (`VariableRegistry.createAs`), bound by OPTIONALs placed before the block
  (`attachFilteredBlock`); a nested block's reads must be its parent or the parent's source
  (`assertOuterReadsInScope`); aggregate projections' traversals are OPTIONAL and, when only a
  count reads them, not projected.
- `src/queries/FieldSet.ts` (`attachScopedFilter`, used for paths and sizes; sub-select roots
  registered), `src/queries/IRDesugar.ts` (a size's filter on the counted step or a hop above),
  `src/queries/IRProjection.ts` (a filtered count step is a filtered traversal counted as nodes).
- `src/queries/DslJsonExpression.ts`: encoding an outer reference is refused.
  `src/queries/QueryBuilder.ts`: a failing query that cannot be serialized names its own error.
- Docs: README (a filter that reads the outer subject; filtered size), `documentation/dsl-json.md`
  (filtered size field; no wire form for outer references), `documentation/sparql-algebra.md`
  (step 4). `.changeset/inline-filter-outer-refs-and-filtered-size.md`: **patch**.
- Tests: new `src/tests/inline-filter-outer-refs-and-filtered-size.test.ts` (18 lowering, refusal
  and wire tests, 3 live); two new goldens in `src/tests/sparql-select-golden.test.ts`; goldens
  `countNestedFriends` and `countLabel` updated (see Deviations).
- Backlog 108 removed; backlog 111 and 112 added. Plan 006 Progress: S1 ticked.

### Verification

Typecheck and the gate specs, after rebasing onto `ccr-88cd3a37-okakn0` (S4, S5, S6 landed first):

```
$ time npx tsc -p tsconfig-tests.json --noEmit
real	0m9.256s                (no diagnostics)

$ time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs \
    src/tests/inline-filter-outer-refs-and-filtered-size.test.ts \
    src/tests/sparql-select-golden.test.ts src/tests/ir-select-golden.test.ts
Test Suites: 3 passed, 3 total
Tests:       3 skipped, 197 passed, 200 total
real	0m10.618s
```

The 3 skipped tests are the new `[fuseki]` block (no Docker here). The whole suite, as a wider
check of the touched files' specs (`FieldSet`, `SelectQuery`, DSL-JSON, desugar, projection):

```
$ time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs
FAIL src/tests/ontology-load-files.test.ts
FAIL src/tests/two-copies-built.test.ts
FAIL src/tests/two-copies-entry-points.test.ts
Test Suites: 3 failed, 19 skipped, 159 passed, 162 of 181 total
Tests:       51 failed, 629 skipped, 2887 passed, 3567 total
real	0m36.273s
```

The three failing suites need a build (`lib/esm/index.js is missing: run npx linked build before
this test`); they fail the same way without this change (no `lib/` in a fresh worktree).

Against oxigraph (npm `oxigraph` 0.5.13 in a scratch directory outside the repo), the generated
SPARQL and core's result mapping, on six persons: anna (Anna, best friend bob), bob (friends carl,
ann), carl (Carl, Chess, best friend erik, friend anna), dirk (no name, best friend bob), erik
(friend dirk), ann (Anna). Rows as `[person, best friend's friends]` / `{person: count}`:

```
namesakes         [["ann",[]],["erik",[]],["dirk",[]],["carl",[]],["bob",[]],["anna",["ann"]]]
namesakesOrChess  [["ann",[]],["erik",[]],["dirk",["carl"]],["carl",[]],["bob",[]],["anna",["ann","carl"]]]
carlCount         {"carl":0,"bob":0,"anna":1,"ann":0,"erik":0,"dirk":1}
namesakeCount     {"carl":0,"bob":0,"anna":1,"ann":0,"erik":0,"dirk":0}
sortedPaged       ["anna","ann","bob","carl","dirk","erik"]
```

- `namesakes`: `p.bestFriend.friends.where((f) => f.name.equals(p.name)).name`: only Anna gets a
  match (ann); every person is kept.
- `namesakesOrChess`: `…where((f) => f.name.equals(p.name).or(f.hobby.equals('Chess')))`: dirk,
  who has no name, still gets carl through the other branch (the outer value is bound on the
  block's left side, not inside it).
- `carlCount`: `{carls: p.bestFriend.friends.where((f) => f.name.equals('Carl')).size()}`: 1 for
  anna and dirk, 0 for everyone else, including the persons without a best friend.
- `namesakeCount`: a filtered size with an outer reference.
- `sortedPaged`: `orderBy((p) => p.bestFriend.friends.where((f) => f.name.equals(p.name).not()).name).limit(10)`:
  anna (key Carl) first, the rest (no key) last by IRI; the page sub-SELECT binds the outer value too.

### Deviations

- **Goldens changed (contract C1):** `countNestedFriends` (`p.friends.friends.size()`) and
  `countLabel` (`p.friends.select((f) => ({numFriends: f.friends.size()}))`) now have the
  `?a0 :hasFriend ?a1` hop OPTIONAL. The goldens encoded the bug decision 2 fixes for the filtered
  case: a person without friends was dropped instead of counted 0. Ledger row 4.
- **Refusals beyond the two shapes of backlog 108**, each a silent wrong answer before: a filtered
  size compared in a where, an aggregate over the outer subject inside a filter (ledger rows 5, 6).
- **No DSL-JSON form** for an inline filter that reads the outer subject: `toJSON()` refuses it
  (a wire syntax is a design choice the plan does not settle; backlog 111). Ledger row 2.
- One commit for both phases: they share hunks in `irToAlgebra.ts`, `FieldSet.ts` and
  `SelectQuery.ts`.

### Follow-ups

- Quantifiers reading the outer subject (a silent self-comparison in a top-level where, refused
  inside an inline filter), the DSL-JSON form, a node more than one hop above the filtered
  relation, routed complex-path outer reads: backlog
  `docs/backlog/111-outer-references-quantifiers-and-wire.md`.
- Older lowering edges found on the way: a filtered and an unfiltered path over one relation share
  a filtered traversal; a traversal inside an inline filter is a required top-level triple;
  `size()` in a nested select counts across all members; comparing a filtered size: backlog
  `docs/backlog/112-inline-filter-and-size-lowering-edges.md`.

## Details

### The two bugs

**Outer references.** A traced path is a placeholder alias plus the property ids from its proxy:
`f.name` and `p.name` both trace to `['name']`, so lowering (which resolves an inline filter's
refs from the filtered alias) could not tell them apart. Two things were needed: knowing at trace
time which proxy a path starts from, and, at compile time, binding the outer value where the
filter is evaluated.

**Filtered size.** `FieldSet.convertTraceResult` turned a `SetSize` into `{path, aggregation:
'count'}` without the `wherePath` of its chain; desugaring had nowhere to put one on a count step;
and `irToAlgebra` collected aliases for OPTIONAL-ness from property/alias projections only, so a
count's hops were required, and step 7b projected every traversal alias, which became a GROUP BY
key. (A nested count happened to escape 7b when its projection alias collided with a traversal
alias and was renamed `_agg`.)

### Trace scopes (`src/queries/traceScopes.ts`)

- `withTraceScope(proxy, fn)` pushes a callback's proxy while `fn` runs. `QueryShapeSet.where`
  (via `processWhereClause(…, inline = true)`) opens one; `some`/`every`/`none` open one only when
  a scope is already open (inside an inline filter), so top-level quantifiers are unchanged.
- `traceScopeOf(obj)`: with no scope open, `own`. Else the chain root (walk `.subject`, then the
  object's `proxy`, since chains end at the proxied object while callbacks receive the proxy) is
  compared with the innermost scope: equal → `own`; on the stack below it → `unscoped` (the
  filter's member read from a quantifier: refused); otherwise `outer`, with the path from the
  query root. A root registered by `FieldSet.forSubSelect` (`registerSubSelectRoot`) maps to its
  source relation, recursively, so a sub-select's `f.name` inside a filter is `['friends','name']`
  from the root. Any other root (the select, sort or `.where` callback's proxy) is the query root.
- `toExpressionNode` builds outer paths with `tracedOuterExpression(ids, 'property' | 'alias',
  'outer' | 'unscoped')`: placeholders `__outer_ref_N__` / `__unscoped_ref_N__`, same
  `PropertyRefMap` shape as other refs.
- `SetSize.toCountExpr` and `QueryPrimitiveSet.valuesExpression` (size/min/max) refuse a path that
  is not `own` (`assertOwnAggregatePath`).

### Lowering (`IRLower.ts`, `ExpressionNode.ts`)

`resolveExpressionRefs(expr, refs, rootAlias, resolveTraversal, resolveOuter?)`: an outer
placeholder resolves its traversal ids through `resolveOuter` to an alias (property → `property_expr`
on it, alias → `alias_expr`); an unscoped one, or an outer one without a resolver (a quantifier's
predicate, a mutation's where), throws. `PathLoweringOptions.resolveOuter` carries it;
`lowerWhere` passes it to an expression where and to `lowerExistsCondition`'s chained conditions,
never to a quantifier's predicate.

`outerResolverFor(filteredAlias)` collects the traverse patterns from the filtered traversal's
source up to the root (`LoweringContext.traversalTo`) and walks the outer ids along them only: an
outer reference never creates a traversal, and never reaches the filtered alias itself or a
sibling. Anything else throws "not a hop above the filtered relation". It works for projection
paths and sort keys alike (a sort key's own traversals are in the chain).

### Compile (`irToAlgebra.ts`, `selectToAlgebra`)

- **3a.** For each filtered block, `mapOuterReads` rewrites `property_expr`s on an ancestor alias
  (the block's `from` up to the root) to a key of their own (`a0@a2`) and records an `OuterRead`
  `{key, alias, property, pathExpr}`; `alias_expr`s on an ancestor are recorded as nodes. An
  `EXISTS` inside the filter is not entered (it sees outer bindings where it is evaluated).
- **3b.** The block's own property triples are collected from the filter with the outer reads
  replaced by a literal, so they never land inside the block.
- **5b.** After the projections registered their variables, each read gets a fresh variable
  (`VariableRegistry.createAs(key, alias, property)`, named like `getOrCreate`: `?a0_name`, or
  `?a0_name_2` when the projection holds `?a0_name`) and a triple `?a0 :name ?var`.
  `attachFilteredBlock` wraps those triples as OPTIONALs on the node the block joins, then the
  block: `OPTIONAL { ?a0 :bestFriend ?a1 . OPTIONAL { ?a0 :name ?a0_name } OPTIONAL { ?a1
  :hasFriend ?a2 … FILTER(?a2_name = ?a0_name) } }`.
- **Why not inside the block:** an OPTIONAL group is evaluated before it is joined, so in the
  block `?a0` is unbound and `?a0 :name ?x` ranges over every subject; the join on `?a0` then
  drops the member rows of a subject without a name, also from an `||` branch that does not read
  it. On the left side, the value is bound (or not) per subject before the filter runs.
- **Scope:** a nested block (inside its parent's filtered block, OPTIONAL subtree, or paginated
  sub-SELECT) is evaluated against its parent's group, which binds the parent and the node the
  parent's hop leaves from (only the parent under a sub-SELECT, whose source is the subject IRI).
  `assertOuterReadsInScope` refuses any other read. A root-level block joins the top pattern,
  where every ancestor is bound.
- **Counts:** for an ungrouped select, the aliases of `aggregate_expr` projections join
  `directProjectionAliases` (OPTIONAL subtrees, as a sort path's do). Step 7b skips a traversal
  alias that only aggregate projections read (with ancestors), unless another projection reads it.

Desugar and projection: `FieldSet.attachScopedFilter` (shared by paths and sizes) records the
filter and its segment; `desugarEntry` puts it on the count step's property step or on a parent
step; `lowerSelectionPathExpression` lowers a filtered count step as a traversal of the select's
resolver with the filter attached, and counts `alias_expr` (the member nodes). The wire already
carried `aggregation` with `where`/`whereIndex`, so a filtered size round-trips (tested).

### Refusals (messages)

| Query | Where | Message starts |
|---|---|---|
| `p.friends.where((f) => f.name.equals(p.bestFriend.name))` | lowering | A filter reads a path from outside its own member (bestFriend) that is not a hop above the filtered relation |
| `p.friends.where((f) => f.name.equals(p.friends.name))` | lowering | same |
| `p.bestFriend.bestFriend.friends.where((f) => f.name.equals(p.name))` | compile | An inline filter reads "name" of a node more than one hop above the relation it filters |
| `…where((f) => f.friends.some((g) => g.name.equals(p.name)))` | lowering | … not a quantifier inside it |
| `…where((f) => f.friends.some((g) => g.name.equals(f.name)))` | lowering | … a quantifier (some/every/none) inside an inline filter can read only its own member |
| `…where((f) => p.friends.size().equals(2))` | build | An aggregate (size, min, max) inside an inline filter can be taken only over its own member's paths |
| `where((p) => p.friends.where(…).size().equals(1))` | build | A filtered size() … can be selected, not compared |
| `toJSON()` of an outer reference | encode | An inline filter that reads the outer subject … has no DSL-JSON form yet |

When `exec()` fails, `QueryBuilder` adds the query's DSL-JSON to the error; for a query that has
none it now writes `(not serializable: …)` instead of throwing the encoding error over the real one.

### Tests

- `src/tests/inline-filter-outer-refs-and-filtered-size.test.ts`: outer node read, projected
  outer value keeps its own variable and top-level OPTIONAL, hop read, sub-select member read,
  paged sort key (page sub-SELECT binds it too), every refusal above, `toJSON` refusal, error
  naming, unchanged own-member filter; filtered size (OPTIONAL hops, `GROUP BY ?a0` only, filter
  on a hop above, with an outer reference, compared → refused, unfiltered size OPTIONAL, DSL-JSON
  round trip). `[fuseki]` block: namesakes, `||` with an unnamed person, filtered counts (the same
  dataset as the oxigraph run).
- `src/tests/sparql-select-golden.test.ts`: two exact goldens (outer reference, filtered size);
  `countNestedFriends`, `countLabel` updated.

### Known limitations

See backlog 111 and 112. A filtered and an unfiltered path over one relation still share the
filtered traversal (112.1), which also holds for a filtered size beside the relation's projection.

### Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 1 | tasks, design | How to tell `p.name` from `f.name` (same property ids) | Trace-time scope stack; outer paths get their own placeholder kind, resolved at lowering along the filtered path's hops | Pass the outer root alias into every proxy | Contained (one module, one placeholder kind); refs keep their shape; correctness first |
| 2 | tasks, wire | An outer reference has no DSL-JSON form (paths are member-relative) | Refuse in `toJSON()`, backlog 111 | Invent a wire syntax (`@outer`) | A wire syntax and version bump are a design choice outside the plan's decisions; refusing is never wrong |
| 3 | implementation, compile | Where to bind the outer value | A variable of its own, OPTIONAL just before the block on its left side; refuse a node not bound there | Reuse the projection's variable / a triple inside the block | Inside the block is wrong for `||` and unnamed subjects (oxigraph run); a shared variable mixes scopes |
| 4 | implementation, size | The unfiltered nested size dropped instances too (goldens `countNestedFriends`, `countLabel`) | Same OPTIONAL rule for every counted path, goldens updated | Fix only the filtered case | Report 107's projection rule and decision 2 ("count 0 when none"); one rule, the goldens encoded the bug (C1) |
| 5 | implementation, size | A filtered size compared in a where silently counted every member | Refuse, backlog 112.4 | Leave it | Safety: a refusal over a wrong answer; supporting it needs HAVING over a filtered block |
| 6 | review | An aggregate over the outer subject inside a filter would count on the member | Refuse (`assertOwnAggregatePath`) | Leave it | Same silent self-comparison class as decision 1 |
| 7 | review | A quantifier reading the outer subject in a top-level where is a silent self-comparison (older) | Unchanged, backlog 111.1 | Refuse or resolve it here | Outside S1's scope (inline filters); changing quantifier semantics is S1-adjacent, not S1 |
| 8 | review | The query error wrapper threw the encoding refusal over the real error | Catch it, write `(not serializable: …)` | Leave it | Needed so the new refusals are readable; no other behaviour changes |
| 9 | wrapup | Phases share hunks | One implementation commit | Split by hand | The split would not build on its own between the two |
