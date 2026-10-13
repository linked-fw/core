---
summary: >
  Replace the `__blank` node-data key (report 034) with schema-driven minting: a nested create is
  written as a blank node when the property it sits under declares a blank-capable `sh:nodeKind`.
  The core metamodel declares the SHACL path slots blank-capable, so shape sync writes the same
  blank path structure as 2.30 with nothing on the wire. Blank-node cleanup on delete / replace
  follows the blank-capable properties instead of `contains`.
status: Ideation
packages: [core]
---

# 003 — `sh:nodeKind`-driven blank nodes

Background: [report 034](../reports/034-shacl-complex-paths-as-blank-nodes.md) (PR #332, released
in 2.30.0) made shape sync write complex `sh:path` values as untyped blank nodes through a
`__blank: true` key on nested create node-data, and added a blank-node block to the containment
cascade, tied to `contains`. PR #334 (2.30.1) keeps a nested node's concrete shape on decode and
has a round-trip test that uses `__blank`.

The lead developer considers `__blank` a hack: an extra reserved key on every layer (builder
input, IR, DSL-JSON wire, SPARQL lowering) for something the schema already knows. IRIs stay the
default everywhere; blank nodes are used only where SHACL requires them (§2.3.1: an inverse,
alternative or cardinality path is "a blank node that is the subject of exactly one triple"; an
IRI in `sh:path` is a predicate path).

## Planning blockers explored

Priority framework: maintainability, then scalability, then performance.

### Decision 1 of 9 — what decides that a nested create is a blank node (accepted: 1A)

**The property's existing `sh:nodeKind`** (`nodeKind` decorator option, `normalizeNodeKind` in
`src/shapes/SHACL.ts`, the `PropertyShape.nodeKind` metamodel property in `src/utils/Package.ts`).
The minting rule for a nested create (node-data with fields) under a property:

| Property `nodeKind` | nested create without id | nested create with id |
|---|---|---|
| unset, `sh:IRI` | IRI (minted, as today) | IRI |
| `sh:BlankNode` | blank node | **error** (a blank node has no id) |
| `sh:BlankNodeOrIRI` | blank node | IRI |
| `sh:BlankNodeOrLiteral` | blank node | **error** (an IRI is not allowed) |
| `sh:IRIOrLiteral` | IRI | IRI |
| `sh:Literal` | **error** (a literal property cannot hold a node) | **error** |

`objectProperty` defaults to `sh:IRI`, `literalProperty` to `sh:Literal`, `linkedProperty` leaves
it unset, so nothing changes for a property that does not opt in.

Rejected: **B, the node shape's `sh:nodeKind`** — `sh:path` is polymorphic and the operator nodes
are untyped, so nothing on the value says which shape decides; **C, both** — more than is needed
now (recorded in the backlog).

### Decision 2 of 9 — a blank node is written without `rdf:type`

A blank nested node gets only its field triples, as `__blank` nodes did. A SHACL path operator
must be the subject of exactly one triple (report 034 measured that a typed one is ill-formed),
and a per-shape "typed blank node" switch would be a new node-level option (backlog: node-level
`sh:nodeKind`). The value's shape is known from the property that holds it.

Consequence recorded for users: the concrete subclass of a blank value is not persisted (no
type triple). A select returns blank values as today (decision 7).

### Decision 3 of 9 — SHACL path lists use a dedicated `PathList` shape

The cells of a sequence or alternative list must stay blank to keep the sync output unchanged
(the head of a sequence *is* the `sh:path` value, and an IRI there is a predicate path), and an
operator inside a list sits under `rdf:first`. `List` cannot carry that:

- `List.first` holds literals in `sh:in` lists, so `sh:BlankNodeOrIRI` on it would make the node
  kind check reject them;
- `List.rest` is `sh:IRI` and blank-capable would change every user list built with `rdfList()`
  without ids (blank tail cells after an IRI head); the override rule also forbids widening it in
  a subclass.

So core adds `PathList` (targetClass `rdf:List`, `dependent`), with `first` and `rest`
(`shape: PathList`) both `sh:BlankNodeOrIRI` and `contains`. `serializePathToNodeData` builds path
lists from it; `PathNode.alternativePath` declares it as its value shape. `List`, `rdfList()` and
the `sh:in` lists (cells with fixed IRIs `{psIri}/in/{i}`) are untouched.

### Decision 4 of 9 — metamodel declarations

`sh:BlankNodeOrIRI` on `PropertyShape.path`, every `PathNode` slot (`inversePath`,
`alternativePath`, `zeroOrMorePath`, `oneOrMorePath`, `zeroOrOnePath`) and `PathList.first` /
`.rest`. Predicate paths are `{id}` references and stay IRIs; operator nodes and path list cells
(no id) become blank. `contains` stays on these properties: the typed dependent cascade still
needs it to remove the IRI path nodes of versions before 2.30 (migration).

### Decision 5 of 9 — remove `__blank` entirely

From `NodeDescriptionValue`, `convertNodeDescription`, `IRNodeData`, the DSL-JSON encoder and both
decoders, `RESERVED_KEYS`, the SPARQL lowering (`assertBlankIsOwned`, `BLANK_SYNTAX_PREDICATES`,
the blank-root check), `serializePathToNodeData`, `RdfListNodeData`, README and the architecture
doc. The wire carries nothing new: the receiving side lowers with its own registry, which has the
metamodel (client and server both load `@_linked/core`), so both mint the same way. A `__blank`
key sent by an older client becomes an unknown property and is rejected like any other.

### Decision 6 of 9 — deletion follows blank-capable properties (accepted: 2A)

When a subject is deleted (by id and bulk), or a value is replaced / unset through a property
whose `nodeKind` allows blank nodes, its blank value and blank descendants are deleted:

```sparql
<owner> (p1|…|pn) ?bn0 . FILTER(isBlank(?bn0))
?bn0 (q1|…|qm)* ?bn . ?bn ?bnp ?bno . FILTER(isBlank(?bn))
FILTER NOT EXISTS { ?bn0 (q1|…|qm)* ?mid . ?mid (q1|…|qm)+ ?bn . FILTER(!isBlank(?mid)) }
```

- `p…` — the blank-capable properties of the owner's shape (and its sub-shapes);
- `q…` — the closure: the blank-capable properties of the shapes those properties' values can
  have (value shape and sub-shapes; a property without a value shape is polymorphic and reaches
  every shape, as `reachableDependentTypes` already treats it). For a property shape that is the
  `PathNode` slots, `PathList.first`/`.rest` and `sh:path`;
- owners: the deleted subject, and every dependent-typed node the typed cascade deletes (so a
  NodeShape delete removes the blank paths of its property shapes, including those of its
  generated single-owner shapes);
- every deleted node is guarded with `FILTER(isBlank(…))`, so no IRI (a predicate such as
  `schema:image`, a listed entity) is ever deleted, and the `NOT EXISTS` guard refuses a blank node
  reached *through* an IRI: SPARQL property paths cannot constrain intermediate nodes, and with a
  polymorphic slot the closure includes every blank-capable predicate of the registry. This keeps
  the #332 regression (a blank list's `rdf:first` must not lead into the entity it lists and
  delete that entity's blank children). Blank structures written by core are trees, so the guard
  removes nothing they own.

It replaces both the `contains`-tied blank block of `buildOwnedCascade` and the bulk delete's
recursive `blankNodeBlocks` (which recursed without a cycle guard).

Rejected: **B, keep the `contains`-tied block** — blank nodes would need `contains` to be
deletable, two rules for one thing; **C, generic CBD** (delete every blank node reachable) — it
can traverse through IRIs into unrelated blank structures (OWL restrictions, other tools' data).

### Decision 7 of 9 — DSL scope of this step (accepted: 3A)

Supported: nested create (decision 1), and delete / replace / unset through the parent
(decision 6). Clear errors, never silent, for:

- an `update` / `upsert` / `updateWhere` with a nested value that would be minted blank (its
  INSERT template runs once per WHERE solution, so the structure would be written several times);
- linking a blank-node id (`{id: '_:b0'}`), `update().for('_:b0')`, a delete by a blank-node id:
  a blank node is not addressable. A blank-node id is a string starting with `_:` (SPARQL /
  N-Triples label syntax; never a valid IRI, whose scheme starts with a letter). The check sits
  in the SPARQL lowering's IRI term constructor, so every path (in-process and wire) hits it;
- a nested create with an id under `sh:BlankNode` / `sh:BlankNodeOrLiteral`, and a nested object
  under `sh:Literal` (decision 1).

A select returns stored values as today: a blank value comes back as its label (Fuseki: `b0`,
without `_:`), so passing that string back as an id cannot be detected (backlog).

Rejected for now (backlog): **B** update/upsert of blank values through the parent; **C** a read
model that returns blank values as nested objects without an id.

### Decision 8 of 9 — the create result

A nested node's id in the create result is `''` when core minted it, as before, so a blank node
reports `''` too. Unchanged.

### Decision 9 of 9 — release

Minor changeset. `__blank` (released in 2.30.0, used only by shape sync) is removed and replaced
by `nodeKind`-driven minting. The persisted SHACL of shape sync is unchanged: verified by
comparing the INSERT DATA of a fixture sync against the 2.30.0 release, modulo blank labels.

## Selected route

1A + PathList + 2A + 3A as above.
