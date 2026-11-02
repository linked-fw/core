---
date: 2026-11-02
summary: >
  Comments, tests' example data, the README and current docs (backlog, plans, architecture) no
  longer name the private app built on core; they say "a host app" and use example.org IRIs.
  No behaviour change, no changeset.
packages: [core]
---

# 115 — No host-app mentions

## PR

**What changed.** Every mention of the private host app (its name, its abbreviation, its docs,
plans, backlog numbers and commits, its local paths) is gone from `src/`, `README.md` and
`docs/` outside `docs/reports/`. Comments now say "a host app", "a host's gateway" or "an app";
example IRIs moved to `example.org` (`{workspaceSlug}.id.example.org`, `acme.id.example.org`,
`data.example.org`); test fixtures were renamed to neutral names (`mi-app`, the `my-app:` prefix).
References to the host's architecture docs were dropped, with the rule stated inline where it
mattered. **Verification:** `npx linked build` (`✔ Build successful`), `npm test` (`Test Suites:
19 skipped, 155 passed, 155 of 174 total`, `Tests: 613 skipped, 2854 passed, 3467 total`, then
typecheck clean). **Deviations:** none. **Follow-ups:** bare `arch-NN` references (e.g. `arch-02`
in `SHACL.ts`, `arch-04` in `LinkedStorage.ts`) still point at docs outside this repo, but do not
name the app; left as they are.

## Details

41 files, comments and docs only, plus test data whose values do not change what a test checks
(`shape-check-multiple-inheritance`, `sparql-prefixed-names`, `shape-graphs*`; the prefix keeps its
hyphen, the namespace still string-prefixes the access namespace). Plans 003-005 now refer to an
unnamed host-app master plan; owner-machine paths became placeholders (`<host>/`, `<master-wt>/`).
