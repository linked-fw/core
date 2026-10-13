---
summary: >
  Core persists SHACL (including the generated single-owner shapes and `sh:class` on
  properties), but nothing validates writes against it: core's in-process validator does not
  check `sh:class` of references or cross-node rules like `sh:maxCount` on inverse paths, and the
  default Fuseki setup exposes no SHACL service. Explore write-time or on-demand store
  validation.
packages: [core]
---

# 054 — SHACL validation of writes against the persisted shapes

Source: [report 032](../reports/032-owned-replace-noop-and-single-owner-shacl.md). Contract:
[owned-values](../architecture/owned-values.md).

## Today

- `src/shapes/validation.ts` (report 027) validates DSL mutations in process: counts, datatypes,
  ranges, patterns, `in`, undeclared keys. It is per node and pure; it does not look at the store.
- `sh:class` of an object value is never checked, except for owned properties, where
  `SparqlDataset.checkOwnedLinks` refuses a wrongly typed linked id (one SELECT).
- The single-owner constraint (`sh:targetObjectsOf p` + `sh:inversePath p` / `sh:maxCount 1`) is
  persisted but not checked by anything.
- The default Fuseki setup has query, update and graph-store services only. Even Fuseki's SHACL
  service validates on demand (`POST /<ds>/shacl`), never on `/update`.
- Raw SPARQL updates bypass every check.

## Options

- (a) **On-demand report:** a core helper that runs a SHACL validator (or a SPARQL translation of
  the supported constraints) against a dataset and returns a `ValidationReport` (see backlog 034).
- (b) **Targeted write-time checks in `SparqlDataset`:** extend the owned-link pattern to the
  single-owner rule (one ASK per mutation that links owned ids: does the id already have another
  owner through the predicate?). Closes the "two owners" hole without a full validator.
- (c) **Store-side:** a store wrapper that validates the affected nodes after each update and
  rolls back (needs transactions, backlog 018).

## Open questions

- Should (b)'s single-owner check refuse, or steal ownership (unlink the previous owner)?
- Is a periodic validation report enough for applications, given the class check already guards
  the destructive case?
