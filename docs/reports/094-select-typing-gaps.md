---
date: 2026-10-30
summary: >
  Three select gaps found while Create Now replaced raw SPARQL (CN backlog 091): a multi-valued
  literal in an array select was typed as the whole row; the expression methods of a query path
  (`isDefined()`, `strlen()`, …) ran but were not in its type, and a relation had no
  `isDefined()`; a relation projected bare next to a `where` that traverses it returned `null`.
  All three fixed. Minor. Closes backlog 082; backlog 086 new.
packages: [core]
---

# 094 — Select typing gaps

## PR

### Summary

Each gap was reproduced first: gaps 1 and 2 with `tsc`, gap 3 against Fuseki.

| Gap | Verdict | Fix |
|---|---|---|
| 1. `select((c) => [c.languages])`, `string[]` with no maxCount | Real type bug. The rows held arrays, but the row was typed `string[]` (TS2339 `Property 'nickNames' does not exist on type 'string[] & {name: string} & {id: string}'`) | The `QueryPrimitiveSet` branch of `GetQueryObjectResultType` passes the array flag and `HasName` through, like the `QueryPrimitive` branch does. The field is now `string[]` |
| 2. `p.hobby.isDefined()` in `.where()` | Real type gap. The path proxy answers every expression method, but `QueryPrimitive` declared none of them. A relation had no `isDefined()` at runtime either | `ToQueryPrimitive` is intersected with the `*ExpressionMethods` interface of the value type. `QueryShape` gets `isDefined()`/`isNotDefined()` |
| 3. `select((u) => [u.ofKey])` returned `null` | Real runtime bug, and only next to a `where` that traverses the same relation. Bare, it returned `{id}`. `irToAlgebra` projected the traverse variable (`?a1`) while `resultMapping` read `?a0_ofKey` | `resultMapping` reads the traverse variable for a property the query traverses. The type (`{id: string}`) was already right |

### Changes

- `src/queries/SelectQuery.ts`:
  - The `QueryPrimitiveSet` result type is fixed.
  - `ToQueryPrimitive` adds the `String`/`Numeric`/`Date`/`BooleanExpressionMethods` of the
    value type.
  - `QueryShape.isDefined()` and `QueryShape.isNotDefined()` are new.
  - The inline primitive `where` (`p.hobby.where((h) => h.equals(…))`) is now typed
    `InlinePrimitiveWhere`, because its proxy answers `equals` only. Without that it would have
    picked up the new methods too.
- `src/expressions/ExpressionMethods.ts`: `BaseExpressionMethods` adds `lang`, `datatype`, `iri`,
  `isIri`, `isLiteral`, `isBlank`, `isNumeric`, `md5`, `sha256` and `sha512`. These were in the
  proxy's method list and on `ExpressionNode`, but not in the type.
- `src/queries/reservedQueryNames.ts`: `isDefined` and `isNotDefined` are added to the reserved
  names.
- `src/sparql/resultMapping.ts`: `collectTraverseVars` collects (from, property) → target at any
  depth (join, optional, union, exists), the same bindings the registry in `irToAlgebra` makes.
  `sparqlVarName` uses them.
- `src/tests/select-result-typing.test.ts` (new):
  - compile-time exact-type checks (gap 1, and the `{id}` type for gap 3);
  - SPARQL unit checks for `isDefined`/`isNotDefined` on a literal and on a relation, `lang()`
    and `strlen().gt()`;
  - a mapping unit check for gap 3;
  - four `[fuseki]` live tests (all three gaps).
- `README.md`: one paragraph saying which expression methods a literal path and a relation path
  have.
- `docs/backlog/082-…` is removed, because this report does its first question. Its second
  question moves to the new backlog 086.
- `.changeset/select-typing-gaps.md`: minor. Paths and relations have new typed methods.

### Verification

- `npx tsc -p tsconfig-tests.json`: `TYPECHECK-OK` (no errors). `npx tsc -p
  tsconfig-dts-check.json`: `DTS-OK`. To show that the gap 1 check catches the bug, the old
  branch was put back for one run: `select-result-typing.test.ts:53:27 - error TS2339: Property
  'nickNames' does not exist on type 'string[] & { name: string; } & { id: string; }'`.
- `npx linked build`: `✔ Build successful`.
- The new suite: `Tests: 11 passed` and `[fuseki] live tests: 4 total — 4 passed`. With the
  neighbouring suites: `PASS dsl-property-name-collisions`, `PASS expression-types`, `PASS
  sparql-fuseki`, `Tests: 135 passed, 135 total`.
- Full jest against CN's Fuseki on :3030, in `linked-core-test-*` datasets: `Tests: 24 failed,
  122 skipped, 3013 passed, 3159 total`.
  - Three suites fail on dev without this change too: `shape-graphs-fuseki`,
    `inference-features-fuseki` and `sparql-fuseki-shape-sync`. Their error is `Loading SHACL test
    data failed: 405 Method Not Allowed`, because :3030 is not the SHACL-enabled test image.
  - The two others failed only under the full parallel run: `graph-query-fuseki` (the
    concurrent-create race tests) and `ontology-sync-fuseki`. Run alone: `PASS
    ontology-sync-fuseki`, `PASS graph-query-fuseki`, `Tests: 2 skipped, 22 passed`.
  - The baseline comparison: the seven failing files of the first full run, run on the stashed
    tree and on the changed tree, gave the same `Tests: 58 failed, 43 passed, 101 total`. After
    `npx linked build`, the three build-dependent ones (`two-copies-*`, `ontology-load-files`)
    passed with `54 passed`.
- Create Now against this build: `tsc` on CN's `tsconfig.typecheck.json`, with `@_linked/core`
  mapped to this worktree's `lib/`, gives 0 errors. A probe file compiles too. It selects
  `CapabilityAppConfig` `[c.languages, …]` and checks the field is exactly `string[]`; it runs
  `TranslationKey.select(…).where((k) => k.ofShape.isDefined())`; and it selects
  `TranslationUnit [u.language, u.ofKey]` and reads `units[0].ofKey.id`.

### Deviations

- `node_modules` in the worktree links to CN's root `node_modules`, not to core's own. Core's own
  holds only `@jest`/`@types`, so jest could not find the `ts-jest` preset. No dual-copy type
  errors came up.
- More than the brief asked: the RDF-introspection and hash methods are now typed too. They are
  the rest of the same mismatch, between the proxy's method list and the type.

### Follow-ups

- An `@objectProperty` with a `string` accessor (`TranslationKey.ofShape`) is typed with every
  string method, but at runtime it is a relation, so `k.ofShape.strlen()` compiles and throws.
  Also, `ExpressionInput` does not take a query path. Both are in core backlog 086.
- Create Now can drop its workarounds once this is released (listed below). The home for this
  is CN backlog 091, "What core needs" item 6, which the master updates.

## Details

### Create Now call sites that can drop a workaround

| File | Today | With this release |
|---|---|---|
| `src/utils/capabilityAppConfig.ts` `readCapabilityAppConfig` | `const rows: unknown = …`, then `rows as ReadonlyArray<Record<string, unknown>>` | `const rows = await CapabilityAppConfig.select(…)`; `row.languages`, `row.reviewedOnlyLanguages` and `row.mtFormality` are `string[]` |
| `src/services/translation/TranslationOverviewService.ts` `shapeReach` (T1, line ~179) | reads every key, drops the ones without a shape in code | `.where((k) => k.ofShape.isDefined())` |
| same file, `shapeTranslationDetail` (line ~210) | `u.ofKey.select((k) => [k.key])` | `u.ofKey` (returns `{id}`) |
| same file, the stale-marking update (report 335, "Units without a `state`") | marks every unit, since `isDefined()` could not be typed | `.where((u) => u.ofKey.oneOf(ids).and(u.state.isDefined()))` if the old rule is wanted |
| `src/backend/shapes/projectPackages.ts` lines 60, 154, 195 | `rows: unknown` | check each one: line 154 is a typed select and may only need the `unknown` dropped; 60 and 195 go through `as any` shapes |

### Why the result-type rule for multi-valued literals was safe to change

The old branch only fired for the array form (`[p.nickNames]`), where it typed the whole row as
`string[]`. No typed caller can have used that row as anything else: indexing it by field
fails, and a caller that treats it as an array would read rows as strings. The keyed form
(`{n: p.nickNames}`) was already `string[]` and is unchanged. Core, and CN against this build,
typecheck with no new errors.
