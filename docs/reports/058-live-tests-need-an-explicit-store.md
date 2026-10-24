---
summary: >
  Core's live Fuseki tests run only against a store the environment names (FUSEKI_BASE_URL and
  FUSEKI_ADMIN_PASSWORD, no default port or password); without them global setup contacts no
  store. The reaper deletes only `linked-core-test-*` (the old prefix `nashville-test-` was another
  project's), compose projects are per port, CI sets the variables through `test:ci`. Test-only, no
  changeset.
packages: [core]
---

# 058 — Live tests need an explicit store

## PR

### Summary

Core's Jest global setup defaulted to Fuseki on `http://localhost:3939` with password `admin`.
Another project's stock Fuseki listens there (container `tests-fuseki-1`), and agents that ran
`npm test` without setting the environment reached it three times: `reapTestDatasets` deleted its
`nashville-test-*` datasets and the inference probe ran there.

What the reaper did before: it deleted every dataset whose name started with `nashville-test-`
(core's own prefix, a leftover name that another project also uses) plus `linked-inference-probe`.
It did not look at any run tag, so it reaped whatever matched the prefix on whichever store it
reached.

- **No defaults.** The live tests need `FUSEKI_BASE_URL` and `FUSEKI_ADMIN_PASSWORD` set
  explicitly. Without them global setup contacts and starts no store: the `[fuseki]` blocks are
  skipped locally (`skipped: FUSEKI_BASE_URL, FUSEKI_ADMIN_PASSWORD not set`), and under `CI` or
  `REQUIRE_FUSEKI` the run fails with a message naming the variables. A URL without a port fails
  setup. `isFusekiAvailable`, `ensureFuseki` and teardown refuse too. Test files that build a
  store at load time get an `http://fuseki-base-url-unset.invalid` placeholder, which never
  resolves.
- **The prefix is core's own.** Datasets are `linked-core-test-<file>`, the probe
  `linked-core-test-inference-probe`; `reapTestDatasets` deletes only that prefix. Teardown reaps
  only a store global setup reached and checked.
- **Compose.** The compose file has no default port or password (`:?` guards). Global setup passes
  them in, and its compose project defaults to `linked-core-test-<port>`, so runs on different
  ports never recreate each other's container.
- **Messages.** The non-inferring-store error no longer says to stop the container on the port
  (it may be another project's). It says to use a free port of your own.
- **The second-store test** (`LINKED_SECOND_FUSEKI_URL`) runs only when the main live store is
  configured.
- **CI.** The shared workflow can only choose an npm script, so `pr.yml` sets `test-script:
  test:ci`. That script sets `FUSEKI_BASE_URL=http://localhost:3939 FUSEKI_ADMIN_PASSWORD=admin`
  for the runner's own store and refuses to run outside GitHub Actions (`GITHUB_ACTIONS`).
- **Docs.** README "Running the tests" (new), AGENTS.md, the compose file and helper comments.

No changeset: nothing published changes (test helpers, test setup, scripts, docs).

### Changes

- `src/test-helpers/fuseki-test-store.ts`: `FUSEKI_ENV`, `fusekiConfigMissing`,
  `fusekiConfigMessage`, `fusekiTestPort`, prefix `linked-core-test-`, gated availability and
  start, per-port compose project, `composeEnv` without defaults.
- `src/tests/global-setup.ts`, `global-teardown.ts`, `src/test-helpers/fuseki-live.ts`: the gate,
  the skip reason, the reap condition.
- `src/tests/docker-compose.test.yml`: required port and password.
- `src/tests/sparql-fuseki.test.ts`, `sparql-fuseki-coverage.test.ts`: the helper's
  `FUSEKI_BASE_URL` instead of inline `|| 'http://localhost:3939'`.
- `src/tests/ontology-sync-fuseki.test.ts`: second-store gate.
- `package.json` (`test:ci`), `.github/workflows/pr.yml`, `README.md`, `AGENTS.md`.
- `docs/backlog/074-loadstores-names-the-alias-of-a-constructor-error.md`: an unrelated follow-up
  from fuseki report 004's review.

### Verification

Worktree `~/web/wt/fsset` (branch `main--fsset`). Own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on
:3321 (compose project `fuseki-fsset`).

- With `FUSEKI_BASE_URL=http://localhost:3321 FUSEKI_ADMIN_PASSWORD=admin REQUIRE_FUSEKI=1`:
  `npm test`: `Test Suites: 1 failed, 4 skipped, 142 passed, 143 of 147 total`, `Tests: 122
  skipped, 2819 passed, 2941 total`, `[fuseki] live tests: 398 total — 396 passed, 0 failed, 2
  skipped`. The failed suite is the known `two-copies-built.test.ts` (`Module cache already has
  entry …/lib/esm/shapes/SHACL.js. This is a bug in Jest`). The same numbers as report 057.
- `npm run typecheck`, `npm run check:dts`: clean. `npx linked build`: `✔ Build successful`.
- No variables: `[globalSetup] Every [fuseki] test will be reported as SKIPPED: the live Fuseki
  tests need FUSEKI_BASE_URL and FUSEKI_ADMIN_PASSWORD set explicitly …`, `[fuseki] live tests:
  112 total — 0 passed, 0 failed, 112 skipped` (one file).
- `REQUIRE_FUSEKI=1`, no variables: `[globalSetup] Fuseki is required (CI or REQUIRE_FUSEKI is
  set), but the live Fuseki tests need FUSEKI_BASE_URL and FUSEKI_ADMIN_PASSWORD set explicitly …`;
  with only the URL, the message names `FUSEKI_ADMIN_PASSWORD` alone.
- `FUSEKI_BASE_URL=http://localhost`: `… names no port: give it the port of your own test store`.
- Reaper: with `nashville-test-foreign` and `linked-core-test-leftover` created on :3321, a run
  printed `[globalSetup] deleted 1 dataset(s) a previous run left behind`, and the listing still
  held `/nashville-test-foreign` (then removed by hand).
- `npm run test:ci` locally: `test:ci runs only on GitHub Actions. …`, exit 1.
- Independent review: no high findings. Applied: per-port compose project (medium), the
  stop-the-container advice removed (medium), the second-store gate, the no-port check, a
  `down` note in the compose file, trimmed password, the one-store-per-run note.

### Deviations

- No per-run tag: an owned prefix is enough once every run names its own store, and setup still
  has to reap what a killed run left. Two runs on one store would delete each other's datasets;
  the docs say to give each run its own store.

### Follow-ups

- Backlog 074 (`loadStores` names the alias of a constructor error).
