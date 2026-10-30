---
date: 2026-10-30
summary: >
  `LinkedStorage` logs a `console.warn` notice once per call site when a shapeless read that names
  no dataset (a subject read `TriplesBuilder.forNode({id})` without `.from()`, a shapeless ask
  `Shape.exists(iri)` / `AskBuilder.forNode(iri)`) is sent to more than one dataset, naming the
  number of datasets and the fix (`.exec(dataset)`, `Shape.exists(iri, dataset)`, `.from(graph)`).
  Call site = first stack frame outside core; one notice per kind when there is none. Patch.
packages: [core]
---

# 095 — A notice when a shapeless read is sent to several datasets

## PR

### Summary

A shapeless read has no routing key, so `LinkedStorage` sends it to every dataset it knows: a
subject read is read in each and the answers joined, a shapeless ask asks each in turn until one
says `true`. The answer is right, but each such read costs a query per dataset, and the caller
usually knows which dataset it means. `LinkedStorage` now says so once per call site:

```
[linked] A shapeless ask (Shape.exists(iri), AskBuilder.forNode(iri)) names no dataset, so
LinkedStorage sent it to all 2 datasets it knows and asked them in turn until one answered true
(at file:///…/app.mjs:10:13). To ask one dataset, pass it: Shape.exists(iri, dataset) or
.exec(dataset). This notice shows once per call site.
```

Nothing is logged with one dataset, an explicit dataset (`exec(target)` never reaches
`LinkedStorage`), a shaped read, or a subject read with `.from()` graphs. No graph-to-dataset
routing was added.

### Changes

- `src/utils/fanOutNotice.ts` (new): `noticeFanOut(kind, count)` finds the call site (the first
  stack frame outside core, `file:line:column`), dedupes on it in a module-level `Set` (one key per
  kind when no frame is found) and logs with `console.warn` and the `[linked]` prefix, as core's
  other warnings do. It raises `Error.stackTraceLimit` to 50 for the one capture: the built code's
  down-levelled `async` helpers push the caller past V8's default 10 frames. Core is the directory
  above the module's `utils/` (`src/`, `lib/esm/`); core's own `tests/` counts as outside.
  `resetFanOutNotices()` is internal, for tests.
- `src/utils/LinkedStorage.ts`: `triplesQuery` (subject read, more than one dataset, no `graphs`)
  and `askAnyDataset` (more than one dataset) call it before their first `await`, while the
  caller's frames are on the stack. Doc comments say so.
- `src/tests/fan-out-notice.test.ts` (new): two in-memory stub datasets.
- `README.md`: a "Shapeless reads across datasets" section after "Triples reads (no shape)".
- `.changeset/fan-out-notice.md`: patch.

### Verification

`NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/fan-out-notice.test.ts`:

```
PASS src/tests/fan-out-notice.test.ts
  a subject read sent to more than one dataset
    ✓ notices once for repeated calls from one site, again from a second site
    ✓ an awaited builder without exec() has no call site: one notice for all such reads
    ✓ nothing with one dataset, an explicit target, or .from() graphs
  a shapeless ask sent to more than one dataset
    ✓ notices once for repeated calls from one site, again from a second site
    ✓ nothing with one dataset, an explicit target, or a shaped ask
Tests:       5 passed, 5 total
```

`npm test` (jest, then `tsc -p tsconfig-tests.json`; no `FUSEKI_BASE_URL`, so the live suites
skip; nothing here touches the store):

```
[fuseki] live tests: 418 total — 0 passed, 0 failed, 418 skipped
Test Suites: 18 skipped, 142 passed, 142 of 160 total
Tests:       538 skipped, 2615 passed, 3153 total
```

`npx linked build`: `✔ Build successful`. Against the built `lib/esm` from a script outside core
(two stub datasets, the same subject read twice in a loop, then `Shape.exists(iri)` on two lines),
three notices: one for the loop, one per `exists` line, each with the script's `file:line:col`.
Before the stack-limit change the built run found no site (the frames stopped at
`queryDispatch.js`), which is why that change is in.

### Deviations

- **A subject read with `.from(graph)` logs nothing, though it still reads every dataset** (in
  those graphs only). The owner named `.from(graph)` as a fix, and a notice it cannot silence would
  be noise; making `.from()` pick a dataset would be graph-to-dataset routing, which the owner
  ruled out. The README and the `triplesQuery` doc comment state it.
- **A builder awaited without `.exec()`** (`await TriplesBuilder.forNode({id})`,
  `await AskBuilder.forNode(iri)`) is run by its `then()` from a microtask, with the caller off the
  stack, so it gets the fallback: one notice per kind for all such reads (the message says so).
  `Shape.exists(iri)` and `.exec()` calls keep their site.

### Follow-ups

- Capture the call site when the builder is made (`forNode`), so awaited builders get their own
  site too; costs a stack capture per builder. Home: this report (not scheduled).
- A router that forwards client queries (a server endpoint) is one call site for all of them, so
  it is noticed once. Home: this report.

## Details

Why at the router and not the builder: the fan-out is `LinkedStorage`'s decision (one dataset
means no fan-out), and an explicit target never reaches it, so "nothing when a target is given"
holds by construction. The check runs before the first `await` because `triplesQuery` and
`askAnyDataset` are `async`: their bodies run synchronously up to it, under the caller's frames
(`exec` → dispatch → `resolveTriples`/`resolveExistence` → the instrumented dispatch →
`LinkedStorage`, all synchronous calls).

The location parser takes V8's `at f (loc)` and `at loc` and the `f@loc` form, with a location
that starts with a URL scheme (`file://`, `http://`), `/` or a drive letter, so `node:internal`
and `<anonymous>` frames are skipped. In a bundle where this module has no `utils/` directory,
core is the module's own file.

The ask notice fires per call even when the first dataset answers `true` (the fan-out may then
stop at one); it reports the datasets the router would ask.
