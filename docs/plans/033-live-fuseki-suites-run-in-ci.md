---
summary: Make the live-Fuseki suites honest — one availability decision in Jest globalSetup, visible skips locally, a hard failure under CI/REQUIRE_FUSEKI, per-file datasets, a reporter line that counts live tests, and a test:fuseki script that selects every live suite.
packages: [core]
status: Review
source_backlog: docs/backlog/009-ci-test-integrity-fuseki.md
related_backlog: [docs/backlog/037-fuseki-suites-share-one-dataset.md, docs/backlog/047-sparql-fuseki-shape-sync-is-flaky.md]
---

# 033 — Live Fuseki suites run in CI, and say so

## Ideation

### What was measured first (before deciding anything)

Backlog 009 says CI "never starts Fuseki". The artifact says otherwise. The last feature PR run
(`gh run view 38305862605 --log`) contains:

```
[ensureFuseki] Fuseki not running — starting via Docker...
[ensureFuseki] Fuseki is ready
FUSEKI_TEST_ENDPOINT unset — skipping the live parse check
Test Suites: 4 skipped, 96 passed, 96 of 100 total
Tests:       121 skipped, 2183 passed, 2304 total
```

The shared workflow (`linked-fw/.github` `pr.yml@v1`) runs `npm test` on `ubuntu-latest`, which has
Docker, and `jest.config.cjs`'s `globalSetup` calls `ensureFuseki()`, which runs
`docker compose up -d --wait`. So the live suites **do** run in CI today. The 4 skipped suites and
121 skipped tests are compile-only type suites and the DSL-JSON exclusions, not Fuseki.

The real gaps are:

1. **Silence on failure.** If the Docker start fails (image pull, rate limit, port), `ensureFuseki`
   returns `false`, `globalSetup` only warns, and ~290 tests across 10 files `return` early and
   report **passed**. Nothing in the result distinguishes that run from a real one.
2. **One live check is never run anywhere.** `sparql-prefixed-names.test.ts` asks a real endpoint
   to parse two queries, but only when `FUSEKI_TEST_ENDPOINT` is set — and nothing sets it.
3. **`npm run test:fuseki` runs 4 of 10 live files** (`--testPathPatterns='sparql-fuseki'`), so the
   documented command misses `property-path-fuseki`, `nested-select-pagination`,
   `property-path-named-resolution`, `shacl-cascade`, `owned-link-check`, `mutation-where-union`.
4. **Datasets are per worker, not per file** (backlog 037 / 047). `DATASET_NAME` is
   `nashville-test-${JEST_WORKER_ID}`, so consecutive files on one worker reuse a dataset — the
   structural explanation 047 records for the flaky shape-sync suite.
5. **No evidence line.** A green run gives no count of live tests that actually executed.

### Planning blockers

None. Jest behaviour the design depends on was verified with throwaway probes:
- `process.env` set in `globalSetup` is visible in worker processes (2 workers) — passed.
- A top-level `beforeAll` does **not** run when every test in the file is skipped — confirmed (a
  throwing top-level `beforeAll` beside a `describe.skip` left the suite "skipped", not failed).

### Decisions

**Decision 1 of 6 — Where the availability decision lives.**
(a) Each suite keeps calling `ensureFuseki()` in `beforeAll` and guards each test (today);
(b) a per-test helper that throws/skips at runtime — Jest cannot mark a test skipped once it is
running; (c) **`globalSetup` decides once and exports the result through an env var; suites read it
synchronously at collection time and register `describe` or `describe.skip`.**
Chosen: (c). One decision point, no per-test guard, skips are real Jest skips. Maintainability.

**Decision 2 of 6 — When missing Fuseki fails.**
`REQUIRE_FUSEKI` if set (`0`/`false` opts out, anything else requires); otherwise required when `CI`
is set (GitHub Actions sets `CI=true`). Fails in `globalSetup` by throwing — Jest aborts the run with
that message, before any suite runs. Locally without Docker: a `console.warn` and visibly skipped
suites whose names say why.

**Decision 3 of 6 — CI workflow change.**
(a) Add a `services: fuseki` job in this repo; (b) **no workflow change**: `npm test` in the shared
workflow already starts Fuseki through `globalSetup`, and `CI=true` now makes that start mandatory.
Chosen: (b). A second job would run the same suites twice and duplicate the compose definition.
Added CI time ≈ the two previously skipped parse checks (seconds). Least invasive; maintainability.

**Decision 4 of 6 — How `test:fuseki` selects the live suites.**
(a) A hand-kept list of files — drifts; (b) **`describeFuseki` prefixes every live block with
`[fuseki]`, and `test:fuseki` runs `--testNamePattern='\[fuseki\]'`** — any new live block is
selected automatically. Chosen: (b). Also drop the script's own `docker compose up/down`
(`globalSetup`/`globalTeardown` already start it and stop it only if they started it), and drop
`--runInBand` (Decision 5 makes parallel safe). `REQUIRE_FUSEKI=1` in the script.

**Decision 5 of 6 — Dataset isolation (folds in backlog 037; addresses 047's structural cause).**
(a) keep per-worker; (b) `maxWorkers: 1`; (c) **per test file**: `nashville-test-<file basename>`
from `expect.getState().testPath`, falling back to the worker id outside a test file
(globalSetup). Chosen: (c) — correct under any invocation, keeps parallelism (scalability), and a
failing dataset name points at its file.

**Decision 6 of 6 — Evidence of live tests in the log.**
A ~30-line CJS Jest reporter added beside `default` prints
`[fuseki] live tests: N passed, F failed, S skipped` from `onRunComplete`, counting tests whose
top `describe` starts with `[fuseki]`. Prints only; failing is `globalSetup`'s job.

### Selected route

`src/test-helpers/fuseki-live.ts` (new, test-only): `FUSEKI_LIVE_ENV`, `fusekiLive`,
`describeFuseki(name, fn)`, `fusekiRequired()`. `globalSetup` sets the env and throws when required.
Every live block in the 10 files becomes `describeFuseki`, with its hooks inside it and no
`if (!fusekiAvailable) return`. `sparql-prefixed-names` live parse check uses the shared store.

## Plan

### Contracts

- `process.env.LINKED_TEST_FUSEKI_LIVE` — `'1'` when globalSetup reached Fuseki, `'0'` otherwise.
  Unset (a run without this jest config) counts as not live.
- `REQUIRE_FUSEKI` — `1`/`true`/anything: required; `0`/`false`: not required; unset: required iff
  `CI` is set and not `false`.
- `describeFuseki(name, fn)` → `describe('[fuseki] ' + name, fn)` when live, else
  `describe.skip('[fuseki] ' + name + ' (Fuseki unavailable at <url>)', fn)`.
- `DATASET_NAME` → `nashville-test-<basename of the test file without .test.ts>`.

### Files

| File | Change |
|---|---|
| `src/test-helpers/fuseki-live.ts` | new — env contract, `describeFuseki`, `fusekiRequired` |
| `src/test-helpers/fuseki-test-store.ts` | per-file `DATASET_NAME`; doc header |
| `src/tests/global-setup.ts` | set env; throw when required and unavailable |
| `src/tests/fuseki-live-reporter.cjs` | new — live-test count line |
| `jest.config.cjs` | `reporters: ['default', <reporter>]` |
| `package.json` | `test:fuseki` |
| 10 test files | `describeFuseki`, hooks moved in, guards removed |

### Pitfalls

- `fuseki-live.ts` imports `@jest/globals`; `globalSetup` must not import it (it runs outside the
  test environment) — keep the env-name constant in the store module, which globalSetup already uses.
- Mixed files (live + offline describes) must have their Fuseki hooks inside the live block, or the
  offline run would call `createTestDataset()` without Fuseki.
- `sparql-fuseki-shape-sync` sets the global query dispatch in `beforeAll`; it must stay inside the
  live block.

## Phases

### Phase 1 — helper, globalSetup, store, reporter, script
Validation: `npx tsc -p tsconfig-tests.json` clean; a probe that `REQUIRE_FUSEKI=1` with Fuseki
unreachable aborts the run.

### Phase 2 — convert the 11 live files
Validation: `grep -rn "if (!fusekiAvailable) return\|if (!available) return\|FUSEKI_TEST_ENDPOINT" src`
is empty; `npm test` with Fuseki: same pass count + the 2 parse checks, live count printed;
`npm run test:fuseki` runs every `[fuseki]` block; without Fuseki (`REQUIRE_FUSEKI=0`, unreachable
URL) the live blocks show as skipped; with `CI=1` and Fuseki stopped the run fails.

### Phase 3 — shape-sync loop (backlog 047)
Run `sparql-fuseki-shape-sync` 20× against live Fuseki and record the result.

Dependencies: 1 → 2 → 3, sequential.

## Implementation log

**Phase 1 — done.** `fuseki-live.ts`, `fusekiRequired()`/`FUSEKI_LIVE_ENV`/per-file `DATASET_NAME`
in the store, globalSetup, reporter, `test:fuseki`. `npm run typecheck` clean. A probe test
confirmed `DATASET_NAME === 'nashville-test-zz-probe'` inside a file named `zz-probe.test.ts`.

**Phase 2 — done.** 10 files converted (9 that guarded with `return` + `sparql-prefixed-names`).
- `npm test` with Fuseki: `Tests: 121 skipped, 2183 passed, 2304 total` (identical to the last CI
  run) and `[fuseki] live tests: 281 total — 280 passed, 0 failed, 1 skipped` (the 1 is the
  pre-existing `test.skip` for the SHACL endpoint). ~30 s wall.
- `npm run test:fuseki`: `Test Suites: 90 skipped, 10 passed`; `280 passed` live — every live file,
  up from 3 matched by the old `sparql-fuseki` path pattern.
- No Docker (fake `docker` on PATH), `CI=1`: exit 1 —
  `[globalSetup] Fuseki is required (CI or REQUIRE_FUSEKI is set) but is not reachable at http://localhost:3939 …`.
- No Docker, no CI: exit 0, warning, `[fuseki] live tests: 281 total — 0 passed, 0 failed, 281 skipped`,
  `Tests: 401 skipped, 1903 passed` — skips are counted, not passes.
- `CI=1 REQUIRE_FUSEKI=0`, no Docker: exit 0, live tests skipped (explicit opt-out works).
- Guard grep (`if (!fusekiAvailable) return`, `if (!available) return`, `FUSEKI_TEST_ENDPOINT`): empty.

**Phase 3 — done.** `sparql-fuseki-shape-sync` 20× in a loop against live Fuseki: 20/20 passed
(11 passed, 1 skipped each). Full parallel suite 5× with `REQUIRE_FUSEKI=1`: 5/5 identical
(2183 passed, 280 live). No failure to capture; the two structural explanations 047 recorded
(per-worker dataset reuse, silent pass on absence) are both removed.

## Review

Against the original intent (backlog 009) and the brief:

| Goal | Result |
|---|---|
| CI runs the live suites | Already true before this change (measured, see Ideation); now **required** under `CI=true` — a failed Docker start fails the run instead of passing ~280 empty tests. |
| All live suites, incl. shacl-cascade, shape-sync, owned-link-check | All 10 files, 281 live tests, counted by the reporter; `test:fuseki` selects them by name prefix. |
| Silent skip → loud | Guard centralized in `describeFuseki`; skipped locally, fatal under CI / `REQUIRE_FUSEKI`. |
| Dataset collisions (037) | Per-file dataset; 5 parallel full runs identical. |
| CI time | No new job or step. The only newly executed CI tests are the two prefixed-names parse checks (≈ ms). |

Findings:
1. **Low** — `CI` set in a developer shell makes a Docker-less local run fail. Intended, and the error names the opt-out (`REQUIRE_FUSEKI=0`).
2. **Low** — when `ensureFuseki` started a container that never answered, globalSetup throws and jest skips globalTeardown, leaving the container up. Same as before for the start path; not worth a try/finally in test infra.
3. **Low** — the reporter counts by the outermost describe name; a `[fuseki]` block nested inside an offline describe would be missed. `describeFuseki` is only used at file top level; documented in the helper.
4. **Info** — the shared workflow (`linked-fw/.github` `pr.yml@v1`) needs no change; no other `@_linked` repo is affected.

No medium-or-higher findings, so no iteration.
