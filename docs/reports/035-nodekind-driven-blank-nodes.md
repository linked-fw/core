---
summary: >
  `__blank` (report 034) is removed. A nested create is written as an untyped blank node when the
  property holding it declares a blank-capable `sh:nodeKind`; the metamodel declares the SHACL
  path slots `sh:BlankNodeOrIRI` and adds a `PathList` shape, so shape sync writes byte-for-byte
  what 2.30.0 wrote. Blank values are deleted through blank-capable properties (subject delete,
  replace / unset, owned children, dependent nodes), never through `contains`, and only blank
  nodes are ever deleted. Updates that would mint blank nodes and `_:` ids are refused. Minor.
packages: [core]
---

# 035 — `sh:nodeKind`-driven blank nodes

PR: [#336](https://github.com/linked-fw/core/pull/336).

Follows [report 034](034-shacl-complex-paths-as-blank-nodes.md) (PR #332, 2.30.0), which wrote
complex `sh:path` values as blank nodes through a `__blank: true` key on nested create node-data
and deleted them with a `contains`-tied blank block. That key ran through every layer (builder
input, IR, DSL-JSON wire, lowering) for something the schema already knows. IRIs stay the default
everywhere; blank nodes are used where the property says so, and core says so only for SHACL path
operator nodes and path lists (SHACL §2.3.1).

Follow-ups: [backlog 054](../backlog/054-blank-node-support-next-steps.md). Contract:
[owned-values — Blank-node values](../architecture/owned-values.md#blank-node-values).

## Decisions

Priority: maintainability, then scalability, then performance.

1. **The property's `sh:nodeKind` decides (1A).** `nestedNodeKind` in `src/sparql/irToAlgebra.ts`:

   | `nodeKind` | without id | with id |
   |---|---|---|
   | unset, `sh:IRI`, `sh:IRIOrLiteral` | IRI (minted, as before) | IRI |
   | `sh:BlankNodeOrIRI` | blank node | IRI |
   | `sh:BlankNode` | blank node | error: a blank node has no id |
   | `sh:BlankNodeOrLiteral` | blank node | error: an IRI is not allowed |
   | `sh:Literal` | error | error |

   `objectProperty` defaults to `sh:IRI`, `literalProperty` to `sh:Literal`; `linkedProperty`
   leaves it unset. Nothing changes for a property that does not opt in. Rejected: the node
   shape's `nodeKind` (`sh:path` is polymorphic and its operator nodes are untyped, so nothing on
   the value names the deciding shape); both (more than needed now, backlog 054 item 3).
2. **A blank node is untyped.** Field triples only, no `rdf:type`, as `__blank` nodes were: a
   SHACL path operator must be the subject of exactly one triple (report 034). Consequence: the
   concrete subclass of a blank value is not persisted (backlog 054 item 3).
3. **`PathList`** (`src/shapes/PathList.ts`, targetClass `rdf:List`, `dependent`): `first` and
   `rest` (`shape: PathList`, `contains`) are `sh:BlankNodeOrIRI`. `List` could not carry it:
   `List.first` holds literals in `sh:in` (a node-only kind would fail the node-kind check), and
   a blank-capable `List.rest` would turn the tail cells of every `rdfList()` without ids into
   blank nodes (the override rule also forbids widening `sh:IRI` in a subclass). `PathList.first`
   is **not** `contains`: ownership is per predicate across the registry, and `rdf:first` of
   every other list holds values the list does not own. `List`, `rdfList()` and `sh:in` (fixed
   IRI cells `{psIri}/in/{i}`) are unchanged. Like `PathNode`, it is loaded by `shapes/index.ts`
   and importable as `@_linked/core/shapes/PathList`, not a root export.
4. **Metamodel.** `PropertyShape.path` (`src/utils/Package.ts`), every `PathNode` slot and
   `PathList.first` / `.rest` are `sh:BlankNodeOrIRI`; `PathNode.alternativePath` declares
   `PathList`. Predicate paths are `{id}` references and stay IRIs; operator nodes and path list
   cells carry no id (`serializePathToNodeData`) and become blank. `contains` stays on the slots so
   the typed dependent cascade still removes the IRI path nodes of versions before 2.30.
5. **`__blank` removed** from `NodeDescriptionValue`, `convertNodeDescription`, `IRNodeData`
   (`blank`), the DSL-JSON encoder and both decoders, `RESERVED_KEYS`, `RdfListNodeData`,
   `serializePathToNodeData`, the lowering (`assertBlankIsOwned`, `BLANK_SYNTAX_PREDICATES`, the
   blank-root check), README and `owned-values.md`. Nothing new on the wire: the side that lowers
   uses its own registry, which has the metamodel, so client and server mint the same way. A
   `__blank` key is now an undeclared property (rejected). The root of a create is always an IRI.
6. **Deletion follows blank-capable properties (2A).** `buildBlankCascade`, one UNION branch per
   owner:

   ```sparql
   <owner> (p1|…|pn) ?bn0 . FILTER(isBlank(?bn0))
   ?bn0 (q1|…|qm)* ?bn . ?bn ?bnp ?bno .
   FILTER(isBlank(?bn) && NOT EXISTS { ?bn0 (q…)* ?mid . ?mid (q…)+ ?bn . FILTER(!isBlank(?mid)) })
   ```

   | Mutation | Owner | `p…` |
   |---|---|---|
   | delete by id, bulk delete (`subjectBlankCascade`) | the subject (bulk: led by its type triple) | the subject shape's blank-capable predicates, sub-shapes included |
   | delete by id / bulk (`ownedChildBlankCascade`), `contains` replace / set-remove of a property with a `shape` | the immediately-owned child | its value shape's blank-capable predicates |
   | any containment cascade (`buildOwnedCascade`) | each dependent-typed node it deletes (`<root> (c…)* ?bo . ?bo a <T>`) | the blank-capable predicates of the shapes targeting `T` |
   | replace / unset / overwrite of a blank-capable property | the old value itself (`?old`, bound by `<s> <p> ?old`) | — |

   - `q…` (`blankWalkPredicates`): the closure over value shapes and sub-shapes; a blank-capable
     property without a value shape is polymorphic and yields every blank-capable predicate in the
     registry (the rule `reachableDependentTypes` applies to `contains`).
   - Only blank nodes are deleted. The `NOT EXISTS` refuses a blank node reached through an IRI
     (property paths cannot constrain intermediate nodes), which keeps the #332 regression: a
     blank list's `rdf:first` must not lead into a listed entity and delete that entity's blank
     values. Core's blank structures are trees, so the guard removes nothing they own.
   - A dependent type's predicate is followed only when every shape targeting that class declares
     it blank-capable (`collectContainment().dependentBlankProps`): `List` and `PathList` both
     target `rdf:List` and disagree, so a typed list cell's blank `rdf:first` member is content
     and stays (review gap 1).
   - Replaced: the `contains`-tied blank block of `buildOwnedCascade` and the bulk deletes'
     recursive `blankNodeBlocks` (which recursed by value shape without a cycle guard).
   - Rejected: keep the `contains`-tied block (two rules for one thing, blank nodes would need
     `contains`); generic CBD (traverses through IRIs into unrelated blank structures such as OWL
     restrictions).
7. **DSL scope (3A).** Supported: nested create; delete / replace / unset through the parent.
   Errors, never silent:
   - an `update` / `upsert` / `updateWhere` whose value would be minted blank, at any depth
     (`nestedCreateTriples` has no label minter outside a create; a `DELETE/INSERT … WHERE`
     template mints a blank node per WHERE solution). The message names the property and, for
     `sh:BlankNodeOrIRI`, suggests an id;
   - a `_:…` id wherever the lowering builds an IRI term of a triple (`iriTerm`): links,
     `update().for()`, delete by id, a select's `.for()`;
   - the error rows of decision 1.

   A select returns stored values as before: a blank value comes back as its label (Fuseki `b0`,
   no `_:`), which cannot be detected when passed back (backlog 054 item 2). Rejected for now
   (backlog 054): update / upsert of blank values through the parent; a read model returning
   blank values as nested objects without an id.
8. **Create result:** a minted nested node reports `id: ''`, blank or not, as before.
9. **Release: minor** (`.changeset/nodekind-driven-blank-nodes.md`). `__blank`, released in 2.30.0
   and used only by shape sync, is removed. The persisted SHACL of shape sync is unchanged.

## Sync output equivalence

A scratch script ran `syncShape` with a recording `SparqlDataset` on a fixture with an inverse
path, a three-way alternative with nested `*` and `^`, a three-step sequence with a nested
inverse, `+`, `?` over a sequence, a `contains` property (its generated single-owner shape) and
an `sh:in` list mixing literals and an IRI, once against the npm build of **2.30.0** and once
against this branch's `lib/` (`npx linked build`). The INSERT DATA is 103 lines in both and
`diff` is empty, blank labels included (the labels are allocated in the same order). Rerun after
the review iteration: still identical. Pinned in `src/tests/shape-sync-output-equivalence.test.ts`
(golden = the 2.30.0 output; compared with labels normalized, and exactly). The DELETE differs,
as intended.

## Migration

Unchanged from report 034: the typed cascade (kept `contains` and `dependent`) removes the IRI
path nodes of versions before 2.30 on the next sync; the live migration test passes. Data written
by 2.30.x is already in the final form.

## Consumer impact

- No `__blank` in the consuming application's `src`, its `packages/*`, or any other
  `packages-local/*` checkout.
- No decorated consumer shape declares a blank-capable `nodeKind`. The consuming application maps
  user-authored `nodeKind` values into SHACL Turtle (`ShapeService`); a runtime shape registered
  with `sh:BlankNode*` now gets blank nested creates and refused nested updates.
- **Mixed versions:** a client on this version sending DSL-JSON to a 2.30.x lowering side gets IRI
  path nodes (the `__blank` key it read is gone). Upgrade the lowering side first (changeset,
  backlog 054 item 11).

## Files

| File | Change |
|---|---|
| `src/shapes/PathList.ts` (new) | path list cell shape |
| `src/shapes/PathNode.ts` | slots `sh:BlankNodeOrIRI`; `alternativePath` → `PathList` |
| `src/utils/Package.ts` | `PropertyShape.path` `sh:BlankNodeOrIRI` |
| `src/shapes/index.ts` | loads `PathList` |
| `src/shapes/serializePathToNodeData.ts`, `List.ts` | no `__blank`; path lists from `PathList` |
| `src/queries/QueryFactory.ts`, `MutationQuery.ts`, `IRMutation.ts`, `IntermediateRepresentation.ts`, `MutationSerialization.ts`, `lowerMutationJSON.ts`, `src/shapes/validation.ts` | `__blank` removed |
| `src/sparql/irToAlgebra.ts` | `isBlankCapable`, `nestedNodeKind`, `nestedCreateTriples`, `generateNodeDataTriples(kind)`, `iriTerm` `_:` check, `blankCapableProperties`, `blankWalkPredicates`, `buildBlankCascade`, `subjectBlankCascade`, `ownedChildBlankCascade`, `collectContainment().dependentBlankProps`; old blank code removed |
| `README.md` | "Blank-node values (`nodeKind`)"; shape-sync paragraph |
| `docs/architecture/owned-values.md` | "Blank-node values" (writing, deleting, guards) |
| `docs/backlog/054-blank-node-support-next-steps.md` | follow-ups |

## Tests

- `src/tests/blank-nested-nodes.test.ts` (rewritten, 27): minting per `nodeKind` (with / without
  id, every kind), labels, IR without markers, wire round trip without `__blank`, `__blank`
  rejected; 3A errors (update, upsert, updateWhere, nested deeper, id'd value allowed, `_:` link /
  `for()` / delete); cascade text (NodeShape delete reaches `sh:path` of deleted property shapes,
  never through `(contains)*`, subject block, replace / unset block); live: the #332 list
  regression, delete by id of a 5-node blank alternative with IRIs intact, replace with an IRI
  link and unset, owner delete and child replace remove the child's blank values, a typed list
  cell's blank member kept.
- `src/tests/shape-sync-output-equivalence.test.ts` (new): the 2.30.0 golden.
- `mutation-decode-concrete-shape.test.ts` (#334's round trip: blank `PathNode` via `nodeKind`,
  no `__blank`, wire lowering writes `_:b0`), `shacl-path-translator.test.ts` (blank under a
  blank-capable slot, IRIs under a plain one), `single-owner-constraint.test.ts`,
  `shacl-cascade.test.ts`, `mutation-where-union.test.ts` (bulk delete is one blank branch;
  solutions still add up live).
- Unchanged and passing live: `sparql-fuseki-shape-sync.test.ts` — idempotent re-sync, no orphan
  blank nodes, migration from IRI path nodes, Jena SHACL (two owners → `conforms false`, one →
  `conforms true`).

`npm test`: exit 0, 2223 passed, 120 skipped (baseline 2209 / 120), typecheck clean.
`npm run test:fuseki`: `[fuseki] live tests: 291 total — 291 passed, 0 failed, 0 skipped`
(baseline 285). `npx linked build`: green.

## Limitations

- Walk cost: `?bn0 (q…)* ?bn` runs through IRIs before the guard filters; with the polymorphic
  closure a path operand connected to large data is enumerated. Blank nodes shared between owners,
  or also reachable through an IRI, are deleted or kept respectively (documented tree assumption).
- Deeper non-dependent owned nodes keep their blank values; bare `{id}` links under
  `sh:BlankNode` are not refused; unknown properties mint IRIs silently; `_:` in filter
  expressions is not refused; duplicate branch on a dependent subject (backlog 054 items 5, 7-10).
