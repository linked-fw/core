---
summary: >
  Shape sync writes complex `sh:path` values (inverse, alternative, sequence, `*`/`+`/`?`) as
  untyped blank nodes, so SHACL validators read them as the paths they are; before, every one was
  an IRI and was read as a predicate path that never matched. Nested create node-data gains
  `__blank: true`; the containment cascade gains a blank-node block; the next sync replaces stored
  IRI path nodes. Verified with Jena SHACL on the test Fuseki. Minor release. Consumers that
  joined on path node ids across queries must key path structure by the property shape instead.
packages: [core]
---

# 034 — Complex SHACL paths as blank nodes

## The bug

SHACL §2.3.1: a property path is an IRI (a predicate path) or a blank node. Shape sync wrote every
complex path as IRI-named, typed nodes, so validators read `sh:path <…/owners/inv>` as the
predicate `<…/owners/inv>`. Jena's `ShaclPaths.parsePath` returns `pathLink(node)` for any URI
before it looks at `sh:inversePath`. Every persisted complex path was misread, including every
generated `.singleOwner` constraint (report 032), which therefore never reported anything.

Measured on the test Fuseki (Jena 6.2.0, `/ds/shacl`), two subjects pointing at one image,
`sh:maxCount 1` on the inverse path:

| `sh:path` value | `sh:conforms` |
|---|---|
| `<…/inv>` + `<…/inv> a core:PathNode ; sh:inversePath ex:image` (before) | `true` |
| `[ sh:inversePath ex:image ]` (after) | `false`, `maxCount[1]: … Got count = 2` |
| `[ a ex:PathNode ; sh:inversePath ex:image ]` | `false` (Jena is lenient) |

## Persisted format

Before:

```turtle
<…/Thing/image.singleOwner/owners> sh:path <…/Thing/image.singleOwner/owners/inv> .
<…/Thing/image.singleOwner/owners/inv> a core:PathNode ; sh:inversePath schema:image .
<…/Person/region> sh:path <…/Person/region/seq/0> .
<…/Person/region/seq/0> a rdf:List ; rdf:first ex:worksAt ; rdf:rest <…/Person/region/seq/1> .
<…/Person/region/seq/1> a rdf:List ; rdf:first ex:locatedIn ; rdf:rest rdf:nil .
```

After:

```turtle
<…/Thing/image.singleOwner/owners> sh:path [ sh:inversePath schema:image ] .
<…/Person/region> sh:path ( ex:worksAt ex:locatedIn ) .
```

Operator nodes and list cells carry only the triples the SHACL syntax defines — no `rdf:type`.
The spec defines an inverse, alternative or cardinality path as "a blank node that is the subject
of exactly one triple"; a typed one is ill-formed, and validation over ill-formed shapes is
undefined, so typed blank nodes (which Jena tolerates) were rejected. Simple predicate paths stay
IRIs; `sh:in` lists keep IRI cells (valid SHACL lists, out of scope).

## Decisions

Priority: maintainability, then scalability, then performance.

1. **Untyped blank nodes in plain SHACL syntax** (above).
2. **Mechanism: `__blank: true` on nested create node-data**, a sibling of `__id`. The pipeline
   could not write blank nodes: `generateNodeDataTriples` minted an IRI for every node and wrote
   its type. `__blank` is carried `NodeDescriptionValue.__blank` → `IRNodeData.blank` → DSL-JSON
   `__blank` (both directions, and the builder rehydration path) → a new `blank` SPARQL term
   (`_:bN`, minted per INSERT DATA). `serializePathToNodeData` keeps building `PathNode` / `List`
   node-data and swaps its deterministic `__id`s for `__blank`. Every walker of `IRNodeData`
   (mutation effects, live queries, owned-link check, query dependencies) kept working: the value
   is still node-data with a shape. Rejected: a dedicated "SHACL path value" IR kind (same touch
   points plus a value kind every walker must learn); a shape-derived rule from `sh:nodeKind`
   (no wire change, but cannot say "no `rdf:type`", and `List` is shared with `sh:in` and user
   lists, so blankness would have to propagate implicitly).
3. **Where `__blank` is allowed.** Nested only, in a create only, never with an id, and only under
   a `contains` property or, inside a blank parent, a list / path syntax predicate (`rdf:first` of
   a blank cell). Otherwise it throws:
   - root of a create — the root must be addressable;
   - with `__id`/`id` — in `convertNodeDescription`, and again in the lowering for IR from any
     source (wire included);
   - update / upsert / set-add — blank nodes in a `DELETE/INSERT … WHERE` template are minted once
     per WHERE solution, and the cleanup UNION yields several, so the structure would be written
     several times;
   - under any other property — nothing would ever delete it;
   - `__blank` other than `true` — in both decoders.
   A blank nested node reports `id: ''` in the create result, as minted nested ids already did.
4. **Delete: one blank-node block in `buildOwnedCascade`**, emitted wherever the typed blocks are
   (subject deletes whose shape reaches a dependent type, `contains` replace / set-remove):

   ```sparql
   <root> (c1|…|cn)* ?bn0 . FILTER(isBlank(?bn0))
   ?bn0 (rdf:first|rdf:rest|sh:inversePath|sh:alternativePath|sh:zeroOrMorePath|sh:oneOrMorePath|sh:zeroOrOnePath)* ?bn .
   ?bn ?p ?o . FILTER(isBlank(?bn))
   ```

   Blank nodes have no IRI and no type, so the typed dependent blocks cannot see them. The first
   walk reaches the blank nodes owned through `contains` edges; the second continues inside the
   blank structure and follows `rdf:first` too, because a sequence member that is itself an
   operator is held by `rdf:first`, which is not a `contains` edge. The second walk is limited to
   the list / path syntax predicates: SPARQL property paths cannot require the nodes between `?bn0`
   and `?bn` to be blank, and following every `contains` edge let a blank list's `rdf:first` lead
   into an entity it merely lists and delete that entity's blank children (review finding,
   reproduced on Fuseki, regression-tested). One UNION branch more where the typed cascade already
   runs; a `Thing.image` owner still pays for none.
5. **`PathNode` keeps `dependent: true` and `core:PathNode`**: the typed block is what removes the
   IRI path nodes of earlier versions.
6. **Release: minor** (`.changeset/shacl-complex-paths-as-blank-nodes.md`). The persisted format
   changes and `__blank` is a new create input; nothing is removed. `serializePathToNodeData`
   keeps its second parameter (ignored, documented) so existing two-argument calls compile.

## Migration

The next sync of a shape removes the IRI path nodes earlier versions wrote: they are typed
`core:PathNode` / `rdf:List` and reached through `contains`, so the typed blocks delete them, and the
create writes blank nodes. Tested live (legacy inverse and sequence nodes injected, then synced:
no `…/owners/…` or `…/region/…` subjects left, one blank `sh:path` each, no orphan blank nodes).

Known leftover: a legacy operator node held by a sequence cell's `rdf:first` (an IRI like
`<…/seq/0/inv>`, from a sequence containing an inverse or alternative) was never reachable by the
typed cascade (`rdf:first` is not `contains`) and stays as an unreferenced orphan. Nothing points
at it, so validators ignore it. To remove such leftovers by hand:

```sparql
DELETE { ?n ?p ?o } WHERE {
  ?n a <https://linked.cm/ont/core/PathNode> ; ?p ?o .
  FILTER(isIRI(?n)) FILTER NOT EXISTS { ?x ?y ?n }
}
```

## Readers

Core has no reader of persisted path structure: runtime shapes come from the wire
(`registerRuntimeShape` / `fromWire`, `PathExpr` JSON) and the registry. A DSL select of
`PropertyShape.path` returns a blank node's label string (`resultMapping.ts`), valid only within
that result set; noted in `SelectQuery.ts`.

### Consumer impact (a consuming application; follow-up there)

1. **Breaks — `src/utils/shapeCatalogQuery.ts`.** Query 1 (DSL select, :78-135; `path:
   idOf(p?.path)` :390-397) returns each path node's id. `PATH_STRUCTURE_QUERY` (:222-238)
   returns the structure keyed by `?node` (:267-274). `resolveCatalogPaths` (:332-343) joins the
   two on that id. Blank labels are per result set, so the join misses (the label is then returned
   as if it were a predicate IRI, :310) or collides (`b0` in both) and gives a property the wrong
   path. Fix: return `?ps` from the structure query and key the structure by the property-shape
   IRI. Callers: `src/backend/shapes/ProjectProvider.ts:419`, `src/utils/documentStaging.ts:435`,
   `src/features/document-studio/services/ManagedDocumentRemapService.ts:108`,
   `src/features/document-studio/services/shapeGuidedExtraction.ts:139`. The unit test
   `src/__tests__/shapeCatalogQuery.test.ts:198-260` uses an in-memory map and does not cover the
   cross-query join.
2. **Degrades — `src/data/shapeInstances.ts:61`** calls `fetchShapeCatalog()` without a store, so
   complex paths arrive as their node reference: a meaningless label instead of a stable (already
   wrong) IRI.
3. **Loses the path quietly — `src/services/AppShapeIngestService.ts:151,179,297`** copies `?path`
   by value into another dataset as `sh:path <…>`. A blank label fails `isSafeIri` and is dropped;
   today it copies an IRI that points at structure the target dataset lacks.
4. **Unchanged leak — `src/services/CodeShapeSyncService.ts:279-283`** deletes a shape's property
   shapes without following `sh:path`; its own writes are simple paths only (:306).

Nothing depends on the `rdf:type core:PathNode` / `rdf:List` triples. The other `packages-local`
checkouts and `packages/*` have no store readers of path structure.

## Pre-existing gap found (not changed)

Inbound DSL-JSON validation (`lowerMutationJSON` → `assertInboundDataValid` →
`decodeNodeDataToRaw`) drops `__shape`, so a nested value of a polymorphic slot
(`PropertyShape.path`, `List.first`) fails with "the property declares no shape for its values".
`fromJSON` rehydration fails the same way. A shape sync whose dataset is reached over the mutation
wire cannot write any complex path, IRI-named or blank. The wire round-trip test therefore uses a
slot with a declared value shape. Worth a backlog item.

## Files

| File | Change |
|---|---|
| `src/queries/QueryFactory.ts` | `NodeDescriptionValue.__blank` |
| `src/queries/MutationQuery.ts` | read and validate `__blank` in `convertNodeDescription` |
| `src/queries/IntermediateRepresentation.ts`, `IRMutation.ts` | `IRNodeData.blank` |
| `src/queries/MutationSerialization.ts`, `lowerMutationJSON.ts` | `__blank` on the wire |
| `src/shapes/validation.ts` | `__blank` is a reserved key |
| `src/sparql/SparqlAlgebra.ts`, `algebraToString.ts` | `blank` term, `_:label` |
| `src/sparql/irToAlgebra.ts` | blank subjects without type; `assertBlankIsOwned`; rejections; `BLANK_SYNTAX_PREDICATES`; blank block in `buildOwnedCascade` |
| `src/shapes/serializePathToNodeData.ts` | `__blank` operator nodes and blank list cells |
| `src/shapes/List.ts`, `PathNode.ts`, `SelectQuery.ts` | types, comments |
| `src/shapes/syncShapes.ts`, `singleOwnerConstraint.ts` | one-argument serializer calls |
| `src/tests/docker-compose.test.yml` | `ENABLE_SHACL`, `ENABLE_UPDATE`, `ENABLE_DATA_WRITE` |
| `src/test-helpers/fuseki-test-store.ts` | `readDatasetAsTurtle`, `validateWithJenaShacl` |
| `README.md`, `docs/architecture/owned-values.md` | stored format, `__blank`, cascade rule |

## Validator evidence

`secoresearch/fuseki` uncomments `fuseki:endpoint [ fuseki:operation fuseki:shacl ; fuseki:name
"shacl" ]` on its built-in `ds` dataset when started with `ENABLE_SHACL=true`; `ENABLE_DATA_WRITE`
allows the graph-store PUT of test data. A per-test dataset cannot get one: Fuseki 6 refuses a
service configuration uploaded to `/$/datasets` ("Service configuration from an upload file not
supported"). The live tests (`sparql-fuseki-shape-sync.test.ts`) sync the shapes into their own
dataset, CONSTRUCT them back as Turtle, load the data into `ds` and POST the shapes to
`/ds/shacl`:

- two subjects with one image → `sh:conforms false`, `sh:MaxCountConstraintComponent`, focus node
  the image, `sh:resultPath [ sh:inversePath <https://schema.org/image> ]`, source shape
  `<…/E2EProject/image.singleOwner/owners>`;
- one subject → `sh:conforms true`;
- the pre-change IRI form with two subjects → `sh:conforms true` (the bug, pinned).

This replaces the skipped placeholder test.

## Tests

- `src/tests/blank-nested-nodes.test.ts` (new, 15): lowering (untyped `_:b0`, one label per
  node), IR flag, wire round-trip, every rejection, cascade text, and a live regression for the
  `rdf:first` over-deletion.
- `src/tests/shacl-path-translator.test.ts`: blank operator with exactly one triple; blank list
  cells; node-data marks.
- `src/tests/single-owner-constraint.test.ts`, `shacl-cascade.test.ts`: updated pins.
- `src/tests/sparql-fuseki-shape-sync.test.ts`: blank inverse with exactly one triple; idempotent
  re-sync (blank triple count stable); removed accessor, path change and NodeShape delete leave no
  orphan blank nodes; migration from IRI nodes; Jena SHACL (three cases above).

`npm test`: exit 0, 2204 passed, 120 skipped (the unchanged baseline), typecheck clean.
`npm run test:fuseki`: 285 live tests, 285 passed, 0 skipped.

## Limitations and follow-ups

- Consumer reader (item 1 above) must move to a single-query or `?ps`-keyed read before a
  consumer installs this version.
- A subject delete whose shape reaches no dependent type emits no blank block; blank nodes deeper
  than the owned-child block are not removed there. Shape sync is not affected.
- Legacy sequence-member operator nodes stay as orphans (query above).
- The wire validation gap for polymorphic slots (above).
- Blank labels `_:bN` are unique within one INSERT DATA; a caller concatenating several generated
  INSERT DATA operations into one request would reuse labels. Core never does.
