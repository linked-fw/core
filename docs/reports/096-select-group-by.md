---
date: 2026-10-31
summary: >
  Grouped selects (route B2 of the grouping proposal): select, then `.groupBy('key')` returns a
  GroupedSelectBuilder with having/orderBy/limit/offset/from/exec/JSON; aggregates Expr.count(),
  countDistinct(), min(), max(); datasets declare `supports` and a select needing an undeclared
  feature is refused before it is sent; DSL-JSON 1.2 (`op: 'select'`, `requires`); every count is
  COUNT(DISTINCT), fixing the size() fan-out. Minor. Closes backlog 012; narrows 006; new 087, 088.
packages: [core]
---

# 096 — Select groupBy

## PR

### Summary

Grouping and aggregation in the select DSL, in the order SQL uses:

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

- `groupBy(...keys)` names result fields (`keyof R`); every non-aggregate field must be a key
  (type error and runtime error). It returns a `GroupedSelectBuilder`, whose type has `having`,
  `orderBy`, `limit`, `offset`, `from`, `exec` and the wire form, and no `where`, `.for`,
  `.one`, nested selects or live patching.
- Aggregates: `Expr.count()` (group members, `COUNT(DISTINCT ?member)`), `.countDistinct()` on
  single-valued paths, `.size()` on multi-valued ones, `.min()`/`.max()` on literal paths, typed
  by value. Outside a grouped select they are per row, like `.size()`.
- No new IR kind and no new `IDataset` method: the query is an `IRSelectQuery` with optional
  `groupBy`, `having` and `requires`. A dataset lists the features it answers in
  `IDataset.supports` (`'groupBy'`, `'min'`, `'max'`); `assertQuerySupported` refuses a select,
  count or ask that needs an undeclared feature before it is sent (in `exec`, `LinkedStorage`,
  `resolveCount`, `resolveExistence`). `SparqlDataset` declares all of them.
- DSL-JSON 1.2: a select that needs a feature carries `op: 'select'` and `requires`; a reader
  that predates them refuses the envelope through `fromJSON`, and a current reader refuses an
  unknown `requires` entry. Plain envelopes are unchanged apart from `v`.
- `size()` fan-out fixed: every count lowers to `COUNT(DISTINCT …)`. Before, a person with 2
  friends and 3 nick names got `friends: 6, nicks: 6` live on Fuseki.
- `orderBy` on a plain select refuses an aggregate (it used to sort by the counted path's
  values); aggregates are refused as update values.

### Changes

- New: `src/queries/queryFeatures.ts` (features, `featuresOfExpressions`, `parseRequires`),
  `src/queries/GroupedSelectBuilder.ts` (builder, `GroupField`, `assertGroupable`, row types).
- `src/queries/QueryBuilder.ts`: `groupBy`, `expressionTrees`, `whereExpression`,
  `requiredFeatures`, feature check in `exec`, `op`/`requires` in `toJSON`, grouped `fromJSON`.
- `src/expressions/ExpressionNode.ts`: `AggregateExpression`, `countDistinct/min/max`, numeric
  aggregate arithmetic. `ExpressionMethods.ts`: `AggregateMethods`. `Expr.ts`: `Expr.count()`.
- `src/queries/SelectQuery.ts`: aggregate result typing, `countDistinct` on relations, `min/max`
  on literal sets, `orderBy` guard, `SelectQuery.requiredFeatures?`.
- IR and pipeline: `IntermediateRepresentation.ts` (`groupBy`, `having`, `requires`),
  `IRDesugar.ts`, `IRLower.ts`; `IRMutation.ts` (aggregate update values refused).
- SPARQL: `irToAlgebra.ts` (grouped mode: no root, explicit GROUP BY, HAVING, optional aggregate
  paths, ORDER BY over projections; counts DISTINCT), `resultMapping.ts` (grouped rows),
  `SparqlDataset.ts` (`supports`).
- Stores and dispatch: `IDataset.supports`, `QueryDispatch.supports`, `assertQuerySupported`,
  checks in `LinkedStorage`, counts and asks (`CountBuilder`, `AskBuilder`).
- Wire: `wireVersion.ts` (1.2), `fromJSON.ts` (`op: 'select'`), `FieldSet.ts` (root field `''`
  parses; unknown field `aggregation` refused).
- `reservedQueryNames.ts`: `countDistinct`. `index.ts`: exports.
- Tests: `select-group-by.test.ts` (new), `query-features.test.ts` (new), `size-fan-out.test.ts`
  (new), `sparql-select-golden.test.ts` (five goldens now pin `COUNT(DISTINCT …)`).
- Docs: README (Grouping and aggregates), `documentation/dsl-json.md`,
  `documentation/intermediate-representation.md`; backlogs 012 removed, 006/020/079 updated, 087
  and 088 new. Changeset: minor.

### Verification

- `size-fan-out.test.ts` without the fix, live: `"friends": 6, "nicks": 6` where 2 and 3 were
  expected; with it: `Tests: 3 passed`.
- `select-group-by.test.ts` + `query-features.test.ts`: `Tests: 59 passed, 59 total`,
  `[fuseki] live tests: 14 total — 14 passed, 0 failed, 0 skipped`.
- `npx linked build`: `✔ Build successful`. Full jest against an own Fuseki
  (`FUSEKI_BASE_URL=http://localhost:3941`, started by global setup):
  `Tests: 122 skipped, 3104 passed, 3226 total`, `[fuseki] live tests: 437 total — 435 passed,
  0 failed, 2 skipped`. `npx tsc -p tsconfig-tests.json` and `npm run check:dts`: clean.
- Two independent review rounds (below): 3 high and 6 medium findings in the first, all fixed;
  2 medium typing findings in the second, fixed; the rest low and recorded.

### Deviations

- Keys, `orderBy` and `having` by field name (the owner's later decision), not accessors;
  `having` takes a field name and a condition on its value.
- No `countDistinct` feature and no IR `distinct` flag: every count is distinct (decision 10).
- The plan's "tag the baseline" (aggregate in where) is not done: it would break stores written
  before features (backlog 087).
- A node-valued key is typed `{id: string}`, unlike the object form of a plain select (backlog
  088).

### Follow-ups

- `RemoteDataset` (@_linked/server) declares no `supports`, so grouped selects through it are
  refused; tagging the baseline; computed `orderBy` silently ignored: backlog 087.
- Relation field typed as the shape in the object form of select: backlog 088.
- `sum`/`avg` (fan-out of joined plural paths): backlog 006.
- A pre-1.2 envelope with a `["max", …]` field is now refused by a custom dataset without
  `supports`; `sum`/`avg` heads decoded from DSL-JSON are not tagged: backlog 006.
- Low typing gaps: keys and `min`/`max` typed non-null (the unbound group is `null`);
  `groupBy()` with no keys types as a builder (throws); `Expr.count().str()`/`defaultTo()` on an
  aggregate are type errors while the runtime accepts them: backlog 087.

## Details

### Decisions

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

### First review

Independent review (a separate agent, given the diff and the plan, not this agent's conclusions).
Findings, by severity:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R1 | high | An aggregate in `where` became part of the group HAVING (filters groups, not members) silently | Fixed: refused at `groupBy`, at `fromJSON`, and in grouped lowering |
| R2 | high | An aggregate over a nested path made its traversal required, dropping members from their group (`n` undercounted) | Fixed: in grouped mode the paths an aggregate reads are OPTIONAL |
| R3 | high | `countDistinct/min/max` on any `ExpressionNode` reached update expressions (invalid SPARQL) | Fixed: an aggregate update value throws in mutation lowering |
| R4 | medium | A field mixing an aggregate and a member's value (`count() + strlen(name)`) passed as an aggregate (invalid SPARQL) | Fixed: refused by `assertGroupable` |
| R5 | medium | The subject as a key was typed `QResult<…>`, runtime `{id}` | Fixed: a node key (relation or subject) types as `{id: string}` from the select's own field type |
| R6 | medium | `Expr.count().plus(1)` accepted at runtime, a type error ("missing: n") | Fixed: arithmetic on `AggregateExpression` returns `AggregateExpression<number>` |
| R7 | medium | `orderBy` on a nested key made its path required, dropping the null group | Fixed: a grouped ORDER BY does not make paths required |
| R8 | medium | A grouped envelope with `sortBy`/`subject`/`one` was accepted (dropped or mis-shaped); dsl-json.md over-claimed that every older reader refuses | Fixed: refused in `fromJSON`; doc states that only readers going through `fromJSON` refuse |
| R9 | medium | `count()`, `exists()` and the ask-by-select fallback skipped the feature check | Fixed: `CountBuilder`/`AskBuilder` have `requiredFeatures`; `resolveCount`, `resolveExistence` and `existenceBySelect` check |
| R10 | low | A pre-1.2 envelope with `["max", …]` is now refused by custom datasets without `supports`; `sum`/`avg` heads are untagged | Recorded in the report (deviation / follow-up 006) |
| R11 | low | `groupBy()` with no keys types as a builder (throws at runtime); keys and min/max are typed non-null | Recorded (follow-up) |
| R12 | low | Two fields over one path emitted a duplicate variable | Fixed: projected and grouped once |
| R13 | low | `resultMap` mutated in place for alias renames (pre-existing) | No change; grouped mapping reads the renamed aliases |
| R14 | low | Stale examples in `Expr.ts`/`ExpressionNode.ts` (accessor form), README alias `?a1` | Fixed |

### Second review

All first-round fixes confirmed by probes; no regressions found (required paths of where filters,
update expressions, plain counts and asks on a store without `supports`, plain select SPARQL).
New:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| N1 | medium | Arithmetic on any aggregate typed `number` (`birthDate.max().plus(1)`, which SPARQL leaves unbound) | Fixed: the overrides are on `AggregateExpression<number>` only (`this` parameter) |
| N2 | medium | The overrides took any operand, so `count().plus(p.birthDate.year())` typed as valid but is refused at runtime | Fixed: operand typed `number \| AggregateExpression<number>` |
| N3 | low | `count().str()`/`defaultTo()` rejected by the type, accepted at runtime | Recorded (087) |
| N4 | low | An aggregate chained to a `some`/`every` quantifier in where passed `groupBy` | Fixed: `whereExpression()` returns the quantifier's predicate and chain |
