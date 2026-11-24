---
date: 2026-11-10
summary: >
  The documentation of `@_linked/core/ontology/loadOntologyFiles` still described the removed
  `linkedOntology`'s `loadData`; it now describes how `registerOntologies` loads an ontology's
  `data` files. Comment only. Patch.
packages: [core]
---

# 121 — `loadOntologyFiles`' documentation

## PR

### Summary

`src/ontology/loadOntologyFiles.ts` opened with "The `loadData` a package's ontology module passes
to `linkedOntology`", an API removed with the scoped prefixes (report 119). The comment now says
what the module does today: it reads the Turtle files `registerOntologies` names in an ontology's
`data`, relative to the registering module (`import.meta.url`), with an example of the ontology
index. No code changes.

### Changes

- `src/ontology/loadOntologyFiles.ts`: module comment.
- Changeset `.changeset/load-ontology-files-doc.md` (patch).

### Verification

- `linked build` → `✔ Build successful` (7.7 s).
- `npm test` → `Test Suites: 19 skipped, 160 passed, 160 of 179 total`, `Tests: 623 skipped,
  2892 passed, 3515 total`, then `tsc -p tsconfig-tests.json`; exit 0 (17.6 s). A first run
  exited 1 after the same jest totals; it did not repeat in two later runs (jest exit 0,
  typecheck exit 0) and nothing in the change can affect a test.

### Deviations

None.

### Follow-ups

None.

## Details

No decisions beyond wording.
