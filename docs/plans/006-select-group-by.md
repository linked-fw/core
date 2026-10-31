---
summary: >
  Grouping and aggregation in the select DSL (owner's choice B2): select, then `.groupBy(r => …)`
  over the result fields, returning a narrower GroupedSelectBuilder with having/orderBy/limit/
  offset/from/exec/JSON; Expr.count(), countDistinct/min/max on paths; rides IRSelectQuery with
  optional groupBy/having/requires; stores declare `supports`, so every store fails loudly.
status: Implementation
packages: [core]
---

# 006 — Select `groupBy` (B2)

## Ideation record

The ideation is the proposal written for the owner (CN session, 2026-10-31), rounds 1 and 2. Its
route B2 was approved with these owner decisions:

- Natural order: select first, then group (as SQL). `.groupBy(...)` returns a narrower grouped
  builder; `.for`, `.one`, nested selects and live patching are absent from its type.
- **Keys by result field name** (owner's later decision, replacing accessor keys):
  `.groupBy('type')`, several as `.groupBy('type', 'project')`; `.orderBy('n', 'DESC')`;
  `.having('n', (n) => n.gt(1))`; typed as `keyof R` over the select's top-level fields.
- No new IR kind and no new `IDataset` method. The query rides `IRSelectQuery` with optional
  `groupBy`/`having`/`requires`; stores declare `supports`; every store that does not support a
  feature fails loudly (dispatch check), and an older server fails loudly on the wire (`op`).
- Scope = the proposal's first slice, plus: a failing test for the suspected `size()` fan-out,
  fixed here when small.

Other routes (A per-subject only, C/C2/C3 dedicated builders, D countBy, B3 key markers) are in
the proposal and are not repeated here.

Why the store mechanism is needed (checked in code): a count rides `selectQuery` with its own IR
kind and is loud only through `resolveCount`'s answer check; `SparqlDataset` sends any unknown
kind down its select path; `SelectBuilder.fromJSON` ignores unknown keys (an old server would drop
`groupBy` silently) and `FieldSet.fromJSON` casts every `aggregation` to `'count'`; an unknown
`op` is refused by `fromJSON` (`queries/fromJSON.ts`).

## Architecture decisions

1. **DSL.**
   ```ts
   const byType = await Feedback.select((f) => ({type: f.feedbackType, n: Expr.count()}))
     .where((f) => f.project.equals({id: projectId}))
     .groupBy('type');
   // → Array<{type: string; n: number}>

   const lastRuns = await ProjectionRun.select((r) => ({instance: r.output, last: r.completedAt.max()}))
     .groupBy('instance')
     .orderBy('last', 'DESC');
   // → Array<{instance: {id: string}; last: Date}>

   LinkedDocument.select((d) => ({root: d.lineageRoot, n: Expr.count()}))
     .groupBy('root')
     .having('n', (n) => n.gt(1));
   ```
   - `groupBy(...keys)` takes result field names (`keyof R`). Every non-aggregate field of the select must be a key (SQL's rule): a missing
     one is a type error (the call returns a `GroupByError` type with no builder methods) and a
     runtime error.
   - The grouped select must use the **object form** (`select(f => ({…}))`): aggregates need names.
   - Members filter = `.where` **before** `groupBy`; group filter = `.having` after it. The grouped
     builder has no `where` (one explicit way; settles backlog 012's row-vs-group ambiguity).
   - `orderBy` after `groupBy` takes field names (keys or aggregates), one or an array.
   - `having(field, condition)` takes a field name and a condition on its value; several calls
     are ANDed. An `orderBy` on the select
     before `groupBy` is refused at `groupBy()` (it sorts members, which a grouped query cannot).
   - `limit`/`offset`/`from` set before `groupBy` carry over (they are query-level); the grouped
     builder has them too.
   - `.for(id)`, `.forAll(ids)`? `.forAll(ids)` stays legal (a member filter, VALUES). `.for(id)`
     and `.one()` make the result single, so `groupBy` is not available on that builder type
     (`Result` not an array) and refuses at runtime. Preloads, selectAll and label selections are
     refused at `groupBy()`.
2. **Aggregates.**
   - `Expr.count()`: members of the group, `COUNT(DISTINCT ?root)`. Nullary, so it lives on `Expr`
     (whose charter is "operations with no natural fluent host"), not as a free function.
   - `.countDistinct()` on a single-valued literal path and a single-valued relation
     (`QueryPrimitive` via the expression proxy, `QueryShape`): `COUNT(DISTINCT ?v)`.
   - `.min()` / `.max()` on a single-valued literal path (number/string/date) and on a plural
     literal path (`QueryPrimitiveSet`).
   - A plural path keeps `.size()` (now `COUNT(DISTINCT …)`, see 6); no `countDistinct` on sets
     (one way).
   - All return `AggregateExpression<T>`, an `ExpressionNode` subclass with a phantom value type
     (`number` for counts, the value type for min/max). Its comparison methods (`gt`, …) build
     HAVING conditions.
   - Aggregates are also legal in an ungrouped select: per subject, like `.size()` today (backlog
     006's per-row reading). `Expr.count()` there is 1 per row (harmless; documented).
3. **IR.** `IRSelectQuery` gains `groupBy?: IRExpression[]` (the key projections' expressions),
   `having?: IRExpression`, `requires?: QueryFeature[]`. `IRAggregateExpression` gains
   `distinct?: boolean`. No new kind.
4. **Features.** `QueryFeature = 'groupBy' | 'min' | 'max'` (counting is baseline: every count is
   a distinct count, decision 10) (new module
   `queries/queryFeatures.ts`). One function computes a query's features from its expression
   trees, used by the builder (`requiredFeatures()`, before dispatch, IR-free) and by lowering
   (`IRSelectQuery.requires`). Baseline features (plain selects, `.size()`, aggregate-in-where)
   need nothing, so no existing store breaks.
5. **Stores.** `IDataset.supports?: readonly QueryFeature[]` and `QueryDispatch.supports?` (an
   optional property, not a method or kind). `assertQuerySupported(target, query)` in
   `queryDispatch.ts` refuses a query whose features the target does not declare. Called by
   `SelectBuilder`/`GroupedSelectBuilder` `exec` on the target or the global dispatch, and by
   `LinkedStorage.selectQuery` on the routed dataset. `SparqlDataset.supports` = all features.
   LinkedStorage's installed dispatch declares all features (it checks the routed dataset itself).
6. **`size()` fan-out fix.** `size()` lowers to `COUNT(DISTINCT ?v)` (confirmed: two plural
   `size()`s in one select produce `COUNT(?a0_friends)` and `COUNT(?a0_nickNames)` over the cross
   product). RDF values of one subject/predicate are a set, so DISTINCT is the right count.
7. **Wire (DSL-JSON 1.2).** A select envelope that needs features carries `op: 'select'` and
   `requires: [...]` (an older server throws "Unknown query op"; a newer one refuses an unknown
   `requires` entry). Grouped: `groupBy: [field names]`, `having` (a DSL-JSON condition, the
   where codec), `groupOrderBy: [{field, direction}]`. Aggregates ride `fields` as computed
   fields (`{as, value: ['max', {'@path': …}]}`); `COUNT(DISTINCT)` encodes as head
   `countDistinct`. A plain select without features keeps its op-less envelope (no change).
8. **Lowering (SPARQL).** `selectToAlgebra` with `groupBy`: no root projection, no auto-projected
   traversal aliases, `GROUP BY` = the key variables (explicit, no inference), `HAVING` = `having`
   (and any aggregate `where`, existing path), `ORDER BY` over key variables / aggregate
   expressions, no `DISTINCT`. `resultMapping` maps grouped rows flat (no `id`, no root
   grouping), key relation → `{id}`, unbound → `null`.

## Expected file changes

- `src/queries/queryFeatures.ts` (new): `QueryFeature`, `ALL_QUERY_FEATURES`,
  `featuresOfExpressions()`, `parseRequires()`.
- `src/queries/GroupedSelectBuilder.ts` (new): the grouped builder, field refs (`GroupField`),
  its JSON.
- `src/queries/QueryBuilder.ts`: `groupBy()`, `requiredFeatures()`, `exec` support check, JSON
  `op`/`requires`, `fromJSON` → grouped.
- `src/queries/SelectQuery.ts`: `AggregateExpression` result typing; `countDistinct/min/max` on
  `QueryPrimitiveSet` and `QueryShape`; EXPRESSION_METHODS; `SetSize` count distinct; `SelectQuery`
  interface `requiredFeatures?`.
- `src/expressions/ExpressionNode.ts`: `AggregateExpression`; `countDistinct/min/max` methods.
- `src/expressions/ExpressionMethods.ts`: typed aggregate methods per value type.
- `src/expressions/Expr.ts`: `Expr.count()`.
- `src/queries/IntermediateRepresentation.ts`: `groupBy/having/requires`, `distinct`.
- `src/queries/IRDesugar.ts`, `IRLower.ts`, `IRProjection.ts`: group fields through the pipeline;
  count_step distinct.
- `src/queries/DslJsonExpression.ts`: `countDistinct` head.
- `src/queries/fromJSON.ts`: `op: 'select'`. `wireVersion.ts`: 1.2.
- `src/queries/queryDispatch.ts`: `assertQuerySupported`, `QueryDispatch.supports`.
- `src/interfaces/IDataset.ts`: `supports?`.
- `src/sparql/irToAlgebra.ts`: grouped mode; aggregate `distinct`.
- `src/sparql/resultMapping.ts`: grouped rows.
- `src/sparql/SparqlDataset.ts`: `supports`.
- `src/utils/LinkedStorage.ts`: routed check, dispatch `supports`.
- `src/test-helpers/query-capture-store.ts`: dispatch declares `supports`.
- `src/index.ts`: exports.
- Tests: `src/tests/select-group-by.test.ts` (types, SPARQL, mapping, wire, store refusal, Fuseki
  contract), `src/tests/size-fan-out.test.ts`.
- Docs: README (grouping section, counting), `documentation/dsl-json.md` (if it documents the
  envelope), backlogs 012 / 006 / 020 updated.

## Pitfalls

- `resolveExpressionRefs` resolves a traced ref through `resolveTraversal`, which memoizes on
  (alias, property): the having/orderBy refs reuse the select's ExpressionNodes, so they bind the
  same variables. Key relation paths must lower to the same variable in projection, GROUP BY and
  ORDER BY.
- The aggregate alias collision rename in `selectToAlgebra` (`a1` → `a1_agg`) rewrites the
  resultMap; grouped mapping must read through the resultMap, not the projection alias.
- `irToAlgebra` auto-projects traversal aliases for nesting (7b): in grouped mode they would
  become group keys. Skip them.
- A HAVING over a non-grouped variable is invalid SPARQL; having refs only reach keys and
  aggregates.
- `QueryResponseToResultType` maps any `ExpressionNode` to `boolean`; the aggregate branch must
  come first.
- `count()` is a reserved-sounding name; `Expr.count()` avoids a new reserved proxy name.
- Golden tests that pin `COUNT(?x)` for `size()` change to `COUNT(DISTINCT ?x)`.
- Builders are IR-free (tree-shaking): the builder's feature check walks the ExpressionNode IR
  fragments, never calls `lower()`.

## Contracts

- `SelectBuilder.groupBy<K extends keyof R & string>(...keys: K[])` →
  `GroupedSelectBuilder<S, Row>` or `GroupByError<…>` (type) / throws (runtime).
- `GroupedSelectBuilder`: `having(field, condition)`, `orderBy(field | fields, dir)`, `limit`, `offset`, `from`,
  `exec(target?)`, `then/catch/finally`, `toJSON()`, `toRawInput()`, `requiredFeatures()`,
  `__queryKind = 'select'`, `shape`, `catalog`.
- `IDataset.supports?: readonly QueryFeature[]`; absent = baseline only.
- `assertQuerySupported(target, query)` throws `Error` naming the missing features and the target.
- Wire: `{v: '1.2', op: 'select', requires, …, groupBy?, having?, groupOrderBy?}`.

## Autonomous decisions

| # | Decision | Why |
|---|---|---|
| 1 | Members count is `Expr.count()` | Nullary; `Expr` holds exactly the operations with no fluent host; no new reserved proxy name |
| 2 | No `where` on the grouped builder; members filter before `groupBy`, `having` after | One explicit way; no row-vs-group ambiguity (backlog 012) |
| 3 | Grouped selects require the object form | Aggregates need names; array form names an expression `expr` |
| 4 | `orderBy` before `groupBy` is refused at `groupBy()` | It sorts members; ORDER BY a non-grouped variable is invalid SPARQL |
| 5 | `countDistinct` only on single-valued paths; plural paths use `size()` (now distinct) | One way per path kind |
| 6 | Baseline features (size, aggregate-in-where) need no `supports` | Not breaking existing stores; tagging them is a follow-up |
| 7 | Aggregates allowed in ungrouped selects (per subject) | Same semantics as `size()`; backlog 006's per-row reading for free |
| 8 | Missing-key check is a type-level error type plus a runtime throw | A parameter-level constraint would break inference of the callback |
| 9 | `size()` → `COUNT(DISTINCT)` | Confirmed fan-out; a one-line lowering change |
| 11 | Keys, `orderBy` and `having` name result fields by string (`groupBy('type')`, `orderBy('n', 'DESC')`, `having('n', (n) => n.gt(1))`); the accessor form was dropped | Owner's decision during implementation; `having` takes the field name plus a condition on its value so it stays name-based and typed by the field's value |
| 12 | A node-valued key is typed `{id: string}` in the grouped row | The object form of a plain select types a relation field as the shape (`Person`) while the rows hold `{id}`; the grouped row states what the rows hold. The plain-select gap is a follow-up |
| 13 | A key over a multi-valued path is one of its values (typed as the element) | SPARQL groups each value separately; `count per tag` is a common need |
| 14 | The root can be a key (`{person: p}`), and `FieldSet` JSON now reads the empty path `''` | Count per subject (`perNode`) needs it; the wire form of a root field did not parse before |
| 15 | Unknown field `aggregation` values in JSON throw | Only `count` exists; another value was read as the bare path |
| 10 | Every `count` aggregate lowers to `COUNT(DISTINCT …)`; no `countDistinct` feature and no `distinct` flag in the IR | A count in this DSL is always a count of values or members, which are sets; one rule instead of a flag. `Expr.count()`/`countDistinct()` stay baseline, so a store that counts already handles them |

## Phases

### Phase 1 — Features, store check, wire envelope, size() fix

Tasks:
- `queryFeatures.ts`; `IDataset.supports`; `QueryDispatch.supports`; `assertQuerySupported`;
  `SparqlDataset.supports`; LinkedStorage check + dispatch `supports`; capture store `supports`.
- `IRAggregateExpression.distinct`; irToAlgebra passes it; count_step and `SetSize.toCountExpr`
  set it (fan-out fix); `size-fan-out.test.ts` (SPARQL + Fuseki).
- Wire version 1.2; `fromJSON` accepts `op: 'select'`; `parseRequires` refuses unknown features.

Validation: `npx tsc -p tsconfig-tests.json` clean; fan-out test fails before the fix and passes
after; existing golden tests updated for `COUNT(DISTINCT)`; dispatch unit tests (missing
`supports` → throws naming the features; SparqlDataset passes).

**Done.** Results:
- Fan-out confirmed live before the fix: `size-fan-out.test.ts` on Fuseki gave
  `"friends": 6, "nicks": 6` for a person with 2 friends and 3 nick names (expected 2 and 3).
  After `convertExpression` emits `distinct: true` for every `count`: `Tests: 3 passed` (one live).
- `sparql-select-golden.test.ts`: the five aggregate goldens now pin `COUNT(DISTINCT …)`:
  `Tests: 90 passed, 90 total`.
- `query-features.test.ts`: `Tests: 8 passed, 8 total`. `npx tsc -p tsconfig-tests.json`: clean.
- Full jest on an own Fuseki (`FUSEKI_BASE_URL=http://localhost:3941`) before the golden update:
  `[fuseki] live tests: 423 total — 421 passed, 0 failed, 2 skipped`; the unit failures were the
  five goldens and the suites that need `lib/` (`two-copies-*`, `ontology-load-files`: "lib/esm/
  index.js is missing: run `npx linked build`"), checked again after the build in phase 3.
- Deviation: no `countDistinct` feature, no IR `distinct` flag (decision 10).

### Phase 2 — Aggregates on paths and `Expr.count()` (done, committed with phase 3)

Tasks: `AggregateExpression`; `countDistinct/min/max` on ExpressionNode, `QueryPrimitiveSet`,
`QueryShape`; EXPRESSION_METHODS; typed methods in ExpressionMethods; result typing branch;
`Expr.count()`; DSL-JSON `countDistinct` head; builder `requiredFeatures()` and the exec check;
`op`/`requires` in `toJSON`.

Validation: compile-time type tests (`n: number`, `last: Date`); SPARQL unit tests for per-subject
`max()`/`countDistinct()`; JSON round trip; exec against a dataset without `supports` throws.

### Phase 3 — `groupBy` and the grouped builder (done)

Tasks: `GroupedSelectBuilder` + field refs; `SelectBuilder.groupBy`; raw input → desugar → lower
(`groupBy/having/orderBy/requires`); irToAlgebra grouped mode; result mapping; JSON
(`groupBy/having/groupOrderBy`) + `fromJSON`; guard `orderBy(p => p.x.size())` on an ungrouped
select (throws).

Validation: type tests (row type, missing key → error type, `.for().groupBy` unavailable);
SPARQL golden tests for U1/U3/U8 shapes; mapping unit tests; wire round trip; Fuseki contract
tests (count per type, count + having, max per group sorted, nested-path key, null key group,
`forAll`, `from`); full `npm test` against an own Fuseki; `npx linked build`.

### Phase 4 — Docs

Tasks: README grouping section + counting update; DSL-JSON doc; backlogs 012/006/020 updated.

Validation: docs describe the built API only; links resolve.

Phases 2 and 3 results (implemented and committed together: the aggregate typing was only
testable through grouped selects):
- `select-group-by.test.ts`: `Tests: 38 passed, 38 total`, `[fuseki] live tests: 12 total —
  12 passed` (count per key with a null group, having, max per group sorted, nested-path key,
  multi-valued key, size()/countDistinct() per group, where-then-group with min, two keys, the
  root as key with order and limit, min per row, exec on a SparqlDataset, through LinkedStorage
  including the refusal of a dataset without `supports`).
- `npx linked build`: `✔ Build successful`. Full jest on an own Fuseki:
  `Tests: 122 skipped, 3091 passed, 3213 total`, `[fuseki] live tests: 435 total — 433 passed,
  0 failed, 2 skipped`. `npx tsc -p tsconfig-tests.json` and `npm run check:dts`: clean.
- Found on the way: the instrumented global dispatch dropped `supports` (fixed: it carries the
  wrapped dispatch's `supports`).

Dependencies: 1 → 2 → 3 → 4 (sequential; one agent).
