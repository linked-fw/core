---
summary: The contract of owned (`contains`) values — when an owned node is deleted (replace, set-remove, subject delete, bulk delete), how ownership is decided (per predicate vs per shape), blank-node values (written and deleted through blank-capable `sh:nodeKind` properties), the class check on linked ids, and the generated single-owner SHACL shapes that shape sync persists and owns through `core:generatedShape`.
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
- **Blank nodes** need neither flag. A nested create is written as a blank node when the
  property that holds it is blank-capable (`sh:BlankNode`, `sh:BlankNodeOrIRI` without an id,
  `sh:BlankNodeOrLiteral`), and it is deleted through that property; see
  [Blank-node values](#blank-node-values). Complex `sh:path` values are written this way.

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

Blank values are a separate rule, below; they are deleted whether or not the property is
`contains`.

The replace and the subject delete decide ownership differently (per predicate vs per shape).
Whether to unify them is open: [backlog 053](../backlog/053-per-property-ownership.md).

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
| Any cascade (`buildOwnedCascade`: subject delete, `contains` replace / set-remove) | each dependent-typed node it deletes (`<root> (c…)* ?bo . ?bo a <T>`) | the blank-capable predicates of the shapes targeting `T` |
| Replace / unset / overwrite of a blank-capable property | the old value itself (`<s> <p> ?old`, `?old` is `?bn0`) | — |
| Delete by id / bulk delete, `contains` replace / set-remove of a property with a `shape` | the immediately-owned child whose own triples are deleted | the value shape's blank-capable predicates |

- `q…` (`blankWalkPredicates`): the blank-capable predicates of the shapes the values can have
  (value shape and sub-shapes, transitively). A blank-capable property without a value shape is
  polymorphic and yields every blank-capable predicate of the registry.
- Every deleted node is blank, so no IRI is ever deleted. The `NOT EXISTS` refuses a blank node
  reached through an IRI (a property path cannot constrain intermediate nodes): a blank list's
  `rdf:first` must not lead into a listed entity and delete that entity's blank values. Blank
  structures core writes are trees, so the guard removes nothing they own.
- A dependent type's predicates are followed only when every shape targeting that class agrees
  they are blank-capable: `PathList.first` / `.rest` are, `List.first` / `.rest` are not (both
  target `rdf:List`), so a typed list cell's blank `rdf:first` member is content and is kept.
- Not covered: the blank values of nodes deeper than the immediately-owned child that are not
  dependent-typed.

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
  blank path nodes (the blank-node cascade of each deleted property shape), never the predicate
  IRI; the create writes the current ones nested.
- **Markers:** `core:generated true` and no `sh:targetClass`, so catalog readers can skip them.
  They are never registered in the in-memory registry.
- **Pruning:** `syncShapes` adds every in-code generated IRI to the protected set, so `'all'` and
  `'ownedNamespaces'` keep them. A stale one goes with its owner's delete.
- **Collisions:** sync throws when a registered shape IRI equals a generated IRI.
- **Not enforced on write.** Neither core nor the default Fuseki setup validates SHACL on update.
  Enforcement is the store's responsibility; core adds no validation queries for it.

Meta-model terms: `sh:targetObjectsOf` (`src/ontologies/shacl.ts`), `core:generated` and
`core:generatedShape` (`src/ontologies/linked-core.ts`), NodeShape accessors in
`src/utils/Package.ts`.
