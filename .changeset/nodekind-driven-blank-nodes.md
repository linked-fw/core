---
'@_linked/core': minor
---

A nested create is now written as a blank node when the **property** that holds it allows blank nodes through its `nodeKind`. This replaces the `__blank: true` node-data key added in 2.30.0, which is removed.

**Minting follows the property's `nodeKind`:**

| `nodeKind` | nested value without an id | with an id |
|---|---|---|
| unset, `shacl.IRI` (the `objectProperty` default), `shacl.IRIOrLiteral` | IRI (as before) | IRI |
| `shacl.BlankNodeOrIRI` | blank node | IRI |
| `shacl.BlankNode`, `shacl.BlankNodeOrLiteral` | blank node | error |
| `shacl.Literal` | error | error |

```ts
@objectProperty({path: ex.geo, shape: GeoPoint, maxCount: 1, nodeKind: shacl.BlankNodeOrIRI})
declare geo: GeoPoint;

// <place1> ex:geo _:b0 . _:b0 ex:lat "52.1" .
await Place.create({geo: {lat: '52.1'}}).withId(place1);
```

A blank node is written with its field triples only, without `rdf:type`. Nothing about it is sent in DSL-JSON: the side that runs the mutation decides from its own shapes. **Upgrade the side that lowers mutations (the server) first:** a 2.30.x server lowering DSL-JSON from this version writes complex `sh:path` values as IRI nodes again, since the `__blank` key it read is no longer sent.

**Blank values are deleted with what holds them.** Deleting the subject (by id, `.all()`, `.where()`), replacing or unsetting the property, deleting or replacing an owned (`contains`) child, and the containment cascade delete the blank value and the blank nodes below it, following only blank-capable properties. Only blank nodes are deleted, never an IRI the structure refers to, and `contains` is no longer needed for it. This replaces the `contains`-based blank-node cleanup of 2.30.0 and the bulk deletes' blank-node cleanup.

**Refused with an error** (not supported yet): an `update` / `upsert` / `updateWhere` whose new value would be a blank node, and an id of the form `_:…` used to link, `update().for()` or delete by id.

**Shape sync is unchanged.** `PropertyShape.path` and the path operator slots are declared `shacl.BlankNodeOrIRI`, and path lists use a new `PathList` shape (`@_linked/core/shapes/PathList`), so sync writes the same blank `sh:path` structure as 2.30.0, byte for byte (pinned by a test against the 2.30.0 output). `PathNode.alternativePath` now declares `PathList` as its value shape; `List`, `rdfList()` and `sh:in` lists are unchanged.

**Removed:** `__blank` on `NodeDescriptionValue`, `IRNodeData.blank`, and the `__blank` DSL-JSON key. Only shape sync used it. A `__blank` key in mutation data is now rejected as an undeclared property.

See README "Blank-node values (`nodeKind`)" and `docs/architecture/owned-values.md`.
