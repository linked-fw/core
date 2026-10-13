---
summary: Persist complex SHACL property paths (inverse, alternative, sequence, cardinality) as untyped blank nodes, so validators read them as the paths they are instead of predicate paths.
status: Implementation
packages: [core]
---

# 003 — Complex SHACL paths as blank nodes

## Problem

Shape sync writes every complex `sh:path` as IRI-named nodes:

```turtle
<…/Thing/image.singleOwner/owners> sh:path <…/Thing/image.singleOwner/owners/inv> .
<…/Thing/image.singleOwner/owners/inv> a core:PathNode ; sh:inversePath schema:image .
```

SHACL §2.3.1: a property path is an IRI (a predicate path) **or a blank node**. An IRI in
`sh:path` is a predicate path, whatever triples it has. Jena's `ShaclPaths.parsePath` returns
`pathLink(node)` for any URI before it looks at `sh:inversePath`. Measured against the test
Fuseki (Jena 6.2.0, `/ds/shacl`) with two subjects pointing at one image and `sh:maxCount 1`:

| `sh:path` value | `sh:conforms` |
|---|---|
| `<…/inv>` (IRI, today) | `true` — the violation is never reported |
| `[ sh:inversePath ex:image ]` | `false`, `maxCount[1]: … Got count = 2` |
| `[ a ex:PathNode ; sh:inversePath ex:image ]` | `false` (Jena is lenient) |

So every persisted complex path, including every generated `.singleOwner` constraint
(report 032), is read as a predicate path that never matches, and silently never flags anything.

## Decisions

Priority: 1 maintainability, 2 scalability, 3 performance.

### D1 — Representation: untyped blank nodes in plain SHACL syntax

```turtle
<…/owners> sh:path [ sh:inversePath schema:image ] .
<…/p>      sh:path ( schema:knows [ sh:inversePath schema:parent ] ) .   # sequence
<…/q>      sh:path [ sh:alternativePath ( schema:a schema:b ) ] .
```

Operator nodes and their list cells are blank nodes and carry **no `rdf:type`**. Chosen over
typed blank nodes (`a core:PathNode`), which Jena tolerates, because the spec defines an inverse,
alternative or cardinality path as "a blank node that is the subject of exactly one triple"; a
typed one is an ill-formed path, and validation over ill-formed shapes is undefined. List cells
could legally keep `rdf:type rdf:List`, but one rule for all path structure (only the triples the
SHACL syntax defines) is simpler. Simple predicate paths stay IRIs. `sh:in` lists stay IRI cells
(an IRI SHACL list is valid there) — out of scope.

### D2 — Mechanism: a `__blank` node-data marker in nested creates

The create pipeline could not write blank nodes: `generateNodeDataTriples` mints an IRI for every
node and always writes its `rdf:type`. Options considered:

- **(chosen) `__blank: true` on nested node-data**, a sibling of `__id`: the node is written as a
  fresh blank node with only its field triples. Carried through `NodeDescriptionValue.__blank` →
  `IRNodeData.blank` → the DSL-JSON wire (`__blank`) → the SPARQL lowering (a `blank` term,
  `_:bN`). `serializePathToNodeData` keeps building `PathNode`/`List` node-data and only swaps its
  deterministic `__id`s for `__blank`. Every walker of `IRNodeData` (mutation effects, live
  queries, owned-link check) keeps working, since the value is still node-data with a shape.
- A dedicated "SHACL path value" kind (`{shaclPath: PathExpr}`) — the same five touch points plus
  a new IR value kind every walker must learn; rejected.
- A shape-derived rule (`nodeKind sh:BlankNode` on the holding property, propagating into nested
  nodes) — needs no wire change, but cannot express "no `rdf:type`", and a list cell's shape
  (`List`) is shared with `sh:in` and user lists, so the rule would have to propagate implicitly;
  rejected as too magic.

Contract: `__blank` is accepted only on **nested** node-data in a **create**. With `__id`/`id` it
throws; at the root of a create it throws (the root must be addressable); in an update/upsert it
throws, because blank nodes in a `DELETE/INSERT … WHERE` template are minted once per solution and
the cleanup UNION yields several solutions, so the structure would be duplicated. Shape sync is
`delete → create (INSERT DATA)`, which is the only writer that needs it. A blank nested node
reports `id: ''` in the create result, as minted nested ids already did.

### D3 — Delete cascade: one blank-node block

Blank nodes cannot be addressed by IRI and carry no type, so the typed dependent cascade
(`?root (c…)* ?own . ?own a <T>`) cannot see them. `buildOwnedCascade` gains one block, emitted
wherever it emits the typed blocks:

```sparql
<root> (c1|…|cn)* ?b0 . FILTER(isBlank(?b0))
?b0 (c1|…|cn|rdf:first)* ?bn . FILTER(isBlank(?bn))
?bn ?p ?o .
```

The first closure reaches the blank nodes owned through `contains` edges (`sh:property`,
`sh:path`, `core:generatedShape`, `rdf:rest`, the path operators). The second continues inside a
blank structure and also follows `rdf:first`, because a sequence member that is itself an operator
node is held by `rdf:first` — not a `contains` edge, so the typed cascade never reached it (legacy
IRI nodes in that position were leaked; see Migration). `rdf:first` is followed only from a blank
node, so a user list of IRIs never leads the cascade into the items it lists. The block costs one
UNION branch, only where the typed cascade already runs (subject deletes whose shape reaches a
dependent type, and `contains` replace/remove in updates); a `Thing.image` owner still pays for
none.

`PathNode` keeps `dependent: true` and `core:PathNode`: the typed block is what removes the legacy
IRI nodes on the next sync.

### D4 — Readers

Core has no reader of persisted path structure: runtime shapes come from the wire
(`registerRuntimeShape`/`fromWire`, `PathExpr` JSON) and the registry, never from the store.
A DSL select of `PropertyShape.path` returns a blank node's label string (`resultMapping.ts:154`),
which is not a stable identity across queries.

Consumer impact (a consuming application, file:line, for a follow-up there):

1. **Breaks** — `src/utils/shapeCatalogQuery.ts`: query 1 (DSL select, :78-135, `path:
   idOf(p?.path)` :390-397) returns the path node's id; `PATH_STRUCTURE_QUERY` (:222-238) returns
   the structure keyed by `?node`; `resolveCatalogPaths` (:332-343) joins them on that id. With
   blank nodes the two queries label nodes independently, so the join misses (the label is then
   returned as a predicate IRI, :310) or, worse, collides (`b0` in both) and gives a property the
   wrong path. Fix there: return `?ps` from the structure query and key by the property-shape IRI.
   Callers: `src/backend/shapes/ProjectProvider.ts:419`, `src/utils/documentStaging.ts:435`,
   `src/features/document-studio/services/ManagedDocumentRemapService.ts:108`,
   `src/features/document-studio/services/shapeGuidedExtraction.ts:139`.
2. **Degrades** — `src/data/shapeInstances.ts:61` calls `fetchShapeCatalog()` without a store, so
   complex paths arrive as their node reference; that becomes a meaningless label instead of a
   stable (but already wrong) IRI.
3. **Loses the path quietly** — `src/services/AppShapeIngestService.ts:151,179,297` copies `?path`
   by value into another dataset as `sh:path <…>`; a blank label fails `isSafeIri` and is dropped.
   Today it copies an IRI pointing at a structure the target dataset lacks.
4. **Pre-existing leak, unchanged** — `src/services/CodeShapeSyncService.ts:279-283` deletes a
   shape's property shapes without following `sh:path`; path nodes are orphaned today and will be
   orphaned (as blank nodes) after.

No reader depends on the `rdf:type core:PathNode`/`rdf:List` triples. Other `packages-local`
checkouts and `packages/*` have no store readers of path structure.

**Blocking:** item 1 breaks a consumer as soon as it installs this version. Per the task brief the
work stops before pushing until the order is decided (see the report).

### D5 — Migration

Stored IRI path nodes from earlier syncs are removed by the next sync's delete: they are typed
`core:PathNode`/`rdf:List` and reached through `contains`, so the existing typed blocks delete them,
and the create writes blank nodes. Exception: a legacy operator node held by a sequence cell's
`rdf:first` (`<…/seq/0/inv>`) was never reachable and stays as an unreferenced orphan — harmless to
validators (nothing points at it). Covered by a live migration test.

### D6 — Release level

**minor.** The persisted format changes and `__blank` is a new create input. No API is removed and
reads through core are unaffected; the consumer break is in a reader that relied on an
undocumented storage detail (path node IRIs). Not a patch: data written by the new version is
different, and readers must be checked. Renovate holds nothing back for a minor, which is why the
consumer fix must land first.

### D7 — Validator evidence

The test compose enables the image's SHACL endpoint (`ENABLE_SHACL=true`, plus `ENABLE_UPDATE` and
`ENABLE_DATA_WRITE` so the test can load data). The `secoresearch/fuseki` entrypoint uncomments
`fuseki:endpoint [ fuseki:operation fuseki:shacl ; fuseki:name "shacl" ]` on its built-in `ds`
dataset; uploading a service config through `/$/datasets` is refused by Fuseki 6 ("Service
configuration from an upload file not supported"). The live test syncs a shape with a `contains`
property into its own dataset, CONSTRUCTs the stored shapes as Turtle, loads a two-owner graph into
`ds`, and POSTs the shapes to `/ds/shacl` expecting `sh:conforms false` with a `maxCount` result on
an inverse path. This replaces the skipped placeholder in `sparql-fuseki-shape-sync.test.ts`.

## Files

- `src/queries/QueryFactory.ts` — `NodeDescriptionValue.__blank`.
- `src/queries/MutationQuery.ts` — read/validate `__blank` in `convertNodeDescription`.
- `src/queries/IntermediateRepresentation.ts`, `src/queries/IRMutation.ts` — `IRNodeData.blank`.
- `src/queries/MutationSerialization.ts` — `__blank` on the wire, both directions.
- `src/sparql/SparqlAlgebra.ts`, `src/sparql/algebraToString.ts` — `blank` term.
- `src/sparql/irToAlgebra.ts` — blank subjects without `rdf:type`; reject in updates; blank block
  in `buildOwnedCascade`.
- `src/sparql/SparqlDataset.ts` — reject a blank root.
- `src/shapes/serializePathToNodeData.ts` — `__blank` instead of minted ids.
- `src/shapes/PathNode.ts`, `singleOwnerConstraint.ts`, `syncShapes.ts` — comments.
- `src/tests/docker-compose.test.yml` — SHACL endpoint.
- Tests: unit (serializer, lowering, cascade, wire round-trip, rejections) and live (sync writes
  blank nodes, re-sync idempotent, migration from IRI nodes, removed property leaves no blank
  orphans, Jena SHACL validation).

## Architecture compliance

`docs/architecture/` holds `publishing.md` and `owned-values.md`. `owned-values.md` describes the
generated `.singleOwner` shape with `sh:path [ sh:inversePath … ]` — the format this change makes
true; update its storage notes. No publishing change.

## Phases

### Phase 1 — Blank nested nodes in create
Marker through input → IR → wire → SPARQL lowering; rejections.
Validation: unit tests for lowering (`_:b` subject, no type triple), wire round-trip, the three
rejections; `npx jest src/tests/sparql-mutation*` green.

### Phase 2 — Cascade blank block + serializer switch
`buildOwnedCascade` blank block; `serializePathToNodeData` uses `__blank`; update unit tests that
pinned `{base}/inv` ids.
Validation: full `npm test` green (offline-live skipped allowed only locally).

### Phase 3 — Live evidence
Compose SHACL endpoint; live tests: format, idempotent re-sync, migration, orphan check, Jena
validation.
Validation: `npm run test:fuseki` green with live tests running.

Dependencies: 1 → 2 → 3, sequential.

### Progress

- Phases 1 and 2 — done, one commit (the lowering signature change and the serializer switch
  could not be tested apart: the cascade tests pin the serializer's output). Validation: `npm
  test` green (2200 passed; the 120 skipped are the offline duplicates of live blocks and
  pre-existing skips). New `src/tests/blank-nested-nodes.test.ts` (11 tests).
- Phase 3 — done. `npm run test:fuseki`: 284 live tests, 284 passed, 0 skipped. Live: format and
  exactly-one-triple check, idempotent re-sync (blank triple count stable, no orphan blank
  nodes), removed accessor and NodeShape delete leave no orphan blank nodes, migration from the
  legacy IRI form, Jena SHACL: two owners → `sh:conforms false` (`MaxCountConstraintComponent`,
  `sh:resultPath [ sh:inversePath schema:image ]`), one owner → conforms, legacy IRI form with two
  owners → `sh:conforms true` (the bug, reproduced).
- Found while testing (pre-existing, not changed): inbound DSL-JSON validation
  (`lowerMutationJSON` → `assertInboundDataValid` → `decodeNodeDataToRaw`) drops `__shape`, so a
  nested value of a polymorphic slot (`PropertyShape.path`, `List.first`) fails with "the property
  declares no shape for its values". A shape sync whose dataset is reached over the mutation wire
  cannot write any complex path, IRI or blank. The wire round-trip test therefore uses a slot with
  a declared value shape.

## Test strategy

Quick gate after each phase: `npx jest <touched test files>` (< 1 min). Full: `npm test`
(jest + typecheck) and `npm run test:fuseki` at the end of phase 3 and in review.

## Review

Independent correctness review of the diff:

1. **Medium — over-deletion.** The inner walk `?b0 (contains|rdf:first)* ?bn` only required its
   end points to be blank. Through a blank list's `rdf:first` it could reach an IRI entity the list
   merely lists and continue along that entity's `contains` edges, deleting its blank children
   (reproduced on Fuseki). The comment claiming otherwise was wrong.
2. Low — a subject delete whose shape reaches no dependent type emits no blank block; blank nodes
   two levels below the subject would stay. Shape sync is unaffected (`sh:path` reaches every type).
3. Low — `__blank` was accepted under a non-`contains` property, where nothing deletes it.
4. Low — the DSL-JSON decoder accepted `__blank` with `__id` (id silently dropped) and ignored a
   non-`true` `__blank`.
5. Low — performance: the blank filters wrapped the whole block.

## Iteration 1

- Gap 1 (medium): the inner walk follows only the RDF-list and SHACL-path syntax predicates
  (`rdf:first`, `rdf:rest`, `sh:inversePath`, `sh:alternativePath`, `sh:zeroOrMorePath`,
  `sh:oneOrMorePath`, `sh:zeroOrOnePath`) — the only structures core writes blank. SPARQL property
  paths cannot constrain intermediate nodes, so restricting the vocabulary is what keeps the walk
  inside syntax. Live regression test in `blank-nested-nodes.test.ts`.
- Gap 3: a blank nested node must be held by a `contains` property, or by a syntax predicate of a
  blank parent (`rdf:first` of a blank cell). Checked in the lowering.
- Gap 4: the lowering rejects `blank` with an `id` (any IR source); the decoder rejects a non-`true`
  `__blank`.
- Gap 5: the blank block is built as `filter(isBlank(bn), join(filter(isBlank(b0), …), …))`; the
  rendered text places each FILTER after the triple that binds it.
- Gap 2: deferred and documented — the blank block runs wherever the typed cascade runs; shapes
  that own only non-dependent values get the depth-1 owned-child delete only.

Validation: `npm test` exit 0 (jest 2204 passed, 120 skipped = unchanged baseline; typecheck
clean). `npm run test:fuseki`: 285 live, 285 passed, 0 skipped.
