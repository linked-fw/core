---
summary: >
  A create with a nested node that has no `__id` returns `id: ''` for that node in the create
  result: `mapSparqlCreateResult` maps the IR, but nested ids are minted only in the SPARQL
  compiler. Return the minted id.
packages: [core]
---

# 072 — Nested create without `__id` returns `id: ''`

Source: CN plan 071 final review; core report 051 §Review fixes ("Observed, not changed").

## Problem

`Shape.create({…, nested: {…}})` without an `__id` on the nested node writes the node under a
minted IRI, but the create result lists it with `id: ''`. `mapSparqlCreateResult`
(`src/sparql/resultMapping.ts`) maps the IR's create data, and the IR carries no id for the nested
node: the id is minted later, while the compiler builds the `INSERT DATA`. The caller cannot
address the nested node it just created without a second read. A nested node with `__id` is
returned correctly.

## First questions

- Mint nested ids when the IR is built (as the top-level id already is), so the compiler and the
  result mapper read the same id, or hand the compiler's minted ids back to the mapper?
- Does any caller rely on the empty id (e.g. treating `''` as "not created")? Grep the dependents
  (server, CN, auth) before changing it.
- A test on the result shape: a nested create without `__id` returns a non-empty id that a select
  then finds.
