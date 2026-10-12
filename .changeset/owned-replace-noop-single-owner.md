---
"@_linked/core": minor
---

Owned (`contains`) values:
- re-sending the current `{id}` is now a no-op, where before it deleted that node's own triples;
- array overwrite keeps the retained ids;
- deleting a subject, by id or in bulk (`.all()`, `.where(...)`), now deletes its immediately-owned
  children, as documented;
- a `contains` property without a value shape only deletes `dependent`-typed values;
- linking a node of the wrong class into an owned property that declares a shape is refused.

Shape sync now also writes a generated `<Shape>.singleOwner` SHACL NodeShape (`core:generated`)
that limits each owned value to one owner across the shape's shaped `contains` predicates.

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
  for that subclass (extending the value shape), or declare `sh:class`.
- **Shape-less `contains` properties keep non-dependent old values.** A `contains` property without
  a value shape (a polymorphic slot such as `sh:path`) no longer deletes the old value's own triples
  on replace or remove. A non-dependent old value is now left in place and may orphan.
