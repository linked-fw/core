---
summary: >
  Owned (`contains`) values made safe and consistent. Re-sending the current `{id}` (single value,
  array item, set add+remove) is a no-op; deletes by id and in bulk delete immediately-owned
  children and only the dependent types the shape can reach; `contains` slots without a value shape
  delete only dependent values; a linked `{id}` of the wrong class is refused by one batched type
  SELECT. Shape sync persists one generated single-owner SHACL NodeShape per declared `contains`
  accessor, owned by its shape through `core:generatedShape`, keeping sync at two requests per
  shape. Minor release; SHACL is not enforced on write.
packages: [core]
source_backlog: docs/backlog/048-owned-property-replace-deletes-any-node.md (consumed, removed)
---

# 032 — Owned-value replace no-op and the single-owner SHACL constraint

Contract (architecture): [owned-values](../architecture/owned-values.md). User docs: README
"Owned properties (`contains` / `dependent`)". Release note:
`.changeset/owned-replace-noop-single-owner.md` (minor). Prior work:
[report 025](025-update-replace-contains-cascade.md) introduced `buildOwnedSelfDelete`.
Source: backlog 048 ("replacing an owned property deletes whatever node it pointed to").

## Problem

A `contains` property says the subject owns the value node. Before this work:

- **S1.** Replacing a `contains` value with its *current* `{id}` deleted that node's own triples
  and re-inserted only the edge. An array overwrite deleted retained ids the same way.
- **F2.** `parent.delete()` did not delete a non-`dependent` owned child, although the README said
  so; bulk deletes (`.all()`, `.where()`) had no owned cleanup at all.
- **F3.** A `contains` property without a value shape (`PropertyShape.path`, polymorphic) deleted
  its old value's own triples on replace, so a replaced simple `sh:path` could wipe the predicate
  IRI's own description.
- **S3.** Nothing checked that a node linked by `{id}` into an owned slot was of the right class,
  so a Person linked into `image` would later be deleted with its owner.
- **S4.** The single-owner rule implied by `contains` existed nowhere as data.
- **F1.** Nothing validates SHACL on write: not core, not the server, not the default Fuseki setup
  (query/update/graph-store services only; even Fuseki's SHACL service is on demand).

## Architecture

```
DSL mutation ─ lower() ─ IR ─┬─ SparqlDataset.checkOwnedLinks(ir)       (create/update/upsert/update-where)
                              │    collectOwnedLinks → 1 SELECT of rdf:types → assertOwnedLinkTypes
                              └─ irToAlgebra
                                   processUpdateFields: keep list, value-shape rule, set add/remove
                                   deleteToAlgebra / bulkDeleteUnion: owned-child blocks +
                                     cascade narrowed by reachableDependentTypes
syncShapes / syncShape ─ buildNodeShapeData ─ generatedShapes: buildSingleOwnerConstraints(...)
                         thunk: DELETE NodeShape (cascades generated) → CREATE NodeShape (nested)
```

### Owned deletes (`src/sparql/irToAlgebra.ts`)

- **Keep list.** `processUpdateFields` collects, per `contains` field, the bare `{id}`s the
  mutation writes again (`keptReferences`, using `isBareNodeReference`). `buildOwnedSelfDelete`
  and `buildOwnedCascade` take an optional `keep` and wrap each block with `keepFilter`:
  `FILTER(?old NOT IN (<k1>, …))` **inside** the UNION branch that binds `?old`, so the edge-only
  delete still fires and the INSERT re-adds the edge. With an IRI root the filter is not needed.
- **Set modification.** An id that is both removed and added is skipped for the self-delete and
  the cascade (`readdedIds`). The set-remove cascade is anchored on the owning edge, so removing an
  id the subject does not own deletes nothing of it.
- **Value-shape rule.** The self-delete runs only when the property declares a value shape
  (`hasValueShape`). Shape-less slots fall through to the cascade, whose path changed from
  `(c…)+` to `(c…)*`: the root itself is matched when it is dependent-typed (PathNode/List roots
  of a replaced `sh:path` are still cleaned), a predicate IRI never is.
- **Subject delete.** `deleteToAlgebra` adds one UNION block per immediately-owned child
  (`ownedValueShapePredicates`: own + inherited `contains` properties with a value shape and a
  simple path): `<s> <p> ?dN . ?dN ?dN_p ?dN_o`, no type guard, no reference check.
- **Bulk delete.** `bulkDeleteUnion` (used by `deleteAllToAlgebra` and `deleteWhereToAlgebra`)
  adds the same child blocks and cascade, rooted at the subject variable, each block led by the
  subject's type triple so a branch evaluated alone never runs a closure with both ends unbound.
  Bulk deletes still do not delete incoming references (pre-existing difference).
- **Narrowed cascade.** `reachableDependentTypes(shapeId)` walks the shape and its sub-shapes
  through properties on `contains` predicates to their value shapes (and sub-shapes) and returns
  only the dependent targetClasses reached; a shape-less slot returns all of them (keeps the
  shape-sync NodeShape delete exact). Memoized per registry version. Measured before narrowing:
  `deleteAll` of 20k owners went from ~0.5 s to ~2.5 s; after it, a shape owning only
  non-dependent values (every `Thing.image` owner) emits no closure at all.

Emitted SPARQL, `Project.update({image: {id: img1}}).for(p1)` with `p1 image img1`:

```sparql
DELETE { <p1> <image> ?old_image . ?old_image ?uc0_sp ?uc0_so . ?uc0_own0 ?uc0_op0 ?uc0_ov0 . }
INSERT { <p1> <image> <img1> . }
WHERE { OPTIONAL {
    { <p1> <image> ?old_image . }
    UNION { <p1> <image> ?old_image . ?old_image ?uc0_sp ?uc0_so . FILTER(?old_image NOT IN (<img1>)) }
    UNION { <p1> <image> ?old_image . ?old_image (c1|c2|…)* ?uc0_own0 .
            ?uc0_own0 rdf:type <Dep> . ?uc0_own0 ?uc0_op0 ?uc0_ov0 . FILTER(?old_image NOT IN (<img1>)) } } }
```

Delete by id of a `Project` with `image` and `attachments`:

```sparql
DELETE { <p1> ?p ?o . ?s ?p2 <p1> . ?d0 ?d0_p ?d0_o . ?d1 ?d1_p ?d1_o . }
WHERE { <p1> rdf:type <Project> .
  { <p1> ?p ?o } UNION { ?s ?p2 <p1> }
  UNION { <p1> <image> ?d0 . ?d0 ?d0_p ?d0_o . }
  UNION { <p1> <attachments> ?d1 . ?d1 ?d1_p ?d1_o . }
  UNION …one block per reachable dependent type… }
```

### Class check (`src/sparql/ownedLinkCheck.ts`, `SparqlDataset.checkOwnedLinks`)

- Runs in `SparqlDataset.createQuery` and `updateQuery` (all update kinds) after `lower()` and
  before the update. It needs the store, so it cannot live in the pure `validate()`; every SPARQL
  store (Fuseki, forwarders extending `SparqlDataset`) inherits it.
- A field is checked when its simple-path predicate is a `contains` predicate anywhere in the
  registry (the same rule as the replace delete) and the property declares a value shape whose
  targetClass resolves. Accepted: the value shape's targetClass, registered sub-shapes'
  targetClasses, `sh:class`. The store's `rdfs:subClassOf` is not consulted.
- Refused only when the node has at least one `rdf:type` and none is accepted. Untyped/absent ids
  pass (upload-then-attach in either order; `rdf:nil` on every list write, also skipped statically).
- Links: single values, array items, set `add` items, at any nesting depth, in create, update,
  upsert, update-where. Not links: nested creates (even with an id), `remove` items, deletes.
- One `SELECT ?id ?type WHERE { VALUES ?id { … } ?id rdf:type ?type }` per mutation with links,
  none otherwise. All violations in one error, e.g.
  `Cannot link <…/alice> into the contains property "image" of <…/Project>: it is typed <…/Person>, but "image" only owns instances of <…/ImageObject>. …`
  A plain property on a shared `contains` predicate gets a message naming the predicate.

### Generated single-owner shapes (`src/shapes/singleOwnerConstraint.ts`, `syncShapes.ts`)

Persisted for `Thing.image` (`contains`, value shape `ImageObject`):

```turtle
<…/Thing> core:generatedShape <…/Thing/image.singleOwner> .
<…/Thing/image.singleOwner> a sh:NodeShape ; core:generated true ;
    sh:targetObjectsOf schema:image ; sh:property <…/Thing/image.singleOwner/owners> .
<…/Thing/image.singleOwner/owners> a sh:PropertyShape ; rdfs:label "owners" ; sh:maxCount 1 ;
    sh:path <…/Thing/image.singleOwner/owners/inv> .
<…/Thing/image.singleOwner/owners/inv> a core:PathNode ; sh:inversePath schema:image .
```

- One per **own** `contains` property with a value shape and a simple path, at
  `${propertyShapeIri}.singleOwner`. Subclasses add none.
- `buildNodeShapeData` nests them under `generatedShapes`; `NodeShape.generatedShapes`
  (`core:generatedShape`) is `contains` with value shape `NodeShape`. The sync thunk is exactly
  delete NodeShape → create NodeShape: the delete's owned-child block removes each generated
  shape's own triples, the cascade (NodeShape reaches everything through shape-less `sh:path`)
  removes `…/owners` and `…/owners/inv`, and `sh:inversePath schema:image` is never followed into
  the predicate IRI. The create is a nested create, so the class check sends no SELECT.
- `syncShapes` adds every in-code generated IRI to `localShapeIris`, so `'all'` and
  `'ownedNamespaces'` pruning keep them; a stale one goes with its owner's delete.
- `assertNoGeneratedIriCollision` throws when a registered shape IRI equals a generated IRI.
- Never registered in memory; no `sh:targetClass`; `core:generated true` lets catalog readers skip
  them. `NodeShape` lives in core, which sync skips, so `core:generatedShape` gets no constraint.

## Decisions and rationale

| # | Decision | Why |
|---|---|---|
| A1 | Replace semantics stay; patch in place is `ValueShape.update(...).for(id)`; linking by `{id}` stays allowed | upload-then-attach is a real flow |
| A2/A6 | Re-sent bare `{id}`s are kept via `FILTER NOT IN`; a nested create with an id still rewrites | smallest change that makes re-send idempotent; filter inside each branch keeps the real replace intact |
| A5 | Non-owning references allowed and left dangling; no adoption ASK, no reference backstop | cost and simplicity; SHACL is the place for the rule |
| D1 | Constraint as a standalone generated NodeShape with `sh:targetObjectsOf` | idiomatic SHACL, written by the declaring package, no mutation of another package's shape |
| D3/D4 | Deterministic IRI from the stable shape IRI; `core:generated true`, no targetClass, never registered | stable across runtimes; one check lets readers skip it (`displayHidden` means something else) |
| D5 | Subject delete deletes immediately-owned children (with a value shape) | one rule for replace/remove/delete; matches README; stops orphans |
| D6 | Value shape decides: shape-less `contains` deletes only dependent values; cascade `(c…)*` | closes F3 without a type guard; `*` and `+` cost the same with a bound root |
| D7 | Class check only for owned properties, in `SparqlDataset`, untyped ids allowed | guards exactly the destructive case; no cost without links; plain references may point across datasets |
| It.1 | Class check uses the per-predicate rule; bulk deletes get owned blocks; changeset "Behaviour changes" | the check must cover every field the delete treats as owning (review H1, H2, M1) |
| It.2 | Cascade narrowed to reachable dependent types | bulk-delete cost was ~5× for every schema-derived shape (M4); shape-sync stays exact |
| It.3 | **Grouped → per accessor.** One constraint per declared `contains` property, plain `sh:inversePath` | the original per-shape group with `sh:alternativePath` over own + inherited predicates duplicated `Thing.image` into every schema subclass; grouping only helps with overlapping value shapes, which the class check already guards |
| It.4 | **Select + delete → owned via `core:generatedShape`.** | iteration 3 found old constraints by a SELECT of `core:generated` shapes filtered by IRI prefix: ≥3 requests per shape (M5), prefix matching broken by `/` in names (L12), non-atomic (L13), suffix special case in pruning (L14). Ownership restores 2 requests, atomic create, no prefix logic |
| A7 | Minor release | lead developer's call, with explicit "Behaviour changes" in the changeset |

Rejected and why it matters later: a property shape on the value shape (mutates another package's
shape, process-dependent output); a property shape on the declaring shape with path
`(p)/^(p)` (leaks into readers, `rdf:first` path nodes not reached by the sync cascade);
registry-wide predicate groups (not idempotent across processes); an `IDataset.batch` to keep
sync at one request (no raw-update channel on `IDataset`, would break routing and forwarding).

## Files

| File | Responsibility |
|---|---|
| `src/sparql/irToAlgebra.ts` | keep list (`isBareNodeReference`, `keptReferences`, `keepFilter`), value-shape rule, set add/remove skip, `(c…)*` cascade, owned-child blocks in `deleteToAlgebra` and `bulkDeleteUnion`, `ownedValueShapePredicates`, `reachableDependentTypes`, `collectContainment` exported |
| `src/sparql/ownedLinkCheck.ts` (new) | `collectOwnedLinks`, `ownedLinkTypesQuery`, `ownedLinkTypesFromResults`, `assertOwnedLinkTypes`, `OwnedLink` |
| `src/sparql/SparqlDataset.ts` | `protected checkOwnedLinks(ir)` before every create and update |
| `src/shapes/singleOwnerConstraint.ts` (new) | `singleOwnerShapeIri`, `singleOwnerProperties`, `buildSingleOwnerConstraints` |
| `src/shapes/syncShapes.ts` | nests generated shapes, two-request thunk, protected generated IRIs in pruning, collision check |
| `src/shapes/SHACL.ts` | `contains` docstring states the full contract |
| `src/utils/Package.ts` | NodeShape accessors `targetObjectsOf`, `generated`, `generatedShapes` |
| `src/ontologies/shacl.ts`, `src/ontologies/linked-core.ts` | `sh:targetObjectsOf`; `core:generated`, `core:generatedShape` |
| `src/index.ts` | exports the three single-owner helpers |
| `README.md` | "Owned properties": replace vs patch, re-send no-op, linking, class check, delete rules, single-owner constraint, not-enforced note |
| `documentation/dsl-json.md` | stale "old node left behind on replace" note corrected |

## Public API

```ts
import {singleOwnerShapeIri, singleOwnerProperties, buildSingleOwnerConstraints} from '@_linked/core';

singleOwnerShapeIri(`${shapeIri}/image`);            // `${shapeIri}/image.singleOwner`
singleOwnerProperties(Thing.shape);                   // own contains props with shape + simple path
buildSingleOwnerConstraints(Thing.shape, shapeIri);   // [{iri, data}] as sync writes them
```

- NodeShape accessors: `targetObjectsOf`, `generated`, `generatedShapes`.
- Terms: `shacl.targetObjectsOf` (`@_linked/core/ontologies/shacl`), `coreOntology.generated`,
  `coreOntology.generatedShape` (`@_linked/core/ontologies/linked-core`).
- Internal but exported from their modules: `buildOwnedSelfDelete(…, keep?)`,
  `buildOwnedCascade(root, prefix, anchor?, keep?, onlyTypes?)`, `collectContainment`,
  `isBareNodeReference` (irToAlgebra); the `ownedLinkCheck` functions.

## Behaviour changes (minor, flagged in the changeset)

- Deletes (by id and bulk) delete owned children: with `@_linked/schema`'s `Thing.image`
  `contains`, deleting a schema-derived entity deletes its linked `ImageObject`s, including shared
  ones linked by `{id}`.
- Linked `{id}`s into owned properties are class-checked; a node typed only with an unregistered
  subclass is refused unless the store also holds the expected type.
- Plain properties on a `contains` predicate are class-checked and replace-deleted too.
- Shape-less `contains` properties keep non-dependent old values (may orphan).
- Edges no reached shape declares are no longer followed by subject-delete cascades.

## Tests

| File | Covers | Cases |
|---|---|---|
| `src/tests/shacl-cascade.test.ts` | keep filter (single, array, nested create, set add+remove), set-remove anchor, `(c…)*`, shape-less slot, subject/multi-id/bulk/where owned blocks, cascade narrowing; live: re-send, array keep, subject delete, shape-less slot keeps predicate IRI, unowned set-remove, kept subtree, upsert, `forAll`/`where`, two owners, bulk deletes | 29 new (41 total) |
| `src/tests/owned-link-check.test.ts` (new) | link collection (all mutation kinds, nesting, set add, `rdf:nil`, per-predicate rule), stub-store SELECT count and refusal, live refusal/acceptance | 17 |
| `src/tests/single-owner-constraint.test.ts` (new) | IRIs, per-accessor data, subclass adds none, skips, two-request thunk with a recording `SparqlDataset` (0 SELECTs), pruning keeps generated IRIs, collision, meta-model refused | 11 |
| `src/tests/sparql-fuseki-shape-sync.test.ts` | live: persisted triples, subclass none, idempotent re-sync, removed accessor cleaned, hand-written NodeShape survives, NodeShape delete removes generated shapes but not the predicate, pruning keeps them, 2 updates / 0 selects | 8 new (11 total) |
| `src/tests/shacl-syncshapes.test.ts`, `mutation-where-union.test.ts` | expectations adjusted for `(c…)*` and owned blocks | — |

Full run (wrap-up, live Fuseki started by `ensureFuseki` on :3939): 96 suites passed, 4 skipped
(type-only); 2183 tests passed, 121 skipped; typecheck clean; `npx linked build` successful. New
live tests were each proven to run by a temporary failing assertion during implementation.

## Known limitations

- **Not enforced on write.** The single-owner constraint and `sh:class` on plain references are
  persisted only ([backlog 054](../backlog/054-shacl-validation-on-write.md)).
- The class check misses ids typed after linking, ids typed between its SELECT and the UPDATE
  (separate requests), raw SPARQL, and non-SPARQL `IDataset`s.
- Each constraint counts owners through its own predicate only; ownership through two different
  `contains` predicates is not reported.
- Replace and subject delete decide ownership differently (per predicate vs per shape)
  ([backlog 053](../backlog/053-per-property-ownership.md)).
- Generated-shape edge cases: a store-only NodeShape at a generated IRI is adopted and wiped; an
  ownerless generated shape is never pruned under `'ownedNamespaces'`
  ([backlog 052](../backlog/052-generated-shape-lifecycle-edge-cases.md)).
- Live suites still pass silently without Fuseki ([backlog 009](../backlog/009-ci-test-integrity-fuseki.md)).

## Follow-ups

- [051](../backlog/051-merge-registry-version-caches.md) — fold the two registry-version caches
  in `irToAlgebra.ts` into one.
- [052](../backlog/052-generated-shape-lifecycle-edge-cases.md) — store-only NodeShape at a
  generated IRI; ownerless generated shapes under `'ownedNamespaces'`.
- [053](../backlog/053-per-property-ownership.md) — per-property versus per-predicate ownership.
- [054](../backlog/054-shacl-validation-on-write.md) — SHACL validation of writes.
- [009](../backlog/009-ci-test-integrity-fuseki.md) — live suites silent without Fuseki.
- [018](../backlog/018-transactions.md) — a batch/raw-update entry point on `IDataset` would let
  sync and multi-step writes go in one request.
- Consumer follow-ups (tracked by consumers): a shape catalog UI should show an "owned" flag on
  `contains` properties and filter `core:generated` NodeShapes explicitly (today they are dropped
  only because they lack `sh:targetClass`); registries that strip `contains` from user-authored
  shapes must do so on every registration path.

## Architecture docs updated

- `docs/architecture/owned-values.md` (new): the owned-value contract, class check, generated
  shapes and their lifecycle.
- `docs/architecture/ontologies.md`: `linked-core` and the `shacl` shortcut list the new terms.
- `docs/architecture/runtime-instances.md`: generated IRIs derive from the stable shape URI and
  are never registered.
