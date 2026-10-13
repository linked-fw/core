---
summary: >
  `contains` ownership is decided per property everywhere (replace, unset, set-remove, array
  overwrite, the linked-id class check, delete by id and bulk delete). The registry-wide predicate
  rule and the `dependent`-typed cascade are replaced by a shape-directed owned-subtree walk
  computed at lowering time (self-loop closures, other recursion unrolled into typed hops up to
  K = 4, sub-shape edges guarded by class per edge, `rdf:nil` never deleted). `contains` needs a
  `shape`, `dependent` is deprecated, and the generated single-owner constraint is a qualified
  count over the declaring class and its registered sub-shapes' classes. Minor.
packages: [core]
---

# 036 — Per-property ownership and a shape-directed cascade

Source: backlog 053 (per-property versus per-predicate ownership, removed with this report).
Contract: [owned-values](../architecture/owned-values.md). User docs: README "Owned properties".
History: [report 025](025-update-replace-contains-cascade.md) (replace cascade),
[report 032](032-owned-replace-noop-and-single-owner-shacl.md) (owned values, single-owner shapes,
`reachableDependentTypes`), [report 034](034-shacl-complex-paths-as-blank-nodes.md) and
[report 035](035-nodekind-driven-blank-nodes.md) (blank-node values and their cascade).
PR: see the end of this report.

## Problem

Before this work ownership was decided two ways:

- **Per predicate** (`collectContainment().containsPreds`): replace, unset, set-remove, array
  overwrite and the linked-id class check treated a property as owning when *any* registered
  shape declared its predicate `contains`. A plain property of shape B on `schema:image` owned its
  values because `@_linked/schema` declares `Thing.image` `contains`.
- **Per shape**: a subject delete (by id and bulk) removed the immediately-owned children of the
  deleted shape's own and inherited `contains` properties.
- Deeper nodes went through one registry-wide cascade `(c1|c2|…)*` over every `contains`
  predicate, guarded by `?own a <DependentType>` and narrowed per delete by
  `reachableDependentTypes`.

So a shape's behaviour depended on which other packages were registered in the process, and a
consuming application had to strip `contains` / `dependent` from user-authored shapes to keep them
from widening library deletes.

## Outcome

- **Ownership is a property's own `contains`** (own or inherited through `extends`), for every
  mutation and for the class check. A plain property on a predicate another shape declares
  `contains` never deletes and is never class-checked.
- **One shape-directed walk** computes the owned subtree of a root shape at lowering time; it
  replaces the predicate alternation and the dependent-type guard.
- **Every node the walk reaches is deleted**; `dependent` has no effect (deprecated).
- **`contains` requires a `shape`**; core's own metamodel drops shape-less `contains`.
- **The single-owner constraint counts owners of the declaring class** (and its registered
  sub-shapes' classes) through `sh:qualifiedValueShape` / `sh:qualifiedMaxCount`.

## Decisions

All decisions are the lead developer's. Numbering follows the plan's ideation (14), then the four
review iterations.

1. **Ownership per property everywhere** (1A). One rule for every mutation; a shape's behaviour no
   longer depends on other registered packages. Rejected: per predicate everywhere (subject
   deletes would delete through plain properties) and keeping the split (two rules, replace stays
   registry-sensitive).
2. **Shape-directed cascade computed at lowering time** (2A). From the deleted / replaced value's
   shape follow its `contains` properties to their value shapes, then theirs. Each hop is an
   explicit path. Rejected: predicate alternation plus a type guard (a plain property on an owned
   predicate leaks back in through the cascade); marking owned edges in the data (migration, extra
   triples, foreign data unmarked).
3. **Single-owner constraint counts owners of the declaring class only** (3A), refined by 6.
   Rejected: counting every subject (reports legitimate references); dropping it (the only
   store-side single-owner check).
4. **`contains` requires a value shape** (4A). `PropertyShape.path` and the four shape-less
   `PathNode` slots (`inversePath`, `zeroOrMorePath`, `oneOrMorePath`, `zeroOrOnePath`) lose
   `contains`: since report 035 their blank values are removed by the blank-capable walk driven by
   `sh:nodeKind`. `PropertyShape.in` (`List`) and `PathNode.alternativePath` (`PathList`) keep it.
   No cleanup of IRI path nodes written before 2.30 is kept (the live test for it was removed);
   the README tells users how to remove them by IRI prefix.
5. **Sub-shapes' `contains` properties are followed, type-guarded** (5A). Per registered
   descendant that adds `contains` properties, a block guarded by its concrete class
   (`?img a ex:Photo . ?img ex:thumbnail ?t`). Core writes the concrete class's `rdf:type` on
   create, so no inference is needed. Rejected: declared value shape only (orphans sub-shape-owned
   values); unguarded union (per-predicate ownership again).
6. **Single-owner owners enumerated by class at sync time** (6B). The qualified shape lists the
   declaring `targetClass` and every registered sub-shape's, because `sh:class` matches a subclass
   instance only through `rdfs:subClassOf` triples, which datasets without inference lack.
   Rejected: `sh:class` on the declaring class only; `sh:node <declaring shape>` (nearly every
   node conforms to an all-optional shape).
7. **Every reached node is deleted; `dependent` is deprecated** (7A). No registry-wide dependent
   set remains, so no registered shape can widen another's deletes. `dependent` is still accepted
   by `@linkedShape` and persisted as `core:dependent`, with no effect. Core's `PropertyShape`,
   `List`, `PathNode`, `PathList` drop it. Behaviour change: an owned value of an owned value that
   is not `dependent` is now deleted with the owner instead of orphaned.
8. **Remove `collectContainment` and `buildOwnedCascade`** (8A), plus the internal
   `reachableDependentTypes`, `ownedValueShapePredicates`, `ownedChildBlankCascade`,
   `shapeHasContainsProperty`, the `Containment` type and `OwnedLink.sharedPredicate`. Nothing in
   the workspace imported them (reachable only through the `./*` subpath). `buildOwnedSelfDelete`
   stays.
9. **Recursion** (9A, superseded by iteration 1): first one closure per strongly connected group;
   the independent review showed a multi-shape group deleted through plain properties and dropped
   sub-shape guards. Final rule below ("Recursion").
10. **`sh:or` as blank `PathList` cells, new metamodel terms** (10A). `shacl.qualifiedValueShape`,
    `shacl.qualifiedMaxCount`, `shacl.or`; accessors `PropertyShape.qualifiedValueShape` (value
    shape `NodeShape`, `sh:BlankNodeOrIRI`), `PropertyShape.qualifiedMaxCount` (integer),
    `NodeShape.class`, `NodeShape.orShapes` (`sh:or`; labelled `orShapes` because `or` is a
    reserved DSL-JSON label; no declared value shape, like `sh:path`, since naming `PathList` by
    IRI failed the build's shape-reference check and importing it is a cycle). The qualified shape
    and its list are blank nodes, removed by the blank cascade of the `owners` property shape.
    `sh:maxCount 1` is dropped (it would count every subject). Rejected: a separate list shape;
    raw triples outside the create pipeline (sync would no longer own and delete them).
11. **Smaller items.** The per-class blank agreement rule (`dependentBlankProps`) is gone: each
    hop's blank values come from that hop's shape (`blankCapableProperties`). `PathList.first`
    stays non-`contains`. A value shape without `targetClass` is followed by edge; a sub-shape
    without `targetClass` cannot be guarded.
12. **Release: minor** (lead decision), hand-written changeset naming every behaviour change and
    removal.
13. **Where `contains` without a shape is refused** (13A): `createPropertyShape`
    (`src/shapes/SHACL.ts`) throws, so decorators fail at load. Shapes registered from data
    (`PropertyShapeData` built directly) are not validated; the walk, the class check and the
    single-owner constraint skip a shape-less `contains` (it owns nothing).
14. **Memoize the walk** per (root shape, registry version) (14A); lowering only instantiates
    variables.

Iteration decisions (from the independent review and three adversarial reviews):

15. **Self-loop closures only; everything else unrolled into typed hops** (iteration 1, H1/H2).
    A closure `p*` only for a shape that owns itself through an unguarded edge; every other
    recursion (several shapes, a guarded sub-shape edge) is explicit hops typed with the declaring
    shape's class or a registered descendant's. Guarded edges never join a closure. Rejected:
    refusing such deletes; a separate query computing the owned set first (two round trips, not
    atomic).
16. **K = 4 unroll limit** (`MAX_OWNED_RECURSION`). Measured total branches of a delete by id: a
    two-shape cycle grows linearly (K = 3 → 6, 4 → 7, 5 → 8; three-shape cycle 7 / 8 / 9); a
    shape with two recursive sub-shape edges doubles per step (K = 3 → 16, 4 → 32, 5 → 64). K = 4
    is the largest value that keeps that case under the 64-branch warning; it unrolls a cycle five
    hops deep. Deeper values are left in place (orphans, the safe direction).
17. **Sub-shape class guard, decided per edge** (iterations 1–3: M3, M-A, M-B, M-1, M-2). A
    sub-shape's added `contains p` is followed under `?n a <SubClass>` unless `blockedGuard`
    refuses it: the sub-shape has no `targetClass`; one of its super-shapes holds the class (the
    parent's own nodes would match); or another shape holding the class, not extending the
    sub-shape, declares `p` as a **plain** property through a simple path (following it would
    delete that shape's references). A holder that does not declare `p`, or owns it too, does not
    block. Each refusal is warned once per (sub-shape, property) with its cause. A sub-shape that is
    a copy of its direct super-shape (same class or none) and adds nothing is skipped silently
    (iteration 4 narrowed this: a sub-shape with a class of its own is always warned). Rejected:
    skipping every shared class (registering an unrelated shape would orphan values); asking the
    application to reject such shapes (core would still be wrong for other callers).
18. **Recursion typing accepts the declaring shape's class and every registered descendant's**
    (iteration 3, M-1): the position is already reached through an owned edge whose value shape is
    the declaring shape, so typing only refuses unrelated classes.
19. **`rdf:nil` is never deleted** (iteration 1, M4): every walk node, its blank-cascade branch
    and the replaced-value self-delete carry `FILTER(!sameTerm(?n, rdf:nil))`. Before, any
    `rdf:List`-typed `rdf:nil` was matched by the dependent guard; the unguarded walk would match
    every triple on it.
20. **Branch count: warn, no cap** (iteration 1, M5). A cap would silently under-delete; lowering
    warns once per root shape above `OWNED_BRANCH_WARNING` (64). Reduction is backlog 055.

## Architecture

### Pipeline

All in `src/sparql/irToAlgebra.ts`:

- `ownedPredicate(ps)` — the simple-path predicate of a `contains` property with a value shape,
  or nothing (a shape-less or complex-path `contains` owns nothing in the walk).
- `classHolders(class)` — registry-wide `targetClass` → shape ids (memoized per registry version).
- `blockedGuard(sub, ps)` — why a sub-shape's added `contains` property cannot be followed from
  nodes of its class, or null (decision 17).
- `ownedEdges(shape)` — the shape's own and inherited `contains` edges (unguarded) plus, per
  registered descendant, its added `contains` edges guarded by its class; deduplicated by
  (guard, predicate, target). Emits the per-edge warnings.
- `shapeClasses(shape)` — the shape's class and every registered descendant's (recursion typing).
- `ownedWalk(root)` — DFS over `ownedEdges` from the root shape. One target per path. A
  self-loop is the target's closure; a hop into a shape already on the path counts as a repeat;
  a path stops after `MAX_OWNED_RECURSION` repeats. A hop is typed when guarded (sub-shape class)
  or when its source and target lie in one strongly connected group of several shapes (the
  declaring shape's `shapeClasses`). Warns once per root above `OWNED_BRANCH_WARNING` targets.
  Memoized per (root, registry version).
- `ownedSubtreeBlocks(rootShapeId, rootTerm, anchor, varPrefix, keep?)` — instantiates the walk
  as UNION branches: anchor triples, the root's closure, typing triples or `?t IN (…)` filters,
  each hop, the node's own triples `?n ?p ?o`, the `rdf:nil` filter, and the node's blank cascade
  (`buildBlankCascade` over the target shape's blank-capable properties). `keep` wraps each block
  in `FILTER(?old NOT IN (…))`.

Contracts (module-internal):

```ts
type OwnedHop = {guard?: string; typeClasses?: string[]; predicate: string; closure: string[]};
type OwnedTarget = {hops: OwnedHop[]; blankProps: PropertyShapeData[]};
type OwnedWalk = {rootClosure: string[]; rootBlankProps: PropertyShapeData[]; targets: OwnedTarget[]};
```

The caller keeps deleting the root itself (subject wildcard, or `buildOwnedSelfDelete` plus the
root's blank cascade), so the walk emits blocks strictly below the root. A root that owns itself
adds one branch `<root> (r…)+ ?n` for its other nodes.

### Callers

| Caller | Root shape | Root term | Anchor |
|---|---|---|---|
| `deleteToAlgebra` (delete by id) | subject shape | subject IRI | none (IRI root) |
| `bulkDeleteUnion` (`deleteAll`, `deleteWhere`) | subject shape | `?a0` | subject type triple |
| `processUpdateFields` replace / unset / array overwrite | property's value shape | `?old_<field>` | owning edge, `keep` filter |
| `processUpdateFields` set-remove | property's value shape | removed IRI | owning edge |

`processUpdateFields` reads the field's property shape once; `isContainsField = !!ps?.contains &&
!!ps.valueShape`. Update, upsert, `updateWhere` and `forAll` all lower through it, as does the
DSL-JSON wire.

`ownedLinkCheck.buildRule` (`src/sparql/ownedLinkCheck.ts`) builds a class-check rule only for
`ps.contains && ps.valueShape`; `sharedPredicate` and its message are gone.

### Emitted shape (one branch)

```sparql
?c_w rdf:type <ex:Photo> .                 # only for a guarded sub-shape hop (or ?t IN (…) in a cycle)
?c_w <ex:thumbnail> ?c_0_0e .
?c_0_0e <ex:next>* ?c_0_0 .                # only when the target shape owns itself
?c_0_0 ?c_0_p ?c_0_o .
FILTER(!(sameTerm(?c_0_0, rdf:nil)))
# + blank cascade of ?c_0_0
```

### Single-owner constraint

`buildSingleOwnerConstraints` (`src/shapes/singleOwnerConstraint.ts`) writes, per `contains`
property with a simple path, one generated NodeShape whose `owners` property shape is:

```turtle
<…/Thing/image.singleOwner/owners> sh:path [ sh:inversePath schema:image ] ;
    sh:qualifiedValueShape [ sh:or ( [ sh:class schema:Thing ] [ sh:class ex:Project ] ) ] ;
    sh:qualifiedMaxCount 1 .
```

Classes: the declaring `targetClass` plus every `getSubShapes` `targetClass`, deduplicated and
sorted. One class → `[ sh:class C ]`. No `targetClass` → no constraint, one `console.warn` per
shape id. Sync rewrites stored constraints on the next run (delete of the NodeShape removes the
generated shapes through `core:generatedShape`, the create writes the new ones nested), so no
migration script is needed. Sub-shapes registered only in another process are missing until a
process that knows them syncs.

## Files

| File | Change |
|---|---|
| `src/sparql/irToAlgebra.ts` | the walk (`ownedPredicate`, `classHolders`, `blockedGuard`, `ownedEdges`, `shapeClasses`, `ownedWalk`, `ownedSubtreeBlocks`), exported `MAX_OWNED_RECURSION` / `OWNED_BRANCH_WARNING`; `processUpdateFields`, `deleteToAlgebra`, `bulkDeleteUnion` use it; `rdf:nil` filter in `buildOwnedSelfDelete`; removed helpers listed in decision 8 |
| `src/sparql/ownedLinkCheck.ts` | per-property rule; `sharedPredicate` removed |
| `src/shapes/SHACL.ts` | `createPropertyShape` throws for `contains` without `shape`; `contains` docstring |
| `src/shapes/singleOwnerConstraint.ts` | qualified constraint, owner-class enumeration, warn-once |
| `src/utils/Package.ts` | `PropertyShape.path` without `contains`; `dependent` dropped from `PropertyShape`; new accessors; `dependent` option deprecated |
| `src/shapes/PathNode.ts`, `PathList.ts`, `List.class.ts` | drop `dependent` and shape-less `contains`; `PathList` doc widened to blank `rdf:List` cells of generated SHACL |
| `src/shapes/nodeShapeData.ts` | `dependent` documented deprecated |
| `src/shapes/syncShapes.ts` | thunk doc |
| `src/ontologies/shacl.ts` | `qualifiedValueShape`, `qualifiedMaxCount`, `or` |
| `src/ontologies/linked-core.ts` | `core:dependent` vocabulary comment (no effect) |

## Public API changes

- **Removed:** `collectContainment`, `buildOwnedCascade` (from `@_linked/core/sparql/irToAlgebra`),
  `OwnedLink.sharedPredicate`. To ask whether a property owns its value, read its own `contains`.
- **Added:** `MAX_OWNED_RECURSION` (4), `OWNED_BRANCH_WARNING` (64) from the same module;
  metamodel accessors `PropertyShape.qualifiedValueShape`, `PropertyShape.qualifiedMaxCount`,
  `NodeShape.class`, `NodeShape.orShapes`; `shacl.qualifiedValueShape`, `shacl.qualifiedMaxCount`,
  `shacl.or`.
- **Throws:** `contains: true` without `shape` at decoration.
- **Deprecated:** `dependent` (shape option and `NodeShapeData.dependent`).

## Behaviour changes

- A plain property on a predicate another shape declares `contains` no longer deletes on replace /
  unset / set-remove / overwrite or subject delete, and links through it are not class-checked.
  Declare `contains` (with a `shape`) on it to keep the old behaviour. Existing data linked that
  way keeps its node (no migration).
- Deeper owned values go with their owner whether or not their shape is `dependent`.
- Sub-shape-added `contains` properties are followed from nodes of the sub-shape's class.
- `rdf:nil` keeps its triples on every list delete or replace.
- The single-owner constraint is qualified; a plain reference from another class conforms.
- Shape sync no longer deletes IRI-named path nodes written before 2.30.
- Fewer solutions per delete: the immediate child is no longer matched twice (replace of a
  `contains` field in a `where` mutation went from 28 to 18 solutions).

## Consumer guidance

A user-authored shape with a `targetClass` of its own is isolated by core: its `contains` is
followed only from nodes of its class, recursion is typed per hop, and a plain property never
owns. Stripping `dependent` from user shapes is pointless (no effect). A user sub-shape of a
library value shape that **takes a library class** and adds `contains x` is followed from every
node of that class, so it can widen library deletes through `x` — unless a registered shape of
that class declares `x` plainly through a simple path, which blocks the guard. A consuming
application that strips `contains` from user-authored shapes therefore keeps one reason to: user
shapes reusing a library class. It can stop once its catalog refuses (or strips `contains` from)
user shapes whose `targetClass` a library shape targets. Its own re-implementation of the
predicate rule (a "contains predicates" helper used by instance writes and document remapping)
must switch to a per-property check.

## Tests

| File | Covers |
|---|---|
| `src/tests/owned-walk-recursion.test.ts` (new, 19: 10 pure, 9 live) | two-shape cycle unrolled into typed hops; unroll depth K; self-loop closure with a guarded sub-shape hop outside it; same-class sub-shape not followed (warned once); same-class profile keeps its parent's guard; class shared with another hierarchy (warning names it); grandchild with a class of its own that cannot be guarded is warned once, while class-less and same-class copies of its parent stay silent; `rdf:nil` filter; branch counts pinned for the metamodel and a schema-like fixture; the branch warning; live: plain reference on an owned predicate kept in a cycle, cycle deleted to depth, sub-shape edge in recursion only from its class, same-class sub-shape, profile, foreign hierarchy, cycle through a shared-class sub-shape node, unrelated sharer without the predicate, `rdf:nil` on delete and replace |
| `src/tests/shacl-cascade.test.ts` | plain property on an owned predicate (no delete); nested walk with self-loop closure; sub-shape guard; deep non-`dependent` owned value; `contains` without `shape` throws; live: plain property keeps its old value, sub-shape owned value deleted, orphan repro, keep list, `deleteAll`, `where` |
| `src/tests/owned-link-check.test.ts` | plain property on a `contains` predicate not checked; contains cases unchanged |
| `src/tests/single-owner-constraint.test.ts` | one class, sorted `sh:or` with sub-shapes, no `targetClass` → `[]` with one warning |
| `src/tests/sparql-fuseki-shape-sync.test.ts` | Jena SHACL on `/ds/shacl`: two sub-shape-class owners → `conforms false` (`QualifiedMaxCountConstraintComponent`), owner + plain reference → `true`, one owner → `true`; blank-node count stable across re-syncs; no stale property shapes, list cells or blank paths |
| `src/tests/shape-sync-output-equivalence.test.ts` | golden sync output (renamed `GOLDEN_SYNC_OUTPUT`), owners constraint updated deliberately |
| `src/tests/blank-nested-nodes.test.ts` | blank `sh:path` deleted on shape-sync delete; a typed `List` cell's blank `rdf:first` member kept |
| `shacl-metamodel`, `shacl-list-pathnode`, `mutation-where-union`, `mutation-decode-concrete-shape` | metamodel assertions and counts adjusted; shape-less `contains` fixtures made plain |

Every repro for the review findings (H1, H2, M3, M4, M-A, M-B, M-1, M-2, and the iteration-4
warning condition) was checked to fail with the pre-fix `irToAlgebra.ts` restored.

Final validation: `npm test` 2245 passed, 120 skipped, 0 failed (100 suites), `[fuseki] live tests: 302 total — 302 passed, 0 failed`, typecheck clean; `npx linked build` OK.

Benchmark (20k owners, Fuseki :3939, base vs branch): `deleteAll` of owners with a two-cell owned
chain ≈0.9 s → ≈0.5 s; `deleteAll` of owners of a plain child ≈0.33 s both; 20 re-syncs of a wide
shape ≈0.26 s both. Branch counts: core metamodel + `@_linked/schema` (41 shapes) at most 8 per
delete (`NodeShape` 8, `PathList` / `PathNode` 5, `PropertyShape` 4, `List` 3, `Thing` /
`CreativeWork` 6, other schema shapes 2–3); synthetic width-3 depth-4 DAG 120 (warns).

## Architecture docs

- `docs/architecture/owned-values.md` rewritten: ownership rule, deletion table, the owned-subtree
  walk (self-loops, unrolled recursion, sub-shapes and the per-edge guard, `rdf:nil`, branch
  count), invariants, blank-node owners, class check, generated single-owner shapes; pointer to
  this report.
- `docs/architecture/ontologies.md` unchanged: the `shacl` shortcut grows only by terms core
  writes, as its rule requires.
- README "Owned properties": per-property rule, delete walk, sub-shape class rule, recursion limit,
  `rdf:nil`, qualified single-owner Turtle, `dependent` deprecated, legacy path-node note.

## Known limitations

- **Complex-path sharers** (L-α): only a sharer's simple paths block a guard; a plain use of the
  predicate inside a complex path does not.
- **Cycle typing vs a plain sharer** (L-γ): inside a cycle, typing accepts a descendant's shared
  class, so a plain sharer does not block there (as an untyped hop outside a cycle would not).
- **An untyped node stops a multi-shape cycle**: values behind it are left (safe direction).
- **`contains` wins**: a sub-shape redeclaring an inherited `contains` property as plain keeps the
  inherited ownership (`getPropertyShapes` keeps both).
- **`forAll` over a cycle shape**: keep filters guard only the root (pre-existing).
- **Unroll depth**: values deeper than `MAX_OWNED_RECURSION` repeats on a non-self-loop cycle are
  orphaned.
- **Branch count** grows with DAG width and recursive sub-shape edges; warning only.
- **Single-owner constraint**: sub-shapes registered only in another process are missing until
  that process syncs; a declaring shape without `targetClass` gets none; ownership through two
  different predicates is not reported.
- **Shapes registered from data** with a shape-less `contains` are not validated (they own
  nothing).

## REVIEW (wrapup)

- Last review's lows closed: the iteration-4 warning condition is pinned by a test that fails
  with the old condition restored (checked); README names the class-less copy case; the consumer
  verdict says "declares plainly through a simple path".
- Code review pass over `git diff main...HEAD`: comments corrected (owned paths rather than
  groups, the former cascade path marked as history, the `parent?.id !== shapeId` reason, the
  inherited-property skip, a schematic note on the SPARQL sketch, the IRI-predicate test), review
  labels removed from test fixture comments, register-for-effect fixtures marked, stale
  `dependent` wording in tests, `Package.ts` and `singleOwnerConstraint.ts` docs fixed. No dead code
  found (`tsc --noUnusedLocals` clean for the changed sources; unreferenced test classes are
  registered for effect).
- Backlog 051 refreshed (the caches it named are gone; four remain).
- PR readiness: changeset (minor) matches final behaviour, architecture doc and README updated,
  tests and build green. Ready for review.

## Follow-ups

- [055](../backlog/055-owned-walk-branch-count.md) — reduce the owned walk's branch count
  (per-target merge, per-level evaluation, shared prefixes).
- [051](../backlog/051-merge-registry-version-caches.md) — fold the registry-version caches in
  `irToAlgebra.ts` (now including `classHoldersCache` and `ownedWalkCache`) into one helper.
- Consumer follow-up (tracked by the consumer): replace its predicate-rule helper with a
  per-property check, and narrow its stripping of `contains` from user-authored shapes to shapes
  reusing a library class (see "Consumer guidance").
