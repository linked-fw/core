---
summary: Expose sum/avg/min/max aggregates on the query DSL (IR + SPARQL already support them); count is the only one reachable today.
---

# DSL aggregates: sum / avg / min / max

## Context

`.size()`/`.count()` on a collection is the only aggregate reachable from the
DSL. The IR (`IRAggregateExpression`, `name: 'count' | 'sum' | 'avg' | 'min' |
'max'`) and the SPARQL serializer already handle all five generically — the gap
is purely the DSL surface and the lowering that hardcodes `aggregation: 'count'`.

Deferred out of the linked-query test-coverage effort (plan 001) because adding
a DSL surface is feature work, not test coverage. Pick up as its own workflow
cycle; the coverage tests for these land with the implementation.

**Also the home for the general aggregate review** raised by the GraphQL-style
selection proposal ([idea 025](../ideas/025-graphql-style-nested-selection.md)).
That proposal folds `$count` into its v1 object form because `.size()` already
works, but explicitly leaves the rest of the aggregate story to this node: when
`sum`/`avg`/`min`/`max` (and any `groupBy`, [idea 016](../ideas/016-aggregations.md))
land, decide how they surface in the `Shape.select({...})` object form too — a
`$sum`/`$avg`/… option per aggregate, or a single `$agg` option naming the
function. Keep the object-form surface consistent with the chainable one.

## Sketch (≈5 edits)

1. Add `.sum()/.avg()/.min()/.max()` to `QueryShapeSet` / numeric
   `QueryPrimitive` (mirror `SetSize`), returning `SetSum`/`SetAvg`/… markers
   — `src/queries/SelectQuery.ts`.
2. Widen `FieldSetEntry.aggregation` from `'count'` to
   `'count' | 'sum' | 'avg' | 'min' | 'max'` — `src/queries/FieldSet.ts:55`.
3. Detect the new markers in `convertTraceResult` and set the aggregation name
   — `src/queries/FieldSet.ts:~646`.
4. Generalize `DesugaredCountStep` → aggregate step carrying `name`
   — `src/queries/IRDesugar.ts`.
5. Pass the name through projection (already generic) —
   `src/queries/IRProjection.ts:~97`.

## Open questions

- Numeric-only constraint + return-type inference for each aggregate.
- `min`/`max` over dates (and strings?) — define supported operand types.
- Interaction with GROUP BY scoping already used by `count`.

## Tests to add when implemented

- Exact-result E2E (store contract) for `sum/avg/min/max` over a multi-valued
  numeric field on the `Metric` shape (plan 001 seeds this field).
