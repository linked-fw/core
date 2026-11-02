---
summary: >
  A count inside an `EXISTS` (`w.friends.some((f) => f.articles.size().equals(1))`) compiles to
  `FILTER(COUNT(?x) = 1)` inside the `EXISTS`, which is not valid SPARQL. (The orderBy half is
  done: report 096.)
packages: [core]
---

# 079 — Aggregates inside EXISTS and in orderBy

Source: the review of report 078 (seen on `main` too; not caused by that change).

## Problem

- **Inside `EXISTS`.** `Person.select().where((p) => p.friends.some((f) => f.articles.size().equals(1)))`
  emits `FILTER(EXISTS { … FILTER(COUNT(?a1_articles) = 1) })`. An aggregate is not allowed in a
  `FILTER`; a store refuses the query or answers it wrongly. At the top level the same filter
  becomes `GROUP BY` + `HAVING`.
- **In `orderBy`** (done, report 096): `orderBy` on a plain select now refuses an aggregate, and a
  grouped select sorts by one (`.groupBy('node').orderBy('n', 'DESC')`).

## First questions

- Compile a count inside `EXISTS` as a sub-select (`{ SELECT ?a1 WHERE { … } GROUP BY ?a1
  HAVING(COUNT(…) = 1) }`) inside the `EXISTS`, or refuse it with a clear error?
