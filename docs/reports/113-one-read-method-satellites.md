---
date: 2026-11-01
summary: >
  Step X1 of master plan 111: the test doubles, fixtures and examples of fuseki, react, shape-ui,
  cli, auth and server-utils follow core's one read method (readQuery). Test and docs changes only;
  cli gets a patch changeset (its react-native template test) and its own report 047.
packages: [fuseki, react, shape-ui, cli, auth, server-utils]
---

# 113 — One read method in the other repos (step X1)

## PR

**What changed**

| Repo | Commit | Change |
|---|---|---|
| react | `a2512bb` | `src/tests/fixtures.ts` `ScriptedDataset.readQuery` (`switch (readKindOf(q))`: select and count, ask; refuses the rest; declares `supports: ['ask']`); `react-component-behavior.test.tsx` `MockStore.readQuery` (select and count) and the missing-store test calls `LinkedStorage.readQuery({__queryKind: 'select', …})`; `native-barrel.test.tsx` store stub `readQuery`. `graphQuery` and `unsupportedGraphQuery` stay. |
| shape-ui | `a02790c` | `src/catalog.test.ts` dataset: `readQuery` (select, ask; refuses the rest), `supports: ['ask']`; `graphQuery` stays. |
| cli | `a38fa01` | react-native template `nativeDefaults.test.tsx` stub answers `readQuery`; patch changeset `one-read-method.md`; report 047. |
| auth | `8ddbef7` | DPoP URL fixtures (`issuer-tokens`, `solid-access-token`) and the README's DPoP example name `…/@_linked/server/readQuery`. |
| server-utils | `2f75086` | README `rejectOnError` example calls `readQuery`. |
| fuseki | none | `FusekiStore.graphs.test.ts` checked: its `graphQuery` calls stay (owner decision 1); no old read name in the repo. |

No production code changed. Only cli has a changeset (patch); the others are test- or docs-only.

**Verification** (worktree `one-read-method--x1`, against core built from the master's C1; each
package built there with `linked build` first, since the repos load each other's `lib/`)

- react `npm test`, 6.6 s: `Test Suites: 7 passed, 7 total`, `Tests: 84 passed, 84 total`;
  `npx tsc --noEmit -p tsconfig-test.json`: no output.
- shape-ui `npm test`, 4.3 s: `Test Suites: 9 passed, 9 total`, `Tests: 84 passed, 84 total`.
- fuseki `npm test`, 3.1 s: `Test Suites: 1 skipped, 4 passed, 4 of 5 total`,
  `Tests: 5 skipped, 21 passed, 26 total` (the skipped suite is the live Fuseki one).
- auth `npm test`, 6.7 s: `# tests 626`, `# pass 626`, `# fail 0`.
- server-utils `npm test`, 2.0 s: `Tests: 73 passed, 73 total`; `# tests 119`, `# pass 119`, `# fail 0`.
- cli: see report 047 (`npm run test:unit` 1267 passed; the template full test fails only on the
  pinned core 2.43.0 and passes, 24 of 24, with the new core).
- `grep -rnwE 'selectQuery|askQuery|triplesQuery|triplesTermsQuery' src test tests defaults README.md docs/architecture`
  per repo: no hits, except server-utils `src/shapes/Lincd_API_Client.ts:21` (`selectQuery` of the
  `LincdAPI` client shape, which calls the `select` route, not an `IDataset` method).

**Deviations from the plan**

- One report for all six repos (113) instead of one each, and report 047 in cli only (owner
  simplification). W's report moves from 113 to 114. Plan 111 updated.
- server-utils: plan 111 listed `QueryAccess.ts:48,393,396` as comments to rename; they name
  `LinkedStorage.graphQuery`, which stays, so they are unchanged. The README example was changed
  instead.
- auth's README DPoP example URL was renamed too (not listed in the plan).
- cli's Verify command: the template suite runs with `jest.template.config.cjs` and
  `RUN_TEMPLATE_FULL=1` (plan corrected).

**Follow-ups**

- The cli release PR moves the react-native template's exact `@_linked/core` pin (2.43.0) to the
  core minor that ships `readQuery`; recorded in plan 111's release order and in cli report 047.
- These repos' CI installs core from npm, so their test PRs go green only after the core minor is
  published (plan 111's release order already says so).

## Decision ledger

| # | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|
| 1 | Doubles that had `askQuery` would now get asks as a select `LIMIT 1` | Declare `supports: ['ask']` where a double answered asks (react `ScriptedDataset`, shape-ui) | Leave the fallback | Keeps what the tests exercised (C-3) |
| 2 | Core's `readQueryOf` helper is in `src/test-helpers`, not exported | Each double switches on `readKindOf` from `@_linked/core/queries/readQuery` | Export the helper | No core change in a test-only step; the plan asks for a switch |
| 3 | The cli template's stub answered every read alike | One `readQuery` answering every read alike, no kind switch | A switch per kind | The stub only shows loading or error; nothing to tell apart |
| 4 | The template pins core 2.43.0 exactly, and the new stub fails against it | Keep the stub on `readQuery`; move the pin in the cli release | Answer both `selectQuery` and `readQuery` | No legacy; the pin cannot name an unreleased core |
| 5 | server-utils `Lincd_API_Client.selectQuery` | Unchanged | Rename it | It is the `LincdAPI` client's `select` route, not `IDataset` |
| 6 | Owner simplification of reports | 113 for X1, W's report becomes 114 | Keep 113 for W | The owner named 113 for X1 |
