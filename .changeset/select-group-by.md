---
"@_linked/core": minor
---

Grouped selects: `Shape.select((s) => ({key: s.path, n: Expr.count()})).where(…).groupBy('key')` returns a `GroupedSelectBuilder` with `having(field, condition)`, `orderBy(field | fields, direction)`, `limit`, `offset`, `from`, `exec` and its DSL-JSON form. New aggregates `Expr.count()`, `.countDistinct()`, `.min()`, `.max()` (per group, or per row outside a grouped select). Datasets declare the query features they answer in `IDataset.supports` (`SparqlDataset` declares all); a select that needs an undeclared feature is refused before it is sent. DSL-JSON 1.2: such a select carries `op: 'select'` and `requires`. Every count now lowers to `COUNT(DISTINCT …)`, so two counted paths in one select no longer inflate each other. `orderBy` on a plain select refuses an aggregate, and aggregates are refused as update values.
