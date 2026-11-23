---
summary: >
  The object form of select returns rows that follow the keys the user wrote, and its types match
  them: a key is a top-level field of the row (or a sub-select's member row) holding the
  expression's yield (an array through a multi-valued hop); keyed sub-selects and preloads hold
  their member rows; size()/expressions inside a sub-select are per member. Nested objects and the
  key `id` are refused (type and build time); DSL-JSON `as` names the key; two reads of one relation
  under two keys now answer. Minor. Backlog 110 closed; follow-ups in backlog 114.
packages: [core]
---

# 121 — Object-form rows follow their keys

## PR

### Summary

Plan 006 step S8 (decisions 13, 18–21; backlog 110). In the object form, a key on a deeper path
moved to the leaf of a nested object (`{n: p.bestFriend.name}` → `row.bestFriend.n`), the key of a
sub-select or preload was dropped, a `size()` or expression in a sub-select landed on the root row,
a nested plain object threw at mapping and the key `id` overwrote the row's id; the types promised
something else again. Now a key names a top-level field of the object it is written in and holds
the expression's yield: through single-valued hops the value or `null`, through any multi-valued
hop the array of distinct values. A keyed sub-select or `preloadFor` holds its member row(s);
computed fields inside a sub-select are per member (also beside other fields, through a hop or a
filter — backlog 112.3). Hops never appear. The types say exactly that; `preloadFor` carries the
component's fields. A nested plain object, an array value, `null` and the key `id` are a
build-time error, and their row type is a `SelectError` naming the reason (addendum: the type-level
constraint of the first landing was removed for backward compatibility). DSL-JSON `"as"` names the key. Two reads of one relation under two keys
(`{all: p.friends.name, moa: p.friends.where(…).hobby}`, two filters) answer instead of being
refused. Live queries refetch a key read through a hop when that node changes. The array form is
unchanged except where it was wrong: a `size()` or expression inside an array-form sub-select is
now per member (addendum, master decision 28). User-visible row change → **minor** changeset
listing every moved row.

### Changes

- `src/queries/IntermediateRepresentation.ts` — `IRResultMapEntry` gains optional `container`,
  `keyed`, `members` (absent in the array form, so its IR is unchanged).
- `src/queries/IRDesugar.ts` — keys honoured per entry (a keyed entry beside unkeyed ones, e.g.
  `.preload()`); `alias` (DSL-JSON `as`) read as the key.
- `src/queries/IRLower.ts` — seeds carry their row (steps, under a key, keyed groups); a keyed
  sub-select emits a `members` seed/entry; entries get `container`/`keyed` where the hops from the
  root would place them elsewhere.
- `src/queries/projectionDuplicates.ts` — positions follow the rows (keyed groups, hops inside the
  innermost keyed row, key), each level with its reading; pagination refused per shared traversal;
  the keyed-advice refusals lifted.
- `src/queries/FieldSet.ts` — refusals: nested object / array value, key `id`, two names for one
  DSL-JSON key.
- `src/sparql/resultMapping.ts` — rows built per container (`buildRow`): flat, nested, keyed values
  (collapsed), keyed members. Replaces `mapFlatRows`/`mapNestedRows`.
- `src/sparql/irToAlgebra.ts` — a row's alias (a keyed sub-select's members, the member a field is
  computed per) is projected, so a per-member aggregate groups by it; a `members` entry is never
  renamed with a colliding projection alias.
- `src/queries/SelectQuery.ts` — `KeyedFieldResult` (the type of a key), `SelectResponse`
  (constraint on select callbacks; exported), `QueryComponentLike` infers the component's response.
  `src/queries/QueryBuilder.ts`, `src/shapes/Shape.ts` — the constraint on `select`.
  `src/queries/GroupedSelectBuilder.ts` — `GroupKeyValue` reduced to unwrapping an array.
- `src/queries/queryDependencies.ts` — a keyed value read below its row: hops below and the
  value's predicate `hidden`, hops above `narrow`.
- Tests: new `object-form-rows.test.ts` (IR, recorded rows, DSL-JSON round trips, types, refusals,
  `[fuseki]` block), `object-form-live.test.ts`, fixtures `src/test-helpers/object-form-fixtures.ts`
  and `src/tests/fixtures/object-form-rows.bindings.json`; updated goldens and pinned shapes (see
  Deviations); a `query-dependencies` case.
- Docs: README (custom keys), `documentation/intermediate-representation.md` (object-form section),
  `sparql-algebra.md` (result mapping), `dsl-json.md` (keys). Changeset
  `object-form-rows-follow-keys.md` (minor). Backlog 110 removed, 114 added, 112 notes 112.3 answered.

### Verification

Typecheck — `time npx tsc -p tsconfig-tests.json --noEmit`: `exit 0`, `real 0m8.793s`.

Landing gate (new/changed tests, select/IR goldens, typing, group-by, duplicates, the inline-filter
and quantifier files of reports 115/118/122, FieldSet, DSL-JSON round trip, live, dependency and
mapping specs of touched files), after the last rebase (13764c9):

```
$ time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs \
    src/tests/object-form-rows.test.ts src/tests/object-form-live.test.ts \
    src/tests/sparql-select-golden.test.ts src/tests/ir-select-golden.test.ts \
    src/tests/select-result-typing.test.ts src/tests/select-group-by.test.ts \
    src/tests/duplicate-projection-fields.test.ts src/tests/inline-filter-outer-refs-and-filtered-size.test.ts \
    src/tests/quantifier-outer-refs-and-aggregates.test.ts src/tests/inline-filter-and-size-lowering-edges.test.ts \
    src/tests/where-hops-and-every-counterexamples.test.ts \
    src/tests/field-set.test.ts src/tests/dsl-json-roundtrip.test.ts src/tests/live-matching.test.ts \
    src/tests/live-query-store.test.ts src/tests/query-dependencies.test.ts \
    src/tests/sparql-result-mapping.test.ts src/tests/nested-select-pagination.test.ts \
    src/tests/ir-desugar.test.ts src/tests/query-builder.test.ts src/tests/sparql-algebra.test.ts \
    src/tests/sparql-fuseki.test.ts
[fuseki] live tests: 185 total — 0 passed, 0 failed, 185 skipped
Test Suites: 1 skipped, 21 passed, 21 of 22 total
Tests:       188 skipped, 931 passed, 1119 total
real	0m11.445s
```

Full regular set once (not the gate):
`Tests: 51 failed, 683 skipped, 3074 passed` — the 51 are `two-copies-built`,
`two-copies-entry-points`, `ontology-load-files`, which need `lib/` (no build in the worktree), as
in report 119.

oxigraph (scratch install in `/tmp`, not a dependency). Every case of
`object-form-fixtures.ts` lowered, run on the fixture dataset, mapped, compared with the contract
rows, and round-tripped through DSL-JSON (same SPARQL); the answers are recorded in the fixture:

```
OK  rt=true n / bb / names / fbf / fb / xFriends / xFriendsArray / xBestFriend / w / wName /
    pre / preFriends / person / nAndB / subSize / subSizeArray / subSizeThroughHop /
    subSizeFiltered / subExpr / subExprFiltered / subExprFilteredBeside / deepSub /
    twoSubsOneRelation / preloadBeside / allAndCarls / twoFilters / one / forP1
FAILURES []
```

Every `[fuseki]` suite run on oxigraph through a scratch jest config that maps the Fuseki helpers
to an in-memory oxigraph, on this branch and on the integration branch, failure lists diffed: the
only difference besides the lib-dependent suites is that `sparql-fuseki` "countLabel" now passes
(it asserted the old root-row count; rewritten). Failures shared by both (inference-dependent
suites, `FusekiStore` HTTP tests, "countNestedFriends" — backlog 114) are unchanged.

The live test fails without the `queryDependencies` change (renaming the best friend did not
refetch `{n: p.bestFriend.name}`), passes with it.

### Deviations

- Goldens changed (they encoded the bug, C1): `sparql-select-golden` `countLabel` (`?a1` projected,
  `GROUP BY ?a0 ?a1`: one count per friend); `ir-select-golden` "nested array children do not
  inherit the enclosing custom result key" (a `members` entry for the key);
  `duplicate-projection-fields` (IR of a keyed field; the Carl case and two filters under two keys
  now answer; a keyed + paginated read of one relation and two sub-selects under one key added as
  refusals); `sparql-fuseki` "countLabel" and `inline-filter-outer-refs…` "a preloaded component"
  assert the new rows.
- Pinned old type shapes updated: `select-result-typing` (keyed sub-select holds the row),
  `type-probe-deep-nesting` TEST 2/19 (TEST 3/20 compile unchanged and now match the rows).
- `src/index.ts` exports the new `SelectError` type (the error row type; addendum).
- No DSL-JSON wire bump for `as` (ledger 14).

### Follow-ups

- Array-form `p.bestFriend.friends.size()`: row `{friends}` on the root, typed nested — backlog 114.1.
- A computed field is typed `boolean` whatever it computes (pre-existing) — backlog 114.3.
- `sparql-fuseki` "countNestedFriends" asserts 2 rows, OPTIONAL gives 4 (before this step too) —
  backlog 114.2.

## Details

### The contract (plan 006 S8) and what implements it

| Rule | Where |
|---|---|
| A key is a field of the row it is written in (root or sub-select member row) | `IRLower` sets `container` (the row's alias) and `keyed`; `resultMapping.buildRow` places keyed fields |
| Value = expression's yield; hops collapsed | `KeyedField` `value`: chain container → source; `plural` if a hop or the property is multi-valued; plural → distinct values (`[]`), else first non-null or `null` |
| Sub-select / preload under a key = member row(s) | `members` entry (no projection item); its fields have `container` = member alias; `collectEntityRows` |
| Subject as a field `{id}` | `alias_expr` of the root, `container` root, empty chain → `{id}` |
| Expressions / `size()` in a sub-select per member | entries get `container` = member alias; `irToAlgebra` projects it (GROUP BY key); mapped flat in that row |
| Keys per entry | `IRDesugar.desugarEntries` |
| DSL-JSON `as` names the key | `keyOf(entry)` = `customKey || alias`; `checkJsonKey` refuses two different names |
| Refused: nested object, key `id` | `FieldSet.keyedEntry` / `assertResultKey` (runtime), `ObjectFormRow` → `SelectError` row type (addendum) |
| Array form unchanged (except per-member computed fields, addendum) | entries without `container`/`keyed` place as before; an array-form sub-select's computed field gets `container` |

### Result-map entries (IR)

`IRResultMapEntry = {key, alias, container?, keyed?, members?}`. An entry carries `container`
when its row is not the one its hops from the root reach: a keyed field; any field inside a keyed
sub-select; an expression or aggregate inside any sub-select. `members` entries precede their
fields (seed order). Example:

```ts
Person.select((p) => ({n: p.bestFriend.name, x: p.friends.select((f) => ({c: f.friends.size()}))}))
resultMap: [
  {key: 'n', alias: 'a2', container: 'a0', keyed: true},
  {key: 'x', alias: 'a3', container: 'a0', keyed: true, members: true},
  {key: 'c', alias: 'a4', container: 'a3', keyed: true},
]
```

Container aliases are resolved after the seed's own path is lowered (`aliasAfterPath` then shares
the traversal), so traversal numbering of array-form selects does not change. A `members` seed
lowers its steps with their inline filters (`membersAlias`), so a keyed `p.friends.where(F).select(…)`
keeps its filter whatever fields follow.

### Result mapping

`buildNestingDescriptor` builds `RowSpec`s: `{flatFields, nestedGroups, keyed}`. `rowFor(alias)`
returns the root, a registered members row, or (walking traversals up) a nested group under one of
those — for an unkeyed sub-select inside a keyed one, or a per-member field of an array-form
sub-select. Unkeyed entries with a container nest under hops from that container; computed ones
are flat in it. `mapRows` groups bindings by root id; `buildRow` → flat fields, nested groups
(`collectEntityRows` by traversal id), keyed values (`keyedValue`), keyed members
(`keyedMembers`). Literal traversals are detected over every nested group of the tree across all
bindings. The duplicate-key assertion now covers every row (flat + keyed keys).

### SPARQL

Only change: aliases of rows (members, containers) are projected, also when an aggregate's output
name collided with one (`aggregateRenamedAliases`), and `members` entries are excluded from the
collision renames. So `p.friends.select((f) => ({c: f.friends.size()}))` emits
`SELECT ?a0 (COUNT(DISTINCT ?a1_friends) AS ?a1_agg) ?a1 … GROUP BY ?a0 ?a1`. A count beside the
finer grouping is `COUNT(DISTINCT …)` of its own variable and unchanged.

### Duplicate checks (`projectionDuplicates.ts`)

`positionOf(seed)` → segments: one per enclosing keyed sub-select (`key`, reading = its canonical
steps + pagination), then hops inside the innermost keyed row (unkeyed path: its own steps below
that row except the last; keyed / computed / members: the row's steps below it), then the field's
own key (a filtered relation leaf: an empty key, as before). Rules: same position and signature →
dropped; same position, different signature → refused; a field whose position is a prefix of
another's → refused unless the bare relation is subsumed (decision 17, unchanged; a members seed
is never the short side); a level both share by name but read differently → refused; two seeds
sharing a traversal (identical canonical steps from the root) with different pagination at that
depth → refused with the pagination advice, whatever their keys. Advice: pagination differs →
"cannot yet read a relation with two different paginations"; same position with a key → "give
each a key of its own"; otherwise the object form.

### Types

`ObjectToPlainResult<T>` maps each key through `KeyedFieldResult<V>`:
FieldSet (sub-select) → `QueryResponseToResultType<Response>` (the member row), plural through
`CrossesSet<Source>`; BoundComponent → `{id} & component fields`; `SetSize` → `number`;
`QueryPrimitiveSet` → `P[]`; `QueryPrimitive` → `P` (plural through a set); `QueryShape` → `{id}`
(plural through a set; root subject → `{id}`); `QueryShapeSet` → `{id}[]`; otherwise the old
`QueryResponseToResultType` (expressions, aggregates). `CrossesSet` tests `QueryShape` before
`QueryShapeSet` (a QShape matches QueryShapeSet structurally) and treats `any` as single.
An object-form response with a nested plain object / array value or the key `id` types its row as
`SelectError<message>` (`ObjectFormRow`; the first landing's `SelectResponse` constraint on the
select signatures is gone, see addendum). No strict null checks (backlog 028): `null` values are
typed as the value.

### Live

`queryDependencies` reads the result map: a keyed entry whose value is read on a node below its
row → `collectKeyed` (hops below + predicate hidden, chain above narrow); otherwise as before.

### Rows that moved

Listed in the changeset (`.changeset/object-form-rows-follow-keys.md`) with before/after for every
case; the `objectFormRows` fixture holds the rows on a dataset (p1 → p2 → p3).

### Tests

- `src/tests/object-form-rows.test.ts` (105 tests, 28 of them `[fuseki]`: 28 recorded-row cases, 28 DSL-JSON round trips,
  IR result maps, compile-time `Equals` for every case incl. `.one()`, `.for()`, grouped and the
  array form of `preloadFor`, `@ts-expect-error` refusals, runtime refusals, a 28-case `[fuseki]`
  block). Recorded answers guarded by the SPARQL they answer: when lowering changes, re-record
  (scratch recorder described above: lower each case, run on oxigraph, write `{sparql, results}`).
- `src/tests/object-form-live.test.ts` — live refetch.
- `src/test-helpers/object-form-fixtures.ts` — cases, dataset, rows, `normalizeRows`.

### Known limitations

- Nullability not typed (backlog 028).
- `preload('path', c)` on the builder does not change the result type (a string path).
- Array-form count through a hop (backlog 114.1).

### Phases (as run)

1. IR + lowering + build-time refusals (commit "result-map entries name their row").
2. Result mapping + per-member aggregate grouping; recorded oxigraph fixtures.
3. Positions + lifted refusals; rebased over S9 (112.3 cases added as fixtures).
4. Types incl. grouped and preload (the `SelectResponse` constraint of this phase was removed in the fix round).
5. Live dependencies, docs, changeset; rebased over the S9 fix round (filtered sub-select computed
   field case added).

### Review (self, keep-going)

- Intent and plan fit: every row of the S8 table and the verify list met; master's two added
  cases (112.3 count through a hop/filter beside a field; a filtered sub-select's computed field)
  covered by fixtures.
- Gaps found and fixed during the run: an aggregate's renamed alias also renamed the members entry
  (`x: {id: "0"}`), and a renamed traversal was not re-projected — both fixed in `irToAlgebra`;
  stale comment naming `mapNestedRows` fixed.
- Cleanup: unused helpers (`FieldSeed`, `propertySteps`, old advice branches, `QueryShape` imports
  in `GroupedSelectBuilder`) removed.
- Architecture: no `docs/architecture` doc covers projection rows; documentation files updated.

### Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 1 | design, IR | How to mark object-form entries | Three optional fields on `IRResultMapEntry` (`container`, `keyed`, `members`), only where the default placement is wrong | A container on every entry | Contract asks for additive IR so array-form goldens stay put |
| 2 | phase 1, refusals | An array as an object-form value (`{both: [p.name, p.hobby]}`) also threw `Unknown trace result type` | Refused like a nested object, naming the key | Support it as a nested multi-selection | No row field can hold an array of selections; same reason as decision 20 |
| 3 | phase 1, DSL-JSON | A field with both `customKey` and `as` | Refused when they differ; either one names the key | `customKey` wins silently | Never a silent choice between two names the user wrote |
| 4 | phase 1, IR | An object-form component under `preloadFor` in the array form gets `container`/`keyed` entries | Accept: the component's keys are fields of its member row; array-form rows unchanged | Strip keys inside unkeyed preloads | The contract places a sub-select's keys in its member row |
| 5 | phase 1, lowering | Container aliases must not change traversal order | Resolve a seed's container after its own path is lowered; a members seed lowers its steps with their inline filters | Resolve while collecting seeds | Eager resolution renumbers traversals of array-form selects |
| 6 | phase 2, tests | No store here; rows must be checked per case | Record oxigraph's answers per case in a fixture (guarded by the SPARQL text), map them in unit tests; same cases live in a `[fuseki]` block | Hand-written bindings | Real store answers for 28 cases; the guard forces re-recording when lowering changes |
| 7 | phase 2, mapping | Value of a keyed single-valued field when the first binding lacks it | First non-null over the row's bindings | First binding (as flat fields) | Never a spurious `null` when other fields multiply rows |
| 8 | phase 2, scope | `{x: p.friends.select((f) => ({e: …}))}` dropped a person without friends | Left to S9 (decision 22); after rebasing it answers (fixture `subExpr`) | Fix here | Same lowering S9 owned |
| 9 | phase 3, messages | The "keys of the object form nest under the relation" advice no longer holds | Dropped; keyed position conflicts say "give each a key of its own", others point at the object form, pagination keeps its own advice | Keep three keyed variants | The object form now keeps reads apart |
| 10 | phase 3, scope (112.3) | A count through a hop or a filter in a sub-select beside a field was missing from member rows | A field of the member row (key = counted relation's label) | Nest it under the hop | It is computed per member, so the member row is where it is true |
| 11 ⚠ | phase 4, types | How to refuse a nested object / key `id` in the type | Constraint `SelectResponse` on select callbacks (compile error at the key) | An error-branded result type | A compile error is a refusal; a brand compiles and fails only on use. Touches every select signature — superseded by the addendum (M5, master decision 29) |
| 12 ⚠ | phase 4, types | A callback typed to return `unknown` no longer satisfies the constraint | Accept; such helpers use `any` (changeset says so) | Leave `unknown` unconstrained | `unknown` cannot be checked; possible compile break for wrappers in apps — superseded by the addendum (M5, master decision 29) |
| 13 | phase 5, live | Which predicates a collapsed key depends on | Hops below the row and the value's predicate hidden, hops above narrow | First hop narrow | Hidden is a superset; never stale |
| 14 | phase 5, wire | `as` now names the key | No wire-version bump; documented | Bump to 1.12 | `toJSON()` writes `customKey`; the format is unchanged |

### Addendum — review fix round (920a240..)

An independent review ran 218 selects on oxigraph, before and after the first landing. Fixes:

| # | Finding | Fix | Tests |
|---|---|---|---|
| H1 | A live keyed sub-select or preload across a hop (`{x: p.bestFriend.friends.select(…)}`) did not refetch when the hop changed: `members` entries were not attributed | `queryDependencies.collectMembers`: hops of a members entry read below its row are hidden, the hop read on the row's node narrow | `object-form-live` (sub-select and preload; fails without), `query-dependencies` |
| H2 | A `size()` beside a field reading the same relation counted 1 (the sibling's variables are GROUP BY keys, splitting the count): `{fn: p.friends.name, c: p.friends.size()}`, `{c: p.friends.size(), fb: p.friends.bestFriend.name}`, the same in a sub-select, a count beside a keyed sub-select of the relation, a filtered count beside the same filtered path. Root-level cases were wrong before report 121 too | `IRLower.countOverOwnTraversals`: a count whose traversal another field (or a row) reads counts over a traversal of its own (with the same inline filter); no golden changed | fixtures `countBesideName`, `countBesideHop`, `subCountBeside`, `countBesideMembers`, `filteredCountBeside` (oxigraph) |
| M3 | `.preload('friends', c)` beside `{x: p.friends.select(…)}` put the component's fields into the `x` rows and dropped `friends` | Refused at lowering (`refuseRowsSharedWithAKey`), naming both: the member alias names the keyed rows, so a row reached through it from outside the key has no place | `object-form-rows` |
| M4 | Master decision 28: the array form changed (per-member computed fields; an extra GROUP BY alias), contrary to the PR text | Kept (correct rows); report and changeset corrected, the array-form rows listed in the changeset's migration notes | — |
| M5 | Master decision 29: the `SelectResponse` constraint broke code that compiled before (callbacks returning `unknown`/`object`, generic wrappers, named interfaces) | Constraint removed from `Shape.select`, `QueryBuilder.select` and the sub-selects; the row type of a nested object / array value / key `id` is `SelectError<message>` (exported); the runtime refusal stays; the test helper is back to `unknown` | `object-form-rows` (each snippet compiles; the error row types) |
| L6 | A key colliding with a preload read "friends.name and friends.name" | Refusals name a field's key and the sub-select it is in: `(friends: friends.name and friends.select(name: name))` | `object-form-rows` |
| L7 | `({n: p.name, z: null})` threw `Unknown trace result type: null` | Refused naming the key (a sub-select still skips a `null` value, as before) | `object-form-rows` |
| L8 | `{e: p.bestFriend.name.concat('!')}` typed `boolean` (pre-existing) | Backlog 114.3 (needs a result type on `ExpressionNode`) | — |
| L9 | A members entry could shadow a projection alias in `queryDependencies` (`entryOf` by alias) | `entryOf` built from non-members entries | `query-dependencies` (fails without) |

Ledger (fix round):

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 15 | H2 | How to keep a count from being split by GROUP BY keys | A traversal of its own for a count whose traversal is read elsewhere (lowering) | A sub-SELECT per count | Smallest change; COUNT(DISTINCT) over an independent variable is per row in any finer group; no golden moved |
| 16 | M3 | Preload beside a keyed sub-select of the same relation | Refuse | Give the preload a traversal of its own | A second traversal changes alias sharing for every select; refusal is never silent and rare |
| 17 | M5 | Error message for a nested object / key `id` | The whole row type is `SelectError<…>` (reading any field fails to compile) | Only the key's type is the error | `id` lives on every row; a per-key brand would still let `row.id` read |
| 18 | L7 | `null` in a sub-select's object | Keep skipping it (as before); refuse only at the top level, where it threw | Refuse both | Backward compatibility for conditional sub-select fields |

Verification (fix round): typecheck exit 0 (`real 0m8.415s`); landing gate as above plus the new
tests: `Tests: 193 skipped, 948 passed, 1141 total` (`real 0m12.003s`); all 33 fixture cases OK on
oxigraph and round-trip through DSL-JSON; every `[fuseki]` suite on oxigraph against the
integration branch: no new failure (only the lib-dependent suites differ); full regular set
`51 failed` (the same lib-dependent suites).
