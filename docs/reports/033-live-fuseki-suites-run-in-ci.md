---
summary: >
  Live-Fuseki tests can no longer pass without running. jest globalSetup decides once whether
  Fuseki is reachable; `describeFuseki` registers live blocks or visibly skips them; under `CI` or
  `REQUIRE_FUSEKI` an unreachable Fuseki aborts the run. Datasets are per test file, a reporter
  prints the live-test count, and `npm run test:fuseki` selects every live block. Test-only; no
  CI workflow change and no changeset.
packages: [core]
source_backlog: docs/backlog/009-ci-test-integrity-fuseki.md (consumed, removed)
folded_backlog:
  - docs/backlog/037-fuseki-suites-share-one-dataset.md (resolved, removed)
  - docs/backlog/047-sparql-fuseki-shape-sync-is-flaky.md (structural causes removed, no failure reproduced in 25 runs, removed)
---

# 033 — Live Fuseki suites run in CI, and say so

## What was actually wrong

Backlog 009 assumed CI never starts Fuseki. The CI log said otherwise — the last feature PR run
(`38305862605`) printed `[ensureFuseki] Fuseki is ready` and
`Tests: 121 skipped, 2183 passed, 2304 total`. The shared workflow (`linked-fw/.github`
`pr.yml@v1`) runs `npm test` on `ubuntu-latest`; Docker is present there, and `jest.config.cjs`'s
`globalSetup` calls `ensureFuseki()`, which runs `docker compose up -d --wait`. So the live suites
already ran in CI. The real defects:

1. **A failed start was invisible.** `ensureFuseki()` returning `false` produced only a warning,
   and ~280 tests in 9 files then hit `if (!fusekiAvailable) return;` and reported *passed*.
2. **One live check never ran anywhere.** `sparql-prefixed-names` asked a real endpoint to parse
   two queries only when `FUSEKI_TEST_ENDPOINT` was set; nothing set it, and it returned early as a pass.
3. **`npm run test:fuseki` covered 3 of 10 live files** (`--testPathPatterns='sparql-fuseki'`).
4. **Datasets were per worker, not per file** (037/047): consecutive files on a worker reused one.
5. **No evidence**: nothing in the output said how many live tests ran.

## Design

```
globalSetup ── ensureFuseki() ──► process.env.LINKED_TEST_FUSEKI_LIVE = '1' | '0'
     │                                 │ (inherited by every jest worker)
     │ unreachable && fusekiRequired() │
     └──► throw → run aborts           ▼
                          describeFuseki(name, fn)  ← read synchronously at collection
                            live:   describe('[fuseki] name', fn)
                            absent: describe.skip('[fuseki] name (skipped: Fuseki unavailable at <url>)', fn)
                                       │
          fuseki-live-reporter.cjs ◄───┘ counts tests whose outermost describe starts with [fuseki]
```

### Decisions (priority: maintainability, scalability, performance)

1. **One availability decision, in globalSetup**, passed to workers through an env var, read at
   collection time. Jest cannot mark a running test skipped, so a per-test runtime guard can only
   pass or fail; a collection-time `describe.skip` is a real skip. Verified with probes: env set in
   globalSetup reaches workers; a file's top-level `beforeAll` does not run when all its tests are
   skipped.
2. **When it fails:** `REQUIRE_FUSEKI` decides when set (`0`/`false` opt out, anything else
   requires); otherwise required iff `CI` is set and not `0`/`false`. GitHub Actions sets
   `CI=true`, so CI requires Fuseki with no workflow input.
3. **No CI workflow change.** A separate Fuseki job would run the same suites twice and duplicate
   the compose file; the existing `npm test` already starts Fuseki and is now required to.
   Added CI time: two parse checks, milliseconds.
4. **`test:fuseki` selects by name** (`--testNamePattern='\[fuseki\]'`), so a new live block is
   picked up without editing a file list. The script's own `docker compose up/down` and
   `--runInBand` were dropped: globalSetup/globalTeardown start Fuseki and stop it only when they
   started it, and per-file datasets make parallel runs safe. `REQUIRE_FUSEKI=1` is set in it.
5. **Per-file datasets** (037 option 1): `DATASET_NAME = nashville-test-<file basename>` from
   `expect.getState().testPath`, falling back to the worker id outside a test file. Correct under
   any jest invocation, keeps parallelism, and the dataset name in a failure points at the file.
6. **Reporter prints, does not fail.** Failing is globalSetup's job; a filtered run that selects no
   live file legitimately counts 0.

## Files

| File | Responsibility |
|---|---|
| `src/test-helpers/fuseki-live.ts` (new) | `describeFuseki`, `fusekiLive`, `FUSEKI_TEST_PREFIX`; imports `@jest/globals`, so test files only |
| `src/test-helpers/fuseki-test-store.ts` | per-file `DATASET_NAME`; `FUSEKI_LIVE_ENV`, `fusekiRequired()` (kept here because globalSetup must not import `@jest/globals`) |
| `src/tests/global-setup.ts` | sets the env; throws when required and unreachable; warns otherwise |
| `src/tests/fuseki-live-reporter.cjs` (new) | `[fuseki] live tests: N total — P passed, F failed, S skipped` |
| `jest.config.cjs` | `reporters: ['default', <reporter>]` |
| `package.json` | `test:fuseki` |
| `AGENTS.md` | the convention, two lines |
| 10 test files | live blocks via `describeFuseki`; per-test guards removed |

Converted files: `sparql-fuseki`, `sparql-fuseki-coverage`, `sparql-fuseki-shape-sync`,
`property-path-fuseki`, `property-path-named-resolution`, `nested-select-pagination`,
`shacl-cascade`, `owned-link-check`, `mutation-where-union`, `sparql-prefixed-names` (the latter
now creates its dataset and parses through `executeSparqlQuery`; `FUSEKI_TEST_ENDPOINT` is gone).

### Convention for new live tests

```ts
import {describeFuseki} from '../test-helpers/fuseki-live';

describeFuseki('my feature against Fuseki', () => {
  beforeAll(async () => { await createTestDataset(); });   // hooks inside the block
  beforeEach(async () => { await clearAllData(); });
  test('…', async () => { /* no availability check */ });
});
```

Call it at file top level (the reporter reads the outermost describe). A file-level hook shared
by several live blocks starts with `if (!fusekiLive) return;`, because jest runs top-level hooks
whenever any test in the file — including an offline one — runs. Tests never check availability.

## Validation

- `npm test` with Fuseki: `Tests: 121 skipped, 2183 passed, 2304 total` (identical to CI before),
  `[fuseki] live tests: 281 total — 280 passed, 0 failed, 1 skipped` (the pre-existing `test.skip`
  for the SHACL endpoint the test image lacks). ~30 s wall.
- `npm run test:fuseki`: `Test Suites: 90 skipped, 10 passed`, 280 live passed.
- Docker unavailable (stub `docker` on PATH), `CI=1`: exit 1 with
  `[globalSetup] Fuseki is required (CI or REQUIRE_FUSEKI is set) but is not reachable at http://localhost:3939 …`.
- Docker unavailable, no CI: exit 0, `281 skipped` live, `Tests: 401 skipped, 1903 passed`.
- `CI=1 REQUIRE_FUSEKI=0`, Docker unavailable: exit 0, live skipped.
- Per-file name probe: `DATASET_NAME === 'nashville-test-zz-probe'` inside `zz-probe.test.ts`.
- Backlog 047: `sparql-fuseki-shape-sync` 20× in a loop, 20/20 green; full parallel suite 5×,
  5/5 identical. No failure reproduced.
- CI on the PR: see PR section.

## Backlog disposition

- **009** — consumed. All three of its options are done (visible skip / required flag, Fuseki in CI,
  prominent count).
- **037** — resolved by the per-file dataset (its "hardcoded `nashville-test`" text was already
  stale; the per-worker fix had landed, the per-file one is what it asked for).
- **047** — both structural explanations it recorded (cross-file dataset reuse on a worker, silent
  pass when Fuseki was slow or absent) are removed, and 25 runs reproduced nothing. If it recurs,
  the failing output is now meaningful (a dataset named after the file, and no silent passes) —
  capture it and open a new item.

## Known limitations

- A `CI` variable set in a developer shell makes a Docker-less local run fail; the error names
  `REQUIRE_FUSEKI=0`.
- If `ensureFuseki` starts a container that never answers, globalSetup throws and jest skips
  globalTeardown, leaving the container running (unchanged from before for that path).
- Two jest runs at once against one Fuseki still share per-file dataset names.

## Release

Test and dev-script changes only: `src/tests/**` and `src/test-helpers/**` are excluded from the
build (`tsconfig-esm.json`), and `package.json` changed only in `scripts`. No changeset.
