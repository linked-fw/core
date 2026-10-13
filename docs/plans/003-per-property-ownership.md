---
summary: >
  Ideation for deciding `contains` ownership per property everywhere (replace, unset, set-remove,
  array overwrite, the linked-id class check, subject and bulk deletes), replacing the
  registry-wide predicate rule with a shape-directed cascade computed at lowering time, and
  narrowing the generated single-owner constraint to owners of the declaring class.
status: Review
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

### Decision 1 of 14 = A — ownership per property everywhere

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

### Decision 2 of 14 = A — shape-directed cascade walk computed at lowering time

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

### Decision 3 of 14 = A — the single-owner constraint counts owners of the declaring class only

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

### Decision 4 of 14 = A — `contains` requires a value shape

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

### Decision 5 of 14 = A — follow sub-shapes' `contains` properties, type-guarded

Context: value shape `ImageObject`, stored node typed with a registered sub-shape (`Photo`) that
declares an extra `contains` property (`thumbnail`). Becomes routine once shape forms offer
sub-shape choice.

Chosen: the walk emits, per registered sub-shape that adds `contains` properties, a block guarded
by the sub-shape's concrete class (`?img a ex:Photo . ?img ex:thumbnail ?t …`). Core writes the
concrete class's `rdf:type` on create, so no inference is needed. No block when no sub-shape adds
ownership (the common case).

Rejected: B declared value shape only (orphans sub-shape-owned values); C unguarded union of
sub-shapes' predicates (per-predicate ownership again).

### Decision 6 of 14 = B — single-owner owners enumerated by class at sync time

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

### Decision 7 of 14 = A — every node the walk reaches is deleted; `dependent` has no effect

Context: today the immediate child of a `contains` property goes on the edge alone, while deeper
nodes go only when they are `dependent`-typed, and the set of dependent classes is registry-wide
(`collectContainment().dependentTypes`, narrowed per delete by `reachableDependentTypes`). Under
2A the walk already knows each hop's shape, so the type no longer selects anything.

Chosen: every node reached through an owned edge (at any depth) has its own triples and blank
values deleted, the rule the immediate child already follows. No registry-wide dependent set
remains, so no registered shape can widen the deletes of another. `dependent` is **deprecated**:
still accepted by `@linkedShape`, still persisted as `core:dependent` by sync, no effect on deletes,
documented as such. Core's own shapes (`PropertyShape`, `List`, `PathNode`, `PathList`) drop it.
Behaviour change (named in the changeset): an owned value of an owned value that is not
`dependent` (e.g. a `contains` property on `ImageObject`) is now deleted with the owner instead of
orphaned.

Rejected: B keep `dependent` as the gate for depth ≥ 2 — two rules for one edge kind; C keep the
registry-wide typed guard — the cross-shape widening this work removes.

### Decision 8 of 14 = A — remove `collectContainment` and `buildOwnedCascade`

Context: both are exported from `src/sparql/irToAlgebra.ts` (reachable through the `./*` subpath
export, not from the `sparql` barrel). Nothing outside core imports them: checked
`create_now/src`, `create_now/packages/*` and every `packages-local/*` checkout. The app's
`containsPredicateIris()` (`src/utils/ownedProperties.ts`) is its own copy of the predicate rule.

Chosen: remove both (and `reachableDependentTypes`, `ownedValueShapePredicates`,
`ownedChildBlankCascade`, `shapeHasContainsProperty`); the shape-directed walk replaces them.
`buildOwnedSelfDelete` stays. The changeset names the removals.

Rejected: B keep `collectContainment` deprecated, still returning `containsPreds` — keeps a
registry scan alive whose only meaning is the rule 1A removes, with no known caller.

### Decision 9 of 14 = A — recursion via strongly connected groups of the shape graph

Context: the walk graph has shapes as nodes and owned edges (`contains` property → value shape).
Self-loops are common (`List.rest`, `NodeShape.generatedShapes`, a comment owning replies);
longer cycles (A owns B owns A) are possible in runtime shapes.

Chosen: group the reachable shapes into strongly connected components (Tarjan). Entering a group
appends `(e1|…|ek)*` over the group's internal owned predicates (one predicate for a self-loop:
exact). Edges between groups are explicit hops. A multi-shape group follows its own owned
predicates without per-member distinction — still only predicates the group's shapes declare
`contains`. Blocks are one per path through the condensed graph, so a value reached two ways is
deleted by two blocks (harmless).

Rejected: B unroll cycles to a fixed depth — silently incomplete; C refuse cycles — legitimate
models have them.

### Decision 10 of 14 = A — `sh:or` written as blank `PathList` cells; new metamodel terms

Context: 6B needs `sh:qualifiedValueShape`, `sh:qualifiedMaxCount` and `sh:or` written through
the create pipeline nested in the NodeShape create, so that the next sync's delete removes them.
`List` cells are IRIs (`List.rest` stays `sh:IRI`), which the blank cascade does not enter.

Chosen: add `sh:qualifiedValueShape`, `sh:qualifiedMaxCount`, `sh:or` to `src/ontologies/shacl.ts`;
metamodel accessors `PropertyShape.qualifiedValueShape` (value shape `NodeShape`, `sh:BlankNodeOrIRI`),
`PropertyShape.qualifiedMaxCount` (integer), `NodeShape.class` and `NodeShape.or` (value shape
`PathList`, `sh:BlankNodeOrIRI`). The qualified shape and the list are blank nodes, removed by the
blank cascade of the `owners` property shape. One owner class → `[ sh:class C ]` (no `sh:or`);
several → `[ sh:or ( [ sh:class A ] [ sh:class B ] … ) ]`, classes sorted for stable output.
`sh:maxCount 1` is dropped (it would count every subject). `PathList`'s doc widens to "a blank
`rdf:List` cell of generated SHACL structure".

Rejected: B a separate list shape for `sh:or` — a third shape targeting `rdf:List`; C raw triples
outside the create pipeline — sync would no longer own and delete them.

### Decision 11 of 14 — smaller open items

- Item 6: the per-class blank agreement rule (`dependentBlankProps`) goes; each hop's blank
  values come from the hop's own shapes (`blankCapableProperties`, sub-shapes included).
- Item 7: `PathList.first` stays non-`contains` (the blank walk covers it; nothing to own).
- Item 8: a value shape without `targetClass` is followed by edge (base hops need no type); a
  sub-shape without `targetClass` cannot be guarded and adds no block (documented).
- Sub-shape guards (5A) are emitted for every registered descendant that adds `contains`
  properties, each with its full extra set (a node is typed only with its concrete class).

### Decision 12 of 14 — release: minor changeset (lead decision)

Hand-written, user-facing. Names: a plain property on a predicate another shape declares
`contains` no longer deletes or class-checks (declare `contains` on the property to keep the old
behaviour); deeper owned values now go with their owner; `contains` without a `shape` throws (add
a `shape`, or drop `contains` and rely on `sh:nodeKind` for blank structure); `dependent` is
deprecated; the single-owner constraint is now qualified by owner class (re-sync to rewrite);
`collectContainment` / `buildOwnedCascade` removed.

### Decision 13 of 14 = A — where `contains` without a value shape is refused

Chosen: `createPropertyShape` (`src/shapes/SHACL.ts`) throws when `contains` is set without
`shape`, so decorators and core's `createPropertyShape` calls fail at load. Shapes registered from
data (`PropertyShapeData` built directly, e.g. a catalog) are not validated; the walk, the class
check and the single-owner constraint skip a shape-less `contains` (it owns nothing).

### Decision 14 of 14 = A — memoize the walk per (root shape, registry version)

The abstract walk (hops, guards, closures, blank properties) is cached like
`reachableDependentTypes` was; lowering only instantiates variables.

## Selected route

1A + 2A (shape-directed walk, Decisions 7, 9, 11, 14) + 4A/13A + 5A + 6B/10A, removal per 8A,
minor release per 12.

## Plan

### Architecture decisions (chosen route)

1. **Ownership is a property's own `contains`** (1A). `processUpdateFields` reads
   `findPropertyShapeById(field.property)` once per field; `isContainsField = !!ps?.contains &&
   !!ps.valueShape` (a shape-less `contains` owns nothing, 13A). `ownedLinkCheck.buildRule` uses
   the same test; `sharedPredicate` and its message go.
2. **One shape-directed walk** (2A, 5A, 7A, 9A, 14A) replaces `collectContainment`,
   `reachableDependentTypes`, `buildOwnedCascade`, `ownedValueShapePredicates`,
   `ownedChildBlankCascade` and `shapeHasContainsProperty`. It is used by the subject delete (root
   = subject shape, root term = subject IRI), the bulk deletes (root term `?a0`, anchor = type
   triple), the `contains` replace / unset / overwrite (root = value shape, root term `?old`,
   anchor = owning edge, `keep` filter) and set-remove (root term = removed IRI, anchor = edge).
   The caller keeps deleting the root itself (subject wildcard / `buildOwnedSelfDelete` + the
   root's blank cascade), so the walk emits blocks strictly below the root.
3. **Single-owner constraint qualified by owner classes** (6B, 10A).
4. **`contains` requires `shape`** (4A, 13A); core metamodel drops `contains` on
   `PropertyShape.path` and the four shape-less `PathNode` slots, and `dependent` everywhere.
5. **`dependent` deprecated** (7A): accepted, persisted, no effect.

### Contracts

```ts
// src/sparql/irToAlgebra.ts (module-internal)
/** One hop of the walk: from the current position, optionally type-guarded, along `predicate`,
 *  then `closure*` inside the target group. */
type OwnedHop = {guard?: string; predicate: string; closure: string[]};
/** A group of nodes the walk deletes: the hops from the root position, and the blank-capable
 *  properties of the group's shapes (sub-shapes included). */
type OwnedTarget = {hops: OwnedHop[]; blankProps: PropertyShapeData[]};
type OwnedWalk = {
  /** Internal predicates of the root's own group: `root (c…)* ?pos` before every hop, and one
   *  extra block `root (c…)+ ?n` for the root group's other nodes. */
  rootClosure: string[];
  rootBlankProps: PropertyShapeData[];
  targets: OwnedTarget[];
};
function ownedWalk(rootShapeId: string): OwnedWalk;            // memoized per registry version
function ownedSubtreeBlocks(
  rootShapeId: string, rootTerm: SparqlTerm, anchor: SparqlTriple[], varPrefix: string,
  keep?: SparqlTerm[],
): {deletePatterns: SparqlTriple[]; whereBlocks: SparqlAlgebraNode[]};
```

Emitted per target (each a UNION branch, `keepFilter`ed on `?old` when given):

```sparql
# root group with internal predicates r…:  <root> (r…)* ?w_p .
?w_p  a <SubClass> .            # only when the hop is a sub-shape's (5A)
?w_p  <c1> ?w1_e . ?w1_e (s…)* ?w1 .   # closure only when the target group has internal preds
?w1 ?w1_p ?w1_o .               # the node's own triples
# + buildBlankCascade(owner ?w1, blankProps)
```

Edges of a shape `S` (`ownedEdges`): every flattened property of `S` with `contains`, a
`valueShape` and a simple path (unguarded); for every registered descendant `U` of `S` with a
`targetClass`, each flattened `contains` property of `U` not in `S`'s flattened set, guarded by
`U.targetClass`. Deduplicated by (guard, predicate, target).

Single-owner data (`buildSingleOwnerConstraints`):

```ts
properties: [{
  __id: `${iri}/owners`, label: 'owners', qualifiedMaxCount: 1,
  path: serializePathToNodeData({inv: {id: predicate}}),
  qualifiedValueShape: classes.length === 1
    ? {shape: NodeShape, class: {id: classes[0]}}
    : {shape: NodeShape, or: blankList(classes.map((c) => ({shape: NodeShape, class: {id: c}})))},
}]
```
`classes` = declaring `targetClass` + every `getSubShapes(nodeShape)` `targetClass`, deduped,
sorted. No `targetClass` → no constraint, `console.warn` once per shape id.

### Files expected to change

- `src/sparql/irToAlgebra.ts` — walk, `processUpdateFields`, `deleteToAlgebra`,
  `bulkDeleteUnion`; remove the replaced helpers and the `Containment` type; comment block.
- `src/sparql/ownedLinkCheck.ts` — per-property rule.
- `src/shapes/SHACL.ts` — throw in `createPropertyShape`; `contains` docstring.
- `src/utils/Package.ts` — `PropertyShape.path` loses `contains`; `dependent` removed from
  `PropertyShape` / `List`; new accessors (`qualifiedValueShape`, `qualifiedMaxCount`,
  `NodeShape.class`, `NodeShape.or`); `dependent` option docstring (deprecated).
- `src/shapes/PathNode.ts`, `src/shapes/PathList.ts`, `src/shapes/List.class.ts` — drop
  `dependent`, shape-less `contains`; docs.
- `src/shapes/nodeShapeData.ts` — `dependent` doc (deprecated).
- `src/ontologies/shacl.ts` — `qualifiedValueShape`, `qualifiedMaxCount`, `or`.
- `src/shapes/singleOwnerConstraint.ts` — qualified constraint.
- Tests: `shacl-cascade`, `blank-nested-nodes`, `owned-link-check`, `single-owner-constraint`,
  `sparql-mutation-golden`, `shape-sync-output-equivalence`, `sparql-fuseki-shape-sync` (Jena),
  plus any suite declaring shape-less `contains`.
- Docs: `docs/architecture/owned-values.md`, `README.md` "Owned properties", `.changeset/*.md`.

### Pitfalls

- Every block must bind its root through the anchor (or an IRI root): an unanchored `?old`
  chain matches every node.
- Shape-sync delete must stay exact: NodeShape → `generatedShapes*` → `sh:property` →
  PropertyShape (own triples + blank `sh:path` / `sh:qualifiedValueShape`) → `sh:in` → `List`
  (`rdf:rest*`). Covered by `sparql-fuseki-shape-sync` and the golden fixture.
- `getSubShapes(Shape)` may be the whole registry: guard blocks only for descendants that add
  `contains` properties.
- Removing `dependent` from `PropertyShape` must not change sync output for user shapes (core
  shapes are not in the golden fixture).
- `NodeShape.class` / `NodeShape.or` add blank-capable properties to `NodeShape`: a NodeShape
  delete gains one blank-cascade branch.

### Architecture compliance

`npx semantu-agents docs architecture` lists `ontologies.md`, `owned-values.md`,
`publishing.md`, `runtime-instances.md`. `owned-values.md` is the contract this work changes; it
is rewritten in Phase 5 (ownership rule column, cascade invariants, shape-less `contains`, class
check, generated shapes). `ontologies.md`: new `sh:` terms go into core's own `shacl` copy, as the
rule there requires for metamodel terms. `publishing.md`: minor changeset, no publish here.
`runtime-instances.md`: no new module state beyond registry-version caches.

### Test strategy

- Package: `@_linked/core` only. Consumer (`create_now`) is not changed (report only).
- Quick gate (≈40 s): `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs
  src/tests/{shacl-cascade,owned-link-check,single-owner-constraint,blank-nested-nodes,sparql-mutation-golden,shape-sync-output-equivalence}.test.ts`
  (starts Fuseki on :3939 via global setup; summary line `[fuseki] live tests: … 0 failed`).
- Full per phase (lead request): `npm test` (jest + typecheck) and `npx linked build`.
- Command source: `package.json` scripts, `jest.config.cjs`, report 033 live conventions.

## Phases

Dependency graph: Phase 1 → Phase 2 → Phase 3; Phase 4 is independent of 1–3 (only
`singleOwnerConstraint.ts`, `shacl.ts`, metamodel accessors) and could run in parallel, but it
touches `Package.ts` like Phase 3, so it runs after it. Phase 5 (docs, changeset) last. Every
phase: quick gate, then `npm test` (0 failed in `[fuseki] live tests`) and `npx linked build`.

### Phase 1 — shape-directed walk and per-property replace — DONE (with Phase 2)

Result: `ownedEdges` / `ownedWalk` / `ownedSubtreeBlocks` in `irToAlgebra.ts`; the six old
helpers and `Containment` removed. Deviation: Phase 2 was folded in, because removing
`collectContainment` forced the `ownedLinkCheck` change and its tests into the same green commit.
Also removed: the live test "complex paths stored by earlier versions" (legacy IRI path cleanup,
Decision 4). Updated counts: `shacl-cascade` delete-size (fewer solutions: the immediate child is
no longer matched twice), `mutation-where-union` replace-size (18, was 28).
Validation: quick gate 137/137 (25 live); `npm test` 2223 passed, 0 failed,
`[fuseki] live tests: 292 total — 292 passed`; `npx linked build` OK.

Tasks:
1. In `irToAlgebra.ts` add `ownedEdges`, `ownedWalk` (Tarjan groups, memoized per registry
   version) and `ownedSubtreeBlocks` per the contract.
2. `processUpdateFields`: `isContainsField` from the field's own property shape (`contains` and
   `valueShape`); replace / unset / overwrite / set-remove use `buildOwnedSelfDelete` + root blank
   cascade + `ownedSubtreeBlocks(valueShape, …)`.
3. `deleteToAlgebra` / `bulkDeleteUnion`: replace immediate-child blocks and the dependent cascade
   with `ownedSubtreeBlocks(query.shape, subject, anchor)`.
4. Remove `collectContainment`, `Containment`, `reachableDependentTypes`, `buildOwnedCascade`,
   `ownedValueShapePredicates`, `ownedChildBlankCascade`, `shapeHasContainsProperty`.
   `ownedLinkCheck` switches to `ps.contains` here already (it imports `collectContainment`);
   its tests are adjusted in Phase 2.
5. Update tests that asserted the old SPARQL (`shacl-cascade`, `blank-nested-nodes`,
   `sparql-mutation-golden`).

Validation (tests in `src/tests/shacl-cascade.test.ts` unless noted):
- `plain property on an owned predicate` — shape `TRef` with plain `ex:owns` (value `TCell`), the
  same predicate `TBox.owns` declares `contains`: assert the update SPARQL has no `?uc` /
  wildcard delete of `?old_…`, only the edge delete.
- `nested walk` — `TBox.owns` → `TCell.next` (self-loop): assert the delete of a TBox contains
  `<box> <ex:owns> ?…` then `(<ex:next>)*` and no `rdf:type` guard; the replace contains the
  `?old` self-delete and a block `?old <ex:next>+ ?…` (root group closure).
- `sub-shape guard` — `TImg` (value shape) and `TPhoto extends TImg` adding `contains thumb`
  (`TThumb`): assert the owner's delete contains `?w a <ex:TPhoto>` followed by `<ex:thumb>`; a
  shape with no ownership-adding sub-shape emits no `a` guard.
- `deep non-dependent owned value` — deleting the owner deletes `owns/next` cells without
  `dependent` (no type triple in the block).
- Live (`describeFuseki`): (a) plain property on a library-owned predicate keeps its old value on
  replace (store: `<r> ex:owns <c1>`, `<c1> ex:label "x"`; update `TRef.owns` → `<c2>`; assert
  `<c1> ex:label "x"` still present); (b) sub-shape owned value deleted (owner → `TImg` node typed
  `ex:TPhoto` with `ex:thumb <t>`, `<t> ex:label "t"`; delete owner; assert `<t>` has no triples);
  (c) existing live cases (orphan repro, keep list, deleteAll, where) still pass with `dependent`
  removed from the fixtures where it is meaningless.
- `blank-nested-nodes`: the blank cascade still deletes a property shape's blank `sh:path` on
  shape-sync delete; the `List.first` agreement test is rewritten to: a typed `List` cell's blank
  `rdf:first` member is kept (List has no blank-capable properties).
- Shape-sync live suite (`sparql-fuseki-shape-sync`) passes unchanged: re-sync leaves no stale
  property shapes, list cells or path blank nodes.
- Quick gate, `npm test`, `npx linked build` pass.

### Phase 2 — class check per property — DONE (in the Phase 1 commit)

Tasks: `ownedLinkCheck.ts` — rule only for `ps.contains && ps.valueShape`; drop `sharedPredicate`
from `OwnedLink` and the message; update file docstring.

Validation (`src/tests/owned-link-check.test.ts`):
- `plain property on a contains predicate is not checked` — `collectOwnedLinks` on a create
  linking `{id}` through a plain property whose predicate another shape declares `contains`:
  assert `[]`.
- existing contains-property cases unchanged (accepted classes, nested, set add, rdf:nil).
- Quick gate, `npm test`, `npx linked build`.

### Phase 3 — `contains` requires a value shape; `dependent` deprecated — DONE

Result: `createPropertyShape` throws for `contains` without `shape`; `PropertyShape.path` and the
four shape-less `PathNode` slots lost `contains`; `PropertyShape`, `List`, `PathNode`, `PathList`
lost `dependent`; `dependent` documented deprecated (option and `NodeShapeData`). Test shapes with
a shape-less `contains` became plain (`mutation-decode-concrete-shape`, `owned-link-check`,
`single-owner-constraint`) or were removed with their tests (`TSlot` in `shacl-cascade`);
metamodel assertions updated (`shacl-metamodel`, `shacl-list-pathnode`).
Validation: `npm test` 2221 passed, 0 failed, `[fuseki] live tests: 291 total — 291 passed`
(shape-sync live suite unchanged: no stale property shapes / list cells / blank paths without
`dependent`); `npx linked build` OK.

Tasks:
1. `createPropertyShape`: throw `` `contains` on "<label>" needs a `shape`: … `` when `contains` is set
   without `shape`.
2. `Package.ts`: `PropertyShape.path` without `contains`; `PropertyShape` and `List` registered
   without `dependent`; `dependent` option docstring → deprecated.
3. `PathNode.ts`: drop `dependent` and `contains` on the four shape-less slots
   (`alternativePath` keeps `contains`, it has `shape: PathList`); `PathList.ts`, `List.class.ts`:
   drop `dependent`; docs.
4. `nodeShapeData.ts` `dependent` doc.
5. Tests declaring shape-less `contains` (`TSlot` in `shacl-cascade`, others found by grep)
   become decoration-throws tests or get a shape.

Validation:
- `contains without a shape throws at decoration` (`shacl-cascade.test.ts`): a
  `@linkedShape` class with `@objectProperty({path, contains: true})` → assert the decoration
  throws with a message naming the property and `shape`.
- Shape-sync live suite still exact (NodeShape delete removes property shapes, `sh:in` cells,
  blank paths) — proves `dependent` was not needed.
- Quick gate, `npm test`, `npx linked build`.

### Phase 4 — qualified single-owner constraint — DONE

Result: `sh:qualifiedValueShape` / `sh:qualifiedMaxCount` / `sh:or` terms; accessors
`PropertyShape.qualifiedValueShape`, `PropertyShape.qualifiedMaxCount`, `NodeShape.class`,
`NodeShape.orShapes`. Deviations: the `sh:or` accessor is labelled `orShapes` (`or` is a
reserved DSL-JSON label), and it declares no value shape (like `sh:path`): naming `PathList` by IRI
failed the build's shape-reference check, and importing it would be a cycle. Golden fixture
updated deliberately (owners: `sh:qualifiedValueShape [ sh:class fx:Fixture ]`,
`sh:qualifiedMaxCount 1`, no `sh:maxCount`). Jena tests: two sub-shape owners → `conforms false`
(`QualifiedMaxCountConstraintComponent`); an owner plus a plain reference → `conforms true`; one
owner → `true`; re-sync leaves the blank-node count unchanged.
Validation: `npm test` 2226 passed, 0 failed, `[fuseki] live tests: 293 total — 293 passed`;
`npx linked build` OK.

Tasks: `shacl.ts` terms; `Package.ts` accessors (`qualifiedValueShape`, `qualifiedMaxCount`,
`NodeShape.class`, `NodeShape.or`); `buildSingleOwnerConstraints` per contract (warn once when no
`targetClass`); `PathList` doc; golden fixture `shape-sync-output-equivalence.test.ts` updated
deliberately (owners: `sh:qualifiedMaxCount 1`, `sh:qualifiedValueShape [ sh:class fx:Fixture ]`,
no `sh:maxCount`).

Validation:
- `single-owner-constraint.test.ts`: one class → `qualifiedValueShape.class`; with a registered
  sub-shape → `or` list of both classes sorted; no `targetClass` → `[]` and one warning across two
  calls.
- Live Jena (`sparql-fuseki-shape-sync.test.ts`, `/ds/shacl`): owner shape `TOwner` (class
  `ex:Owner`) with `contains img`, sub-shapes `TOwnerA`, `TOwnerB`; data `<a> a ex:OwnerA ;
  ex:img <i>`, `<b> a ex:OwnerB ; ex:img <i>` → assert `sh:conforms false`; data `<a> a ex:OwnerA ;
  ex:img <i>`, `<r> a ex:Other ; ex:img <i>` → assert `sh:conforms true`.
- Re-sync removes the old constraint's blank structure (count of blank nodes after two syncs
  equals after one).
- Quick gate, `npm test`, `npx linked build`.

### Phase 5 — docs and changeset — DONE

Result: `owned-values.md` (Ownership, deletion table, owned-subtree walk, invariants, blank-node
owners, class check, generated shapes), README "Owned properties" (per-property rule, delete
walk, single-owner Turtle, `dependent` deprecated, legacy path-node note), `SHACL.ts` `contains`
docstring, `syncShapes.ts` thunk doc, `.changeset/per-property-ownership.md` (minor).
Validation: stale-term grep clean; quick gate 138/138 (24 live); `npm test` 2226 passed, 0
failed, 293 live passed; `npx linked build` OK.

Tasks: rewrite `docs/architecture/owned-values.md` sections (ownership rule column, invariants,
shape-less `contains`, class check, generated shapes, backlog pointer); README "Owned
properties" (ownership rule, what a delete removes, single-owner Turtle, `dependent`
deprecated); `SHACL.ts` `contains` docstring; `.changeset/per-property-ownership.md` (minor,
Decision 12). Backlog 053 is removed at wrapup, not here.

Validation: `grep -n "per predicate\|containsPreds\|collectContainment\|reachableDependentTypes\|buildOwnedCascade" README.md docs/architecture src`
returns no stale hit; quick gate, `npm test`, `npx linked build`.

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

## Review

Evidence: `npm test` 2226 passed, 0 failed, `[fuseki] live tests: 293 total — 293 passed`;
`npx linked build` OK. Benchmark (20k owners, Fuseki :3939, base 1c3a7f3 vs branch): `deleteAll`
of owners with a two-cell owned chain ≈0.9 s → ≈0.5 s; `deleteAll` of owners of a plain child
≈0.33 s both; 20 re-syncs of a wide shape ≈0.26 s both. Architecture: `owned-values.md` rewritten;
`ontologies.md` rule kept (the `shacl` shortcut grows only by terms core writes).

Remaining gaps (all low; the independent review subagent's findings were not received before handback):
- L1: no committed test for a two-shape ownership cycle (probed by hand: `(toA|toB)*` closure, terminates).
- L2: inside a recursive group, sub-shape guards are not applied (union of the group's predicates).
- L3: a sub-shape with the same `targetClass` as its parent cannot be told apart by its guard.
- L4: DAG path enumeration in the walk has no cap (one branch per path).
- L5: golden constant still named `GOLDEN_2_30_0`; README heading keeps "/ `dependent`" for the anchor.
