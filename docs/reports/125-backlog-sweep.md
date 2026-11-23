---
summary: >
  Backlog sweep of @_linked/core, run as a master plan in ten steps (reports 115–124): inline-filter
  outer references and filtered size(), quantifier outer references and aggregates inside EXISTS
  refused, duplicate projection fields, multi-key sorting (thenBy), relation field types and rows
  that follow their keys in the object form, lowering edges, `||` in mutation wheres, a keyed
  cached(), and a cached graph routing. A final security review refused `__proto__` and non-string
  result keys. Minor release with three behaviour changes called out in the changesets.
packages: [core]
---

# 125 — Backlog sweep

## PR

### Summary

A hands-off sweep of small backlog items in `@_linked/core`, run by a master agent with one step
agent per item, an independent review per wave and a full run per wave. Most steps fix silent wrong
answers in query lowering: an inline filter or a quantifier that compared a member with itself, a
filtered `size()` that counted every member, traversals that dropped instances or ranged over every
node, `||` in a delete/update where that changed too few subjects. The others add features: per-key
sort directions (`thenBy`), a keyed `cached()`, object-form rows and types that follow the keys the
user wrote, and a per-dataset graph routing cache (a delete by id at 300 shapes drops from 12 ms to
about 50 µs). Closes backlog 019, 023, 049, 070, 079, 088, 108, 110 and 113; adds 109, 111, 112,
114, 115 and 116.

The overall release is **minor**. Three changesets call out behaviour changes for upgraders:
object-form rows (`object-form-rows-follow-keys.md`), `every` with a missing hop
(`where-hops-and-every-counterexamples.md`), and delete/update wheres with `or`/`isNotDefined()`,
which now delete or update more subjects (`mutation-where-or-branches.md`).

### Changes

- **Inline-filter outer references, filtered size** (S1, [report 115](115-inline-filter-outer-refs-and-filtered-size.md),
  backlog 108 closed, 111 and 112 added): `p.bestFriend.friends.where((f) => f.name.equals(p.name))`
  compares with the outer node. A filtered `size()` counts only the members its filter keeps, and
  an instance without the counted hops gets a count of 0 instead of being dropped. Patch.
- **Multi-key sorting** (S4, [report 116](116-multi-key-sorting-then-by.md), backlog 019 closed,
  109 added): `SelectBuilder.thenBy(fn, direction)`. DSL-JSON wire version 1.11. Minor.
- **Keyed `cached()`** (S6, [report 117](117-keyed-cached.md), backlog 049 closed):
  `cached(key, fn, args, …)` and `invalidateCached(key, args?)`. Rejected promises are evicted.
  Minor.
- **Quantifier outer references, aggregates in EXISTS** (S2, [report 118](118-quantifier-outer-refs-and-aggregates-in-exists.md),
  backlog 079 closed (its answering half folded into 042), items 1–2 of 111 done): a quantifier
  reads the outer subject or an enclosing member. An aggregate inside a quantifier, an inline
  filter or a `minus()` is refused at lowering; it used to emit `FILTER(COUNT(…))`. Patch.
- **Duplicate projection fields** (S3, [report 119](119-duplicate-projection-fields.md), backlog
  023 closed): an exact duplicate is one field. One key selected two ways is refused at lowering.
  Patch.
- **Relation field type in the object form** (S5, [report 120](120-object-form-relation-field-type.md),
  backlog 088 closed, 110 added): typed `{id: string}` / `{id: string}[]`. Types only, patch.
- **Object-form rows follow their keys** (S8, [report 121](121-object-form-rows-follow-keys.md),
  backlog 110 closed, 114 added): a key is a top-level field of its row, and the types match the
  rows. Nested objects and the key `id` are refused. DSL-JSON `as` names the key. Minor, behaviour
  change.
- **Inline-filter, quantifier and computed-field lowering edges** (S9, [report 122](122-inline-filter-quantifier-and-computed-field-lowering-edges.md),
  backlog 112 reduced, 113 added): silent wrong answers are fixed, or refused where a fix needs
  design. `every` counts a member without the hop against the condition (behaviour change).
- **`||` in a mutation's where** (S10, [report 123](123-mutation-where-or-branches.md), backlog
  113 closed): matches what a select's where matches. ⚠ Deletes and updates more subjects.
- **Graph routing cost** (S7 measurement, S11 implementation, [report 124](124-graph-routing-cache.md),
  backlog 070 closed, 115 added): each read set is computed in one traversal, and the routing is
  cached per dataset. Minor.
- **Final security review** (this report): `__proto__` refused as an object-form or DSL-JSON key,
  and DSL-JSON `as`/`customKey` must be strings (`src/queries/FieldSet.ts`, test in
  `src/tests/object-form-rows.test.ts`). The `cached()` JSDoc says when expired entries stay in
  memory; pruning is backlog 116.

### Verification

Final runs from the master's status table:

- W1 (wave 1 run and review of S1): `2938 passed, 0 failed (Fuseki skipped)`. The review found 3
  wrong answers, fixed in d208c9e.
- W2 (final run and reviews of S2, S9, S8, at c5fc20c): `3161 passed, 0 failed, 697 skipped
  (Fuseki, no Docker); check:dts green`.
- S11 (report 124, after its review fixes): `Test Suites: 20 skipped, 172 passed, 172 of 192 total` /
  `Tests: 698 skipped, 3175 passed, 3873 total`. Benchmark: delete by id `12412.1 / 19568.3` →
  `48.6 / 99.3` µs (median / p95, 300 shapes).

Wrap-up gate in a fresh worktree of the integration branch, with the security fix applied:

- `npm run build` (12.6 s): `✔ Build successful`.
- `npm test` (41.0 s, jest followed by typecheck): `Test Suites: 20 skipped, 172 passed, 172 of 192 total` /
  `Tests:       698 skipped, 3179 passed, 3877 total`. The skipped suites are the `[fuseki]` blocks.
  The one new test is the `__proto__`/non-string key test; the baseline before the fix was 3178.
- `npm run check:dts` (2.4 s): exit 0, no diagnostics.

Fuseki suites are skipped because this container has no Docker. CI runs them (`npm run test:ci`).
Each step that changed generated SPARQL also ran it against oxigraph in a scratch directory, with
the results quoted in its report.

### Deviations

- **S7 did not land, by design.** It measured the routing cost and pushed a prototype branch,
  `ccr-88cd3a37-okakn0--s7`. The owner then chose to build the cache (decisions 30–32), and a new
  step S11 landed it.
- **Steps added during the run:** S8 (backlog 110, found by S5), S9 (backlog 112, found by S1) and
  S10 (backlog 113, found by S9). Decisions 13, 15 and 23 record them.
- **S4 bumped the wire version to 1.11 with no wire change.** Accepted (decision 16).
- **S11's cache key leaves out the catalog.** The registry memos are kept per catalog instead
  (report 124, Deviations).
- **The array form changed where it was wrong** (decision 28): a `size()` or expression in an
  array-form sub-select is now computed per member. Report 121 and its changeset list these rows.
- **A fix in the wrap-up review.** `__proto__` and non-string keys are refused. This change and its
  test landed in the wrap-up commit range, and the object-form changeset now lists them.

### Follow-ups

Each open backlog item that this sweep created or changed:

- [042](../backlog/042-ask-and-count-with-aggregate-filters.md): answering an aggregate inside a
  quantifier, an inline filter or a `minus()` (needs a sub-SELECT with GROUP BY/HAVING). Folded in
  from 079.
- [109](../backlog/109-per-key-direction-grouped-and-nested-order.md): per-key directions for the
  grouped builder's `orderBy` and a nested select's `.orderBy()`.
- [111](../backlog/111-outer-references-quantifiers-and-wire.md): items 3–5. These cover the
  DSL-JSON form for outer references (`toJSON()` refuses them today), nodes more than one hop
  above, and routed complex-path outer reads.
- [112](../backlog/112-inline-filter-and-size-lowering-edges.md): items 4, 6 and 7. Comparing a
  filtered size, and answering the refused filtered-path forms. Item 7 is a where narrowing a
  relation that a field or count also reads, which is an owner call (decision 24).
- [114](../backlog/114-array-form-aggregate-row-and-fuseki-count-tests.md): an array-form count
  through a hop lands on the root row, the Fuseki `countNestedFriends` row count, and computed
  fields typed `boolean`.
- [115](../backlog/115-catalog-write-graphs-from-global-read-sets.md): a mutation lowered in a
  shape catalog gets its write graphs from the global registry (pre-existing).
- [116](../backlog/116-cached-expired-entry-pruning.md) (new, from the security review):
  `cached()` never prunes expired entries that are not requested again.

## Details

### Plan and contracts

Single repository, so master plan 006 was both the master plan and the sub-plan. Integration
branch in place: `ccr-88cd3a37-okakn0`, target `main`. Each step worked in
`/home/user/wt/<agent>` on `ccr-88cd3a37-okakn0--<agent>` and landed by rebase plus
`merge --ff-only`. There were no PRs, and only the master pushed. Step agents ran in automatic
mode with keep-going behaviour, starting at tasks mode.

Owner decisions that the master took up front (owner may override by number):

1. 108-1: an outer reference in an inline filter resolves to the outer alias. Where it cannot be
   brought into scope, it is refused, never compared with itself.
2. 108-2: a filtered `size()` counts only the kept members. Every instance is kept (count 0).
3. 079: an aggregate inside `EXISTS` is refused at lowering. Answering it is backlog 042.
4. 023: an exact duplicate is de-duplicated. The same key with a different path or sub-selection
   is refused early. No auto-suffixed keys.
5. 019: `.thenBy(fn, direction = 'ASC')` appends one key. `orderBy` replaces the whole sort.
   `thenBy` without `orderBy` is refused. The grouped builder is out of scope.
6. 088: object-form relation fields are typed `{id: string}` / `{id: string}[]`.
7. 049: keyed `cached(key, fn, args, cacheTimeMs?, alsoCacheErrors?)` plus `invalidateCached`. A
   rejected promise is evicted. The identity form warns on the inline-arrow miss outside
   production. Nothing is deprecated.
8. 070: measure only. The owner decides what to build.

Contracts:

- C1 (S1–S3): every golden test stays unless it encoded the bug. S1 changed 2 goldens for that
  reason (report 115).
- C2 (S4): the multi-key sort's DSL-JSON form is documented in `documentation/dsl-json.md`, and
  `toJSON` → `fromJSON` gives identical SPARQL.
- C3 (S6): `cached` (both forms) and `invalidateCached` are exported from `src/utils/cached.ts`.

S8 contract (decisions 18–21):

- A key names a top-level field of the object it is written in: the root row, or a sub-select's
  member row.
- The key's value is what its expression yields. Through single-valued hops it is the leaf or
  `null`. Through any multi-valued hop it is an array of distinct values, `[]` when empty.
- A sub-select or preload under a key holds the member rows `{id, …}`.
- Intermediate hops never appear in the row. The subject as a field is `{id}`.
- Expressions and `size()` inside a sub-select are computed per member.
- DSL-JSON `"as"` names the key.
- A nested plain object and the key `id` are refused, both in the type and at build time.

### Waves

- **Wave 1:** S1, S4, S6 and S7 (S7 read-mostly), with S5 started early (decision 11, types
  only). The W1 run and review of S1 found 3 wrong answers, fixed in d208c9e:
  - filtered steps get traversals of their own;
  - preloaded components read their own subject;
  - a node compared with a query path no longer throws.
- **Wave 2:** S2 and S3, after S1.
  - S2's review found a `.as()` member-cast regression inside quantifiers and inline filters,
    fixed in 2e2f82e.
  - S3 had a fix round (decision 17): `[p.bestFriend, p.bestFriend.name]` merges as before
    (f462e96).
- **Wave 3:** S8 (after S3), S9 (after S2), then S10 (after S9, run by the S9 agent).
  - S9's review found two problems. HIGH: a hop under `isNotDefined()`/`defaultTo()` became
    OPTIONAL, so `deleteWhere(p.bestFriend.name.isNotDefined())` deleted 7 instead of 1
    (decision 26). MEDIUM: under `every`, a member without the hop passed (decision 27). Both
    were fixed in 13764c9.
  - S8's review found four problems, all fixed in e16939a (decisions 28–29): live refresh across
    hops, a sibling count that counted 1 per value, a preload dropped beside a keyed sub-select,
    and a `SelectResponse` constraint that broke compiling code.
  - The W2 run was green at c5fc20c.
- **Wave 4:** S11, the routing cache, built per the owner's choice 1A. Its review fixed one MEDIUM
  (a wrapped routing answered from the inner read sets) and one LOW (frozen read sets reached
  `ir.writeGraphs`). It recorded LOW 2 as backlog 115.

### The 070 measurement and the owner's decisions

S7 measured `graphRoutingFor` (route table, `ownersOf`, `referringGraphsForShape`) for a routed
point read, create and delete by id, at about 10 and about 300 registered shapes. A delete by id
took about 12 ms at 300 shapes with dense ownership. The cause was the
`referringGraphsForShape` → `readGraphsForShape` recursion, which never memoized sets computed
during recursion, so `contains` cycles made it near-exponential. A per-dataset cache prototype was
4–11× faster. The prototype is kept on branch `ccr-88cd3a37-okakn0--s7` (commit a22ce68, pushed,
never merged).

The owner decided:

- **30 (1A):** fix the recursion, then cache the routing per dataset, with the referring-shapes
  index.
- **31 (2):** the cache refreshes when a route is set or unset, when any shape is registered or
  re-registered (registry version), and when the data root changes. Each dataset's routing is
  rebuilt whole. There is no `invalidateGraphRouting` export, and the documented rule is: change a
  shape, then re-register it.
- **32 (3A):** keep the prototype as the pushed branch `--s7`.

S11 (report 124) measured the result with `ROUTING_BENCH=300` (308 shapes, 302 routes), median /
p95 in µs:

| scenario | before | after (traversal + cache) |
|---|---|---|
| select.for | 359.9 / 702.5 | 199.9 / 327.8 |
| create (owned cover) | 419.4 / 826.2 | 114.1 / 250.6 |
| update.for | 385.5 / 800.0 | 45.8 / 117.6 |
| delete by id | 12412.1 / 19568.3 | 48.6 / 99.3 |
| delete by id, cold (first after a change) | 12173.2 / 18709.3 | 1654.9 / 2942.0 |
| live deps (select) | 221.4 / 491.1 | 17.8 / 37.9 |
| live effects (delete) | 158.2 / 299.6 | 5.4 / 8.3 |

At 10 shapes every scenario is 15–140 µs before and after.

### Final security review (wrap-up)

Scope: `git diff main...ccr-88cd3a37-okakn0 -- src` (47 files, +8860/−564).

- **SPARQL injection: none found.** The sweep adds no new text-building path. Every new construct
  is lowered to algebra nodes and serialized by the unchanged `src/sparql/algebraToString.ts`:
  - variables through `sanitizeVarName` (`[^A-Za-z0-9_]` → `_`, l.47). This covers the new
    outer-reference keys such as `a0@a2` and the `${sanitizeVarName(alias)}_${propertySuffix(property)}`
    names of the new registry entries.
  - IRIs through `assertSafeIri` (l.380).
  - literals through the existing escaping.

  Object-form keys and DSL-JSON `as`/`customKey` never reach query text. They live only in
  `IRResultMapEntry.key` and in result mapping. Sort directions from DSL-JSON still pass
  `checkDirection` (`deserializeSortByPath`, unchanged). Filter signatures
  (`JSON.stringify(lowerWhere(… $x placeholders …))`) are used only as map keys.
- **DSL-JSON parsing of new fields.** `as`/`customKey` were checked only for `id` and for two
  different names (`checkJsonKey`). A non-string `as` (`5`, `{}`) was accepted as the key.
  **Fixed:** both must be strings. `sortBy` entries use the existing per-entry validation.
  Outer references have no wire form and refuse on `toJSON` (`assertEncodable`).
- **Prototype pollution through result keys.** Keys now name top-level row fields
  (`row[keyed.key] = …` in `buildRow`, `resultMapping.ts`). A probe of
  `{['__proto__']: p.friends.select((f) => ({n: f.name}))}` mapped to `[{"id":"x:p1"}]`, with
  `Object.keys` = `['id']` and the prototype `{ id: 'x:f1', n: 'Anna' }`. The field was lost, and
  the member row's fields appeared as inherited properties. DSL-JSON `{"as": "__proto__"}` reached
  the same path. This is per-row only, not global pollution, because rows are fresh object
  literals. **Fixed:** `assertResultKey` refuses `__proto__` (object form, sub-select object form,
  DSL-JSON `as`/`customKey`), which covers grouped keys too, since they go through the same
  FieldSet entries. `constructor`/`prototype` stay allowed: assigning them creates an ordinary own
  field (tested).
- **Unbounded work from crafted input.**
  - The routing's read-set and referring-graph memos are keyed by shape id. Shape ids from
    DSL-JSON must be registered (`MutationSerialization` refuses unknown shapes, and selects
    resolve the shape first), so the memos are bounded by registered shapes.
  - Per-catalog memos sit in a `WeakMap` per routing, and routings sit in a `WeakMap` per dataset.
    Both are reclaimed with their keys.
  - The read-set traversal expands each shape once (a `reached` set).
  - `traceScopes` uses `WeakMap`/`WeakSet` only.
  - `projectionDuplicates` and filter signatures grow with the query, not across queries.
  - `cached()`: the keyed form holds its keys strongly, and an expired entry is dropped only when
    the same key and args are looked up again (the identity form has done this since before the
    sweep). **Documented** in the JSDoc. Pruning needs a policy choice, so it is **backlog 116**.
  - The development-only `_seenSources` grows with distinct function sources in code.
- **Destructive mutation semantics.**
  - `withMutationWhere` always wraps the matched pattern in `{type: 'filter', expression:
    convertExpression(where, …)}`, so a where can never lower to "no filter". Refused constructs
    (aggregates in EXISTS, outer reads that cannot resolve) throw before a plan exists.
  - Hops under `isNotDefined()`/`defaultTo()` stay required, and only an `||` branch makes a hop
    optional (decision 26). This is tested in `where-hops-and-every-counterexamples.test.ts`
    ("delete and update where: erik only") and `mutation-where-or-branches.test.ts`.
  - Old-value triples under a traversal stay inside its OPTIONAL group (`buildUpdateWhere`),
    unchanged.
  - The wider matching of `||`/`isNotDefined()` (decision 25 ⚠) is intended and called out in
    the changeset.

### Files of note (per step, see each report for the full list)

- Lowering:
  - `src/queries/IRLower.ts`: filtered traversals, projection seeds per row, keyed entries.
  - `src/queries/traceScopes.ts` (new): which root a proxy path runs from.
  - `src/queries/projectionDuplicates.ts` (new): duplicate and conflicting fields per row
    position.
  - `src/sparql/irToAlgebra.ts`: outer references, EXISTS reads, required/optional split, and the
    mutation where (`withMutationWhere`).
- Result mapping: `src/sparql/resultMapping.ts` builds one row tree (`RowSpec`, keyed `value` and
  `members` fields).
- Object form:
  - `src/queries/FieldSet.ts`: `keyedEntry`, `assertResultKey`, `checkJsonKey`.
  - `src/queries/SelectQuery.ts`: types, `SelectError`.
  - `src/queries/queryDependencies.ts`: hidden dependencies for collapsed hops.
- Sorting: `src/queries/QueryBuilder.ts` (`thenBy`, `_evaluateSort`) and `src/queries/wireVersion.ts`
  (1.11).
- Caching: `src/utils/cached.ts` and `src/utils/graphRouting.ts` (`buildRouting`, `routingCache`,
  `builtReferringGraphs`).
- New tests:
  - `cached-keyed`, `select-then-by`;
  - `inline-filter-outer-refs-and-filtered-size`, `quantifier-outer-refs-and-aggregates`,
    `quantifier-member-cast`;
  - `duplicate-projection-fields`;
  - `object-form-rows` (with recorded bindings `fixtures/object-form-rows.bindings.json`),
    `object-form-live`;
  - `inline-filter-and-size-lowering-edges`, `where-hops-and-every-counterexamples`,
    `mutation-where-or-branches`;
  - `graph-routing-cache`, `graph-routing-read-sets`, and `routing-cost.bench` (opt-in with
    `ROUTING_BENCH`).

### Changesets (overall: minor)

| File | Bump | Behaviour change called out |
|---|---|---|
| `select-then-by.md` | minor | – |
| `keyed-cached.md` | minor | rejected promises now evicted (stated) |
| `object-form-rows-follow-keys.md` | minor | **Behaviour change** + moved-rows table + Migration |
| `graph-routing-cache.md` | minor | frozen read-set arrays (stated) |
| `inline-filter-outer-refs-and-filtered-size.md` | patch | – (fixes) |
| `quantifier-outer-refs-and-aggregates.md` | patch | – (fixes, refusals) |
| `duplicate-projection-fields.md` | patch | – (fixes, refusals) |
| `object-form-relation-field-type.md` | patch | type change: code reading `row.friend.name` stops compiling (stated) |
| `inline-filter-and-size-lowering-edges.md` | patch | – (fixes, refusals) |
| `mutation-where-or-branches.md` | patch | **Behaviour change**: deletes/updates more |
| `where-hops-and-every-counterexamples.md` | patch | **Behaviour change**: `every` returns fewer |

### Docs updated across the sweep

- `README.md`: sorting (`thenBy`), "Custom keys (object form)", graph routing cache and the
  re-register rule, and every/none semantics.
- `documentation/dsl-json.md`: 1.11, multi-key `sortBy`, `as`.
- `documentation/intermediate-representation.md`: where an object-form key sits.
- `documentation/sparql-algebra.md`: per-member counts in sub-selects.
- The routing architecture doc (report 124).
- `docs/backlog/README.md` gained an index of open items and the sweep's closures (this wrap-up).

### Autonomous decisions

Mode: master keep-going (owner, 2026-11-23). Step agents inherited keep-going. The owner set one
exception: S7 (070) never lands without the owner. Rows 1–32 are the master's ledger, copied
unchanged. Rows 33–35 are the wrap-up's own.

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 1–8 | Decisions above | Design of each step | Decisions 1–8 | See each decision | Correctness first, then simplicity and backward compatibility |
| 9 | Where steps land | No linked app; one repo | Integration branch in place (`ccr-88cd3a37-okakn0`), git worktrees, no PRs | Standalone PR per step | Session may push only this branch; one release later |
| 10 | Testing | No Docker, so no live Fuseki | oxigraph (scratch, not a dependency) to execute generated SPARQL; CI runs Fuseki suites | Skip runtime checks | Proves SPARQL validity and answers without touching the repo's deps |
| 11 | Waves | S5 independent of every other step | Start S5 during wave 1 | Wait for wave 2 | Types-only, no shared files; shortens the run |
| 12 | Draft PR | Wrapup skill opens a backup draft PR per integration branch | None | Open one | Session rule: no PR unless the owner asks |
| 13 | S5 follow-up, backlog 110 | Object-form rows differ from their types (deeper-path key moved to the leaf, sub-select / preloadFor key dropped, nested plain object throws) | New step S8: the runtime honours the keys the user wrote, as the types promise; a construct the runtime cannot answer is refused at build time, never a throw at mapping | Change the types to match today's rows | The keys are what the user asked for; the types already promise them (correctness, no API change) |
| 14 | S1 follow-up, backlog 111 items 1–2 | A quantifier reading the outer subject compares the member with itself (silent wrong answer) | Add to S2 (same EXISTS lowering): resolve to the outer alias, which EXISTS sees in scope; refuse what cannot resolve | Leave in backlog 111 | Silent wrong answer in the code S2 already touches |
| 15 | S1 follow-up, backlog 112 | Older silent wrong answers in inline-filter / nested size lowering | New step S9 (wave 3): fix each, or refuse it loudly where a fix needs design | Leave in backlog | Correctness first; same area, context fresh |
| 16 | S4 deviation | Wire version bumped to 1.11 with no wire change | Accept | Revert to 1.10 | Harmless; reverting churns the docs and tests again |
| 17 | S3 ledger #2 | `[p.bestFriend, p.bestFriend.name]` was refused by S3 | Merge as before (bare relation subsumed by unfiltered nested fields) | Refuse | Backward compatibility; the merge was well-defined |
| 18 ⚠ risky | S8 contract | Object-form rows nest a key under the path's hops (`{n: p.bestFriend.name}` → `row.bestFriend.n`); the types promise otherwise | A key names a top-level field of the object it is written in; its value is the expression's yield; intermediate hops never appear. Minor bump; the changeset lists every moved row | Make the types follow today's rows | Neither side matched, so typed code could not read today's rows without a cast; the keys are what users wrote and what grouped selects already do. Consumers reading `row.bestFriend.n` (untyped / cast) break |
| 19 | S8 plural values | A key through a multi-valued hop | An array of distinct values (`[]` when empty) | One entry per member (a bag) | Same set semantics as every multi-valued value today (`SELECT DISTINCT`); a sub-select keeps per-member association when it is wanted |
| 20 | S8 refusals | Nested plain object `{info: {…}}` (throws today), key `id` (silently overwrites the row id) | Refuse both, in the type and at build time | Support nested objects | No DSL-JSON form exists for a nested object; `id` is the row's identity |
| 21 | S8 scope | DSL-JSON `"as"` is documented as aliasing the result key but ignored; a lone `size()`/expression in a sub-select lands at the root row (wrong data) | Both in S8 (same key handling and mapping) | Backlog | Same code, fixed together |
| 22 | S9 scope | `{e: p.bestFriend.name.concat('!')}` makes the hop required and drops the instance | Sent to S9 (projection keeps every instance, report 107 rule) | Backlog | Silent wrong answer in S9's area |
| 23 | S9 follow-up, backlog 113 | `\|\|` in a delete/update where makes every triple required: fewer subjects change than should (silent, data-affecting) | New step S10 (report 123), run by the S9 agent (same required/optional split) | Leave in backlog | Correctness first; a mutation that silently skips rows is the most costly kind of wrong answer |
| 24 | S9 ledger #10, backlog 112.7 | A where shares its traversal with a projection/count of the same relation (`{n: p.friends.size()}` + `where(p.friends.name = 'Anna')` → n counts only Annas) | Leave in backlog 112.7 for the owner | Give every where its own traversal | Long-standing documented-by-behaviour semantics; changing it changes many answers — an owner call |
| 25 ⚠ risky | S10 | A delete/update where with `\|\|` or `isNotDefined()` used to change too few subjects (or none) | Match what a select's where matches; the changeset calls out that such mutations now delete/update more | Keep the old (wrong) matching | Correctness; but apps relying on the no-op now lose rows — flagged for the owner |
| 26 ⚠ risky | S9 review HIGH 1 | A hop under a bare `isNotDefined()`/`defaultTo()` became OPTIONAL: `deleteWhere(p.bestFriend.name.isNotDefined())` deleted 7 instead of 1 | Keep base semantics: the path's relations must exist, only the leaf may be missing; only an `\|\|` branch makes a hop optional | "No value at the path" reading | Safety (destructive in mutations) and backward compatibility; consistent with `.equals()` requiring the hop |
| 27 | S9 review MEDIUM 4 | Under `every`, a member lacking the predicate's hop passes | It is a counterexample (fails the predicate), for plain and filtered `every`; `some`/`none` unchanged | Document today's behaviour | Correctness: "every friend's best friend is Erik" is false for a friend without one |
| 28 | S8 review MEDIUM 4 | The array form changed (per-member sizes/expressions in sub-selects) contrary to the contract | Keep the new (correct) rows; list them in report 121 and the changeset | Restore the old rows | Correctness; the old rows were wrong |
| 29 | S8 review MEDIUM 5 | A `SelectResponse` constraint on every `select` signature broke code that compiled (`unknown` callbacks, generic wrappers, interfaces) | Remove the constraint; a nested object / `id` key yields an exported `SelectError` row type; the build-time refusal stays | Keep the constraint | Backward compatibility, with the protection kept at the result type and at runtime |
| 30 | 070, owner (1A) | What to build from the S7 measurement | Fix the delete-by-id read-set recursion, then cache routing per dataset with the referring-shapes index | Fix only / park | Owner's choice |
| 31 | 070, owner (2) | When the cache refreshes | On route set/unset, on any shape (re)registration (registry version), and when the data root changes. One routing object per dataset is rebuilt whole on its next use (ownership crosses shapes). No `invalidateGraphRouting` export; documented rule: change a shape → re-register it | Per-shape invalidation; an explicit invalidate API | Owner: small and simple; an app editing shapes changes code and re-registers |
| 32 | 070, owner (3A) | Keep the prototype | Pushed as `ccr-88cd3a37-okakn0--s7` (benchmark branch, never merged) | Patch in backlog | Owner's choice |
| 33 | Wrap-up security review | `__proto__` as a result key replaced the row's prototype | Refuse `__proto__` at build time (object form and DSL-JSON); allow `constructor`/`prototype` | Refuse all three (as `MutationSerialization` skips them); or assign rows with `defineProperty` | Safety with the least change: only `__proto__` misbehaves on assignment; the other two are ordinary own fields, so refusing them would break working selects |
| 34 | Wrap-up security review | DSL-JSON `as`/`customKey` accepted any JSON value | Must be strings; an empty string still names nothing, as before | Require non-empty | Correctness without breaking an envelope that carried `""` |
| 35 | Wrap-up security review | `cached()` keeps expired entries that are not requested again | Document it in the JSDoc; pruning policy to backlog 116 | Sweep on insert now | Choosing a policy (sweep, cap, LRU) and testing it without exporting internals is design, not a small fix; the behaviour is older than the sweep |

### Status (final)

| Step | Scope | Deps | Status | Landed | Report | Notes |
|---|---|---|---|---|---|---|
| S1 | 108 outer refs / filtered size | – | done | e6ef1a0..0bf69f6, d208c9e | 115 | 2 goldens changed (encoded the bug); follow-ups 111, 112 |
| S4 | 019 thenBy | – | done | 6b0915c..afd7fe4 | 116 | builder-only; wire 1.11; follow-up 109 |
| S6 | 049 keyed cached | – | done | c416562..b04ab29 | 117 | 13 new tests |
| S7 | 070 measure | – | done | not landed (branch `--s7`, pushed) | – | delete-by-id 12 ms at 300 shapes; cache 4–11×; owner chose 1A → S11 |
| S11 | 070 delete-by-id recursion + routing cache | – | done | d461a7b..f7ab8ce | 124 | review: wrapped routing (MEDIUM), frozen writeGraphs (LOW) fixed; follow-up 115 |
| S5 | 088 relation field type | – | done | b6aa386..448c188 | 120 | follow-up 110 → S8 |
| S2 | 079 refuse agg in EXISTS + 111 items 1–2 | S1 | done | bb31db3..b9d4429, 2e2f82e | 118 | review: `.as()` cast regression, fixed |
| S3 | 023 duplicate fields | S1 | done | 3e328a2..f462e96 | 119 | fix round: decision 17 |
| S8 | 110 object-form rows follow their keys | S3 | done | a0f0ef7..920a240, e16939a..314383c | 121 | minor; review: live refresh across hops, sibling count, preload drop, signature break → fixed (decisions 28, 29); follow-up 114 |
| S9 | 112 inline-filter / size lowering edges | S2 | done | d81ff18..107a39a, 13764c9 | 122 | 112 reduced to 4, 6 (refused half), 7; follow-up 113 → S10; review: destructive isNotDefined hop regression + every → fix round (decisions 26, 27) |
| S10 | 113 `\|\|` in mutation where | S9 | done | 027d44c, c5fc20c | 123 | ⚠ deletes more (decision 25), called out in changeset |
| W2 | final run + reviews of S2, S9, S8 | – | done | c5fc20c | – | 3161 passed, 0 failed, 697 skipped (Fuseki, no Docker); check:dts green |
| W1 | wave 1 run + review of S1 | – | done | fixes d208c9e | – | 2938 passed, 0 failed (Fuseki skipped); review: 3 wrong answers, fixed |
| Wrap | security review, report 125, index, gate | – | done | the two wrap-up commits (security fix, report) | 125 | `__proto__` / non-string keys refused; backlog 116 |

The S11 row was still marked "in progress" in the plan when the wrap-up started. It landed as
d461a7b..f7ab8ce (report 124, Progress ticked).
