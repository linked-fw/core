---
'@_linked/core': minor
---

Ownership of `contains` values is now decided **per property**, everywhere. Until now a property owned its values when *any* registered shape declared its predicate `contains`, so a plain property on such a predicate (say a user shape's `schema:image`, which `@_linked/schema` declares `contains` on `Thing.image`) deleted its old value on replace and class-checked links.

**A plain property on a predicate another shape declares `contains` no longer deletes or class-checks.** Replacing, unsetting or set-removing its value only changes the edge; deleting its subject leaves the value in place; linking any `{id}` through it is allowed. To keep the old behaviour for such a property, declare `contains: true` (with a `shape`) on it.

**Deleting an owner deletes everything it owns.** The cleanup walks shapes, not predicates: from the owner's shape it follows that shape's `contains` properties to their value shapes, then their `contains` properties, and so on. Deeper owned values now go with their owner even when their shape is not `dependent` (before, only `dependent`-typed descendants were deleted below the first level). When a value is typed with a registered sub-shape of the declared value shape, the `contains` properties that sub-shape adds are followed too, from nodes of that class only. Such a property is not followed through the parent (warned once with the cause) when the sub-shape has no `targetClass`, shares it with a super-shape, or shares it with another shape that holds the same predicate as a plain property through a simple path. A copy of a sub-shape that adds nothing (same class, or no `targetClass`) is skipped silently.

Recursion: a shape owning its own kind (list cells, replies) is followed to any depth; any other cycle is followed hop by hop, each hop checked against the declaring class, for at most `MAX_OWNED_RECURSION` (4) re-entries per path — deeper values are left in place. `rdf:nil` is never deleted. A delete whose owned walk exceeds `OWNED_BRANCH_WARNING` (64) branches logs a warning. Both constants are exported from `@_linked/core/sparql/irToAlgebra`.

**`contains` without a `shape` now throws** when the class is decorated: the walk needs a value shape to follow. Add the value's `shape`, or drop `contains` — a blank value is deleted through a blank-capable `nodeKind` without it. Core's own `PropertyShape.path` and the shape-less `PathNode` slots no longer declare `contains`.

**`dependent` is deprecated** and has no effect. It is still accepted, and shape sync still persists it as `core:dependent`. Core's own shapes no longer declare it.

**The generated single-owner constraint counts only owners of the declaring class.** `sh:maxCount 1` (every subject counted) becomes a qualified count over the declaring `targetClass` and every registered sub-shape's class, so a plain reference from another class conforms:

```turtle
<…/Thing/image.singleOwner/owners> sh:path [ sh:inversePath schema:image ] ;
    sh:qualifiedValueShape [ sh:or ( [ sh:class schema:Thing ] [ sh:class ex:Project ] ) ] ;
    sh:qualifiedMaxCount 1 .
```

With one class the qualified shape is `[ sh:class C ]`. A declaring shape without `targetClass` gets no constraint (sync warns once). Re-sync to rewrite stored constraints. New metamodel accessors: `PropertyShape.qualifiedValueShape`, `PropertyShape.qualifiedMaxCount`, `NodeShape.class`, `NodeShape.orShapes` (`sh:or`), and the `shacl.qualifiedValueShape` / `qualifiedMaxCount` / `or` terms.

**Removed:** `collectContainment` and `buildOwnedCascade` (exported from `@_linked/core/sparql/irToAlgebra`), which implemented the predicate rule, and the `sharedPredicate` field of `OwnedLink`. Nothing replaces them; to ask whether a property owns its value, read its own `contains`.

**No longer done:** the next sync no longer deletes the IRI-named path nodes versions before 2.30 wrote; it leaves them unreferenced.

See README "Owned properties" and `docs/architecture/owned-values.md`.
