---
summary: >
  Ideation for deciding `contains` ownership per property everywhere (replace, unset, set-remove,
  array overwrite, the linked-id class check, subject and bulk deletes), replacing the
  registry-wide predicate rule with a shape-directed cascade computed at lowering time, and
  narrowing the generated single-owner constraint to owners of the declaring class.
status: Ideation
packages: [core]
source_backlog: docs/backlog/053-per-property-ownership.md
---

# 003 — Per-property ownership

Source: [backlog 053](../backlog/053-per-property-ownership.md). Contract:
[owned-values](../architecture/owned-values.md). History: [report 032](../reports/032-owned-replace-noop-and-single-owner-shacl.md)
(owned values, `reachableDependentTypes`), [report 034](../reports/034-shacl-complex-paths-as-blank-nodes.md)
and [report 035](../reports/035-nodekind-driven-blank-nodes.md) (blank-node values and their cascade).

## Context (from backlog 053)

Ownership is decided two ways today:

- **Per predicate** (`collectContainment().containsPreds`): replace, unset, set-remove, array
  overwrite and the linked-id class check treat a property as owning when *any* registered shape
  declares its predicate `contains`. A plain property of shape B on `schema:image` owns its values
  because `@_linked/schema` declares `Thing.image` `contains`.
- **Per shape**: a subject delete (by id and bulk) removes the immediately-owned children of the
  deleted shape's own and inherited `contains` properties with a value shape only.
- The dependent cascade `(c1|c2|…)*` follows every `contains` predicate in the registry, guarded
  by `?own a <DependentType>`, narrowed per subject delete to `reachableDependentTypes`.
- Blank values (report 035) are deleted through blank-capable (`sh:nodeKind`) properties, not
  through `contains`; the blank cascade is attached to each owner the owned cascade deletes.

## Accepted decisions

### Decision 1 = A — ownership per property everywhere

`contains` means "this accessor owns its value", and only that accessor. Replace, unset,
set-remove, array overwrite, the linked-id class check and subject delete (by id and bulk) all
use the property's own `contains` (own or inherited through `extends`). A plain property on a
predicate that another shape declares `contains` never deletes and is never class-checked.

- Rationale: one rule for every mutation; a shape's behaviour no longer depends on which other
  packages are registered in the process; removes the cross-package interference that forces
  consumers to strip `contains` from user-authored shapes.
- Rejected: **B, per predicate everywhere** — subject deletes would also delete through plain
  properties; deletes more, through shapes that never declared ownership, and keeps the
  cross-package interference. **C, keep the split** — two rules to document and explain; the
  replace path stays registry-sensitive.

### Decision 2 = A — shape-directed cascade walk computed at lowering time

From the deleted / replaced value's shape, follow its own `contains` properties to their value
shapes, then those shapes' `contains` properties, and so on. Each hop is an explicit path
(`<root> c1 ?a . ?a c2 ?b …`); a recursive self-loop (`List` `rdf:rest`, `PathList` `rdf:rest`)
becomes `*` on that predicate. Builds on the reachable-dependent-type walk (report 032 iteration
2) and the blank-capable walk (`blankWalkPredicates`, report 035).

- Rationale: the walk is exactly what per-property ownership means; the cascade can no longer
  traverse an edge only some other shape owns.
- Rejected: **B, predicate alternation plus a type guard** — still traverses edges by predicate,
  so a plain property on an owned predicate leaks back in through the cascade. **C, mark owned
  edges in the data** — needs a data migration and extra triples per edge; data written by
  other tools would carry no markers.

### Decision 3 = A — the single-owner constraint counts owners of the declaring class only

```turtle
sh:property [
  sh:path [ sh:inversePath p ] ;
  sh:qualifiedValueShape [ sh:class <declaring targetClass> ] ;
  sh:qualifiedMaxCount 1 ] .
```

- Rationale: under 1A only the declaring shape's subjects own through `p`; a plain reference
  from another class is allowed and must not be reported.
- Rejected: **B, count every subject** — matches the predicate rule that 1A removes and reports
  legitimate references. **C, drop the constraint** — loses the only store-side check of the
  single-owner rule.

### Decision 4 = A — `contains` requires a value shape

Context: `PropertyShape.path` and the four `PathNode` slots are `contains` without a value shape;
they make the cascade fall back to "every dependent type" (`irToAlgebra.ts:2736-2738`). Since
report 035 their blank values (operator nodes, `PathList` cells) are removed by the blank-capable
walk driven by `sh:nodeKind`, so `contains` on them no longer does anything a shape-directed walk
needs.

Chosen: declaring `contains: true` without a value shape is an error. `contains` is removed from
`PropertyShape.path` and the `PathNode` slots; their blank structure stays covered by the
blank-capable walk. `sh:in` (`List`) and `alternativePath` (`PathList`) keep `contains` — they have
value shapes. **No legacy cleanup:** there are no stored IRI path nodes from before 2.30 (the only
installation is a local development store that can be wiped), so nothing has to keep deleting them.

Rejected: B keep the "every dependent type" fallback for shape-less hops (the exception per-property
ownership removes); C polymorphic value shape (`sh:or (PathNode PathList)`) — needs `sh:or` in the
walk and metamodel for structures the blank walk already handles.

### Decision 5 = A — follow sub-shapes' `contains` properties, type-guarded

Context: value shape `ImageObject`, stored node typed with a registered sub-shape (`Photo`) that
declares an extra `contains` property (`thumbnail`). Becomes routine once shape forms offer
sub-shape choice.

Chosen: the walk emits, per registered sub-shape that adds `contains` properties, a block guarded
by the sub-shape's concrete class (`?img a ex:Photo . ?img ex:thumbnail ?t …`). Core writes the
concrete class's `rdf:type` on create, so no inference is needed. No block when no sub-shape adds
ownership (the common case).

Rejected: B declared value shape only (orphans sub-shape-owned values); C unguarded union of
sub-shapes' predicates (per-predicate ownership again).

### Decision 6 = B — single-owner owners enumerated by class at sync time

Context: owners usually own through an inherited property (a `Project` owns `image` through
`Thing.image`). Datasets without inference or `rdfs:subClassOf` triples would not match
`sh:class schema:Thing` against a node typed only `ex:Project`.

Chosen (refines Decision 3):
```turtle
sh:property [ sh:path [ sh:inversePath p ] ;
  sh:qualifiedValueShape [ sh:or ( [ sh:class <DeclaringClass> ] [ sh:class <SubClass1> ] … ) ] ;
  sh:qualifiedMaxCount 1 ] .
```
The class list is the declaring shape's `targetClass` plus every registered sub-shape's, computed
at sync time (sync rewrites it each run). A declaring shape without `targetClass` gets no
constraint; sync logs it once. Limitation: sub-shapes registered only in another process are
missing until a process that knows them syncs.

Rejected: A `sh:class` on the declaring class only (misses subclass owners without inference);
C `sh:node <declaring shape>` (nearly every node conforms to an all-optional shape).

## Open-item map

`BLOCKER` = must be decided before planning. Line numbers are on `main` at `18b0dd5`.

### Blockers

1. **RESOLVED (Decision 4)** — shape-less `contains` properties under a shape-directed walk.** `PropertyShape.path`
   (`src/utils/Package.ts:680-690`, `contains: true`, no value shape) and the `PathNode` slots
   `inversePath` / `zeroOrMorePath` / `oneOrMorePath` / `zeroOrOnePath` (`src/shapes/PathNode.ts:36,52,57,62`)
   have no value shape. Today they make `reachableDependentTypes` return every dependent type
   (`src/sparql/irToAlgebra.ts:2736-2738`, "keeps the shape-sync delete of a NodeShape exact"),
   and `buildOwnedCascade` relies on the zero-hop `(c…)*` match to delete a dependent-typed root
   (`irToAlgebra.ts:2988-2996`). A shape-directed walk has no next shape at such a hop.
   Candidates to explore: keep "every dependent type reachable" for shape-less hops (typed guard,
   predicate alternation only below that hop); require a value shape (or a list of allowed
   shapes, e.g. `PathNode | PathList`) on every `contains` property; special-case the metamodel.
   Correction to the brief: `sh:in` is *not* shape-less — `PropertyShape.in` declares
   `shape: List` (`Package.ts:790-792`); `PathNode.alternativePath` declares `PathList`
   (`PathNode.ts:41-45`).
2. **RESOLVED (Decision 5)** — sub-shape polymorphism. The value shape is `ImageObject`, but the node
   is typed with a registered sub-shape that declares extra `contains` properties. Today the walk
   already visits sub-shapes (`getSubShapes`, `irToAlgebra.ts:2721`; `src/utils/ShapeClass.ts:338`,
   indexed by `extends`, not by `targetClass`). Under 2A, following a sub-shape's extra properties
   needs a per-type block (`?x a <SubClass>` guard per sub-shape) or unconditional union of all
   sub-shapes' `contains` properties (deletes through properties the actual node's shape may not
   declare when two sub-shapes reuse a predicate). Decide which, and whether the type guard needs
   `rdfs:subClassOf` (project datasets have no inference).
3. **RESOLVED (Decision 6)** — single-owner constraint needs the declaring `targetClass` (3A).**
   `buildSingleOwnerConstraints` (`src/shapes/singleOwnerConstraint.ts:71-96`) uses no
   `targetClass` today and no `qualifiedValueShape` exists anywhere in `src/`. Open: a declaring
   shape without `targetClass` (sync writes it, `src/shapes/syncShapes.ts:82`; delete-by-shape
   already throws in `resolveShapeScanIri`, `irToAlgebra.ts:132`); subclasses of the declaring
   class own through the inherited property but `sh:class` matches them only with
   `rdfs:subClassOf` triples or inference (one `sh:or` of every registered sub-shape class, or one
   constraint per sub-shape?); abstract shapes that are never instantiated.

### Fate of `collectContainment().containsPreds`

Every consumer and its replacement under 1A/2A:

| Consumer | Today | Under 1A/2A |
|---|---|---|
| `processUpdateFields` replace / unset / overwrite / set-remove (`irToAlgebra.ts:2074`, `2087`; set-remove `2107-2145`; replace `2185-2193`, `2294-2320`) | `isContainsField` = predicate in `containsPreds` | `findPropertyShapeById(field.property)?.contains` (already looked up at `2092` for the value shape) |
| `buildOwnedCascade` (`irToAlgebra.ts:2975`, path at `2993-2996`) | `(c1\|…\|cn)*` over all registry `contains` predicates, one block per dependent type | shape-directed per-hop blocks from the root's value shape (Decision 2) |
| `reachableDependentTypes` (`irToAlgebra.ts:2703`, filter at `2735`) | walks own+inherited properties but keeps those whose *predicate* is in `containsPreds` (hybrid) | walks `ps.contains` only; becomes the walk that emits the per-hop paths |
| `ownedLinkCheck.buildRule` (`src/sparql/ownedLinkCheck.ts:107`, `sharedPredicate` at `122`) | checks any property on a `contains` predicate | checks `ps.contains` only; `sharedPredicate` branch and its message go |
| `collectContainment.dependentTypes` / `dependentBlankProps` (`irToAlgebra.ts:2653-2682`) | per class | keep (used by the dependent-type guard and blank cascade); open whether they move into the walk |
| Shape sync (`syncShapes.ts:124`) | indirect, via `DeleteBuilder.from(NodeShape,{id})` | indirect; must stay exact (NodeShape → PropertyShape → path / `sh:in` / generated shapes) |
| CN `containsPredicateIris()` (`create_now/src/utils/ownedProperties.ts:19`, used in `InstanceProvider.ts:204`, `ManagedDocumentRemapService.ts:70,83`) | consumer re-implements the predicate rule | consumer must switch to a per-property check (see consumer impact) |

Per-shape helpers that already follow 1A and stay: `ownedValueShapePredicates` (`irToAlgebra.ts:2573`),
`ownedChildBlankCascade` (`2590`), `shapeHasContainsProperty` (`2612`), used by `deleteToAlgebra`
(`3151`) and `bulkDeleteUnion` (`3252`). Open: whether `containsPreds` is removed from the
`Containment` type (it is exported via `collectContainment`, `irToAlgebra.ts:2632`) or kept for
consumers — public-API question.

### Unknowns / code paths

4. **Update-where, forAll, upsert.** `updateToAlgebra` (`irToAlgebra.ts:2356`) and
   `upsertToAlgebra` (`2372`) go through `buildDeleteInsertPlan` → `processUpdateFields`;
   `updateWhereToAlgebra` (`3403`) calls `processUpdateFields` on a variable subject; forAll and
   where lower to `buildCanonicalUpdateWhereMutationIR` (`src/queries/lower.ts:131-139`). All take
   the per-property rule through `processUpdateFields`; the per-hop cascade must stay correct as
   UNION branches with a variable root (anchor triple, `keepFilter`). Not blocking.
5. **Bulk delete.** `deleteAllToAlgebra` (`3305`) / `deleteWhereToAlgebra` (`3339`) →
   `bulkDeleteUnion` (`3265-3291`, cascade `3288`). Per-hop blocks multiply by matched subject;
   see performance. Not blocking.
6. **Blank cascade attachment.** `buildOwnedCascade` attaches a blank cascade to each
   dependent-typed node it deletes (`irToAlgebra.ts:3030-3048`, `dependentBlankProps`). Under 2A
   the owner of each hop is known by shape, so the blank predicates can come from that shape
   (`blankCapableProperties`, `irToAlgebra.ts:2765`) instead of the per-class agreement rule
   (`2669-2682`, `PathList.first` vs `List.first`). Open whether that rule can go. Not blocking.
7. **`PathList.first` was kept non-`contains` because ownership was per predicate**
   (report 035 decision 3; `src/shapes/PathList.ts:37`). Under 1A it could become `contains`
   without affecting `List.first`. Open; not blocking.
8. **Dependent shapes without `targetClass`** are skipped silently by `collectContainment`
   (`irToAlgebra.ts:2653`) and `reachableDependentTypes` (`2747`). A shape-directed walk could
   follow them by edge without a type guard. Open; not blocking.

### Consumer impact

9. **Applications that strip `contains` / `dependent` from user-authored shapes.** The consuming
   application strips both on every catalog registration (`create_now/src/utils/runtimeShapeRegistry.ts:46-72`,
   `withoutOwnership`; `src/data/shapeInstances.ts:65`; test `src/data/shapeInstances.ownership.test.ts`),
   because "core decides what is an owned edge by PREDICATE across the whole registry".
   - Behaviour change: a user-authored plain property on a library-owned predicate (e.g.
     `schema:image`) stops deleting its old value on replace → orphans where there were none.
   - Under 1A the stripping is no longer needed for isolation (a tenant shape's `contains` only
     affects that shape), but `dependent` still widens the typed guard per class (if the guard
     remains), so stripping `dependent` may still be needed. Open.
   - The consumer's `containsPredicateIris()` (row above) and its comment
     (`ownedProperties.ts:1-13`) encode the predicate rule and must change in step.
10. **Release level — open.** Behaviour change in deletes and in the class check (fewer of
    both) and a changed generated constraint. Minor (safe direction for deletes, documented) vs
    major (observable orphans for plain properties on owned predicates; `containsPreds` removal
    if exported). Record as open; current version 2.30.0 (`package.json`).

### Architecture-doc updates

11. `docs/architecture/owned-values.md`: the "Ownership rule" column of the deletion table, the
    cascade invariants (`(c1|c2|…)*`), "A `contains` property without a `shape`", the class-check
    section ("contains predicate anywhere in the registry"), the generated single-owner shapes
    section (qualified constraint, `targetClass` requirement), the backlog-053 pointer.
    README "Owned properties" (`README.md:286-335`, `380-392`). `src/shapes/SHACL.ts:212-221`
    doc comment. Comment block at `irToAlgebra.ts:2555-2566`.

### Migration / compatibility

12. **Stored generated constraints are rewritten by sync — confirmed.** `buildSyncThunk`
    (`syncShapes.ts:119-129`) deletes the NodeShape (`124`; the owned-child block on
    `generatedShapes`, `Package.ts:916-917`, removes the old constraints) and re-creates it with
    the current ones nested (`125`, data from `syncShapes.ts:96-99`) on every sync. So the 3A
    shape replaces the old one on the next sync, with no migration script. Golden fixture
    `src/tests/shape-sync-output-equivalence.test.ts` pins 2.30.0 output and must be updated
    deliberately.
13. **Typed IRI path nodes written before 2.30:** none exist (the only installation is a local
    development store that can be wiped), so no cleanup is kept (Decision 4).
14. Existing data where a plain property linked a node through an owned predicate keeps its
    node after 1A (nothing deletes it). No data migration; document.

### Testing

15. Test surfaces (all in `src/tests/`, flat `testMatch`, `jest.config.cjs`):
    `shacl-cascade.test.ts` (pure + `[fuseki]`), `blank-nested-nodes.test.ts` (pure + `[fuseki]`),
    `owned-link-check.test.ts` (pure + live), `single-owner-constraint.test.ts` (pure),
    `sparql-fuseki-shape-sync.test.ts` (live, incl. Jena SHACL on `/ds/shacl`),
    `shacl-syncshapes.test.ts`, `shape-sync-output-equivalence.test.ts` (golden),
    `sparql-mutation-golden.test.ts` (golden SPARQL for create/update/delete).
    Needed: a plain property on an owned predicate (no delete on replace/subject delete, no class
    check); per-hop cascade through `List` / `PathList` `rdf:rest*`; sub-shape extra `contains`
    properties; the qualified single-owner constraint validated by Jena (a plain reference from
    another class conforms, a second owner of the declaring class does not).
16. **Commands.**
    - Quick (measured ≈38 s, 6 suites / 136 tests incl. 23 live; live blocks skip when Fuseki is down):
      `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/shacl-cascade.test.ts src/tests/owned-link-check.test.ts src/tests/single-owner-constraint.test.ts src/tests/blank-nested-nodes.test.ts src/tests/sparql-mutation-golden.test.ts src/tests/shape-sync-output-equivalence.test.ts`
    - Full: `npm test` (jest + `npm run typecheck`, ≈30 s plus typecheck; requires Fuseki when
      `CI` is set).
    - Live only: `npm run test:fuseki` (`REQUIRE_FUSEKI=1`, `--testNamePattern='\[fuseki\]'`).
    - Live conventions (report 033): `describeFuseki(name, fn)` from
      `src/test-helpers/fuseki-live.ts:26`, at file top level, prefixes `[fuseki]` and skips when
      Fuseki is unavailable; hooks inside the callback; a shared file-level hook starts with
      `if (!fusekiLive) return;`. One dataset per file (`src/test-helpers/fuseki-test-store.ts`),
      Fuseki on `:3939`, started by `src/tests/global-setup.ts`.
    - Gap: CI (`.github/workflows/pr.yml`) delegates to a shared workflow; whether it runs the live
      suites depends on `CI` being set there (not verifiable from this repo).

### Performance

17. Per-hop blocks replace one closure per dependent type. A deep owned tree (NodeShape →
    PropertyShape → path / `sh:in` → List spine → generated shapes) yields more UNION branches;
    bulk deletes multiply them per subject (report 032 measured 20k-owner `deleteAll` at ≈0.5 s →
    ≈2.5 s before narrowing). Measure the shape-sync delete and a schema-wide bulk delete before
    and after. Recursive `*` on a single predicate is cheaper than `(c1|…|cn)*`. Not blocking.
18. Lowering-time walk cost: memoize per (shape, registry version) as `reachableDependentTypes`
    does (`irToAlgebra.ts:2703-2712`). Not blocking.

### Risks

19. Orphans in consumers that relied on the predicate rule (item 9) — silent, no error.
20. Under-deleting the shape-sync tree if blocker 1 is resolved too narrowly (stale property
    shapes or path nodes in cn-main / project datasets after a sync).
21. A qualified constraint written for a class without `rdfs:subClassOf` triples reports nothing
    for sub-shape owners (blocker 3) — false conformance, the same failure mode report 034 fixed
    for IRI paths.
