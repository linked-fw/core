---
summary: >
  The object form of select types a relation field as the node reference the row holds —
  `{id: string}` (single-valued) / `{id: string}[]` (multi-valued) — like the array form; a
  sub-select keeps its object of selected fields. Types only, patch. Closes backlog 088; new
  backlog 110 for the row-structure mismatches found on the way.
packages: [core]
---

# 120 — Relation field type in the object form of select

## PR

### Summary

`Person.select((p) => ({friend: p.bestFriend}))` typed `friend` as `Person` while the row holds
`{id}`, so `row.friend.name` compiled and read `undefined`. A relation field in the object form
now types as `{id: string}` (single-valued) or `{id: string}[]` (multi-valued), matching the
rows and the array form (decision 6 of plan 006). The same holds inside the object of a
sub-select, with `.one()` and with `.for(id)`. A sub-select keeps the object of its selected
fields. No runtime change.

### Changes

- `src/queries/SelectQuery.ts`
  - `CreateQResult`, the named-field branch (`HasName = true`, final source): a shape value
    becomes `QResult<Value, SubProperties>` (`{id: string}`) instead of the shape.
  - `CreateShapeSetQResult`, the named-field branch: `QResult<ShapeType, SubProperties>[]`
    (`{id: string}[]`) instead of `CreateQResult<Source, null, never>[]`, which was assignable
    to `{id: string}[]` but not identical, named the source's shape instead of the members',
    and dropped `SubProperties`.
- `src/queries/GroupedSelectBuilder.ts` — comment only: `GroupKeyValue`'s reason now names the
  subject-as-field case (backlog 110); the relation half of the old reason no longer holds.
- `src/tests/select-result-typing.test.ts` — compile-time tests for single, multi, `.one()`,
  `.for(id)`, a relation in the object of a sub-select, and a sub-select in the object form
  (strict `Equals`); a unit test that maps SPARQL bindings of the object form to `{id}` /
  `[{id}, {id}]`; two live cases (Fuseki-only); the dataset gains two `hasFriend` triples.
- `README.md` — "Custom keys (object form)" example with the result type.
- `.changeset/object-form-relation-field-type.md` — patch.
- Backlog 088 removed; backlog 110 added.

### Verification

Typecheck (after rebase onto `ccr-88cd3a37-okakn0` at `afd7fe4`):

```
$ time npm run typecheck
> tsc -p tsconfig-tests.json
real	0m8.944s
exit: 0
```

The typing tests and every existing typing test file (`grep expectType|assertType|type-probe
src/tests`; the `type-probe-*.ts` files compile under the typecheck above):

```
$ time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs \
    src/tests/select-result-typing.test.ts src/tests/intermediate-representation.types.test.ts \
    src/tests/query-builder.types.test.ts src/tests/query.types.test.ts \
    src/tests/select-group-by.test.ts src/tests/select-node-type.test.ts
PASS src/tests/select-group-by.test.ts (5.065 s)
PASS src/tests/select-result-typing.test.ts
PASS src/tests/select-node-type.test.ts
[fuseki] live tests: 27 total — 0 passed, 0 failed, 27 skipped
Test Suites: 3 skipped, 3 passed, 3 of 6 total
Tests:       142 skipped, 72 passed, 214 total
real	0m10.706s
```

(The three `*.types.test.ts` suites are `describe.skip` — compile-only, covered by the
typecheck.) New tests by name:

```
✓ a relation field in the object form is a node reference
✓ .one() and .for(id) keep the node reference
✓ a relation field in the object of a sub-select is a node reference
✓ a sub-select keeps the object of its selected fields
✓ holds the node reference, one per value
○ skipped a relation field in the object form returns node references
○ skipped a relation field in the object of a sub-select returns a node reference
```

The new assertions fail without the fix: with `SelectQuery.ts` reverted, `tsc` reports
`TS2344: Type 'false' does not satisfy the constraint 'true'` at 8 assertions of
`select-result-typing.test.ts` (lines 79–105).

No live store here. The two Fuseki-only cases were run on oxigraph (scratch, not a dependency):
the generated SPARQL over the test file's dataset, mapped by `mapSparqlSelectResult`, with the
same assertions — passed:

```
[{"id":"…/p1","friend":{"id":"…/p2"},"name":"Semmy","all":[{"id":"…/p3"},{"id":"…/p2"}]},
 {"id":"…/p2","friend":{"id":"…/p3"},"name":"Moa","all":[]},
 {"id":"…/p3","friend":null,"name":"Jinx","all":[]}]
[{"id":"…/p1","friends":[{"id":"…/p3","friend":null,"name":"Jinx"},
                         {"id":"…/p2","friend":{"id":"…/p3"},"name":"Moa"}]}, …]
✓ live cases on oxigraph (56 ms)
```

### Deviations

- No existing typing test or probe relied on the old type: `tsc` passed unchanged after the fix,
  so none was changed.
- `CreateShapeSetQResult` changed too (the step named `CreateQResult`): the multi-valued field
  was already structurally `{id: string}[]` but failed a strict equality check; it now is exactly
  that, as decision 6 states.

### Follow-ups

- Row structure vs. type in the object form — custom key on a deeper path, a sub-select or
  `preloadFor` (key moved or dropped at runtime), the subject as a field (malformed type), a
  nested plain object (runtime error), `preloadFor` component fields missing from the type:
  backlog 110.
- A missing single-valued relation is `null` at runtime and typed `{id: string}`, like every
  literal field: backlog 028 (strict null checks).

## Details

### What the rows hold (checked before changing the types)

Each case was lowered with `selectToSparql`, run on oxigraph over a small dataset (p1 →
bestFriend p2, friends p2, p3; p2 → bestFriend p3, friends p3) and mapped with
`mapSparqlSelectResult`:

| Select | Row (p1) | Type before | Type now |
|---|---|---|---|
| `({friend: p.bestFriend})` | `friend: {id}` (`null` when absent) | `Person` | `{id: string}` |
| `({fs: p.friends})` | `fs: [{id}, …]` (`[]` when none) | `QResult<Person, {}>[]` | `{id: string}[]` |
| `({bb: p.bestFriend.bestFriend})` | `bestFriend: {id, bb: {id}}` | `bb: {bestFriend: {id}}` | unchanged (backlog 110) |
| `({fb: p.friends.bestFriend})` | `friends: [{id, fb: {id}\|null}]` | `fb: {bestFriend: {id}}[]` | unchanged (backlog 110) |
| `p.friends.select((f) => ({bf: f.bestFriend}))` | `friends: [{id, bf: {id}\|null}]` | `bf: Person` | `bf: {id: string}` |
| `({x: p.bestFriend.select((b) => ({bf: b.bestFriend, n: b.name}))})` | `bestFriend: {id, bf: {id}, n}` | `bf: Person` | `bf: {id: string}` (key `x` still wrong, backlog 110) |
| `({friend: p.bestFriend}).one()` | `{id, friend: {id}}` | `friend: Person` | `friend: {id: string}` |
| `({friend, fs}).for({id})` | `{id, friend: {id}, fs: [{id}, {id}]}` | `friend: Person` | `friend: {id: string}` |
| `({bf: p.bestFriend.preloadFor(c)})` | `bestFriend: {id, name}` | `bf: Person` | `bf: {id: string}` (key, fields: backlog 110) |
| `({info: {friend: p.bestFriend}})` | throws `Unknown trace result type` | — | backlog 110 |

So the leaf value of a relation is always a node reference, and the fix is in the two
named-field branches; the structural mismatches around deeper paths and sub-selects are a
separate question (change rows or types) and went to backlog 110.

### How the type is built

`ObjectToPlainResult` maps each field through `QueryResponseToResultType<…, Shape, true>`;
`HasName = true` means the field's key is already known, so the value is not wrapped in a
`{property: …}` object. For a single-valued relation at the root (`p.bestFriend`),
`GetQueryObjectResultType`'s `QueryShape` branch calls `CreateQResult<Source = root, Value =
Person, 'bestFriend', {}, true>`; the root's parent source is `null`, and the branch returned
`Value` — the shape. It now returns `QResult<Value, SubProperties>` for a shape (`{} & {id:
string}`, which TypeScript reduces to `{id: string}`), and `Value` unchanged otherwise
(primitives, arrays, numbers from `size()`, nested `QResult`s). For a multi-valued relation,
`CreateShapeSetQResult`'s `[HasName, ParentSource] extends [true, null]` branch now returns
`QResult<ShapeType, SubProperties>[]`.

Sub-selects never take these branches: `QueryResponseToResultType`'s `FieldSet` branch calls
`GetNestedQueryResultType` without `HasName`, so they keep their object of selected fields. A
relation inside a sub-select's own object goes through `ObjectToPlainResult` again and gets the
fix.

### Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 1 | tasks | S5 has no plan doc; phases needed | Two phases in this report: (1) type fix + tests + README, one commit; (2) wrapup (report, changeset, backlog), one commit | A plan doc for a one-branch fix | Master said phases go in the report; smallest record |
| 2 | implementation | Multi-valued field was `QResult<Person, {}>[]`: assignable to `{id: string}[]` but not strictly equal | Change `CreateShapeSetQResult`'s named branch to `QResult<ShapeType, SubProperties>[]` | Leave it, test with mutual assignability | Decision 6 states `{id: string}[]`; the old form also named the source's shape and dropped `SubProperties` |
| 3 | implementation | Custom key on a deeper path / sub-select / preloadFor: rows and types differ in structure | Backlog 110; leaf values fixed only | Change `resultMapping` or the types now | Needs a design choice (which side moves) not settled in the plan's decisions; scope rule |
| 4 | implementation | Subject as a field (`{person: p}`) typed `QResult<Shape, {'': {id}}>`, rows `{id}` | Backlog 110 | Special-case `Source = null` in `CreateQResult` | Not a relation (decision 6); the root `null` source matches `QueryShape` only without strict null checks, which touches every query's typing |
| 5 | review | `GroupKeyValue` could drop its `QueryShape` branch now that relation fields are `{id}` | Keep the branch, fix its comment | Remove it | The subject-key test (`Row['person']`) fails without it (checked) |
| 6 | review | `preloadFor` component fields missing from the row type (both forms) | Backlog 110 | Fix here | Pre-existing, unrelated to the relation's own type; runtime structure also differs |
| 7 | tests | Live cases cannot run here (no Docker) | Add them to the existing Fuseki block, prove them on oxigraph in scratch | Unit tests only | Same pattern as the file; CI runs them |
| 8 | tests | Negative check "no shape fields on a node reference" | `'name' extends keyof Row['friend']` asserted false | `@ts-expect-error` on an expression | `@ts-expect-error` swallowed an unrelated error in a first draft; a type-level check cannot |
| 9 | docs | README had no plain object-form example | Add "Custom keys (object form)" with a relation and a set, only one-segment paths | Document deeper paths too | Deeper paths in the object form are the backlog 110 mismatch |

### Phases

1. **Type fix and tests** (commit "Type a relation field in the object form of select as a node
   reference"): `SelectQuery.ts` (two branches), `GroupedSelectBuilder.ts` (comment),
   `select-result-typing.test.ts`, `README.md`. Validation: typecheck, the typing test files,
   oxigraph run of the live cases, the revert check above.
2. **Wrapup**: comments tightened, this report, changeset, backlog 088 removed, 110 added, S5
   ticked in plan 006.

### Tests

`src/tests/select-result-typing.test.ts`, 18 tests (12 run here, 6 Fuseki-only): the new
compile-time block (4 tests) uses the strict `Equals` already in the file, so `QResult<…>`
shapes that are only mutually assignable would fail. The unit test pins the runtime side with
hand-written bindings (two rows for p1's two friends → one row, `friend: {id}`, `all: [{id},
{id}]`). Existing probes (`type-probe-4.4a.ts`, `type-probe-count.ts`,
`type-probe-deep-nesting.ts`) and `*.types.test.ts` compile unchanged.

### Known limitations

- Deeper-path keys, sub-select / `preloadFor` keys, the subject as a field, nested plain
  objects: backlog 110.
- Nullability is not modelled (backlog 028).
