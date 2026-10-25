---
summary: >
  A count inside an `EXISTS` (`w.friends.some((f) => f.articles.size().equals(1))`) compiles to
  `FILTER(COUNT(?x) = 1)` inside the `EXISTS`, which is not valid SPARQL; and `orderBy` on a
  count (`orderBy((w) => w.articles.size())`) orders by the plain variable, without the aggregate.
packages: [core]
---

# 079 — Aggregates inside EXISTS and in orderBy

Source: the review of report 078 (seen on `main` too; not caused by that change).

## Problem

- **Inside `EXISTS`.** `Person.select().where((p) => p.friends.some((f) => f.articles.size().equals(1)))`
  emits `FILTER(EXISTS { … FILTER(COUNT(?a1_articles) = 1) })`. An aggregate is not allowed in a
  `FILTER`; a store refuses the query or answers it wrongly. At the top level the same filter
  becomes `GROUP BY` + `HAVING`.
- **In `orderBy`.** `orderBy((w) => w.articles.size())` emits `ORDER BY ASC(?a0_articles)`: it
  orders by one value of the property, not by the count.

## First questions

- Compile a count inside `EXISTS` as a sub-select (`{ SELECT ?a1 WHERE { … } GROUP BY ?a1
  HAVING(COUNT(…) = 1) }`) inside the `EXISTS`, or refuse it with a clear error?
- Order by an aggregate: project it (`(COUNT(…) AS ?n)`, `GROUP BY` the root) and order by `?n`, or
  refuse it?
