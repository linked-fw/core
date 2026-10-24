---
date: 2026-10-24
summary: >
  The README gets "Using ontology terms" under §Shapes: namespace imports of the generated
  vocabulary modules, accessors over `{id}`, `{id}` only for a namespace without a module.
  `@_linked/schema`'s README links it. No code changed. Patch.
---

# 076 — README: using ontology terms

## Why

The vocabulary packages now ship generated accessor modules without an aggregated object (cli
report 027). The rule for using them belongs in one place every package can link to.

## What changed

- `README.md` §Shapes → **Using ontology terms**: `import * as <prefix> from
  '<pkg>/ontologies/<prefix>'`, the identifier rule's renames (`_3DModel`, `yield_`,
  `ISO639_2`), the `.data` sibling for `ns`/`loadData`/`dataFiles`/`_ontologyResource`, accessors
  over `{id}`, and `{id}`/`createNameSpace` only for a namespace without a module (the section's
  existing `ex` example is that case).
- `@_linked/schema`'s README links it (schema report 005).

## Gate

- `npx linked build`: "✔ Build successful"; jest: "Tests: 518 skipped, 2462 passed, 2980 total" (the skipped suites are the live Fuseki ones, which need an explicit store); `npm run typecheck`: clean.

## PR

### Summary

Adds a short "Using ontology terms" section to the README.

### Changes

- `README.md` §Shapes → Using ontology terms: namespace imports, accessors over `{id}`, `{id}`
  only for a namespace without a module.

### Verification

- `npx linked build`: "✔ Build successful"; jest: "Tests: 518 skipped, 2462 passed, 2980 total" (the skipped suites are the live Fuseki ones, which need an explicit store); `npm run typecheck`: clean.

### Deviations

None.

### Follow-ups

None.
