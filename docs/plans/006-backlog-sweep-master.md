---
summary: Master plan for a hands-off sweep of small backlog items — query lowering bugs (108, 079, 023), multi-column sorting (019), relation field typing (088), a keyed cached() (049), and a measure-only investigation of graph-routing cost (070).
packages: [core]
status: Implementation
---

# 006 — Backlog sweep (master plan)

Single repository (`@_linked/core`), so this doc is both the master plan and the sub-plan.

## How to use this plan

The master agent prepares, spawns one background step agent per step, checks each landing
against its report, runs an independent review per wave, a full regular-set run per wave, and
keeps the status table below. The master never implements. After a restart: read the status
table, `git worktree list`, and `git log --oneline main..ccr-88cd3a37-okakn0`.

## Where the steps land

**Integration branch in place:** `ccr-88cd3a37-okakn0` (target `main`), checked out in
`/home/user/core`. Each step works in its own git worktree and lands by rebase +
`git -C /home/user/core merge --ff-only <branch>`. No PRs; the owner asks for a release.
Only the master pushes the integration branch.

- Worktree: `git -C /home/user/core worktree add /home/user/wt/<agent> -b ccr-88cd3a37-okakn0--<agent> ccr-88cd3a37-okakn0`
- Dependencies: `ln -s /home/user/core/node_modules /home/user/wt/<agent>/node_modules` — never
  `npm install` in a worktree or in `/home/user/core`.
- Remove after landing: `git -C /home/user/core worktree remove /home/user/wt/<agent>` and
  `git -C /home/user/core branch -d ccr-88cd3a37-okakn0--<agent>`.

## Rules for every step

- **Implement exactly the step's scope.** If the code contradicts this plan, or a review finding
  needs a design choice not settled here, stop and report it instead of choosing.
- **Landing gate (small):** `npx tsc -p tsconfig-tests.json --noEmit` (or `npm run typecheck`),
  the tests you created or changed, and the existing specs your step names — each timed and its
  decisive output quoted in the report. Not the full regular set; the master runs it per wave.
- **No live store here.** This container has no Docker, so `[fuseki]` tests are skipped. Where a
  step changes generated SPARQL, also prove the output parses and answers correctly: install
  `oxigraph` (npm) in your own scratch directory outside the repo and run the generated query
  against a small hand-written dataset; quote the result. Never add it to `package.json`.
- **Never** `pkill`, never touch another agent's worktree, never switch `/home/user/core` to
  another branch, never push.
- **Report** `docs/reports/<nnn>-<topic>.md` under the pre-assigned number, in two parts:
  `## PR` (Summary, Changes, Verification with output quoted, Deviations, Follow-ups each with its
  home) and `## Details` for future agents. Remove the consumed backlog doc. Add a changeset in
  `.changeset/` (fix = patch, feature = minor) for any published-code change. Tick your step in
  the Progress list below in the same landing.
- **Every follow-up has a home:** a backlog item (next free number in `docs/backlog`, re-checked
  after rebase) or another step's section. Not a sentence in the report alone.
- **Docs:** update `README.md` / `documentation/*.md` where user-visible behaviour changes.
- Commit messages, reports and changesets never name AI tooling; code comments never name steps.

## Decisions (taken by the master for the owner; owner may override by number)

1. **108-1 outer references in an inline filter** resolve to the outer alias (`p.name` inside
   `p.bestFriend.friends.where(f => f.name.equals(p.name))` means the root's name). Where the
   outer alias is not in scope of the filter's block and cannot be brought in, refuse loudly —
   never a self-comparison.
2. **108-2 filtered `size()`** counts only the members the filter keeps, and keeps every instance
   (hops above it optional, count 0 when none), per report 107's projection rule.
3. **079 aggregate inside `EXISTS`** (`some/every/none` callbacks, nested where blocks): refuse
   loudly at lowering with an error that names the construct and suggests the top-level form.
   Answering it needs a sub-SELECT with GROUP BY/HAVING — the same missing capability as backlog
   042, so that half is folded into 042 and backlog 079 is removed. Rationale: no invalid SPARQL
   reaches a store; one capability, one backlog item.
4. **023 duplicate projection fields:** an exact duplicate (same key, structurally identical path
   and sub-selection) is de-duplicated silently. Same key with a different path or sub-selection
   is refused early (at build/lowering, not in result mapping), naming the key and pointing at the
   object form (`{a: …, b: …}`) for explicit keys. No auto-suffixed keys: `messages2` cannot be
   expressed in the inferred result type. The `resultMapping` guard stays as a defensive assertion.
5. **019 multi-column sorting:** add `.thenBy(fn, direction = 'ASC')` on the select builder,
   appending one key per call. `.orderBy()` keeps its meaning (it sets the whole sort, replacing
   earlier keys) and its array form (`orderBy(p => [p.a, p.b], dir)`, one direction for all).
   `thenBy` without a preceding `orderBy` is refused. The grouped builder is out of scope. Each key
   keeps today's per-key rules (missing values last, multi-valued → first value in that
   direction, IRI tie-break on pages). DSL-JSON carries per-key direction backward-compatibly:
   the existing form still parses; bump the wire minor version per `documentation/dsl-json.md`.
6. **088 relation fields in the object form** type as `{id: string}` (single) / `{id: string}[]`
   (multi), matching the runtime and the array form; a sub-select keeps its object type.
7. **049 `cached()`:** add a keyed form `cached(key: string, fn, args, cacheTimeMs?,
   alsoCacheErrors?)` storing by `key + argsKey` in a `Map`; keep the function-identity form;
   add `invalidateCached(key, args?)`. An async `fn` whose promise rejects is evicted unless
   `alsoCacheErrors`. Outside production, the identity form warns once per function source when
   it sees a new function whose source text equals one it already cached (the inline-arrow miss),
   pointing at the keyed form. No deprecation.
8. **070 graph routing cost: measure only.** The step measures, may prototype a cache in its own
   worktree, and reports numbers and a recommendation to the master. It does not land; the owner
   decides.

## Autonomous decisions

Mode: master keep-going (owner, 2026-11-23). Step agents inherit keep-going. Exception set by the
owner: S7 (070) never lands without the owner; its findings go to the owner for a joint decision.

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
| 23 | S9 follow-up, backlog 113 | `||` in a delete/update where makes every triple required: fewer subjects change than should (silent, data-affecting) | New step S10 (report 123), run by the S9 agent (same required/optional split) | Leave in backlog | Correctness first; a mutation that silently skips rows is the most costly kind of wrong answer |
| 24 | S9 ledger #10, backlog 112.7 | A where shares its traversal with a projection/count of the same relation (`{n: p.friends.size()}` + `where(p.friends.name = 'Anna')` → n counts only Annas) | Leave in backlog 112.7 for the owner | Give every where its own traversal | Long-standing documented-by-behaviour semantics; changing it changes many answers — an owner call |
| 25 ⚠ risky | S10 | A delete/update where with `||` or `isNotDefined()` used to change too few subjects (or none) | Match what a select's where matches; the changeset calls out that such mutations now delete/update more | Keep the old (wrong) matching | Correctness; but apps relying on the no-op now lose rows — flagged for the owner |
| 26 ⚠ risky | S9 review HIGH 1 | A hop under a bare `isNotDefined()`/`defaultTo()` became OPTIONAL: `deleteWhere(p.bestFriend.name.isNotDefined())` deleted 7 instead of 1 | Keep base semantics: the path's relations must exist, only the leaf may be missing; only an `||` branch makes a hop optional | "No value at the path" reading | Safety (destructive in mutations) and backward compatibility; consistent with `.equals()` requiring the hop |
| 27 | S9 review MEDIUM 4 | Under `every`, a member lacking the predicate's hop passes | It is a counterexample (fails the predicate), for plain and filtered `every`; `some`/`none` unchanged | Document today's behaviour | Correctness: "every friend's best friend is Erik" is false for a friend without one |

## Contracts

- C1 (steps 1, 2, 3): lowering changes in `src/queries/IRLower.ts` and `src/sparql/irToAlgebra.ts`
  keep every existing golden test (`src/tests/*golden*.test.ts`) passing unless the golden itself
  encoded the bug; any changed golden is listed in the report's Deviations with the reason.
- C2 (step 4): the DSL-JSON form of a multi-key sort is documented in `documentation/dsl-json.md`
  and round-trips (`toJSON` → `fromJSON` → identical SPARQL).
- C3 (step 6): public exports — `cached` (both forms) and `invalidateCached` from
  `src/utils/cached.ts`, re-exported wherever `cached` is today.

## Steps

### S1 — 108: inline-filter outer references and filtered size
- **Depends on:** none. **Report:** 115. **Size:** medium (2 phases). **Backlog:** 108.
- **Goal:** decisions 1 and 2.
- **Files:** `src/queries/IRLower.ts`, `src/queries/IRDesugar.ts`, `src/sparql/irToAlgebra.ts`,
  `src/queries/IRAliasScope.ts`; report 107 for the inline-filter LeftJoin layout.
- **Verify:** new golden tests in `src/tests/sparql-select-golden.test.ts` for both shapes from
  backlog 108 (outer ref → `FILTER(?a2_name = ?a0_name)` or equivalent; filtered size counts
  filtered members, instances kept); oxigraph check that a Person whose best friend has no friend
  named X appears with count 0; existing `sparql-select-golden`, `ir-select-golden` pass.

### S2 — 079: aggregates inside EXISTS refused
- **Depends on:** S1 landed (same files). **Report:** 118. **Size:** medium (2 phases). **Backlog:** 079 → 042.
- **Goal:** decision 3. Move the "answer it" half into backlog 042's text; delete 079.
- **Also (decision 14):** backlog 111 items 1 and 2 — a quantifier (`some`/`every`/`none`) whose
  callback reads the outer subject (`p.friends.some((f) => f.name.equals(p.name))`) resolves to the
  outer alias (EXISTS sees the outer bindings), in a top-level where and inside an inline filter;
  what cannot resolve is refused. Remove items 1–2 from backlog 111 (keep 3–5). Builds on report
  115's `src/queries/traceScopes.ts`.
- **Files:** `src/sparql/irToAlgebra.ts` (EXISTS building), possibly `src/queries/IRLower.ts`.
- **Verify:** test that `Person.select().where(p => p.friends.some(f => f.friends.size().equals(1)))`
  throws the named error; top-level aggregate where still works (existing tests).

### S3 — 023: duplicate projection fields
- **Depends on:** S1 landed. **Report:** 119. **Size:** small. **Backlog:** 023.
- **Goal:** decision 4. **Files:** `src/queries/IRLower.ts` (`lowerSelectQuery`),
  `src/sparql/resultMapping.ts`.
- **Verify:** `[p.name, p.name]` → one `?a0_name` in SELECT, result `{id, name}`;
  `[p.friends, p.friends.select(f => f.name)]` throws early naming `friends`; nested duplicates.

### S4 — 019: multi-column sorting (`thenBy`)
- **Depends on:** none. **Report:** 116. **Size:** medium (2 phases). **Backlog:** 019.
- **Goal:** decision 5, contract C2.
- **Files:** `src/queries/QueryBuilder.ts` (orderBy ~l.307), `src/queries/SelectQuery.ts`
  (`evaluateSortCallback` ~l.936), `src/queries/IRDesugar.ts` (`DesugaredSortBy`),
  `src/queries/IRLower.ts`, `src/queries/QueryBuilderSerialization.ts`, `src/queries/fromJSON.ts`,
  `documentation/dsl-json.md`, README "Sorting, limiting, one".
- **Verify:** golden `ORDER BY` with mixed directions; paging with two keys keeps IRI tie-break;
  missing values last per key; DSL-JSON round trip; `thenBy` before `orderBy` throws.

### S5 — 088: relation field type in the object form
- **Depends on:** none (types only). **Report:** 120. **Size:** small. **Backlog:** 088.
- **Goal:** decision 6. **Files:** `src/queries/SelectQuery.ts` (`ObjectToPlainResult`,
  `QueryResponseToResultType`, `CreateQResult`), `src/tests/type-probe-*.ts`, typing tests from
  reports 094/096.
- **Verify:** type tests (`expectType`-style, as existing typing tests) for single, multi,
  sub-select; `npm run typecheck`.

### S6 — 049: keyed `cached()`
- **Depends on:** none. **Report:** 117. **Size:** small. **Backlog:** 049.
- **Goal:** decision 7, contract C3. **Files:** `src/utils/cached.ts`,
  `src/tests/gap1-fixes.test.ts` (existing cached tests), exports.
- **Verify:** inline-arrow keyed form hits; two keys don't collide; expiry; `invalidateCached`
  (all args / one args); async rejection evicted, kept with `alsoCacheErrors`; warning once.

### S7 — 070: graph routing per-read cost (investigation, no landing)
- **Depends on:** none. **Report:** none (returns findings to the master). **Backlog:** 070.
- **Goal:** decision 8: measure the compile-time share of `graphRoutingFor` (route table +
  `ownersOf` + `referringGraphsForShape`) for a routed point read, routed create and delete-by-id,
  with ~10 and ~300 registered shapes; prototype a per-dataset cache keyed by route version,
  registry version and data root; measure again; list invalidation risks.

### S8 — 110: object-form rows follow their keys
- **Depends on:** S3 landed. **Report:** 121. **Plan doc:** 007. **Backlog:** 110.
  **Size:** large (5 phases).
- **Goal:** decisions 13, 18–21. Contract:
  - A key names a top-level field of the object it is written in: the root row, or a sub-select's
    member row. Its value is the expression's yield: through single-valued hops only, the leaf or
    `null`; through any multi-valued hop, an array of distinct values (`[]` when empty). A
    sub-select or preload under a key is the member row(s) `{id, …fields}`. Intermediate hops never
    appear in the row. The subject as a field is `{id}`. Expressions and `size()` inside a sub-select
    are per member. Keys are honoured per entry (`.preload()` beside keyed fields). DSL-JSON `"as"`
    names the key.
  - Refused in the type and at build time: a nested plain object; the key `id`.
  - The array form is unchanged.
- **Today vs proposed** (planning probe, oxigraph-checked): `{n: p.bestFriend.name}` row
  `bestFriend:{id,n}` → `n: string|null`; `{bb: p.bestFriend.bestFriend}` → `bb: {id}|null`;
  `{names: p.friends.name}` → `string[]`; `{fbf: p.friends.bestFriend.name}` → `string[]`;
  `{x: p.friends.select(f => …)}` (key dropped today) → `x: [{id,…}]`; `{x: p.bestFriend.select(…)}`
  → `{id,…}|null`; `{w: p.friends.where(…)}` → `{id}[]`; `{w: p.friends.where(…).name}` →
  `string[]`; `{pre: p.bestFriend.preloadFor(c)}` → `{id, …c's fields}|null` (array form: add the
  component's fields to the type too); `{person: p}` → type `{id}` (row already right);
  `{n: p.bestFriend.name, b: p.bestFriend}` → no extra `bestFriend` key.
- **Files:** `IntermediateRepresentation.ts` (`IRResultMapEntry` optional container alias, keyed
  group entries; additive so array-form goldens do not change), `IRLower.ts` ~410–497 (keep the
  sub-select key, dropped at ~447–455), `IRDesugar.ts` ~292/315 (keys per entry),
  `resultMapping.ts` (tree from containers, collapse hops), `irToAlgebra.ts` (lone sub-select
  aggregate grouping), `projectionDuplicates.ts` `positionOf` (container row path + key; lift the
  keyed refusals — the Carl case and two filters under two keys; keep the pagination refusal),
  `SelectQuery.ts` (`ObjectToPlainResult` plurality walk, subject `{id}`, `BoundComponent` fields,
  nested object → error type), `GroupedSelectBuilder.ts` (`GroupKeyValue` shrinks), `FieldSet.ts`
  ~913/1157 (refusals), `queryDependencies.ts` ~296 + `LiveQueryStore.ts` ~898 (collapsed hops'
  ids leave the row, so their predicates are `hidden`, not `narrow`, or live results go stale).
- **Pitfalls:** pinned old shapes to update (Deviations): `select-result-typing.test.ts:103-104`,
  `type-probe-deep-nesting.ts` TEST 2/19 (and 3/20 only compile via `any`),
  `inline-filter-outer-refs-and-filtered-size.test.ts:273-278`,
  `duplicate-projection-fields.test.ts:222-235`; docs `documentation/intermediate-representation.md`
  ~250–275, `sparql-algebra.md` ~420 (claims sub-select size groups per friend), `dsl-json.md` ~229.
  Grouped selects already put keys at the top (`resultMapping.ts` ~448); fix their types only.
- **Verify:** per case above: rows (unit bindings + a `[fuseki]` block run against oxigraph) and
  strict `Equals` types for root, `.one()`, `.for()` and grouped; DSL-JSON round trip of each;
  lifted refusals answer both lists on a store; refusals for nested object and `id`; `.preload()`
  beside keys; live: renaming p2 refreshes `{n: p.bestFriend.name}`; full typecheck.
- **Phases:** (1) IR + lowering + build-time refusals; (2) result mapping + sub-select aggregate
  grouping; (3) `positionOf` + lifted refusals; (4) types incl. grouped and preload; (5) live
  dependencies, docs, minor changeset listing every moved row.
- **Also (from S9, report 122):** backlog 112 item 3 is this step's lone sub-select aggregate
  (`p.friends.select((f) => ({n: f.friends.size()}))` groups by `?a0` only and lands at the root
  row). Beside a sibling field the SPARQL already groups per member, but the count is missing from
  the rows when it reads a hop or a filter (`p.friends.select((f) => [f.name,
  f.bestFriend.friends.size()])`, `…f.friends.where(…).size()`: `?a2_agg` is projected, the
  member rows carry only `name`; oxigraph, report 122).

### S10 — 113: `||` in a mutation's where
- **Depends on:** S9 landed. **Report:** 123. **Size:** small. **Backlog:** 113.
- **Goal:** decision 23: the required/optional split of a select's where (report 122) in
  `deleteWhereToAlgebra`, `updateWhereToAlgebra`, `buildUpdateWhere`; `isNotDefined()` in a
  mutation's where works. **Verify:** goldens in `sparql-mutation-golden.test.ts`; oxigraph check
  that exactly the right subjects change.

### S9 — 112: inline-filter and nested size lowering edges
- **Depends on:** S2 landed (same lowering). **Report:** 122. **Backlog:** 112.
  Plan-mode detail is filled in when wave 3 starts.

## Waves

- **Wave 1:** S1, S4, S6, S7 (S7 is read-mostly). S4 and S1 both touch `IRLower.ts`; the second
  to land rebases.
- **Wave 2:** S2, S3 (after S1). S5 ran in wave 1 (decision 11).
- **Wave 3:** S8 (after S3), S9 (after S2).
- **Wave run** after each wave (test agent): `npm run build && npm test` in a fresh worktree of
  the integration branch; Fuseki suites skipped (no Docker), CI covers them.
- **Independent review** per wave of the lowering steps (S1–S4): silent wrong answers are this
  sweep's risk.

## Status

| Step | Scope | Deps | Status | Landed | Report | Notes |
|---|---|---|---|---|---|---|
| S1 | 108 outer refs / filtered size | – | done | e6ef1a0..0bf69f6, d208c9e | 115 | 2 goldens changed (encoded the bug); follow-ups 111, 112 |
| S4 | 019 thenBy | – | done | 6b0915c..afd7fe4 | 116 | builder-only; wire 1.11; follow-up 109 |
| S6 | 049 keyed cached | – | done | c416562..b04ab29 | 117 | 13 new tests |
| S7 | 070 measure | – | findings with owner | not landed (branch `--s7`, local) | – | delete-by-id 12 ms at 300 shapes; cache 4–11× |
| S5 | 088 relation field type | – | done | b6aa386..448c188 | 120 | follow-up 110 → S8 |
| S2 | 079 refuse agg in EXISTS + 111 items 1–2 | S1 | done | bb31db3..b9d4429, 2e2f82e | 118 | review: `.as()` cast regression, fixed |
| S3 | 023 duplicate fields | S1 | done | 3e328a2..f462e96 | 119 | fix round: decision 17 |
| S8 | 110 object-form rows follow their keys | S3 | in progress | | 121 | plan doc 007 |
| S9 | 112 inline-filter / size lowering edges | S2 | done | d81ff18..107a39a | 122 | 112 reduced to 4, 6 (refused half), 7; follow-up 113 → S10; review: destructive isNotDefined hop regression + every → fix round (decisions 26, 27) |
| S10 | 113 `||` in mutation where | S9 | done | 027d44c | 123 | ⚠ deletes more (decision 25) |
| W1 | wave 1 run + review of S1 | – | done | fixes d208c9e | – | 2938 passed, 0 failed (Fuseki skipped); review: 3 wrong answers, fixed |

## Progress

- [x] S1 — report 115
- [x] S4 — report 116
- [x] S6 — report 117
- [x] S2 — report 118
- [x] S3 — report 119
- [x] S8 — report 121
- [x] S9 — report 122
- [x] S5 — report 120
- [x] S10 — report 123

## Starter prompt template

> You are a step agent for master plan `docs/plans/006-backlog-sweep-master.md` in
> `/home/user/core` (integration branch `ccr-88cd3a37-okakn0`). Implement step **<S>** only, in
> `/automatic` mode starting at **tasks mode** (no plan doc of your own for small steps; phases and
> validation go in the report). Read first: the plan's "Where the steps land", "Rules for every
> step", "Decisions", "Contracts" and your step's section; the backlog doc it consumes;
> `AGENTS.md`; the skills `tasks`, `implementation`, `review`, `wrapup` in `~/.claude/skills`.
> Create your worktree `/home/user/wt/<agent>` as the plan says. Report number <nnn>. Scope rule:
> implement exactly the step; if the code contradicts the plan or a finding needs a design choice,
> stop and report. Landing gate as in the Rules. Wrap up: report, remove the consumed backlog doc,
> changeset, tick Progress, rebase onto `ccr-88cd3a37-okakn0`, re-check the report number, land
> with `git -C /home/user/core merge --ff-only`, remove your worktree and branch. Do not push.
> Your final message is your report to me: what landed (commit range), the report path, and at
> most twelve lines. No interim updates.
