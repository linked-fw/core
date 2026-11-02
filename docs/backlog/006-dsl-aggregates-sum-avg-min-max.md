---
summary: >
  Expose sum/avg on the query DSL. min/max, countDistinct, Expr.count() and grouping are done
  (report 096); sum and avg remain, and need an answer to the fan-out of joined plural paths.
  Absorbs the former backlog 016 (aggregations).
packages: [core]
---

# DSL aggregates: sum / avg

## Done in report 096

Grouped selects (`select(…).groupBy('key')`), `Expr.count()`, `.countDistinct()`, `.min()`,
`.max()` on literal paths (per group, or per row outside a grouped select), and every count
lowered to `COUNT(DISTINCT …)`. The placement question is answered: methods on paths, plus
`Expr.count()` for the members of a group. min/max are typed by the value (`Date` stays `Date`).

## What remains: sum and avg

`SUM`/`AVG` over a path joined with another plural path in the same select are inflated by the
cross product, and `DISTINCT` does not fix a sum (two equal values are both counted). Options: one
sub-select per aggregated path, or refuse a sum next to another plural path. Then
`.sum()`/`.avg()` beside `min`/`max` in `AggregateMethods` (numeric only), the `'sum'`/`'avg'`
query features, and their result types (`avg` of integers is a decimal).

## What existed before report 096

- The IR's `IRAggregateExpression` names `count | sum | avg | min | max`
  (`src/queries/IntermediateRepresentation.ts:295`); `irToAlgebra` and `algebraToString` lower
  and serialize any of them, and infer `GROUP BY` from the non-aggregate projections.
- The DSL-JSON decoder already accepts all five as expression heads
  (`src/queries/DslJsonExpression.ts:275`), so a wire query can ask for a sum the DSL cannot.
- The DSL reaches count only: `QueryShapeSet.size()` / `QueryPrimitiveSet.size()` return a
  `SetSize` (`src/queries/SelectQuery.ts:1070`, `:1456`, `:1464`), and
  `FieldSetEntry.aggregation` is typed `'count'` (`src/queries/FieldSet.ts:73`, set at `:928`).

Settled elsewhere, so not part of this item:

- `.count()` vs `.size()`: `.count()` is the match count of a whole query, `.size()` a property's
  value count per row (README §Counting; report 030). No alias.
- Explicit `.groupBy()` and HAVING-style aggregate filters: done (report 096; backlog 012 closed).
- `COUNT(DISTINCT …)` and other DISTINCT aggregates: backlog 020.

## Sketch

1. Add `.sum()/.avg()/.min()/.max()` beside `size()` in `src/queries/SelectQuery.ts`,
   generalizing `SetSize` into an aggregate marker that carries its name.
2. Widen `FieldSetEntry.aggregation` to the five names (`src/queries/FieldSet.ts:73`) and set it
   from the marker in `convertTraceResult` (`:928`).
3. Generalize `DesugaredCountStep` (`src/queries/IRDesugar.ts:54`) into an aggregate step that
   carries the name; the projection (`src/queries/IRProjection.ts:99`) is already generic.

## Open questions

- **Placement.** Methods on collections (`p.friends.age.avg()`), standalone functions
  (`Expr.avg(p.friends.age)`), or both?
- **Scope.** Per row over a multi-valued path (`p.friends.age.avg()`, one value per person) is
  the `size()` shape. What does a single-valued property mean (`p.age.avg()`: across every
  matching person, one number for the query, like `.count()`)?
- **Operand types and result types.** Numeric only for `sum`/`avg`? `min`/`max` over dates, and
  strings? What type does each infer (`avg` of integers is a decimal; `min` of dates is a date)?
- **More SPARQL aggregates.** `GROUP_CONCAT` and `SAMPLE` exist in SPARQL; in scope or not?

## Tests to add with it

Exact-result store-contract tests for `sum/avg/min/max` over `Metric.scores`, the multi-valued
decimal field in `src/test-helpers/query-fixtures.ts`.
