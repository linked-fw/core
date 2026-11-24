---
date: 2026-10-31
summary: >
  limit/offset on a select page over root subjects, not SPARQL solution rows: a sub-SELECT of
  subjects (the where, the order, LIMIT/OFFSET) joined to the pattern that reads their values.
  Order on a multi-valued path is MIN ascending / MAX descending, ties by subject IRI; `.one()`
  pages the same way; grouped selects count groups. Patch. New backlog 089.
packages: [core]
---

# 098 — Select limit/offset page over subjects

## PR

### Summary

`Shape.select(...).limit(n)` lowered to a plain `LIMIT n` on the outer query. A subject with a
multi-valued property, or values reached through a multi-valued traversal, spans one solution row
per value, so a page held fewer than `n` instances and an instance could be split across two
pages (the host app's report, `/api/instances`).

Now `limit(n)`/`offset(m)` page over the root subjects. When a subject can span several rows, the
select is lowered as

```sparql
SELECT DISTINCT ?a0 ?a0_name ?a0_nickNames WHERE {
  { SELECT ?a0 (MIN(?a0_nickNames) AS ?page_order_0) WHERE { <where part> }
    GROUP BY ?a0 ORDER BY ASC(?page_order_0) ASC(?a0) LIMIT 10 OFFSET 20 }
  <the select's own pattern>
}
ORDER BY ASC(?page_order_0) ASC(?a0) ASC(?a0_nickNames)
```

Semantics (README "Sorting, limiting, one", `documentation/dsl-json.md`,
`documentation/sparql-algebra.md` step 10, `SelectBuilder.limit` JSDoc):

- A page is `n` instances after the first `m`, each with every value, as without paging.
- **orderBy on a multi-valued or nested path:** each instance has one sort value per key, its
  first value in that direction, the lowest ascending (`MIN`) and the highest descending
  (`MAX`). Keys are taken one by one. Ties are broken by the subject IRI, so consecutive pages
  neither repeat nor skip an instance. An instance without a value of a direct path sorts as
  unbound (first ascending, last descending). A nested sort path keeps only the instances that
  have it, as before (backlog 089).
- **`.one()`**: the first instance with all its values (subject paging with LIMIT 1; before, the
  LIMIT was dropped and every subject's rows were read). **`.for(id)`**: one subject, no LIMIT.
- **groupBy**: one row per group, so `limit`/`offset` count groups (unchanged, documented).
- **count / exists**: drop `limit`/`offset` (unchanged).
- **where with an aggregate** (HAVING): applied by the page, per subject; the outer query does
  not repeat it.
- A select with one row per subject (no multi-valued path, single-valued traversals only) and a
  grouped select keep their plain `LIMIT`/`OFFSET`.
- Other datasets: no other `IDataset` in core pages; `RemoteDataset` forwards DSL-JSON to a
  `SparqlDataset`. The DSL-JSON doc states the semantics a store answering envelopes itself
  must follow.

### Changes

- `src/sparql/irToAlgebra.ts`: `rowsPerSubjectMayExceedOne` (multi-valued traversals, or
  multi-valued paths in the projection or order; an order path's cardinality is read from its
  property shape), `pageBySubject`, `prunePagePattern` (the page drops OPTIONAL blocks that bind
  nothing the page reads: an OPTIONAL never removes a subject), the outer plan (order keys,
  GROUP BY only for projected aggregates, no HAVING when paged); the `.one()` LIMIT workaround
  is gone.
- `src/sparql/SparqlAlgebra.ts`, `src/sparql/algebraToString.ts`: `SparqlSubSelect` gains
  `expressions`, `groupBy`, `having`.
- `src/queries/QueryBuilder.ts`: `limit`/`offset` JSDoc.
- Tests: `src/tests/select-subject-paging.test.ts` (8 lowering tests, 12 live).
- Docs: README, `documentation/dsl-json.md`, `documentation/sparql-algebra.md`; backlog 089.
- `.changeset/select-subject-paging.md`: patch.

### Verification

- The new test before the lowering change: `Tests: 9 failed, 7 passed, 16 total`, `[fuseki]
  live tests: 9 total — 4 passed, 5 failed` (a page of 2 returned 1 person). After:
  `Tests: 20 passed, 20 total`, `[fuseki] live tests: 12 total — 12 passed, 0 failed`.
- `npx linked build`: `✔ Build successful`. Full jest against an own Fuseki
  (`FUSEKI_BASE_URL=http://localhost:3962`): `Tests: 122 skipped, 3126 passed, 3248 total`,
  `[fuseki] live tests: 449 total — 447 passed, 0 failed, 2 skipped`; `npm run typecheck`
  (part of `npm test`): clean.
- Two independent review rounds (below).
- The host app: see the host app's report for this change (typecheck gate, `data,apps` smoke, the `/api/instances`
  spec now asserting subject paging).

### Deviations

- `SparqlSubSelect` needs no `distinct` flag: the page always groups by the subject.
- Single-valued traversals do not trigger paging (review R5).

### Follow-ups

- Backlog 089: an unpaged where-aggregate with a multi-valued projection applies its HAVING per
  (subject, values) group; ordering by a nested path drops instances without it; a multi-valued
  leaf under a single-valued traversal maps to one value.

## Details

### First review

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R1 | medium | Paged where-aggregate: the outer query repeated the HAVING per (subject, values) group and emptied the page | Fixed: the page applies it; the outer has no HAVING and groups only for projected aggregates |
| R2 | medium | README said an instance without a nested sort path sorts as unbound; a nested sort path is a required join | Fixed in the docs; behaviour recorded in backlog 089 |
| R3 | low | No tie-breaker: tied subjects could repeat or be skipped across pages | Fixed: `ASC(?a0)` last in the page and outer ORDER BY |
| R4 | low | Outer ORDER BY lost the select's own order of an instance's values | Fixed: appended when the outer query does not group |
| R5 | low | Single-valued traversals triggered paging | Fixed |
| R6 | low | Outer `SELECT DISTINCT` orders by unprojected page keys (allowed by SPARQL 1.1) | Documented in sparql-algebra.md |

### Second review

All first-round fixes confirmed live; no regressions. Two lows: a stale phrase and example in
sparql-algebra.md (fixed), and an older result-mapping bug, a multi-valued leaf under a
single-valued traversal maps to one value (backlog 089).
