---
summary: The contract of owned (`contains`) values — when an owned node is deleted (replace, set-remove, subject delete, bulk delete), how ownership is decided (per predicate vs per shape), the class check on linked ids, and the generated single-owner SHACL shapes that shape sync persists and owns through `core:generatedShape`.
packages: [core]
---

# Owned values and generated shapes

User-facing description: README "Owned properties (`contains` / `dependent`)". History and
rationale: [report 025](../reports/025-update-replace-contains-cascade.md) (replace cascade) and
[report 032](../reports/032-owned-replace-noop-and-single-owner-shacl.md) (this contract).

## The two flags

- **`contains: true`** on an object property: the subject owns the value node. Code:
  `ObjectPropertyShapeConfig.contains` (`src/shapes/SHACL.ts`), persisted as `core:contains`.
- **`dependent: true`** on a shape: its instances have no independent existence and are deleted
  when a `contains` walk reaches them (list cells, property shapes, and the typed path nodes of
  versions before 2.30).
- **Blank nodes** need neither flag: the cascade deletes every blank node reached through
  `contains` edges, and the blank structure below it (following `rdf:first` too, from a blank
  node only). Complex `sh:path` values are written this way (`__blank` nested node-data).

Both are read from the live shape registry (`collectContainment` in `src/sparql/irToAlgebra.ts`),
so no vocabulary is hardcoded.

## When an owned node is deleted

| Mutation | What goes | Ownership rule |
|---|---|---|
| Replace / unset / array overwrite | the old value's own triples (if the property declares a `shape`) and its dependent subtree | per predicate (registry-wide) |
| Set-remove `{remove: [x]}` | `x`'s own triples (with a `shape`) and its dependent subtree, unless `x` is also in `add` | per predicate |
| Delete by id | the subject, incoming references, each immediately-owned child, the reachable dependent subtree | the deleted shape's own + inherited `contains` properties with a `shape` |
| Bulk delete (`.all()`, `.where()`) | as delete by id, minus incoming references | as delete by id |

Invariants:

- **Re-sending is a no-op.** A bare `{id}` that the mutation writes again (the current single
  value, a retained array item) is kept: every owned-cleanup block is wrapped in
  `FILTER(?old NOT IN (<kept>…))`, inside the UNION branch that binds `?old`. The edge is deleted
  and re-inserted. A nested create carrying an id (`{id, ...fields}`) is not a reference: it
  rewrites that node.
- **A `contains` property without a `shape`** (a polymorphic slot such as `PropertyShape.path`)
  never deletes its value's own triples. Its value goes only when it is `dependent`-typed: the
  cascade path is `(c1|c2|…)*`, so the root itself is matched when it is dependent.
- **Every owned block binds its root through the owning edge** (or, for bulk deletes, the
  subject's type triple), so an absent value matches nothing rather than every node.
- **Blocks are UNION branches, never an OPTIONAL chain**, so their solutions add, not multiply.
- **The subject-delete cascade is narrowed** to the dependent shapes the deleted shape can reach
  (`reachableDependentTypes`): walk the shape and its sub-shapes through properties on `contains`
  predicates to their value shapes and sub-shapes. A shape-less slot reaches everything (keeps the
  shape-sync delete exact). Edges no reached shape declares are not followed.
- Non-owning references to an owned node are allowed and are left dangling when the owner goes.

The replace and the subject delete decide ownership differently (per predicate vs per shape).
Whether to unify them is open: [backlog 053](../backlog/053-per-property-ownership.md).

## The class check on linked ids

Linking an existing node by bare `{id}` into an owned property transfers ownership, so a node of
the wrong class would later be deleted with its owner. `SparqlDataset.createQuery` /
`updateQuery` call `checkOwnedLinks(ir)` (`src/sparql/ownedLinkCheck.ts`) after lowering and
before the update:

- A field is checked when its simple-path predicate is a `contains` predicate anywhere in the
  registry and the property declares a `shape` whose `targetClass` resolves.
- Accepted classes: the value shape's `targetClass`, every registered sub-shape's, and the
  property's `sh:class`. The store's `rdfs:subClassOf` is not consulted.
- A node is refused only when it has at least one `rdf:type` and none is accepted. Untyped and
  absent ids (`rdf:nil`, upload-then-attach) pass; `rdf:nil` is skipped statically.
- Links are collected from single values, array items and set `add` items, at any nesting depth,
  in create, update, upsert and update-where mutations. Nested creates and `remove` items are not
  links.
- Cost: no query without links; otherwise one `SELECT ?id ?type WHERE { VALUES ?id {…} ?id rdf:type ?type }`.
- Not covered: raw SPARQL, non-SPARQL `IDataset`s, a node typed between the SELECT and the UPDATE.

## Generated single-owner shapes

For each **own** `contains` property with a `shape` and a simple path, shape sync persists one
generated NodeShape (`src/shapes/singleOwnerConstraint.ts`):

```turtle
<…/Thing> core:generatedShape <…/Thing/image.singleOwner> .
<…/Thing/image.singleOwner> a sh:NodeShape ;
    core:generated true ;
    sh:targetObjectsOf schema:image ;
    sh:property <…/Thing/image.singleOwner/owners> .
<…/Thing/image.singleOwner/owners> a sh:PropertyShape ;
    rdfs:label "owners" ; sh:maxCount 1 ;
    sh:path [ sh:inversePath schema:image ] .
```

The inverse path is an untyped blank node with exactly one triple. An IRI there would be read by
every SHACL validator as a predicate path (SHACL §2.3.1), which is what versions before 2.30
wrote (`sh:path <…/owners/inv>`, `<…/owners/inv> a core:PathNode`): Jena reported such a
constraint as conforming whatever the data. The next sync replaces those nodes.

- **IRI:** `${propertyShapeIri}.singleOwner` (`singleOwnerShapeIri`), derived from the stable
  shape IRI, so every runtime computes the same one. Subclasses inherit the property but write no
  constraint.
- **Ownership:** `NodeShape.generatedShapes` (`core:generatedShape`) is a `contains` property with
  value shape `NodeShape`. Sync stays two requests per shape: the delete of the NodeShape removes
  the generated shapes (owned-child block), their property shapes (dependent cascade) and their
  blank path nodes (the cascade's blank-node block), never the predicate IRI; the create writes the current ones nested.
- **Markers:** `core:generated true` and no `sh:targetClass`, so catalog readers can skip them.
  They are never registered in the in-memory registry.
- **Pruning:** `syncShapes` adds every in-code generated IRI to the protected set, so `'all'` and
  `'ownedNamespaces'` keep them. A stale one goes with its owner's delete.
- **Collisions:** sync throws when a registered shape IRI equals a generated IRI.
- **Not enforced on write.** Neither core nor the default Fuseki setup validates SHACL on update
  ([backlog 054](../backlog/054-shacl-validation-on-write.md)).

Meta-model terms: `sh:targetObjectsOf` (`src/ontologies/shacl.ts`), `core:generated` and
`core:generatedShape` (`src/ontologies/linked-core.ts`), NodeShape accessors in
`src/utils/Package.ts`.
