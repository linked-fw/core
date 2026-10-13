---
summary: >
  Replace the `__blank` node-data key (report 034) with schema-driven minting: a nested create is
  written as a blank node when the property it sits under declares a blank-capable `sh:nodeKind`.
  The core metamodel declares the SHACL path slots blank-capable, so shape sync writes the same
  blank path structure as 2.30 with nothing on the wire. Blank-node cleanup on delete / replace
  follows the blank-capable properties instead of `contains`.
status: Implementation
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

## Plan

### Architecture

Minting moves from the node-data (`__blank`) to the lowering, where the property shape is known:
`generateNodeDataTriples` asks `nestedNodeKind(field.property, nested)` for every nested create and
passes the answer down. Nothing above the lowering (builders, IR, wire) knows about blank nodes.

```ts
// src/sparql/irToAlgebra.ts (internal)
type NestedNodeKind = 'iri' | 'blank';
/** sh:BlankNode, sh:BlankNodeOrIRI, sh:BlankNodeOrLiteral. */
function isBlankCapable(ps: {nodeKind?: {id?: string}} | undefined): boolean;
/** Decision 1's table; throws for the error rows. */
function nestedNodeKind(propertyId: string, data: IRNodeData): NestedNodeKind;
function generateNodeDataTriples(
  data: IRNodeData,
  options?: SparqlOptions,
  blanks?: BlankNodeMinter, // only a create passes one; a blank node without it throws (3A)
  kind?: NestedNodeKind,    // default 'iri' (the root)
): {term: SparqlTerm; triples: SparqlTriple[]};

/** Blank-capable simple-path predicates of a shape, its ancestors' and its sub-shapes'. */
function blankCapablePredicates(shapeId: string): string[];
/** The inner-walk closure from the given blank-capable property shapes (decision 6). */
function blankWalkPredicates(start: PropertyShapeData[]): string[];
/** One UNION branch: delete the blank values of `owner` through `first` and their blank descendants. */
function buildBlankCascade(
  ownerTriples: SparqlTriple[], // binds the owner (anchor / type / contains walk)
  ownerTerm: SparqlTerm,
  first: string[],
  inner: string[],
  varPrefix: string,
): {deletePatterns: SparqlTriple[]; whereBlock: SparqlAlgebraNode} | null;
```

Where blank cleanup is emitted:

| Mutation | Owner(s) | `first` predicates |
|---|---|---|
| delete by id, bulk delete | the subject | the subject shape's blank-capable predicates |
| delete by id, bulk delete, `contains` replace / set-remove (`buildOwnedCascade`) | each dependent type the typed cascade reaches | that type's shapes' blank-capable predicates |
| replace / unset / overwrite of a blank-capable property | the old value itself (`<s> <p> ?old`) | none: `?old` is `?bn0` |

`iriTerm` (the lowering's IRI constructor) throws for a `_:` id (decision 7).

### Expected file changes

| File | Change |
|---|---|
| `src/shapes/PathList.ts` (new) | `PathList` shape (decision 3) |
| `src/shapes/PathNode.ts` | slots `nodeKind: shacl.BlankNodeOrIRI`; `alternativePath` → `PathList`; comment |
| `src/utils/Package.ts` | `PropertyShape.path` `sh:BlankNodeOrIRI`; register `PathList` |
| `src/shapes/serializePathToNodeData.ts` | no `__blank`; lists from `PathList` |
| `src/shapes/List.ts` | drop `__blank` from `RdfListNodeData` |
| `src/queries/QueryFactory.ts`, `MutationQuery.ts`, `IRMutation.ts`, `IntermediateRepresentation.ts` | remove `__blank` / `blank` |
| `src/queries/MutationSerialization.ts`, `lowerMutationJSON.ts` | remove the wire key |
| `src/shapes/validation.ts` | `__blank` no longer reserved |
| `src/sparql/irToAlgebra.ts` | minting, blank cascade, 3A errors; remove the old blank code |
| `src/queries/SelectQuery.ts` | comment |
| `src/shapes/index.ts` | load `PathList` (registration); like `PathNode` it is not a root export |
| tests | see phases |
| `README.md`, `docs/architecture/owned-values.md` | the rule |
| `docs/backlog/055-blank-node-support-next-steps.md` (new) | follow-ups |
| `.changeset/nodekind-driven-blank-nodes.md` | minor |

### Pitfalls

- `findPropertyShapeById` must resolve the property on both sides; the server registry has the
  metamodel and every registered/runtime shape (`nodeKind` travels in the shape wire format).
- The closure for a polymorphic slot includes test shapes' predicates; tests must not pin the
  full alternation.
- Upsert / update paths call `generateNodeDataTriples` without a minter: blank minting there must
  throw with a message naming the property (3A).
- Legacy IRI `PathNode` / `rdf:List` nodes are still removed by the typed cascade (`contains`
  kept).
- `PathList` shares `rdf:List` as targetClass with `List`; `List` is registered first, so lookups
  by targetClass keep returning `List`.

### Architecture compliance

`npx semantu-agents docs architecture`: `owned-values.md` (owned values and the cascade) applies;
`ontologies.md`, `publishing.md`, `runtime-instances.md` do not constrain this change.
`owned-values.md` currently states "Blank nodes need neither flag … `__blank` nested node-data";
it is updated to the `nodeKind` rule and the new cascade rows. The ownership contract for IRI
values (`contains` / `dependent`) is unchanged.

### Test strategy

Impacted package: core only. Quick gate after each phase (≈1-2 min):
`npx jest --config jest.config.cjs src/tests/<touched files>` (with `NODE_OPTIONS=--experimental-vm-modules`)
plus `npm run typecheck`. Full gate in review: `npm test` (all suites + typecheck; live Fuseki
suites run when the test Fuseki on :3939 is up), `npm run test:fuseki` (must print the
`[fuseki] live tests` summary with 0 skipped), `npx linked build`. Baseline before changes:
2209 passed, 120 skipped; `[fuseki] live tests: 285 total — 285 passed`.

## Phases

Sequential: every phase edits `src/sparql/irToAlgebra.ts`.

### Phase 1 — metamodel, minting, `__blank` removed

Tasks:
1. Add `PathList`; declare the metamodel node kinds (decision 4); `PathNode.alternativePath` →
   `PathList`; load it from `shapes/index.ts`.
2. `nestedNodeKind` + `generateNodeDataTriples(kind)`; remove `assertBlankIsOwned`, the
   blank-root check, `IRNodeData.blank`.
3. Remove `__blank` from builders, IR, wire encode/decode, `RESERVED_KEYS`, `RdfListNodeData`,
   `serializePathToNodeData`.
4. Tests: rewrite `blank-nested-nodes.test.ts` creation cases on a `BlankNodeOrIRI` slot; update
   `mutation-decode-concrete-shape.test.ts` (slot declared `sh:BlankNodeOrIRI`, wire has no
   `__blank`, lowering via wire writes `_:b0`), `single-owner-constraint.test.ts`,
   `shacl-path-translator.test.ts`.

Validation:
- `create under BlankNodeOrIRI without id` — SPARQL contains `<h1> <slot> _:b0 .` and
  `_:b0 shacl:inversePath <…parent> .`, no `rdf:type` on `_:b0`;
- `with id` — `<n1> rdf:type …` IRI node, no `_:`;
- `BlankNode with id` → throws `/sh:BlankNode/`; `BlankNodeOrLiteral with id` → throws;
  `Literal with nested object` → throws; `IRIOrLiteral` → IRI;
- an unset-nodeKind `linkedProperty` and an `objectProperty` → IRI (unchanged);
- each blank node of one create gets its own label (`_:b0`…`_:b2` for `seq [a, inv b]`);
- wire round trip (`toJSON` → `lowerMutationJSON` / `fromJSON`) equals in-process lowering, JSON
  contains no `__blank`;
- `__blank` as input key → rejected as an undeclared property;
- `grep -rn __blank src README.md docs/architecture` → no hits outside comments that explain its
  removal (none expected);
- quick gate + typecheck green.

### Phase 2 — blank cascade follows blank-capable properties

Tasks:
1. `blankCapablePredicates`, `blankWalkPredicates`, `buildBlankCascade` (with the `NOT EXISTS`
   guard).
2. Delete by id and bulk delete: subject block; remove `blankNodeBlocks`.
3. `buildOwnedCascade`: replace the `contains` blank block with one blank block per reached
   dependent type that has blank-capable properties.
4. `processUpdateFields`: replace / unset / overwrite of a blank-capable property gets a block
   rooted at `?old` (bound through `<s> <p> ?old`, keep filter applied).

Validation:
- `NodeShape delete` text: a block `?c_own… rdf:type shacl:PropertyShape . ?c_own… shacl:path ?…bn0`
  with `FILTER(isBlank(?…bn0))`, an inner walk containing `shacl:inversePath` and `rdf:first`,
  `FILTER(isBlank(?…bn))` and `FILTER NOT EXISTS`; no block reaches `?bn0` through
  `(contains)*` directly;
- `plain shape delete` → no `isBlank`;
- live: the #332 list regression (`blank-nested-nodes.test.ts`, slot `sh:BlankNodeOrIRI`) — the
  holder and its cell go, `e1`'s blank child stays;
- live: delete by id of a holder whose blank-capable slot holds `[ shacl:inversePath ex:image ]`
  → the blank node is gone, `ex:image` triples untouched;
- live: replace and unset of a blank-capable slot remove the old blank structure (inverse and an
  alternative list with a nested operator) and never an IRI value;
- live (existing): `mutation-where-union.test.ts` bulk deletes delete each blank subtree, solutions
  add up (counts updated if the block shape changes);
- live (existing): `sparql-fuseki-shape-sync.test.ts` — idempotent re-sync, no orphan blank
  nodes, migration from IRI path nodes, Jena SHACL (two owners → `conforms false`, one owner →
  `conforms true`);
- quick gate + typecheck green.

### Phase 3 — 3A errors

Tasks: errors for update/upsert/updateWhere blank minting (message names the property and points
to create / replace through the parent), and `_:` ids in `iriTerm`.

Validation (`blank-nested-nodes.test.ts`):
- `update().set({slot: inverse})` on a `BlankNodeOrIRI` slot → throws `/update/` and names the
  property; same for `upsert` and `updateWhere`;
- `update` with a nested create **with** id under `BlankNodeOrIRI` → IRI, no error;
- `update().set({slot: {id: '_:b0'}})`, `create({slot: {id: '_:b0'}})` → throw `/blank node/`;
- `UpdateBuilder.from(X).for('_:b0')` lowered → throws; `DeleteBuilder.from(X, {id: '_:b0'})`
  lowered → throws;
- quick gate + typecheck green.

### Phase 4 — equivalence, docs, backlog

Tasks:
1. `src/tests/shape-sync-output-equivalence.test.ts`: the fixture sync's INSERT DATA (every
   complex path form, a `contains` property → single-owner constraint, an `sh:in` list) equals a
   golden captured from the 2.30.0 release (`node syncfixture.mjs` against the npm tarball), blank
   labels normalized.
2. README and `docs/architecture/owned-values.md`; comments in `PathNode.ts`, `List.ts`,
   `SelectQuery.ts`.
3. `docs/backlog/055-blank-node-support-next-steps.md`.

Validation: equivalence test green; the same script run against this branch's `lib/` prints an
INSERT DATA identical to 2.30.0's (diff empty after label normalization); docs grep for
`__blank` → only the changeset / report history.

## Implementation log

### Phase 1 — done

- `PathList` (`src/shapes/PathList.ts`): `first` is blank-capable but **not** `contains`
  (ownership is per predicate across the registry; `rdf:first` of every other list holds values
  the list does not own). `rest` is `contains` like `List.rest`.
- Minting: `nestedNodeKind` / `nestedCreateTriples` / `generateNodeDataTriples(kind)` in
  `irToAlgebra.ts`. The update-path refusal (3A, first bullet) falls out of `nestedCreateTriples`
  (no minter outside a create) and is tested here already.
- `__blank` removed from builders, IR, wire, validation, serializer, `RdfListNodeData`. The
  old `contains`-tied blank block still runs (its predicate list moved next to
  `buildOwnedCascade`) until phase 2.
- Validation: `npm test` exit 0 — 2210 passed, 120 skipped; `[fuseki] live tests: 285 total —
  285 passed`; typecheck clean. Targeted: `blank-nested-nodes`, `mutation-decode-concrete-shape`,
  `single-owner-constraint`, `shacl-path-translator` 44/44.
