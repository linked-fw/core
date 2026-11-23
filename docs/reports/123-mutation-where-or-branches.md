---
summary: >
  A delete or update where with `||` (or `isNotDefined()`) required every triple it read, so too
  few subjects changed; it now requires only what every branch needs, as a select's where. Patch.
  Closes backlog 113.
packages: [core]
---

# 123 — `||` and isNotDefined() in a mutation's where

## PR

### Summary

Plan 006, step S10 (decision 23, backlog 113). `deleteWhereToAlgebra` and
`updateWhereToAlgebra` joined the where's traversals and every property triple into the required
pattern. `deleteWhere((p) => p.name.equals('Bob').or(p.bestFriend.hobby.equals('Golf')))` skipped
Bob when he had no best friend. `p.hobby.isNotDefined()` (`!BOUND` on a required triple) matched
nothing. Both builders now use the split a select's where uses (report 122). Triples every branch
needs are joined. A property only some branches read, or one read under `BOUND`/`COALESCE`, is an
OPTIONAL. A traversal only some branches read is an OPTIONAL subtree that holds the properties read
on it.

### Changes

- `src/sparql/irToAlgebra.ts`: `withMutationWhere(base, where, wherePatterns, registry)` (uses
  `collectRequiredAliases`, `collectRequiredBindingKeys`, `processExpressionForProperties`'
  required/optional split), called by `deleteWhereToAlgebra` and `updateWhereToAlgebra`.
  `buildUpdateWhere` is unchanged: it adds the update's old-value OPTIONALs after the where, which
  already were OPTIONAL.
- Tests:
  - New `src/tests/mutation-where-or-branches.test.ts`: 3 lowering tests and 4 `[fuseki]` tests.
  - Five goldens in `src/tests/sparql-mutation-golden.test.ts` ("|| and isNotDefined() in a
    mutation where"), including an unchanged conjunction. No existing golden changed.
- Docs:
  - README (Delete): a where with `or` / `isNotDefined()`.
  - `documentation/sparql-algebra.md`: the "Mutation where" section.
  - `.changeset/mutation-where-or-branches.md`: **patch**.
- Backlog 113 removed. Plan 006 Progress: S10 ticked.

### Verification

```
$ time npx tsc -p tsconfig-tests.json --noEmit
real	0m11.608s                (exit 0, no diagnostics)

$ time NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs \
    src/tests/mutation-where-or-branches.test.ts src/tests/sparql-mutation-golden.test.ts \
    src/tests/mutation-where-union.test.ts src/tests/mutation-builder.test.ts \
    src/tests/mutation-serialization.test.ts src/tests/lower.test.ts \
    src/tests/quantifier-outer-refs-and-aggregates.test.ts
Test Suites: 7 passed, 7 total
Tests:       16 skipped, 165 passed, 181 total
real	0m9.255s
```

The skipped tests are `[fuseki]` blocks (no Docker). I also ran the whole regular set once as a
wider check, before adding the tests: `Tests: 51 failed, 652 skipped, 2987 passed` in 39 s. All 51
failures are in the three suites that need `lib/` (`two-copies-built`, `two-copies-entry-points`,
`ontology-load-files`), as before this change.

**oxigraph** (npm `oxigraph` 0.5.13 in `/tmp/s9-oxigraph`, not a dependency). I ran the new test
file with its store helpers swapped for an in-memory oxigraph store, and all 7 tests passed, the
4 live ones included. The dataset:

- bob: no best friend, no hobby
- carl: best friend ann, no hobby
- ann: Golf
- erik: Chess, best friend carl
- dirk: nothing

Each update ran on a fresh copy of the data. The persons left afterwards (`id=hobby`), on this
branch and on the base (a detached worktree of `ccr-88cd3a37-okakn0`, removed after):

| Mutation | This branch | Base |
|---|---|---|
| `deleteWhere(name Bob or bestFriend.hobby Golf)` | `ann=Golf, dirk, erik=Chess` | `ann=Golf, bob, dirk, erik=Chess` (bob kept) |
| `deleteWhere(hobby isNotDefined)` | `ann=Golf, erik=Chess` | nothing deleted |
| `deleteWhere(name Carl and bestFriend.hobby Golf)` | `ann=Golf, bob, dirk, erik=Chess` | same |
| `update({hobby: 'Jog'}).where(name Bob or hobby Golf)` | `ann=Jog, bob=Jog, carl, dirk, erik=Chess` | bob not updated |
| `update({hobby: 'Jog'}).where(hobby isNotDefined)` | `ann=Golf, bob=Jog, carl=Jog, dirk=Jog, erik=Chess` | nothing updated |

### Deviations

- `buildUpdateWhere` is named in the plan but needed no change. The where is built before it, in
  `updateWhereToAlgebra`, and its own triples (old values, expression traversals) were already
  OPTIONAL.

### Follow-ups

None found.

## Details

- **Order in the WHERE:** base pattern (type triple, the delete's root wildcard), required
  traversals, required property triples, OPTIONAL property triples on the subject or a required
  node, OPTIONAL traversal subtrees, then the FILTER. A where with no `||`/`BOUND` produces the same
  text as before (all goldens unchanged).
- **Quantifiers** in a mutation's where were already right: they go through the select's EXISTS
  conversion, which report 122 split the same way.
- **Autonomous decisions**

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 1 | design | Duplicate the select's logic or share it | One helper for both mutation builders, reusing the select's `collectRequiredAliases` / `collectRequiredBindingKeys` | Route mutations through `selectToAlgebra` | Mutation wheres have their own base pattern (root wildcard, old values); the helper keeps them as they are |
| 2 | scope | `buildUpdateWhere` named in the plan | Unchanged (Deviations) | Move the where into it | Its triples were already OPTIONAL; moving code adds risk with no change in answers |
