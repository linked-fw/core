---
'@_linked/core': minor
---

Shape sync now writes complex SHACL property paths as blank nodes, so SHACL validators read them correctly.

**What was wrong.** `syncShapes()` / `syncShape()` stored every inverse, alternative, sequence and `*`/`+`/`?` path as IRI-named nodes (`sh:path <…/owners/inv>`). An IRI in `sh:path` is a predicate path (SHACL §2.3.1), so validators such as Jena read those paths as predicates that match nothing. Constraints on complex paths never reported a violation. That includes the generated `…singleOwner` constraints.

**What is stored now.** Paths are written in plain SHACL syntax. Operator nodes and list cells are untyped blank nodes:

```turtle
<…/Thing/image.singleOwner/owners> sh:path [ sh:inversePath schema:image ] .
<…/Person/region> sh:path ( ex:worksAt ex:locatedIn ) .
```

The next sync of a shape removes the IRI path nodes earlier versions wrote. One exception: an operator node that sat inside a sequence (`<…/seq/0/inv>`) is left behind unreferenced. Nothing points at it, and the README has a query to remove it.

**If you read stored shapes.** A path node is now a blank node, and its label is valid only inside the result set it came from. Read a path's structure in the same query that finds it (`?ps sh:path ?p . ?p sh:inversePath ?x`), keyed by the property shape's IRI. Joining on a path node's id across two queries no longer works. Nothing reads the old `rdf:type core:PathNode` / `rdf:List` triples on path nodes; they are gone.

**New: `__blank` in nested create data.** Nested node data in a `create` may carry `__blank: true`. The node is then written as a fresh blank node holding only its field triples, with no `rdf:type`. The delete cascade removes such nodes when they are owned through a `contains` property. It is meant for RDF syntax such as SHACL paths. It throws if:

- it is combined with `__id` or `id`;
- it is on the created root;
- it is used in `update` or `upsert`;
- it is the value of a property that is not `contains`.

`serializePathToNodeData(path)` now produces this form. Its second argument is ignored and kept only for compatibility.
