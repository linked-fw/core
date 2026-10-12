---
"@_linked/core": minor
---

Owned (`contains`) values:
- re-sending the current `{id}` is now a no-op, where before it deleted that node's own triples;
- array overwrite keeps the retained ids;
- deleting a subject now deletes its immediately-owned children, as documented;
- a `contains` property without a value shape only deletes `dependent`-typed values;
- linking a node of the wrong class into a `contains` property that declares a shape is refused.
Shape sync now also writes a generated `<Shape>.singleOwner` SHACL NodeShape (`core:generated`)
that limits each owned value to one owner across the shape's `contains` predicates.
