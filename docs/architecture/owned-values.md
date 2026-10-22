---
summary: The contract of owned (`contains`) values — when an owned node is deleted (replace, set-remove, subject delete, bulk delete), how ownership is decided (per property, by a shape-directed walk), blank-node values (written and deleted through blank-capable `sh:nodeKind` properties), the class check on linked ids, and the generated single-owner SHACL shapes that shape sync persists and owns through `core:generatedShape`.
packages: [core]
---

# Owned values and generated shapes

User-facing description: README "Owned properties (`contains` / `dependent`)". History and
rationale: [report 025](../reports/025-update-replace-contains-cascade.md) (replace cascade),
[report 032](../reports/032-owned-replace-noop-and-single-owner-shacl.md) (this contract) and
[report 036](../reports/036-per-property-ownership.md) (per-property ownership, the
shape-directed walk, the qualified single-owner constraint).

## Ownership

- **`contains: true`** on an object property: the subject owns the value node through *this
  property*, own or inherited through `extends`. Code: `ObjectPropertyShapeConfig.contains`
  (`src/shapes/SHACL.ts`), persisted as `core:contains`. A plain property of another shape on
  the same predicate is a reference: it never deletes and is never class-checked.
- **A `contains` property needs a `shape`** (`createPropertyShape` throws otherwise): the walk
  below follows the value shape. Shapes registered from data (`PropertyShapeData` built
  directly) are not validated; a shape-less `contains` there owns nothing.
- **`dependent: true`** on a shape is deprecated and has no effect. It is accepted and persisted
  (`core:dependent`).
- **Blank nodes** need neither. A nested create is written as a blank node when the property
  that holds it is blank-capable (`sh:BlankNode`, `sh:BlankNodeOrIRI` without an id,
  `sh:BlankNodeOrLiteral`), and it is deleted through that property; see
  [Blank-node values](#blank-node-values). Complex `sh:path` values are written this way.

Everything is read from the live shape registry, so no vocabulary is hardcoded.

## When an owned node is deleted

| Mutation | What goes |
|---|---|
| Replace / unset / array overwrite of a `contains` property | the old value's own triples and blank values, and its owned subtree |
| Set-remove `{remove: [x]}` of a `contains` property | `x`'s own triples and blank values, and its owned subtree, unless `x` is also in `add` |
| Delete by id | the subject, incoming references, the subject's blank values, its owned subtree |
| Bulk delete (`.all()`, `.where()`) | as delete by id, minus incoming references |

Bulk mutations are polymorphic, like select and count: a bulk delete or update of a shape
(`deleteAll`, `deleteWhere`, `update().forAll()` / `.where()`) is scoped by `?s a <C>`, which the
store's inference matches on every instance of a subclass of `C`. Each matched subject loses the
owned subtree its shape's walk reaches (the root shape's walk, with its sub-shapes' guarded
edges). A server that exposes bulk mutations checks access on the root shape and every
registered shape of a subclass (`@_linked/server-utils` `QueryAccess`).

**The owned subtree** (`ownedWalk` / `ownedSubtreeBlocks` in `src/sparql/irToAlgebra.ts`) is
shape-directed. From the root's shape (the deleted subject's shape, or the replaced property's
value shape) it follows that shape's own and inherited `contains` properties with a simple path
to their value shapes, then those shapes' `contains` properties, and so on. Every node it reaches
loses its own triples and its blank values (through its shapes' blank-capable properties). Each
hop is an explicit triple; outside recursion there is no type guard on owned nodes, the edge
asserts ownership. One UNION branch per path from the root.

- **Self-loops are closures.** A shape `S` that owns itself through its own (unguarded) `contains`
  edge is followed with `*` (`List` → `rdf:rest*`, `NodeShape.generatedShapes` →
  `core:generatedShape*`): every such edge from an `S` node is `S`'s own. The root's self-loop
  adds one branch `<root> (r…)+ ?n` for its other nodes.
- **Other recursion is unrolled.** A cycle through several shapes, or a sub-shape edge back into
  the walk, becomes explicit hops, each typed with the declaring shape's class, `?n a <C>`: the
  store infers the superclass types, so the nodes of every subclass match (a declaring shape
  without a `targetClass` types the hop with the most general classes of its sub-shapes,
  `?n a ?t FILTER(?t IN (…))`). No node is walked through a predicate its own shape does not
  own. A path stops after `MAX_OWNED_RECURSION` (4) hops into
  a shape already on it; deeper values are left (orphans, the safe direction), as is anything
  behind an untyped node on such a cycle.
- **Sub-shapes.** For every registered descendant of a reached shape, each added `contains`
  property is followed from nodes of the sub-shape's class only (`?n a <SubClass> . ?n <c> ?m`);
  guarded edges never join a closure. Core writes the concrete class's `rdf:type` on create and
  the store infers the superclasses, so the guard also matches the nodes of every subclass of
  `SubClass`: an edge a deeper sub-shape inherits from a guarded one (same predicate and target)
  is followed once, under the more general guard. Per edge (`blockedGuard`, registry-wide), it is
  not followed when the sub-shape has no `targetClass`, when one of its super-shapes holds the
  class (their own nodes would match), or when another shape holding the class or a subclass of
  it declares the predicate as a plain property (following it would delete that shape's
  references) — warned once with the cause. The subclasses come from the in-memory hierarchy
  (`subClassesOf`: the shape tree plus the registered ontology data once loaded), a safety net
  for a shape on an ontology subclass that does not extend the guarded shape. A
  sharer without the predicate does not block it. A sub-shape adding nothing beyond its direct
  super-shape with its class or none (a profile, a data-only copy) is skipped silently. A profile
  that keeps its parent's class declares `@linkedShape({sharedTargetClass: true})`, so the shape
  check (`checkShapeHierarchy`) does not report it as borrowing the class.
  Recursion typing matches the declaring shape's class and, through inference, every
  descendant's, so inside a cycle a plain sharer of a descendant's class does not block (as an untyped hop outside
  a cycle would not). Only simple paths of a sharer are checked: a plain use of the predicate
  inside a sharer's complex path does not block. A sub-shape redeclaring an inherited `contains` property without
  `contains` inherits it (an override inherits every constraint it does not restate); declaring
  `contains: false` is refused at registration (tighten-only). A shape known only as data that
  drops `contains` is warned and does not remove the inherited ownership (`getPropertyShapes`
  keeps both).
- **`rdf:nil`** is never deleted: every walk node and the replaced-value self-delete carry
  `FILTER(!sameTerm(?n, rdf:nil))`.
- **Branch count:** no cap; lowering warns once per root shape above `OWNED_BRANCH_WARNING` (64)
  branches. The core metamodel stays at ≤ 9 (nested property shapes and `sh:languageIn` lists)
  and `@_linked/schema` at ≤ 8; reducing wide DAGs is [backlog 055](../backlog/055-owned-walk-branch-count.md).
- **Memoized** per (root shape, registry version); lowering only instantiates variables.

Invariants:

- **Re-sending is a no-op.** A bare `{id}` that the mutation writes again (the current single
  value, a retained array item) is kept: every owned-cleanup block is wrapped in
  `FILTER(?old NOT IN (<kept>…))`, inside the UNION branch that binds `?old`. The edge is deleted
  and re-inserted. A nested create carrying an id (`{id, ...fields}`) is not a reference: it
  rewrites that node.
- **Every owned block binds its root through the owning edge** (or, for bulk deletes, the
  subject's type triple), so an absent value matches nothing rather than every node.
- **Blocks are UNION branches, never an OPTIONAL chain**, so their solutions add, not multiply.
  One branch per path through the condensed shape graph: a node reachable two ways is deleted
  by two branches (harmless).
- Non-owning references to an owned node are allowed and are left dangling when the owner goes.

## Blank-node values

History and rationale: [report 034](../reports/034-shacl-complex-paths-as-blank-nodes.md) (blank
SHACL paths) and [report 035](../reports/035-nodekind-driven-blank-nodes.md) (the `nodeKind` rule that replaced its `__blank` node-data key).

**Writing.** The lowering (`nestedNodeKind` in `src/sparql/irToAlgebra.ts`) decides from the
`sh:nodeKind` of the property that holds a nested create, read from the registry of the side that
runs the mutation. Nothing travels in the IR or on the DSL-JSON wire.

| `nodeKind` | without id | with id |
|---|---|---|
| unset, `sh:IRI`, `sh:IRIOrLiteral` | IRI | IRI |
| `sh:BlankNodeOrIRI` | blank | IRI |
| `sh:BlankNode`, `sh:BlankNodeOrLiteral` | blank | error |
| `sh:Literal` | error | error |

A blank node gets a label fresh to its INSERT DATA (`_:bN`) and its field triples only, no
`rdf:type`. Only a create writes one; an update / upsert / update-where whose value would be blank
throws (a `DELETE/INSERT … WHERE` template mints its blank nodes once per WHERE solution). An id
of the form `_:…` is refused wherever the lowering writes an IRI term into a triple (link,
`update().for()`, delete by id, a select's `.for()`): a blank node is not addressable. Filter
expressions (`where(x.equals({id}))`) are not checked.

The metamodel declares `PropertyShape.path`, the `PathNode` slots and `PathList.first` / `.rest`
`sh:BlankNodeOrIRI`. `PathList` is a separate shape from `List` (both target `rdf:List`) because
`List.first` holds literals in `sh:in` and `List.rest` must stay `sh:IRI` for user lists.

**Deleting** (`buildBlankCascade`). One UNION branch per owner:

```sparql
<owner> (p1|…|pn) ?bn0 . FILTER(isBlank(?bn0))
?bn0 (q1|…|qm)* ?bn . ?bn ?bnp ?bno .
FILTER(isBlank(?bn) && NOT EXISTS { ?bn0 (q…)* ?mid . ?mid (q…)+ ?bn . FILTER(!isBlank(?mid)) })
```

| Mutation | Owner | `p…` |
|---|---|---|
| Delete by id, bulk delete | the subject (bulk: led by its type triple) | the subject shape's blank-capable predicates, sub-shapes included |
| The owned subtree (subject delete, `contains` replace / set-remove) | each node a walk branch deletes | the blank-capable predicates of that branch's shapes (sub-shapes included) |
| Replace / unset / overwrite of a blank-capable property | the old value itself (`<s> <p> ?old`, `?old` is `?bn0`) | — |
| `contains` replace / set-remove | the old value whose own triples are deleted | the value shape's blank-capable predicates |

- `q…` (`blankWalkPredicates`): the blank-capable predicates of the shapes the values can have
  (value shape and sub-shapes, transitively). A blank-capable property without a value shape is
  polymorphic and yields every blank-capable predicate of the registry.
- Every deleted node is blank, so no IRI is ever deleted. The `NOT EXISTS` refuses a blank node
  reached through an IRI (a property path cannot constrain intermediate nodes): a blank list's
  `rdf:first` must not lead into a listed entity and delete that entity's blank values. Blank
  structures core writes are trees, so the guard removes nothing they own.
- The owner's blank-capable predicates come from the shapes the walk reached it through, so a
  `List` cell (whose `first` / `rest` are not blank-capable) keeps a blank `rdf:first` member:
  it is content. `PathList` cells (blank-capable) are reached only through blank values.

## The class check on linked ids

Linking an existing node by bare `{id}` into an owned property transfers ownership, so a node of
the wrong class would later be deleted with its owner. `SparqlDataset.createQuery` /
`updateQuery` call `checkOwnedLinks(ir)` (`src/sparql/ownedLinkCheck.ts`) after lowering and
before the update:

- A field is checked when its property is `contains`, has a simple path and declares a `shape`
  whose `targetClass` resolves. A plain property on the same predicate is not checked.
- Accepted classes: the value shape's `targetClass` and the property's `sh:class`. The type
  query reads the store's inferred types, so an instance of any subclass (with or without a
  shape) carries the accepted class and passes; core requires a store with RDFS class inference
  and the ontology hierarchy synced.
- A node is refused only when it has at least one `rdf:type` and none is accepted. Untyped and
  absent ids (`rdf:nil`, upload-then-attach) pass; `rdf:nil` is skipped statically.
- Links are collected from single values, array items and set `add` items, at any nesting depth,
  in create, update, upsert and update-where mutations. Nested creates and `remove` items are not
  links.
- Cost: no query without links; otherwise one `SELECT ?id ?type WHERE { VALUES ?id {…} ?id rdf:type ?type }`.
- Not covered: raw SPARQL, non-SPARQL `IDataset`s, a node typed between the SELECT and the UPDATE.

## Generated single-owner shapes

For each **own** `contains` property with a simple path of a shape with a `targetClass`, shape
sync persists one generated NodeShape (`src/shapes/singleOwnerConstraint.ts`):

```turtle
<…/Thing> core:generatedShape <…/Thing/image.singleOwner> .
<…/Thing/image.singleOwner> a sh:NodeShape ;
    core:generated true ;
    sh:targetObjectsOf schema:image ;
    sh:property <…/Thing/image.singleOwner/owners> .
<…/Thing/image.singleOwner/owners> a sh:PropertyShape ;
    rdfs:label "owners" ;
    sh:path [ sh:inversePath schema:image ] ;
    sh:qualifiedValueShape [ sh:class schema:Thing ] ;
    sh:qualifiedMaxCount 1 .
```

- **Owners counted:** instances of the declaring `targetClass`, one `sh:class`. SHACL follows
  `rdf:type/rdfs:subClassOf*` and the store infers through the synced ontology hierarchy, so the
  instances of every subclass (`ex:Project ⊑ schema:Thing`) count. A plain reference from another
  class conforms. A declaring shape without `targetClass` gets no constraint; sync warns once per
  shape. Versions before this one listed every registered sub-shape's class in an `sh:or`;
  `SHAPE_HASH_VERSION` 2 rewrites the constraint at the next sync.
- **Metamodel:** `PropertyShape.qualifiedValueShape` (value shape `NodeShape`),
  `PropertyShape.qualifiedMaxCount`, `NodeShape.class`, all in `src/utils/Package.ts`. The
  qualified shape is a blank node.

The inverse path is an untyped blank node with exactly one triple. An IRI there would be read by
every SHACL validator as a predicate path (SHACL §2.3.1), which is what versions before 2.30
wrote (`sh:path <…/owners/inv>`, `<…/owners/inv> a core:PathNode`): Jena reported such a
constraint as conforming whatever the data. Versions before this one wrote `sh:maxCount 1`
(every subject counted); the next sync rewrites the constraint.

- **IRI:** `${propertyShapeIri}.singleOwner` (`singleOwnerShapeIri`), derived from the stable
  shape IRI, so every runtime computes the same one. Subclasses inherit the property but write no
  constraint.
- **Ownership:** `NodeShape.generatedShapes` (`core:generatedShape`) is a `contains` property with
  value shape `NodeShape`. Sync stays two requests per shape: the delete of the NodeShape removes
  the generated shapes and their property shapes (the owned walk: `core:generatedShape*` then
  `sh:property`) and their blank path and qualified-shape nodes (the blank-node cascade of each
  deleted property shape), never the predicate IRI; the create writes the current ones nested.
- **Markers:** `core:generated true` and no `sh:targetClass`, so catalog readers can skip them.
  They are never registered in the in-memory registry.
- **Unchanged shapes are skipped:** the create also stores `core:shapeHash` on the NodeShape, a
  SHA-256 of the canonical create data of the shape *including* its generated shapes. `syncShapes` reads the stored hashes of all code
  shapes in one select and writes only the shapes whose hash is missing or differs; `syncShape`
  does the same read inside its thunk. `force: true` rewrites regardless. The hash records what
  sync last wrote, not what the store holds: a subtree edited or partly deleted by another writer
  while the NodeShape and its hash survive is not repaired until the shape changes or a forced sync.
- **Pruning:** `syncShapes` adds every in-code generated IRI to the protected set, so `'all'` and
  `'ownedNamespaces'` keep them. A stale one goes with its owner's delete.
- **Collisions:** sync throws when a registered shape IRI equals a generated IRI.
- **Not enforced on write.** Neither core nor the default Fuseki setup validates SHACL on update.
  Enforcement is the store's responsibility; core adds no validation queries for it.

Meta-model terms: `sh:targetObjectsOf`, `sh:qualifiedValueShape`, `sh:qualifiedMaxCount`, `sh:or` (`src/ontologies/shacl.ts`), `core:generated` and
`core:generatedShape`, `core:shapeHash` (`src/ontologies/linked-core.ts`), NodeShape accessors in
`src/utils/Package.ts`.
