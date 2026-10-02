---
summary: >
  `src/tests/sparql-fuseki-shape-sync.test.ts` failed once and passed on an immediate re-run with
  no change to source or test. That is the whole observation — the failing output was not
  captured, so there is no diagnosis yet. What is structural and worth recording: the file's three
  `test()` blocks are strictly order-dependent, they share one Fuseki dataset named only by
  `JEST_WORKER_ID`, and the Phase A sync runs in `beforeAll` — so any cross-file or cross-run reuse
  of that dataset name is an available explanation.
packages: [core]
status: Open — needs the failure captured before it can be diagnosed
---

# 047 — `sparql-fuseki-shape-sync.test.ts` is flaky

## The observation, and only the observation

The suite failed once and passed on an immediate re-run. Nothing in `src/`, the test, or the
Fuseki container changed between the two runs. **The failing output was not captured**, so which
assertion failed is unknown and nothing below is a diagnosis.

## What the file's structure allows

Recorded so the next person does not have to re-derive it:

- **The three tests are strictly order-dependent.** `Phase A: shapes materialize into the store`
  asserts the result of a `runSync()` performed in `beforeAll`; `Phase B: mutate code shapes,
  re-sync` mutates the shapes Phase A asserted; `Phase C` asserts a cascade over what B left.
  Nothing re-establishes state between them, so a failure in one presents as a failure in a later
  one.
- **The dataset is shared and named only by worker id.**
  `src/test-helpers/fuseki-test-store.ts:25`:

  ```ts
  export const DATASET_NAME = `nashville-test-${process.env.JEST_WORKER_ID ?? '1'}`;
  ```

  Every suite that reaches Fuseki on the same worker uses the same dataset. The file guards this
  with `createTestDataset()` + `clearAllData()` in `beforeAll`, but a dataset another file is
  still writing to, or a `clearAllData()` that lands before an in-flight update from the previous
  suite, is not excluded by that guard.
- **`isFusekiAvailable()` turns absence into a pass.** Every test opens with
  `if (!available) return;`. A Fuseki that is up but slow to accept the first request gives a
  green run that asserted nothing — so a "passed on re-run" is not by itself evidence the run was
  meaningful.

## What to do first

Do not change the test. Run it in a loop against a live Fuseki until it fails and **capture the
output** — which phase, which assertion, and whether `available` was true. Until then there is
nothing to fix, and a speculative change to the isolation would remove the only evidence.

If it proves to be dataset reuse, the fix is a per-suite dataset name rather than a per-worker
one; if it proves to be the readiness check, `isFusekiAvailable()` should fail the run rather than
skip it when `FUSEKI_BASE_URL` is explicitly set.
