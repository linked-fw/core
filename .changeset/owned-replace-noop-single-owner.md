---
"@_linked/core": minor
---

Owned (`contains`) values:
- re-sending the current `{id}` is now a no-op, where before it deleted that node's own triples;
- an array overwrite keeps the ids it sends again and deletes only the ones left out; a set
  modification that removes and re-adds the same id leaves that node alone;
- deleting a subject, by id or in bulk (`.all()`, `.where(...)`), now deletes its immediately-owned
  children (every `contains` property that declares a `shape`), as documented. The `dependent`
  cascade below them now only visits the dependent shapes the deleted shape can reach through its
  owned properties, so a shape that owns only non-dependent values pays no cascade cost;
- a `contains` property without a value shape only deletes `dependent`-typed values;
- linking a node of the wrong class into an owned property that declares a shape is refused before
  anything is written (one `SELECT` per mutation that links owned ids, none otherwise).

Shape sync now also writes one generated SHACL NodeShape per `contains` property with a value
shape, at `<property shape IRI>.singleOwner`, written only by the class that declares the property.
It limits each value of that predicate to one owner (`sh:targetObjectsOf <p>` plus an
`sh:inversePath <p>` property with `sh:maxCount 1`) and is marked `core:generated true`, with no
`sh:targetClass`, so catalog readers can skip it. The declaring shape owns these through a new
`core:generatedShape` edge, so sync still sends two requests per shape: the delete removes them and
the create writes them nested. A removed or renamed accessor's constraint goes with the next sync.
Core does not enforce the constraint on write; run a SHACL validator against the persisted shapes.

New exports and meta-model terms:
- `singleOwnerShapeIri(propertyShapeIri)`, `singleOwnerProperties(nodeShape)` and
  `buildSingleOwnerConstraints(nodeShape, shapeIri)` from `@_linked/core`, to recompute the
  generated shapes' IRIs and data;
- `NodeShape.targetObjectsOf` (`sh:targetObjectsOf`), `NodeShape.generated` (`core:generated`) and
  `NodeShape.generatedShapes` (`core:generatedShape`, `contains`);
- `shacl.targetObjectsOf` (`@_linked/core/ontologies/shacl`), `coreOntology.generated` and
  `coreOntology.generatedShape` (`@_linked/core/ontologies/linked-core`).

See the README section "Owned properties (`contains` / `dependent`)".

**Behaviour changes.** Check these before upgrading:
- **Deletes now delete owned children.** `@_linked/schema` declares `Thing.image` as `contains`,
  so deleting any schema-derived entity (by id or in bulk) now deletes its linked `ImageObject`s,
  including ones linked by `{id}`. If your data shares one image between several entities through
  `image`, deleting one of them deletes the shared image. Link shared images through a property
  that does not own them.
- **Linked `{id}`s are class-checked.** Linking an existing node by `{id}` into an owned property
  (any property on a `contains` predicate that declares a shape) is refused when the node is typed
  and none of its types is the shape's class, a registered sub-shape's class, or `sh:class`. A node
  typed only with a subclass that has no registered shape is refused. To accept it, register a shape
  for that subclass (extending the value shape), or declare `sh:class`. Untyped or not-yet-existing
  ids are allowed.
- **Plain properties on a `contains` predicate are checked too.** Ownership is decided per
  predicate across the registry, so a property *without* `contains` whose predicate another shape
  declares `contains` is class-checked as well (and a replace through it deletes the old value).
  Example: an application shape that declares `schema:image` without `contains`, while
  `@_linked/schema` declares `Thing.image` as `contains`. To resolve a refusal, link a node of the
  value shape's class (or a registered sub-shape's class), register a shape for the node's
  subclass, declare `sh:class` on the property, or use a predicate that no shape owns.
- **Shape-less `contains` properties keep non-dependent old values.** A `contains` property without
  a value shape (a polymorphic slot such as `sh:path`) no longer deletes the old value's own triples
  on replace or remove. A non-dependent old value is now left in place and may orphan.
