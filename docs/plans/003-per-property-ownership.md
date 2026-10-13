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

## Review (independent)

Scope: `git diff main...HEAD` on `feat/per-property-ownership` (through `0548b83`). Live probes were
scratch jest files against Fuseki :3939 (deleted afterwards). Evidence: `npm test` 2226 passed,
0 failed, `[fuseki] live tests: 293 total — 293 passed`; `tsc -p tsconfig-tests.json` exit 0.

### Critical

No findings.

### High

1. **A recursive group of several shapes follows every member's owned predicates from every
   group node, so it deletes through plain properties** (`src/sparql/irToAlgebra.ts:2865-2871`
   `closureOf`, `2879-2891` `visit`, `2950-2962`). Scenario (live, reproduced): `RA { contains toB: RB;
   plain peer on ex:toA }`, `RB { contains toA: RA }`. Data `a1 ex:toB b1 ; ex:toA a2` (a2 is a plain
   reference). `DeleteBuilder.from(RA, a1)` emits `<a1> (ex:toB|ex:toA)+ ?r` and deletes `a2`
   (2 triples → 0). The same holds for outgoing hops: an edge declared by member B is applied at
   nodes that are A's. This is the cross-property leak Decision 1 removes; Decision 9 accepted
   "without per-member distinction" but not this consequence. Fix: when a group member (or any
   reachable shape) has a non-`contains` property on one of the group's closure predicates,
   refuse at lowering (throw naming the shapes) or fall back to per-member typed hops; never emit
   an untyped closure over a predicate someone uses as a reference.
2. **Sub-shape guards are dropped inside recursive groups** (the implementer's L2 understated;
   `closureOf` keeps guarded edges, `irToAlgebra.ts:2868`). Scenario (live, reproduced): `SC {
   contains replies: SC; plain fork: SC }`, `SCSub extends SC { contains fork: SC }`. Data `c1
   replies c2` (c2 a plain `SC`), `c2 fork c5`. Deleting `c1` emits `(replies|fork)*` and deletes
   `c5` (2 → 0), although `c2` is not an `SCSub`. It also makes deletes registry-sensitive again:
   any registered sub-shape of `Thing` (another package, a tenant catalog shape) adding
   `contains x: Thing` turns `Thing` into a self-loop group and adds `x`, unguarded, to every
   Thing-rooted delete. Fix: build the closure from unguarded edges only; turn a guarded
   intra-group edge into an explicit guarded hop (or refuse it), and say so in owned-values.md.

### Medium

3. **A sub-shape with its parent's `targetClass` (or two sub-shapes sharing a class) guards
   nothing** (`irToAlgebra.ts:2792-2797`, implementer's L3). Live: `HBSame extends HB` (same class
   `ex:HB`) adds `contains extra`; deleting through `HB`, which declares no `extra`, deleted the
   `extra` value (2 → 0). Common for profile-style shapes of one class. Fix: skip (and warn) a
   sub-shape whose `targetClass` equals an ancestor's; document.
4. **`rdf:nil` loses its triples on every List walk** (`List.rest` is `contains` with shape
   `List`, so `rdf:rest+` reaches `rdf:nil`; `emit` deletes `rdf:nil ?p ?o`,
   `irToAlgebra.ts:2931-2934`). Live: `rdf:nil a rdf:List ; rdfs:label "nil"` → 0 triples after
   deleting a list holder. On main only a `rdf:List`-typed `rdf:nil` matched (dependent guard); now
   any triple does. A dataset holding the RDF vocabulary loses `rdf:nil`'s description on every
   NodeShape sync that rewrites an `sh:in` list. Fix: `FILTER(!sameTerm(?n, rdf:nil))` in `emit`
   (or stop closures at `rdf:nil`).
5. **Path enumeration is exponential, no cap** (`visit` has a per-call `seen` only,
   `irToAlgebra.ts:2879-2891`; implementer's L4). Measured: core metamodel + `@_linked/schema`
   shapes (42 registered) — NodeShape delete 8 UNION branches (3.4 KB), Thing 6, CreativeWork 6,
   PathList / PathNode 5, PropertyShape 4: fine. A synthetic DAG of 19 shapes (width 3, depth 6,
   each shape owning the 3 of the next layer) gives **1094 branches / 416 KB of SPARQL** for one
   delete by id, and 1093 for `deleteAll`. Fix: one branch per target group (merge incoming
   unguarded hop sequences into one alternation path), or throw above a branch cap.
6. **Leftover scratch test committed**: `src/tests/zz-review-walk.test.ts` (added in `0548b83`;
   prints SPARQL with `console.log`, no assertions, `as any`). At review time it was deleted in
   the working tree but not committed. Fix: `git rm` it in the branch.
7. **Consumer guidance**: the plan (item 9) suggests stripping `contains` from user-authored
   shapes is no longer needed. With findings 2-3, a catalog shape extending a library shape still
   widens deletes of library-class nodes through the parent shape. CN must keep
   `withoutOwnership` (`create_now/src/utils/runtimeShapeRegistry.ts`). Fix: say so in the
   changeset / owned-values.md.

### Low

8. Docs overclaim: README "Owned properties" ("follows the shapes, never the predicates"; sub-shape
   properties followed "only from nodes of that sub-shape's class") and owned-values.md
   (Sub-shapes bullet) are false inside recursive groups (findings 1-2). Fix with the code fix.
9. Stale comment: `src/ontologies/linked-core.ts:29` still says `dependent` instances "may be
   deleted when reached via a `contains` edge".
10. Removed exports in a minor (`collectContainment`, `buildOwnedCascade`, `OwnedLink.sharedPredicate`):
    no importer in `create_now/src`, `packages/*` or any `packages-local/*`; only a comment in
    `create_now/src/utils/ownedProperties.ts:3-7`, which also still describes the predicate rule.
    Reachable only through the `./*` subpath and named in the changeset: acceptable.
11. Tests missing for: two-shape cycle, multi-member group precision, sub-shape guard inside a
    group, same-class sub-shape, `rdf:nil`, a branch-count bound. `GOLDEN_2_30_0` name (L5).

### Verified correct

- Per-property rule: `processUpdateFields` derives `valueShapeId` from the field's own property
  shape once (`irToAlgebra.ts:2085-2089`) for set-remove, replace, unset, array overwrite and nested
  create; update / upsert / updateWhere / forAll and the DSL-JSON wire all lower through it.
  `ownedLinkCheck.ts:102` is per property. No predicate-rule leftover in `src/` (grep).
- Live probes: two-shape cycle `(toB|toA)*` terminates and deletes the chain; sub-shape guard out
  of a group deletes `SCSub`'s attachment and keeps a plain `SC`'s; a node typed with two classes
  is walked; shared node: delete via plain `HB` keeps it, delete via owning `HA` deletes it (the
  `HB` edge dangles, as documented); plain-property replace keeps the old value; `.where()` with a
  four-level chain deletes only the matched owner's subtree, `deleteAll` then the rest, an unowned
  `SC` chain untouched; array overwrite and set-remove inside a recursive group delete the old
  subtree (sub-shape attachment included) and keep re-sent ids.
- Blank structure: shape-sync live suite (blank count stable across re-syncs, no orphan blank
  nodes) passes; golden diff is only the qualified owners constraint (`sh:maxCount` →
  `sh:qualifiedValueShape [ sh:class fx:Fixture ]` + `sh:qualifiedMaxCount 1`).
- Single-owner (Jena, `/ds/shacl`): two sub-shape-class owners → `conforms false`
  (`QualifiedMaxCountConstraintComponent`); owner + plain reference from another class → `true`;
  one owner → `true`; no-`targetClass` shape → no constraint, one warning (unit).
- Architecture: `owned-values.md` rewritten as planned; findings 1-2 contradict its own
  ownership statement until fixed.

## Iteration 1 — Ideation

Selected: independent-review findings 1–5, 7–9, 11 (finding 6, the stray probe, is removed in
`96ef64a`; finding 10 is accepted). Decisions are the lead developer's.

### Gap 1 of 5: recursive groups delete through plain properties (H1) and drop sub-shape guards (H2)

Context: `closureOf` unions every member's owned predicates (guarded ones included) into one
`(p…)*` closure, so a node of member A is walked through a predicate only member B owns (H1), and
a sub-shape's guarded edge is followed from every node of the group (H2).

Chosen: a closure (`p*` / `+`) only for a shape that owns *itself* through an unguarded edge
(`S` declares `contains p` with value shape `S`): every `p` edge from an `S` node is then owned by
`S`'s own declaration. Every other recursion (a group of several shapes, a guarded sub-shape edge
into or inside a group) is **unrolled** into explicit per-hop steps, each typed with the declaring
shape's class (`?n a <Class> . ?n <p> ?m`; a sub-shape hop with the sub-shape's class). Unrolling
stops after `K` repeated shapes on one path (a hop whose target shape already occurs on the path);
values below that depth are left in place (orphans, the safe direction), documented. Guarded edges
never join a closure. Refinement: an unguarded recursive hop is typed with the declaring shape's
class *or a registered sub-shape's* (`?n a ?t FILTER(?t IN (…))`), since a node carries only its
concrete class; with one class it is a plain `?n a <C>` triple.

Rejected: refusing such deletes (legitimate models); extra queries to compute the owned set first
(two round trips per mutation, not atomic).

### Gap 2 of 5: a sub-shape with its parent's class guards nothing (M3)

Chosen: a registered sub-shape whose `targetClass` is also held by the walked shape or by another
of its descendants cannot be told apart by `rdf:type`, so its extra `contains` edges are not
followed; core warns once per such sub-shape. Rejected: following them unguarded (per-predicate
ownership again).

### Gap 3 of 5: the walk deletes `rdf:nil`'s triples (M4)

Chosen: every node the walk (and the replaced-value self-delete) deletes is filtered with
`FILTER(!sameTerm(?n, rdf:nil))`. Rejected: stopping closures at `rdf:nil` (a path cannot exclude
an end node; the filter is needed anyway).

### Gap 4 of 5: branch count is exponential in DAG width, no cap (M5)

Chosen: no hard cap (a cap would silently under-delete). A unit test pins the branch counts of the
core metamodel shapes and of a schema-like fixture; lowering warns once per root shape above 64
branches. New backlog item for reducing branch counts (shared-prefix / per-level strategies).
Rejected: throwing above a cap (turns a slow delete into a failed one).

### Gap 5 of 5: docs overclaims and missing tests (L8, L9, L11, golden name, M7)

Chosen: correct README, `owned-values.md`, changeset and `linked-core.ts:29`; rename
`GOLDEN_2_30_0` to a version-neutral name; add tests for a two-shape cycle (terminates, precise),
multi-member group precision (H1 repro keeps the plainly-referenced node), guard inside recursion
(H2 repro), same-class sub-shape (M3), `rdf:nil` kept, branch-count bound. Each H/M repro must
fail on the pre-iteration code (checked by reverting `src/sparql/irToAlgebra.ts` temporarily).
The consumer note (M7, `withoutOwnership`) is re-evaluated after the fix, below.

## Iteration 1 — Plan

- `src/sparql/irToAlgebra.ts`:
  - `ownedEdges(S)`: unguarded edges from `S`'s own and inherited `contains`; per descendant with a
    `targetClass` held by no other shape in `{S} ∪ descendants(S)`, its extra `contains`, guarded
    by that class; otherwise warn once per sub-shape (Gap 2).
  - `ownedWalk(root)`: `closureOf(S)` = `S`'s unguarded edges with target `S`. A DFS from the root
    emits one target per path; a hop whose target already occurs on the path counts as a repeat,
    and a path stops after `MAX_OWNED_RECURSION = K` repeats. A hop is typed when guarded (the
    sub-shape class) or when its source and target lie in one strongly connected group of several
    shapes (the declaring shape's class and its sub-shapes' classes). Warn once per root above
    `OWNED_BRANCH_WARNING = 64` targets (Gap 4).
  - `ownedSubtreeBlocks`: typing triples / `IN` filters and `FILTER(!sameTerm(?n, rdf:nil))` on
    every deleted node, wrapped around the BGP and the blank cascade (Gap 3).
  - `buildOwnedSelfDelete`: the same `rdf:nil` filter for a variable old value.
- Contracts: `OwnedHop` gains `typeClasses?: string[]` (the source node must have one of them);
  `OwnedTarget.blankProps` is the target shape's own (no group union).
- Tests: `src/tests/owned-walk-recursion.test.ts` (new; pure + `[fuseki]`), updates in
  `shacl-cascade`, branch-count test.
- Docs: README, `owned-values.md`, changeset, `linked-core.ts`, golden rename; backlog doc.
- Pitfall: the real metamodel only has self-loops (`List.rest`, `NodeShape.generatedShapes`), so
  shape sync output and its delete must not change beyond the `rdf:nil` filter.

## Iteration 1 — Phases

### Phase 6: precise recursion and same-class sub-shapes (Gaps 1, 2) — DONE (with Phase 7)

Tasks: `ownedEdges` / `ownedWalk` / `ownedSubtreeBlocks` per the plan; measure `K`.
Validation (`src/tests/owned-walk-recursion.test.ts`):
- H1 repro (`RA {contains toB: RB; plain peer on ex:toA}`, `RB {contains toA: RA}`): pure — no
  closure over `ex:toA|ex:toB`; live — deleting `a1` (`a1 toB b1 ; toA a2`, `b1 toA a3`) deletes
  `b1`, `a3`, keeps `a2`.
- Two-shape cycle: the walk terminates; live chain `a1→b1→a2→b2` is deleted to depth `K`.
- H2 repro (`SC {contains replies: SC; plain fork: SC}`, `SCSub extends SC {contains fork: SC}`):
  pure — closure is `replies*` only and `fork` is behind `a <SCSub>`; live — `c1 replies c2`,
  `c2 fork c5` (c2 a plain SC): `c5` kept; with `c2 a SCSub`, `c5` deleted.
- M3 repro (`HBSame extends HB`, same class, `contains extra`): deleting through `HB` keeps the
  `extra` value; one warning.
- Each repro fails with `src/sparql/irToAlgebra.ts` reverted to `83e9a51`.
- Quick gate, `npm test` (0 failed live), `npx linked build`.

### Phase 7: `rdf:nil` and branch counts (Gaps 3, 4) — DONE (in the Phase 6 commit)

Result (Phases 6 + 7, one commit: the rewritten emitter carries the typing and the `rdf:nil`
filter together): self-loop closures only; other recursion unrolled into typed hops
(`MAX_OWNED_RECURSION` K = 4); a sub-shape whose class is shared is skipped with one warning;
`FILTER(!sameTerm(?n, rdf:nil))` on every walk node and on the replaced-value self-delete;
`OWNED_BRANCH_WARNING` = 64; backlog 055. Typing refinement: an unguarded recursive hop accepts the
declaring shape's class or a registered sub-shape's (`?t IN (…)`).

K choice (measured, total UNION branches of a delete by id): a two-shape cycle grows linearly
(RA/RB: K = 3 → 6, 4 → 7, 5 → 8; a three-shape cycle 7 / 8 / 9); a shape with two recursive
sub-shape edges doubles per step (K = 3 → 16, 4 → 32, 5 → 64). K = 4 is the largest value that keeps
that case clearly under the 64-branch warning; it unrolls a cycle five hops deep. Real
models are unaffected (only self-loops): core metamodel + `@_linked/schema`, 41 shapes, max 8
branches (NodeShape 8, PathList / PathNode 5, PropertyShape 4, List 3, Thing / CreativeWork 6,
every other schema shape 2–3); synthetic width-3 depth-4 DAG 120 (warns).

Tests: `src/tests/owned-walk-recursion.test.ts` (7 pure, 5 live): all 12 fail with
`irToAlgebra.ts` from `83e9a51` (checked). `shacl-cascade` expectations gained the `rdf:nil`
filter. Validation: quick gate green; `npm test` 2238 passed, 0 failed,
`[fuseki] live tests: 298 total — 298 passed`; `npx linked build` OK.

Tasks: nil filter; branch warning; backlog doc.
Validation: `rdf:nil a rdf:List ; rdfs:label "nil"` keeps its triples after deleting a list holder
and after replacing an `sh:in` list (live, fails on `83e9a51`); branch-count test pins NodeShape /
PropertyShape / List / PathNode / PathList and a schema-like `Thing`/`ImageObject` fixture, and the
warning fires once above 64 for a synthetic wide DAG. Gates as above.

### Phase 8: docs and names (Gap 5) — DONE

Result: README (walk, sub-shape class rule, recursion limit, `rdf:nil`), `owned-values.md`
(self-loop closures, unrolled recursion, sub-shapes, `rdf:nil`, branch count, backlog 055),
changeset, `linked-core.ts` vocabulary comment, `SHACL.ts` / `Package.ts` depth claims;
`GOLDEN_2_30_0` → `GOLDEN_SYNC_OUTPUT`.

**Consumer verdict (M7, `withoutOwnership` in the app's `runtimeShapeRegistry.ts`).** After this
iteration a user-authored shape's `contains` can no longer widen deletes of nodes it does not
type: from a library shape's walk, a user sub-shape's added `contains` is followed only from nodes
of the sub-shape's own class (and not at all when it shares the library class), recursion is
typed per hop, and a plain property never owns. So stripping is **no longer needed for
isolation**, and stripping `dependent` is pointless (no effect). What `contains` on a user shape
still does is what it declares: deleting or replacing that shape's own nodes deletes their owned
values, links into it are class-checked, and sync writes its single-owner constraint. The one
reason left to keep stripping `contains` is the app's own rule that owned values are minted
server-side and never accepted as client references (`ownedProperties.ts`): a user-authored
`contains` property that accepts a client `{id}` of the right class would delete that node on the
next replace. Verdict: the app can drop `withoutOwnership` once its instance writes enforce that
rule for user-authored `contains` properties (or it keeps stripping `contains` only); the
reviewer's "must keep" (from H2 / M3) no longer holds.

Re-checked after iteration 2 (Review 2, M-C): M-B (a user sub-shape claiming a library class) is
now skipped by the registry-wide `classGuard`, so it cannot widen library deletes; M-A (a same-class
user profile switching off a library sub-shape's ownership) is fixed, and a profile that adds
nothing is ignored.

Re-checked after iteration 3 (Review 3, M-2): the guard is now decided per edge. A user shape
that takes a library sub-shape's class no longer switches that sub-shape's ownership off unless
it declares the same predicate as a plain property; in that one case the library edge is not
followed (warned) — the safe direction, since following it would delete the user shape's
references. A user sub-shape claiming a library class with a plain property on the predicate is
skipped (M-B).

Corrected after Review 4 (M-α): a user sub-shape of a library value shape that **takes a library
class** (for example `UClaim extends Media` with `targetClass Photo`) and adds `contains x` is
followed from every node of that class, so it *can* widen library deletes through `x`. Harm needs
a reference on `x` that no registered shape of that class declares plainly (a plainly declared one
blocks the guard). Final verdict: `withoutOwnership` keeps one job — stopping user shapes that
reuse a library class from adding ownership to library-class nodes. The app can drop it once its
catalog refuses (or strips `contains` from) user shapes whose `targetClass` is a class a library
shape targets; user shapes with classes of their own are isolated by core. Stripping `dependent`
is pointless either way (no effect).

Tasks: README, `owned-values.md`, changeset, `linked-core.ts:29`, golden rename, consumer verdict
in this doc. Validation: stale-claim grep; gates as above.

## Review 2 (adversarial, after iteration 1)

Live probes on :3939 (scratch deleted, tree clean). H1, H2, M3 (direct), M4, M5 verified fixed;
no variable collisions; bulk / where / forAll / set-remove paths exact; caches and warnings OK.

- **M-A** A same-class profile under a library sub-shape switches the library sub-shape off
  (`holders` counts the class twice and skips both; the warning wrongly says "no targetClass").
- **M-B** A sub-shape whose class is also held by a shape outside the walked hierarchy guards
  nothing: `?n a <C>` matches the other shape's nodes and deletes through its plain property.
- **M-C** The consumer verdict does not hold until M-A / M-B are fixed.
- L-1 docs understate the skip rule; L-2 an untyped node inside a multi-shape cycle stops the walk
  (safe direction, regression from main); L-3 a sub-shape redeclaring an inherited `contains`
  property as plain is ignored ("contains wins"); L-4 forAll over a cycle shape: keep filters
  guard only the root (pre-existing); L-5 the blank cascade of a walk node lacks the `rdf:nil`
  filter.

## Iteration 2 — Ideation

### Gap 1 of 3: which sub-shapes a class guard can tell apart (M-A, M-B)

Chosen: a sub-shape `U` is guardable by its `targetClass` `C` only when every registered shape
holding `C` (registry-wide) is `U` itself or a descendant of `U`. Then `?n a <C>` matches only
nodes of `U` or of shapes that inherit `U`'s `contains` properties. Same-class descendants of a
guardable `U` (profiles) add no guard of their own and are skipped (they are `U` nodes by type);
a sub-shape sharing its class with a shape that is not its descendant (its parent, a sibling,
another hierarchy) is skipped. Warnings name the cause (no `targetClass` / shares `<C>` with
`<shape>`). Recursion typing uses the same guardable classes. Rejected: counting only within the
walked hierarchy (M-B); skipping every holder of a shared class (M-A).

### Gap 2 of 3: blank cascade of a walk node and `rdf:nil` (L-5)

Chosen (cheap, same rule everywhere): the blank cascade branch of a walk node carries the node's
`rdf:nil` filter too.

### Gap 3 of 3: docs and the consumer verdict (M-C, L-1, L-2, L-3)

Chosen: document the guardable rule, the untyped-node stop inside multi-shape cycles (L-2), and
"`contains` wins" for a sub-shape redeclaring an inherited `contains` property as plain (L-3);
re-state the consumer verdict. L-4 is pre-existing and recorded as a remaining low.

## Iteration 2 — Plan

- `irToAlgebra.ts`: `classHolders()` (registry-wide `targetClass` → shape ids, memoized per
  registry version); `guardableClass(sub)` returns the class or the reason it is not guardable;
  `ownedEdges` uses it (skipping silently a same-class descendant of a guardable sub-shape, since
  it adds no guard of its own — its extra `contains` are warned); `shapeClasses` keeps only the
  shape's own class plus guardable descendants' classes; the walk node's blank branch gets the
  `rdf:nil` filter.
- Tests in `owned-walk-recursion.test.ts`: M-A repro (library sub-shape keeps its ownership with a
  same-class profile registered; warning names the profile, not the library shape), M-B repro
  (foreign class holder → not followed, plain reference kept, warning names the other shape);
  both must fail on `087dfaa`.

## Iteration 2 — Phases

### Phase 9: guardable sub-shapes and the blank `rdf:nil` filter (Gaps 1, 2) — DONE

Result: `classHolders` / `classGuard` (registry-wide); `ownedEdges` and `shapeClasses` use them; a
same-class profile that adds nothing is skipped silently, any other unguardable sub-shape warns
with its cause; the walk node's blank branch carries the `rdf:nil` filter. Tests: 4 new (2 pure,
2 live) in `owned-walk-recursion.test.ts`, all failing on `087dfaa` (checked). Validation: quick
gate green; `npm test` 2242 passed, 0 failed, `[fuseki] live tests: 300 total — 300 passed`;
`npx linked build` OK.

Validation: M-A / M-B live + pure repros fail on `087dfaa`, pass after; quick gate, `npm test`
(0 failed live), `npx linked build`.

### Phase 10: docs and consumer verdict (Gap 3) — DONE

Result: README, `owned-values.md`, changeset state the guardable rule, the untyped-node stop (L-2)
and "contains wins" (L-3); consumer verdict re-checked above.

Validation: README / `owned-values.md` / changeset describe the guardable rule, L-2 and L-3;
gates as above.

## Review 3 (adversarial, after iteration 2)

Live probes on :3939 (scratch deleted, tree clean). M-A and M-B verified fixed; guarded
grandchildren, `isSubShapeOf` order, caches, blank `rdf:nil` filter verified.

- **M-1** Recursion typing (`shapeClasses`) drops a descendant's class when another shape also
  holds it, so a typed node of a legitimate sub-shape stops a cycle (live: `b1` left).
- **M-2** A user shape (no `contains`, not a sub-shape) that takes a library sub-shape's class
  switches that sub-shape's guarded ownership off (live: `t1` orphaned); the consumer verdict's
  "makes nothing worse" overclaims.
- L-1 a data-only sub-shape without `targetClass` under a guardable sub-shape, adding nothing, is
  warned misleadingly; L-2 the warning for a profile names its parent as "does not extend it".

## Iteration 3 — Ideation

### Gap 1 of 2: recursion typing (M-1)

Chosen: an unguarded recursive hop accepts the declaring shape's class or any registered
descendant's class (iteration 1's rule). The position is already reached through an owned edge
whose value shape is the declaring shape, so the typing only refuses nodes of unrelated classes;
a class shared with another shape adds the same value-shape assumption every untyped hop makes.

### Gap 2 of 2: when a shared class still guards (M-2, L-1, L-2)

Chosen: decide per edge. A sub-shape's added `contains p` is skipped when its class is held by
one of its super-shapes (the M3 rule: the parent's own nodes would match), or when a shape holding
the class that does not extend the sub-shape declares `p` as a **plain** property (M-B: following
`p` would delete that shape's references). A holder that does not declare `p` at all (M-2), or
declares it `contains` too, does not block the guard. Warnings name the cause per edge; a
sub-shape that adds nothing beyond its direct super-shape is skipped silently (L-1, profiles).
Rejected: skipping every shared class (M-2 orphans on registering an unrelated shape); asking the
app to reject such catalog shapes (core would still orphan for any other caller).

## Iteration 3 — Plan

`irToAlgebra.ts`: `classGuard` becomes `blockedGuard(sub, predicate)` returning the reason or
null; `ownedEdges` calls it per added edge; `shapeClasses` keeps every descendant class. Tests:
M-1 and M-2 live repros (fail on `c02348e`), M-B and M3 still pass. Docs: README,
`owned-values.md`, changeset, consumer verdict.

## Iteration 3 — Phases

### Phase 11: per-edge class guard and full recursion typing (Gaps 1, 2) — DONE

Result: `blockedGuard(sub, ps)` per added edge (super-shape holder, or a holder declaring the
predicate plainly, blocks; warnings per edge with the cause; a sub-shape adding nothing beyond
its direct super-shape is skipped silently); `shapeClasses` keeps every descendant class. Tests:
2 live repros (M-1, M-2) failing on `c02348e` (checked); M-A, M-B, M3 repros still pass.
Validation: quick gate green; `npm test` 2244 passed, 0 failed,
`[fuseki] live tests: 302 total — 302 passed`; `npx linked build` OK.

Validation: M-1 / M-2 repros fail on `c02348e` and pass after; all of `owned-walk-recursion`
passes; quick gate, `npm test` (0 failed live), `npx linked build`.

### Phase 12: docs and consumer verdict — DONE

Result: README, `owned-values.md`, changeset describe the per-edge guard; consumer verdict
re-checked above.

Validation: README / `owned-values.md` / changeset match the per-edge rule; gates as above.

## Review 4 (adversarial, after iteration 3)

Live probes on :3939 (scratch deleted, tree clean). M-1, M-2, M-B, M3, M-A verified; inherited
plain predicates block; grandchild guards under a blocked middle shape work; warnings one per
(sub-shape, property).

- **M-α** The consumer verdict's "cannot widen library deletes" is false: a user sub-shape taking
  a library class and adding `contains` is followed from that class's nodes. Fixed in iteration 4
  by correcting the verdict (behaviour is as designed: a sharer without the predicate does not
  block).
- L-α a sharer whose plain use of the predicate is inside a complex path is not seen by
  `blockedGuard`; L-β the silent skip also hid a sub-shape with a class of its own (fixed in
  iteration 4: silent only for a same-class or class-less copy of its direct super-shape);
  L-γ recursion typing accepts a descendant's shared class, so inside a cycle a plain sharer does
  not block (as an untyped hop outside a cycle would not).

## Iteration 4

### Gap 1 of 1: consumer verdict (M-α) — DONE

Verdict corrected above (Phase 8 section). Code: L-β silent-skip condition narrowed. Docs:
`owned-values.md` notes L-α and L-γ.

Remaining lows (for the review pause): L-α (complex-path sharers), L-γ (cycle typing vs plain
sharer), L-2 of Review 2 (an untyped node stops a multi-shape cycle), L-3 of Review 2 (`contains`
wins over a plain redeclaration), L-4 of Review 2 (forAll over a cycle shape: keep filters guard
only the root, pre-existing), the `MAX_OWNED_RECURSION` depth limit, branch counts (backlog 055),
sub-shapes registered only in another process (single-owner constraint), and the app follow-ups.

## Review (iteration 4)

Scope: a871ac5 (iteration 4 is that one commit). Quick suite green (58 tests, 24 live); a
throwaway probe (deleted, never staged) checked the narrowed condition on :3939.

- **No critical / high / medium.** The narrowed `sameKind` test sits after `blockedGuard` has
  already refused the edge; both of its outcomes `continue` without `add`, so it decides only
  warn-or-silent and cannot make the walk follow an edge it must skip. Edge selection is unchanged
  from b5fc1f1. Probe: `QR contains v → QV`; `QM extends QV` (own class) adds `contains p`;
  `QL extends QM` with class `QL`, shared by `QSharer` holding `p` plainly. Deleting a `QR` follows
  `p` only under `rdf:type QM`, never under `QL`. `QL` is warned once. A class-less copy and a
  `QM`-class copy of `QM` stay silent. The new warning is right: `QL` nodes carry only `QL`, so
  `QM`'s entry does not cover them, and before this change that gap went unwarned.
- L-δ (tests) no test pins L-β: nothing asserts that an own-class grandchild, blocked on a
  property it inherits from its direct super-shape, is warned. A regression to the old condition
  would pass the suite. The probe above is the missing test.
- L-ε (docs) README says core warns when a sub-shape "has no `targetClass`" and exempts only a
  "same-class profile". A class-less copy that adds nothing beyond its direct super-shape is also
  silent (code, `owned-values.md`). The README should name that case too.
- L-ζ (verdict) "Harm needs a reference on `x` that no registered shape of that class declares
  plainly" should say "declares plainly through a simple path", because a complex-path plain use
  does not block (L-α).
- Verified: the corrected consumer verdict (M-α) matches the code. A user sub-shape with a class
  of its own is followed only from nodes of that class. `owned-values.md` states L-α and L-γ
  correctly.
