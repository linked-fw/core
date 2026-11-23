---
summary: A select sorts by several keys, each in its own direction, with `SelectBuilder.thenBy(fn, direction)`; `orderBy` still replaces the whole sort. DSL-JSON 1.11 marks senders that mix directions in `sortBy` (the entry forms are unchanged). Backlog 019 closed; grouped and nested-select per-key directions moved to backlog 109.
packages: [core]
---

# 116 — Multi-key sorting: `thenBy`

## PR

### Summary

`Person.select(…).orderBy((p) => p.birthDate, 'DESC').thenBy((p) => p.name)` now sorts by
birth date descending, then by name ascending. `thenBy(fn, direction = 'ASC')` adds one key per
call after the sort so far. Each key keeps the single-key rules: missing values last, a
multi-valued path sorted by its first value in that key's direction (MIN for ascending, MAX for
descending on a page), aggregates refused, and the subject IRI as the last tie-break on a page.
`orderBy` keeps its meaning: it replaces the whole sort, `thenBy` keys included, and its array
form still uses one direction for all its keys. `thenBy` without a preceding `orderBy` throws.
The IR, algebra and SPARQL layers already took a direction per key, so the change is in the
builder only (plan 006, decision 5; backlog 019).

### Changes

- `src/queries/QueryBuilder.ts`: `thenBy()`; a `thenByKeys` list in the builder state;
  `_evaluateSort()` builds the keys (the `orderBy` callback or the sort restored from DSL-JSON,
  then each `thenBy` key) for both `toJSON()` and `toRawInput()`. `orderBy()` now also clears a
  restored `_sortBy` and the `thenBy` keys. Removed the dead `sortDirection` restore in
  `selectFromJSON`.
- `src/queries/SelectQuery.ts`: `evaluateSortCallback(…, method)` names `orderBy()` or
  `thenBy()` in its errors and refuses an array from a `thenBy` callback.
- `src/queries/wireVersion.ts`: DSL-JSON 1.11.
- Docs: README "Sorting, limiting, one" (example and rules); `documentation/dsl-json.md`
  (versioning line, a multi-key `sortBy` example, how `fromJSON` + `thenBy` combine).
- Tests: new `src/tests/select-then-by.test.ts` (19 tests); a compile-only typing case in
  `src/tests/query-builder.types.test.ts`. The current-version checks in
  `select-node-type.test.ts` and `read-query.test.ts` now check a lower bound (≥ 1.6, ≥ 1.10)
  instead of the exact `'1.10'`, so the next minor bump does not break them.
- `.changeset/select-then-by.md` (minor). Backlog 019 removed; backlog 109 added.

### Verification

Typecheck, after rebasing onto `ccr-88cd3a37-okakn0` (S6 landed first):

```
$ time npx tsc -p tsconfig-tests.json --noEmit
real	0m10.153s          (no diagnostics)
```

New tests and the existing sort, paging, serialization and DSL-JSON specs, after the rebase:

```
$ time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs \
    src/tests/select-then-by.test.ts src/tests/sparql-select-golden.test.ts src/tests/ir-select-golden.test.ts \
    src/tests/serialization.test.ts src/tests/query-builder.test.ts src/tests/select-order-missing-last.test.ts \
    src/tests/select-sort-and-leaf-edges.test.ts src/tests/select-subject-paging.test.ts src/tests/sort-and-aggregate.test.ts \
    src/tests/sort-filter-depth-and-quantifier-casts.test.ts src/tests/select-node-type.test.ts src/tests/read-query.test.ts \
    src/tests/select-group-by.test.ts src/tests/ir-desugar.test.ts src/tests/count-wire.test.ts src/tests/ask-wire.test.ts \
    src/tests/subject-order-and-cursor.test.ts src/tests/query-builder.types.test.ts src/tests/sparql-serialization.test.ts \
    src/tests/dsl-json-spec.test.ts src/tests/triples-read.test.ts
Test Suites: 1 skipped, 20 passed, 20 of 21 total
Tests:       88 skipped, 721 passed, 809 total
real	0m28.790s
```

The skipped suite is `query-builder.types.test.ts` (`describe.skip`, compile-only: the typecheck
covers it). The skipped tests are the `[fuseki]` live blocks (no Docker here).

Two keys, mixed directions, paged, run against oxigraph (npm `oxigraph`, installed in a scratch
directory outside the repo) on six hand-written persons: p1 Chess {Z, B}, p2 Chess {A},
p3 Archery {C}, p4 Chess {}, p5 no hobby {A}, p6 Chess {A, Q}. Query:
`Person.select((p) => [p.name, p.hobby, p.nickNames]).orderBy((p) => p.hobby, 'DESC').thenBy((p) => p.nickNames)`.
Expected order: Chess before Archery before no hobby; within Chess by lowest nick name, missing
last; the p2/p6 tie (both `A`) broken by IRI: p2 p6 p1 p4 p3 p5. Subjects in result order:

```
page           p6 p1                  (.limit(2).offset(1))
pageAll        p2 p6 p1 p4 p3 p5      (.limit(10))
unpaged        p6 p2 p1 p6 p1 p4 p3 p5   (rows; first appearance p6 p2 p1 p4 p3 p5)
roundTripPage  p6 p1                  (toJSON → JSON text → fromJSON, then .limit(2).offset(1))
```

Unpaged rows are one per value and are not tie-broken by IRI (as for one key: the tie-break is a
paging rule), so p6/p2 come in the store's order there.

### Deviations

- **The wire form needed no change.** Every `sortBy` entry has carried its own direction since
  report 024 (G9), and `deserializeSortByPath`/IR lowering already kept it per key. As decision 5
  asks, the minor version is still bumped (1.11) to mark senders that mix directions; readers of
  any earlier 1.x already sort each key in its own direction.
- `thenBy` refuses an array from its callback (decision 5: "appending one key per call"); see
  the decision ledger, row 1.
- Two existing tests pinned the exact wire version `'1.10'`; they now check a lower bound.

### Follow-ups

- Per-key directions for the grouped builder's `orderBy` and a nested select's `.orderBy()`:
  backlog `docs/backlog/109-per-key-direction-grouped-and-nested-order.md`.

## Details

### How it works

The builder keeps the `orderBy` sort as before (`_sortByFn` + `_sortDirection`, or `_sortBy` when
restored from DSL-JSON) and adds `_thenByKeys: {fn, direction}[]`. Callbacks stay lazy, as for
`orderBy`: `_evaluateSort()` runs the `orderBy` callback (or takes the restored `_sortBy`), then
each `thenBy` callback through `evaluateSortCallback(shape, fn, direction, 'thenBy')`, and
concatenates the keys and their directions into one `SortByPath {keys, directions}`. Everything
below the builder already handled a direction per key:

- `IRDesugar.toSortBy` copies `directions` into `DesugaredSortBy`;
- `IRLower` gives each `IROrderByItem` its own direction;
- `irToAlgebra`: unpaged, `orderWithBoundFirst` puts `DESC(BOUND(?k))` before every key; on a
  page, `pageBySubject` aggregates each key per subject with `MAX` (DESC) or `MIN` (ASC), each
  preceded by its bound-first key, then `ASC(?a0)`;
- `algebraToString` writes `ORDER BY` from the list.

So a two-key mixed page is (golden in `select-then-by.test.ts`):

```
SELECT ?a0 (MAX(?a0_hobby) AS ?page_order_0) (MIN(?a0_nickNames) AS ?page_order_1) WHERE { … }
GROUP BY ?a0 ORDER BY DESC(BOUND(?page_order_0)) DESC(?page_order_0)
                      DESC(BOUND(?page_order_1)) ASC(?page_order_1) ASC(?a0) LIMIT 2 OFFSET 1
```

### Rules and interactions

| Case | Behaviour |
|---|---|
| `thenBy` with no sort | throws at the call (`call orderBy() first`) |
| `orderBy` after `thenBy` | replaces the whole sort, `thenBy` keys dropped |
| `orderBy(p => [a, b], dir).thenBy(c)` | keys a, b in `dir`, then c in its own |
| `thenBy(p => [a, b])` | refused at evaluation (`thenBy() adds one sort key`) |
| aggregate in `thenBy` (`p.friends.size()`) | refused, message names `thenBy()` |
| computed expression (`p.name.strlen()`) | allowed; bound to `?order_<i>` when unpaged |
| `.one()` | keeps every key, `LIMIT 1` |
| `count()` / `exists()` | drop the whole sort (their builders cannot hold one) |
| `groupBy` after `thenBy` | refused, as after `orderBy` |
| `SelectBuilder.from(iri)`, `select(FieldSet)` | same SPARQL as the callback form (tested) |
| `fromJSON` then `thenBy` | appends to the restored keys |
| `fromJSON` then `orderBy` | replaces the restored keys |

Errors from a `thenBy` callback surface where `orderBy` errors do: when the query is lowered or
serialized, not at the call. Only the missing-`orderBy` check runs at the call, since it needs
no proxy evaluation.

### DSL-JSON

`sortBy` is an ordered array; each entry carries its own direction (`{path: dir}`,
`{path: {direction, where, whereIndex}}` or `{value, direction}`). `thenBy` only makes mixed
directions reachable from the DSL. Version 1.11 is recorded in `src/queries/wireVersion.ts` and
`documentation/dsl-json.md`, with an example. Contract C2 holds: `toJSON → fromJSON` gives
identical SPARQL and an identical envelope (test "toJSON → fromJSON → identical SPARQL"), and
a 1.7 envelope with lowercase `desc` still parses with per-key directions.

### Typing

`thenBy<OR>(fn: QueryBuildFn<S, OR>, direction: 'ASC' | 'DESC' = 'ASC'): SelectBuilder<S, R, Result>`
is the same signature and return type as `orderBy`, so the result type and `.one()` unwrapping
carry through (compile-only case in `query-builder.types.test.ts`, with a `@ts-expect-error` for a
direction other than `'ASC' | 'DESC'`).

### Files

- `src/queries/QueryBuilder.ts`: `ThenByKey`, `thenByKeys` state, `orderBy` (clears),
  `thenBy`, `_evaluateSort`, `toJSON`/`_buildDirectRawInput` use it, `selectFromJSON` restore.
- `src/queries/SelectQuery.ts`: `evaluateSortCallback` `method` parameter,
  `aggregateSortRefusal(method)`, `sortKeyOf(…, method)`.
- `src/queries/wireVersion.ts`: `WIRE_VERSION = '1.11'` and its history line.
- `src/tests/select-then-by.test.ts`: builder rules (13), SPARQL goldens (2: unpaged mixed,
  paged two keys MAX/MIN + IRI tie-break), DSL-JSON (4: per-key array, round trip, old envelope,
  `fromJSON` + `thenBy`/`orderBy`).
- `README.md`, `documentation/dsl-json.md`, `.changeset/select-then-by.md`.

### Out of scope

- The grouped builder (`GroupedSelectBuilder.orderBy`) and a nested select's
  `FieldSet.orderBy`: both still take one direction for all keys, though their IR and wire carry
  one per key. Backlog 109.
- The in-memory dataset still refuses every sort (`InMemoryDataset`, `'sorting'`), one key or
  many.
- No live Fuseki run here (no Docker); oxigraph checked the generated SPARQL instead. CI runs the
  `[fuseki]` blocks; none were added, since the lowering below the builder did not change.

### Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| 1 | implementation, `thenBy` callback | Decision 5 says "one key per call"; the shared `evaluateSortCallback` accepts arrays | Refuse an array from `thenBy` with a message pointing at chaining | Accept an array, all keys in the `thenBy` direction | Matches the decision's wording; one way to add a key with its own direction; the array form already exists on `orderBy` (maintainability) |
| 2 | implementation, wire version | The wire already carried per-key directions, so nothing in the form changed | Bump to 1.11 anyway, documented as "a sender may mix directions" | Leave 1.10 and report the decision as moot | Decision 5 asks for the bump; a minor bump is harmless and readable (backward compatibility) |
| 3 | implementation, `orderBy` | `orderBy` after `fromJSON` kept the restored `_sortBy` underneath (unused, as the callback wins) | `orderBy` clears `_sortBy` and the `thenBy` keys | Clear only the `thenBy` keys | `orderBy` replaces the whole sort, whatever it came from; no stale state for `thenBy` to append to (correctness) |
| 4 | implementation, tests | Two tests pinned `WIRE_VERSION` to `'1.10'` | Check a lower bound (≥ 1.6 / ≥ 1.10, major 1) | Change the pins to `'1.11'` | Their subject is when a feature arrived, not the current version; the next bump would break them again (maintainability) |
| 5 | implementation, error timing | Where to refuse `thenBy` without `orderBy` | At the call | At lowering, with the other sort errors | Needs no proxy evaluation, and the mistake is in the chain itself; failing at the call points at it (correctness) |
| 6 | wrapup, follow-up | Grouped and nested-select sorts lack per-key direction | One backlog item (109) covering both | Two items, or none (decision 5 scoped the grouped builder out) | Same capability on two builders; the decision scoped them out, so the gap needs a home (maintainability) |
