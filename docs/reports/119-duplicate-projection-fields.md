---
summary: A field selected twice in a select is one field (one SPARQL variable, one row key); one key selected in two different ways, or one relation read two ways by fields nested under it, is refused at lowering, naming the key. Object-form keys over one path project their variable once. Backlog 023 closed; follow-ups added to backlog 110 and 112.
packages: [core]
---

# 119 — Duplicate projection fields

## PR

### Summary

`Person.select((p) => [p.name, p.name])` emitted `SELECT DISTINCT ?a0 ?a0_name ?a0_name` (a
syntax error for stores that check it) and then threw "Duplicate result key" in result mapping.
Per plan 006 decision 4: an exact duplicate field is now dropped before lowering, and one key
selected in two different ways is refused while lowering, naming the key, before any SPARQL is
built. Fields that only share a relation (`[p.bestFriend.name, p.bestFriend.hobby]`) still nest
together; fields nested under one relation that read it in different ways
(`[p.friends.name, p.friends.where((f) => f.name.equals('Carl')).hobby]`, which kept only one
`friends` list) are refused too. No auto-suffixed keys. The result-mapping check stays as a defensive assertion.

### Changes

- `src/queries/projectionDuplicates.ts` (new): `dedupeProjectionSeeds` — places each projection
  field at its row position (relations it nests under + its key), compares fields structurally
  (steps, inline filters, path expressions, sub-select pagination, resolved expressions), drops
  exact duplicates and refuses conflicts (same position, a key nested under another, or a shared
  relation read two ways). The `ProjectionSeed` type moved here from `IRLower.ts`.
- `src/queries/IRLower.ts` (`lowerSelectQuery`): seeds carry their enclosing sub-select
  pagination by relation depth (`context`) and, for expressions, their group path; they pass through
  `dedupeProjectionSeeds` before path lowering.
- `src/sparql/irToAlgebra.ts`: a variable two projection items read is projected once in a
  non-grouped select too (the grouped select already did): `{a: p.name, b: p.name}` gave
  `SELECT ?a0_name ?a0_name`, which oxigraph rejects.
- `src/sparql/resultMapping.ts`: duplicate-key check kept, comment and message reworded as a
  defensive assertion.
- `src/tests/duplicate-projection-fields.test.ts` (new, 29 tests). README ("Multiple paths +
  nested paths"), changeset `duplicate-projection-fields.md` (patch), backlog 023 removed and
  retired in `docs/backlog/README.md`.

### Verification

Typecheck — `npx tsc -p tsconfig-tests.json --noEmit`: exit 0, `real 0m8.328s`.

Jest (`NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs <files>`), after
rebasing onto d208c9e:

```
== src/tests/duplicate-projection-fields.test.ts
Tests:       29 passed, 29 total
real	0m2.546s
== src/tests/sparql-select-golden.test.ts src/tests/ir-select-golden.test.ts
Tests:       184 passed, 184 total
real	0m2.563s
== src/tests/sparql-result-mapping.test.ts src/tests/nested-select-pagination.test.ts src/tests/select-result-typing.test.ts src/tests/select-group-by.test.ts src/tests/inline-filter-outer-refs-and-filtered-size.test.ts
Tests:       36 skipped, 128 passed, 164 total
real	0m3.224s
== src/tests/field-set.test.ts src/tests/dsl-json-roundtrip.test.ts src/tests/query-builder.test.ts src/tests/sparql-algebra.test.ts
Tests:       3 skipped, 336 passed, 339 total
real	0m3.106s
```

Full regular set once (not the gate): `Tests: 51 failed, 634 skipped, 2927 passed` — the 51
failures are all in `two-copies-built`, `two-copies-entry-points` and `ontology-load-files`,
which need `lib/` (`… lib/esm/index.js is missing: run npx linked build`); the worktree has no
build. No golden changed.

oxigraph (scratch install, not a dependency), generated SPARQL run on `p1 name "Semmy", hasFriend
p2; p2 name "Moa"`:

```
flat: SELECT DISTINCT ?a0 ?a0_name
nested: SELECT DISTINCT ?a0 ?a1_name ?a1
objectForm: SELECT DISTINCT ?a0 ?a0_name
flat [{"a0":"http://x/p2","a0_name":"Moa"},{"a0":"http://x/p1","a0_name":"Semmy"}]
nested [{"a0":"http://x/p2"},{"a0":"http://x/p1","a1_name":"Moa","a1":"http://x/p2"}]
objectForm [{"a0":"http://x/p2","a0_name":"Moa"},{"a0":"http://x/p1","a0_name":"Semmy"}]
```

Before the `irToAlgebra` change the object form failed there: `objectForm ERROR error at 8:2:
expected one of Duplicated variable name in SELECT`.

The object form of the shared-relation case, run on oxigraph (bob knows Moa and Carl) and mapped
by `mapSparqlSelectResult` before this step refused it: the SPARQL is right (two traversals since
d208c9e), the row is not — `({all: p.friends.name, carls: p.friends.where(…Carl).hobby})` gave
bob `{"friends":[{"id":"http://x/p3","carls":"Golf"}]}` (`all` and Moa lost). So the object form
does not answer it yet; it is refused too, and recorded in backlog 110 (step S8).

### Deviations

- `irToAlgebra.ts` changed (the plan names `IRLower.ts` and `resultMapping.ts`): the object form
  with two keys on one path must keep working (task), and its duplicate SELECT variable is a
  syntax error. One-line change, the grouped select's existing rule extended to all selects.
- Refusal advice depends on whether the object form can answer: two reads of one relation that
  differ in sub-select pagination still share one traversal (backlog 112 item 1), and keys of the
  object form nest under the relation they read today (backlog 110), so those refusals say to
  select it once instead of pointing at the object form.
- Refusals happen at lowering (running the query or `lower()`), not at `toJSON()`: a conflicting
  query still serializes and is refused where it is lowered.

### Follow-ups

- Backlog 112 item 1 (step S9) rewritten: the projection case (`[p.friends.name,
  p.friends.where(…).hobby]`) is handled here and removed; left: a filtered path beside a
  top-level where on that relation, and a paginated sub-select having no traversal of its own.
- Backlog 110 (step S8) extended: `positionOf` models today's row placement of custom keys; it
  must move with the rows, and the object-form refusals (the Carl example, two filters under two
  keys) lifted once the keys stay apart.

## Details

### How it works

`lowerSelectQuery` flattens the desugared selections into projection seeds
(`collectProjectionSeeds`): a path seed per leaf path (sub-select parent paths prepended), an
expression seed per projected expression (already resolved against the query's aliases). The seed
list goes through `dedupeProjectionSeeds` before any path is lowered, so a dropped duplicate never
attaches an inline filter or creates a projection alias.

For each seed:

- **Position** (`positionOf`): the local names of the relations it nests under, then its key —
  the custom key if it has one, else the last step's local name (`count_step` → its label,
  empty path → `value`). This mirrors `buildNestingDescriptor` in `resultMapping.ts`, which nests
  a value under each traversal of its path. `[p.bestFriend.name, p.bestFriend.hobby]` →
  `bestFriend.name` and `bestFriend.hobby`: different positions, they nest together.
- **Signature** (`signatureOf`): a canonical JSON of what it selects — each step's property, path
  expression, maxCount and inline filter, a size()'s counted path and label, the enclosing
  sub-selects' inner LIMIT/OFFSET/ORDER BY (`context`, with the depth it applies to), or the
  resolved expression IR. The key is not part of it: `[p.bestFriend.name,
  p.bestFriend.preloadFor({query: Person.select((p) => ({name: p.name}))})]` is one field.
- **Filters compare structurally** (`canonicalCondition`): an `ExpressionNode`'s IR with its
  per-build placeholders (`__ref_12__`) replaced by the paths they stand for, dates marked apart
  from strings; an `ExistsCondition` by path, member shape, negation, predicate and chain. Equal
  canonical forms lower identically; anything that differs, even only in form, is refused (safe).

A filtered relation as the field itself (`p.friends.where(…)`) is placed as that relation's own
entry (groups = all its steps, empty key): the row holds it as the `friends` list of `{id}`s
whatever key it has (today's mapping drops the key).

Rules: same position and signature → later seed dropped. Same position, different signature →
refused. A position that is also a relation another seed nests under (`[p.friends,
p.friends.select((f) => f.name)]`, `[p.friends.size(), p.friends.name]`) → refused. Two seeds
nesting under the same relation key at the same depth that read it differently (property, filter,
path expression, or sub-select pagination at that depth) → refused, naming the relation key: the
row has one list there and would keep only one of them.

Refusal message: `Select: the result key "friends" is selected twice with different paths or
sub-selections (friends.name and friends.where(…).hobby); a row holds one value per key.` followed
by advice:

- default: `Select it once, or give each its own key with the object form: select((p) => ({a: …,
  b: …})).`
- the two differ in sub-select pagination (one traversal carries one pagination): `Select it once:
  one select cannot yet read a relation with two different paginations, not even under separate
  keys.`
- either already has an object-form key: at one position `Select it once, or give each a key of
  its own.`; at a shared relation `Select it once: keys of the object form nest under the relation
  their path reads, so they cannot yet keep two reads of one relation apart.`

### What changed behaviour

| Select | Before | Now |
|---|---|---|
| `[p.name, p.name]` | `?a0_name ?a0_name`, mapping throws | `?a0_name`, `{id, name}` |
| `p.friends.select((f) => [f.name, f.name])` | duplicate variable, rows fine | one variable |
| `[p.friends.size(), p.friends.size()]` | two COUNTs, mapping throws | one COUNT |
| `select(['name','name'])`, `FieldSet.for(…, ['name','name'])`, DSL-JSON of it | duplicate variable, mapping throws | one field |
| `{a: p.name, b: p.name}` | `?a0_name ?a0_name` (syntax error in oxigraph) | `?a0_name` once, both keys filled |
| `[p.friends, p.friends.select((f) => f.name)]` | merged silently | refused, key `friends` |
| `[p.friends.where(A), p.friends.where(B)]` | only B applied, duplicate variable | refused |
| `[p.friends.name, p.friends.where(…).name]` | filter applied to both (112 item 1) | refused, key `friends.name` |
| `[p.friends.size(), p.friends]` | mapping throws | refused |
| `[p.friends.select(…).limit(1), p.friends.select(…)]` (same or other fields) | limit applied to both | refused |
| `[p.friends.name, p.friends.where(…Carl).hobby]` | right SPARQL, one `friends` list kept | refused, key `friends`, object-form advice |
| `({all: p.friends.name, carls: p.friends.where(…).hobby})`, `({a: p.friends.where(A), b: p.friends.where(B)})` | one `friends` list kept | refused (backlog 110 lifts it) |
| `[p.friends.where(A), p.friends.where(A).hobby]` | one filtered traversal | unchanged (nest together) |
| `[p.bestFriend.name, p.bestFriend.hobby]`, `[p.friends.select(f=>f.name), p.friends.select(f=>f.hobby)]` | nested together | unchanged |

Backward compatibility: `[p.bestFriend, p.bestFriend.name]`-style selects (a relation and a field
under it) used to merge into one group; they are now refused per decision 4. No test or fixture
in the repo used that shape.

### Files

- `src/queries/projectionDuplicates.ts` — `ProjectionSeed`, `dedupeProjectionSeeds`, the
  canonical forms and the refusal.
- `src/queries/IRLower.ts` — seeds carry `context` / `groupPath`; dedupe call.
- `src/sparql/irToAlgebra.ts` — projection step 7, a variable is listed once.
- `src/sparql/resultMapping.ts` — assertion wording.
- `src/tests/duplicate-projection-fields.test.ts` — exact duplicates (and a filtered relation with
  a field read through the same filter); (flat, nested, across path
  and sub-select, object-form sub-selects, inline filter, quantifier filter, size, preloadFor,
  FieldSet, label select and its DSL-JSON round trip); non-duplicates (object form on one path,
  shared relation, same key at different depths); refusals (relation + sub-select, relation +
  preloadFor, two filters, filtered + unfiltered leaf, size + relation, conflicting keys inside a
  sub-select, relation + nested field inside a sub-select, pagination mismatch, message text,
  object-form pointer for a non-filter conflict); the mapping assertion on a hand-built IR.

### Known limitations

- Positions follow today's row placement, which differs from the types for custom keys on deeper
  paths, sub-select keys, expressions inside a sub-select and a filtered `size()` below the root
  (all placed per today's `resultMapping`). Backlog 110 / step S8 owns moving them together.
- A top-level where on a relation a filtered path also reads is not a projection field and is not
  checked here (backlog 112 item 1).
- `buildCanonicalProjection` in `IRProjection.ts` (test-only helper) does not dedupe.

### Phases (tasks mode, as run)

1. Seeds carry pagination context and group path; `dedupeProjectionSeeds`; wire into
   `lowerSelectQuery`; tests. Gate: typecheck + new tests + goldens. Done.
2. oxigraph check found the object-form duplicate SELECT variable; `irToAlgebra` fix. Done.
3. Review pass (below), docs, changeset, backlog homes, report.
4. After rebasing onto d208c9e (filtered steps get traversals of their own): the master asked to
   refuse `[p.friends.name, p.friends.where(…).hobby]` (one `friends` list kept). Added the
   shared-relation rule and the filtered-relation-leaf placement; oxigraph showed the object form
   collapses too → refused, recorded in backlog 110. Pagination context became depth-keyed.

### Review (self, keep-going)

- Intent and plan fit: decision 4 met; object form, FieldSet, label select, DSL-JSON and
  preloadFor covered. Deviation: `irToAlgebra.ts` (above).
- Gap found and fixed: the refusal pointed at the object form even where the object form gives a
  wrong answer (shared paginated traversal, keys nesting under a relation) — advice split.
- Gap found and fixed: message helper could index `parts[-1]` for an empty path with context.
- Cleanup: the triple blank line in `collectProjectionSeeds` removed.
- Architecture: no architecture doc covers projection keys; nothing to update.

### Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 1 | design | What "same key" means when nested paths share a relation | Row position (relations + key), mirroring result mapping; shared-relation paths are not duplicates | Top-level selection key (would refuse `[p.bestFriend.name, p.bestFriend.hobby]`, an existing golden) | Correctness and backward compatibility; matches decision 4's examples |
| 2 | design | `[p.friends, p.friends.select(…)]` merges fine today | Refuse a key that is both a field and a relation others nest under | Keep merging | Decision 4 names it; ⚠ risky: `[p.bestFriend, p.bestFriend.name]` now throws (no in-repo user) |
| 3 | design | Comparing inline filters | Canonical form with placeholders replaced by their paths | Reference identity (refuses identical rewritten lambdas) | Exact duplicates written twice must dedupe; anything unsure is refused |
| 4 | design | Explicit vs derived key on the same field (preloadFor's `{name}` vs `p.bestFriend.name`) | Key not part of the signature: one field | Refuse | Same value at the same position; nothing to choose |
| 5 | scope | Object form `{a: p.name, b: p.name}` emits a duplicate SELECT variable (oxigraph rejects) | Fix in `irToAlgebra` (project once, as grouped selects did) | Leave to S8 | Task requires the object form keep working; one-line, no row change |
| 6 | message | The object form gives a wrong answer for pagination conflicts (one traversal) and for keyed fields nesting under one relation (110) | Advice per case; object form only where it answers | One message for all | Never steer a user into a silent wrong answer |
| 7 | scope (master's added case) | Fields nested under one relation read two ways keep one list | Refuse at the relation key, array and object form alike | Refuse only the array form | Master's instruction; oxigraph showed the object form collapses too (silent loss) |
| 10 | design | Where a filtered relation leaf (`p.friends.where(…)`) sits | As the relation's own entry, key dropped, as today's rows place it | At its custom key | Mirrors the row; lets equal filters nest and differing ones refuse |
| 8 | timing | Refuse at `toJSON()` too? | Lowering only | Validate in the builder | One check point for all inputs (DSL, FieldSet, builder, DSL-JSON) |
| 9 | changeset | Bump level | patch | minor | Bug fix; refusals replace a later throw or a wrong answer |
