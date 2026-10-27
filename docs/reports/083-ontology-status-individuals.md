---
date: 2026-10-27
summary: >
  Step OA of CN plan 070: the ontology status values as public individuals in core —
  `core:OntologyStatus` with `core:Draft`, `core:ReadyForReview` and `core:Published`, in
  `core.ttl` and on `coreOntology`. An ontology states its status as `adms:status <iri>` (owl's
  `Ontology.status`, owl report 003). Minor.
---

# 083 — Ontology status individuals

## PR

### Summary

The stages an ontology goes through (draft, ready for review, published) are public individuals
of a new class `core:OntologyStatus`, so an ontology's `adms:status` points at a stable IRI. ADMS's
own status vocabulary has none of these stages. The accessor that reads it is owl's
`Ontology.status`; the full step is in owl `docs/reports/003-ontology-metadata-accessors.md`.

### Changes

- `src/data/core.ttl`: `core:OntologyStatus` (`owl:Class`); `core:Draft`, `core:ReadyForReview`,
  `core:Published`, each `a owl:NamedIndividual, core:OntologyStatus` with an English
  `rdfs:label` and `rdfs:comment`. IRIs `https://linked.cm/ont/core/{OntologyStatus,Draft,ReadyForReview,Published}`.
- `src/ontologies/linked-core.ts`: the four terms, exported on `coreOntology`.
- `src/tests/core-ontology.test.ts`: the class is exported, typed and labelled; each individual
  is exported, typed `owl:NamedIndividual` and `core:OntologyStatus`, labelled and described.
- Changeset `ontology-status.md` (minor).

### Verification

`npx linked build` — `✔ Build successful`. `npm test` (jest plus typecheck), rebased on `dev`
`f6de1ba`, 35 s wall clock:

```
Test Suites: 16 skipped, 137 passed, 137 of 153 total
Tests:       534 skipped, 2548 passed, 3082 total
Time:        28.824 s, estimated 57 s
```

(The skipped suites are the `[fuseki]` live tests, which need a Fuseki of their own.)

CN booted on this core (worktree, :4352) logged `[cn-main] ontology sync: written @_linked/core`
and no error.

### Deviations

- Numbered 083, not 081 as CN plan 070 lists: 081 and 082 were taken on `dev` while this step ran.

### Follow-ups

None in core. Writing a status (CN plan 070 step SV) and showing it (step NP) are those steps'
scope, recorded in CN `docs/plans/200-ontology-cn-steps.md`.

## Details

- `linked-core.ts` is hand-written (not generated), so the terms are added beside the other
  `ns()` constants with a comment on what they are for.
- The individuals carry no order or `skos:` scheme: the three values are a fixed set CN reads by
  IRI.
