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
- **Depends on:** S1 landed (same files). **Report:** 118. **Size:** small. **Backlog:** 079 → 042.
- **Goal:** decision 3. Move the "answer it" half into backlog 042's text; delete 079.
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

## Waves

- **Wave 1:** S1, S4, S6, S7 (S7 is read-mostly). S4 and S1 both touch `IRLower.ts`; the second
  to land rebases.
- **Wave 2:** S2, S3 (after S1), S5.
- **Wave run** after each wave (test agent): `npm run build && npm test` in a fresh worktree of
  the integration branch; Fuseki suites skipped (no Docker), CI covers them.
- **Independent review** per wave of the lowering steps (S1–S4): silent wrong answers are this
  sweep's risk.

## Status

| Step | Scope | Deps | Status | Landed | Report | Notes |
|---|---|---|---|---|---|---|
| S1 | 108 outer refs / filtered size | – | todo | | 115 | |
| S4 | 019 thenBy | – | todo | | 116 | |
| S6 | 049 keyed cached | – | todo | | 117 | |
| S7 | 070 measure | – | todo | not landed | – | owner decides |
| S2 | 079 refuse agg in EXISTS | S1 | todo | | 118 | |
| S3 | 023 duplicate fields | S1 | todo | | 119 | |
| S5 | 088 relation field type | – | todo | | 120 | |

## Progress

- [ ] S1 — report 115
- [ ] S4 — report 116
- [ ] S6 — report 117
- [ ] S2 — report 118
- [ ] S3 — report 119
- [ ] S5 — report 120

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
