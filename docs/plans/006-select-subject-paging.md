---
summary: limit/offset on a select page over root subjects, not SPARQL solution rows; a paging sub-SELECT of DISTINCT subjects (with the where, the order and LIMIT/OFFSET) joined to the pattern that reads their values.
packages: [core]
status: Implementation
---

# 006 — Select limit/offset page over subjects

## Problem

`Shape.select(...).limit(10)` lowers to a plain `LIMIT 10` on the outer query. A subject with a
multi-valued property (or a traversal) spans one solution row per value, so the page holds fewer
than 10 subjects and a subject can be split across two pages (CN report 366, `/api/instances`).
`.one()` works around it by dropping the LIMIT when a subject spans several rows, so it reads every
subject's rows and keeps the first.

## Ideation

Planning blockers and decisions (owner's priority: maintainability, scalability, performance).

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Where to fix | In the SPARQL lowering (`selectToAlgebra`), on the finished, graph-scoped algebra | The IR already says "limit n"; the row/subject mismatch is a SPARQL artefact. Wrapping after graph scoping keeps routing/scoping code untouched |
| 2 | SPARQL form | `{ SELECT ?a0 (MIN/MAX(order) AS ?k) WHERE { <where part> } GROUP BY ?a0 [HAVING] ORDER BY ?k LIMIT n OFFSET m }` joined to the full outer pattern; the outer ORDER BY is the page keys | Standard subject-paging shape; every store with SPARQL 1.1 runs it |
| 3 | When | Only for an ungrouped select with `limit`/`offset` whose subjects can span several rows (a traversal, or a multi-valued path in the projection or the order) | One row per subject already pages correctly; those queries keep their plain SPARQL |
| 4 | Inner pattern | The outer algebra with OPTIONAL blocks pruned when nothing the page needs (the subject, the where, the order keys, a join) reads their variables | An OPTIONAL never removes a left row, so dropping it cannot change which subjects match; it avoids paying the whole projection twice |
| 5 | Order on a multi-valued/nested path | A subject sorts by the value that comes first in the requested direction: the lowest ascending (`MIN`), the highest descending (`MAX`); each sort key independently; a subject without the value sorts as unbound (first ascending, last descending, as SPARQL orders unbound) | Deterministic, one row per subject in the page query; matches what the old row order showed first for a subject |
| 6 | `.one()` | Without a subject: subject paging with LIMIT 1 (the first subject, all its values). With `.for(id)`: no LIMIT (one subject already) | Removes the "read everything, keep the first" workaround |
| 7 | `groupBy` | Unchanged: a grouped select has one row per group, so its LIMIT/OFFSET already count groups. Documented | Rows are groups |
| 8 | count / exists | Unchanged: they drop limit/offset (documented already) | — |
| 9 | Other `IDataset`s | No other dataset in core lowers paging; `RemoteDataset` forwards DSL-JSON to a `SparqlDataset`. The semantics are written in the README and DSL-JSON doc so any store implements the same | One definition |

Selected route: decisions 1–9.

## Plan

### Contracts

- `limit(n)`/`offset(m)` on an ungrouped select: the page is the n subjects after the first m, in
  the select's order; each returned subject carries all its values, as without paging.
- Order of a subject on a multi-valued or nested path: decision 5.
- Grouped select: limit/offset count groups. `.one()`: decision 6.

### Changes

- `src/sparql/SparqlAlgebra.ts`: `SparqlSubSelect` gains optional `distinct`, `expressions`
  (`(expr AS ?v)` projections), `groupBy`, `having`.
- `src/sparql/algebraToString.ts`: serialize them.
- `src/sparql/irToAlgebra.ts`: `rowsPerSubjectMayExceedOne`, `pageBySubject` (build the paging
  sub-SELECT, prune OPTIONALs, rewrite the outer ORDER BY), remove the `.one()` LIMIT workaround.
- Tests: `src/tests/select-subject-paging.test.ts` (goldens + live Fuseki).
- Docs: README "Sorting, limiting, one", `documentation/sparql-algebra.md`, `documentation/dsl-json.md`.

### Pitfalls

- MIN/MAX over an unbound order value is unbound; ORDER BY puts it first ascending.
- An ungrouped select with an aggregate in where (HAVING): the page query groups by the subject
  and keeps the HAVING.
- Graph variables of routed reads stay in the pruned pattern only when a kept block uses them.
- Nested-select inner pagination (single subject only) is a separate sub-SELECT; it stays.

## Tasks

### Phase 1: failing tests
- Golden tests for limit/offset on a multi-valued projection, a traversal, order on a multi-valued
  path, `.one()`, where, groupBy; live Fuseki test with 3 persons × several nick names.
- Validation: the new tests fail on the current lowering (live: a page of 2 returns 1 person).

### Phase 2: lowering
- Algebra node fields, serializer, `pageBySubject`, `.one()` change.
- Validation: new tests pass; `sparql-select-golden`, `sparql-fuseki`, `nested-select-pagination`,
  `subject-order-and-cursor` pass (goldens updated where the SPARQL changes on purpose).

### Phase 3: docs and full suite
- README, sparql-algebra.md, dsl-json.md.
- Validation: full jest with an own Fuseki, `npx linked build`, `npm run check:dts`.

### Phase 4: CN
- CN typecheck gate, `test:feature -- data,apps --tier smoke`, update the instances spec.

Dependencies: 1 → 2 → 3 → 4, sequential (one agent).

## Implementation log

- Phases 1–3 (one commit): `select-subject-paging.test.ts` failed before the lowering change
  (`Tests: 9 failed, 7 passed, 16 total`; live `[fuseki] live tests: 9 total — 4 passed, 5
  failed`); after: `Tests: 16 passed`. Deviation: `SparqlSubSelect` needs no `distinct` (the page
  always groups by the subject). An ungrouped select with an aggregate also groups its outer rows
  by the page's sort keys (one per subject), so its ORDER BY can read them. Order paths carry no
  `maxCount` in the IR; their cardinality is read from the property shape.
- Full suite after `npx linked build`: `Tests: 122 skipped, 3122 passed, 3244 total`, `[fuseki]
  live tests: 446 total — 444 passed, 0 failed, 2 skipped`.
