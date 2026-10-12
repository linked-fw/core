---
summary: >
  Owned (`contains`) values. Re-sending the current `{id}` becomes a no-op instead of wiping the
  node. Deleting a subject now deletes its immediately-owned children, as the README already says.
  `contains` properties without a value shape fall back to the `dependent` rule. Shape sync persists
  a generated single-owner SHACL constraint per declaring shape. Linking a node of the wrong class
  into a `contains` property is refused by one batched type query per mutation. Store-side SHACL
  validation is not enforced today; this is recorded as a limitation.
status: Implementation
packages: [core]
source_backlog: docs/backlog/048-owned-property-replace-deletes-any-node.md
---

# 003 — Owned-value replace no-op and the single-owner SHACL constraint

Source: [backlog 048](../backlog/048-owned-property-replace-deletes-any-node.md). Prior work:
[report 025](../reports/025-update-replace-contains-cascade.md) introduced `buildOwnedSelfDelete`.

---

# Ideation

## Context (from backlog 048)

A `contains` property asserts that the subject owns the value node. Core acts on that in three
places in `src/sparql/irToAlgebra.ts`:

| Path | Code | What it deletes today |
|---|---|---|
| Replace / unset / array overwrite | `processUpdateFields` → `containsOldVars` loop (~L2102) | the edge, the old node's own triples (`buildOwnedSelfDelete`), and its dependent subtree (`buildOwnedCascade`) |
| Set remove `{remove:[x]}` | `processUpdateFields` set-mod branch (~L1958) | the edge, x's own triples, and x's dependent subtree |
| Subject delete | `deleteToAlgebra` (~L2510) | the subject, incoming edges, and dependent-typed nodes reached via `(contains)+` |

Whether a predicate counts as `contains` is decided per predicate across the whole registry
(`collectContainment`, ~L2370).

## Accepted decisions (lead developer)

| # | Decision |
|---|---|
| A1 | **Replace semantics stay.** A plain nested object on a `contains` property replaces the owned value, and the old node is deleted. Patch in place goes through `ValueShape.update({...}).for(id)` (in future, active-record `parent.image.update()`). Linking an existing node by `{id}` into a `contains` property stays allowed, e.g. upload then attach. |
| A2 | **S1 is the bug.** Replacing a `contains` value with its current `{id}` must be a no-op. Today the node's own triples are deleted and only the edge is re-inserted. The same applies to array overwrite of a `contains` set: an id that is kept must survive. |
| A3 | **S3 (wrong-type link) gets no SPARQL check in core.** Rely on the store's SHACL validation (`sh:class`). See [Findings](#findings): the store does not validate on write today. **Superseded for `contains` properties by [Decision 7](#decision-7-of-8--class-check-for-ids-linked-into-a-contains-property)** (lead developer, after F1); A3 still holds for every other object property. |
| A4 | **S4 Rule A.** `contains` is translated into a SHACL constraint that is persisted with the shapes: an owned value node has at most one owner across `contains` predicates, `sh:path [sh:inversePath [sh:alternativePath (p1 p2 …)]] ; sh:maxCount 1` (a plain `sh:inversePath p` for a single predicate). Other, non-owning references to the value are allowed. |
| A5 | **S5.** Non-owning references to an owned node are allowed. Dangling references left after the owner is deleted are accepted. There is no adoption ASK, no `NOT EXISTS` reference backstop and no type guard in SPARQL. |
| A6 | **S1 design (accepted after the first pass).** `buildOwnedSelfDelete` and `buildOwnedCascade` take an optional `keep` list. A `FILTER(?old NOT IN (…))` covers the bare `{id}` values of the new value or array. Set-remove skips ids that are also in `add`. A nested create carrying the current id (`{id: current, contentUrl: 'b'}`) keeps today's full-rewrite behaviour: it deletes all of the node's triples and re-inserts the new ones. This is documented. |
| A7 | **Release:** minor, non-breaking changeset. |

## Findings

### F1 — The store does not enforce SHACL on write (S3)

**Answer: no.** Nothing between core and Fuseki validates a SPARQL UPDATE against shapes.

- **Fuseki config.** `/Users/rene/web/create_now/infra/fuseki/configuration/assembler.ttl` L23-51: each
  dataset (cn-main, cn-ai, pg-test) exposes only `fuseki:serviceQuery "sparql"`,
  `fuseki:serviceUpdate "update"`, upload and graph-store services. There is no `fuseki:serviceShacl`.
  L60-88: the datasets are `ja:DatasetRDFS` (RDFS inference) over `tdb2:DatasetTDB2`. That is
  inference, not validation. No `*.ttl` under `infra/fuseki` mentions `shacl`.
  `docker-compose.yml` L121-138 runs plain `FusekiServerCmd`, with no jena-shacl wiring. Even with the
  SHACL service enabled, Fuseki validates only on demand (`POST /ds/shacl`) and never gates `/update`.
- **Store package.** `_linked-fuseki/src/shapes/FusekiStore.ts` L201-215: `executeSparqlUpdate` POSTs
  the update to `${baseUrl}/${dataset}/update` and does nothing else.
- **Server.** `_linked-server/src` has no validation on the mutation path. SHACL appears only where
  shapes are written to the store as data (`utils/syncShapes.ts`, `LinkedServer.tsx` ~L458-491).
  `utils/queryPlane.ts` L86 rehydrates client JSON through core `fromJSON`, so core's DSL validation
  runs again on the server.
- **What does exist: core's in-process validator.** `src/shapes/validation.ts` (report 027) is called
  from `MutationQuery.describe()` (L97-98), from `CreateBuilder` (`'complete'`), `UpdateBuilder`
  (`'partial'`) and `lowerMutationJSON`. It checks `maxCount`, `minCount`, `nodeKind`, `datatype`,
  ranges, length, `pattern` and `in`. Unknown keys are always rejected:
  `undeclaredPropertyMessage`, reported as `sh:ClosedConstraintComponent` (validation.ts L833-845),
  and thrown during normalization even with validation off (MutationQuery.ts L194-199).
  `sh:closed` itself is parsed but ignored (backlog 035).
- **`sh:class` of object values is never checked.** `ps.class` only decides literal versus node
  (validation.ts L291/L307). An `{id}` reference is never checked for type on the client, on the
  server or in the store. Raw SPARQL sent straight to Fuseki bypasses even the DSL checks.

**Consequence.** For S3 (a Person linked into an ImageObject slot) and for the S4 single-owner rule,
nothing enforces the constraint today. Core persists correct SHACL, and any validator (Jena SHACL,
pySHACL, a future Fuseki SHACL endpoint or a server-side `validate` step) can check it on demand.
**Known limitation and follow-up, not fixed in this plan:** enable write-time validation, or a
periodic or on-demand validation report, in the CN/server stack.

### F2 — Subject delete does not delete a non-`dependent` owned child (README mismatch)

The README ("Owned properties") says `parent.delete()` deletes the owned child. It does not, unless the
child is typed with a `dependent` shape. Measured with the emitted SPARQL for
`Project{image: contains ImageObject}` (ImageObject not dependent):

```sparql
DELETE { <p1> ?p ?o . ?s ?p2 <p1> . <p1> rdf:type <Project> .
         ?c_own0 ?c_op0 ?c_ov0 . ?c_own1 ?c_op1 ?c_ov1 . }
WHERE { <p1> rdf:type <Project> .
  { <p1> ?p ?o } UNION { ?s ?p2 <p1> }
  UNION { <p1> (sh:property|sh:path|sh:in|rdf:rest|<image>)+ ?c_own0 . ?c_own0 rdf:type sh:PropertyShape . ?c_own0 ?c_op0 ?c_ov0 . }
  UNION { … ?c_own1 rdf:type rdf:List … } }
```

Only dependent types (PropertyShape, List, PathNode) are deleted. The ImageObject's own triples
remain as an orphan. `buildOwnedCascade` returns nothing at all when no dependent shape is
registered. The shacl-cascade tests only assert the dependent path (`delete cascades via contains
edges to dependent-typed nodes`). This is the same orphan class that report 025 fixed for replace,
left open for delete.

### F3 — `contains` properties without a value shape: self-delete can wipe a non-owned IRI

`PropertyShape.path` (`src/utils/Package.ts` ~L682-687) is `contains: true` with **no valueShape**,
because `sh:path` is polymorphic: a predicate IRI, an `rdf:List` or a `PathNode`. If a PropertyShape's
path is replaced through `update`, `buildOwnedSelfDelete` deletes every triple whose subject is the
old value. When the old path was a simple predicate, that predicate's own triples are deleted, e.g.
the `rdf:Property` description an ontology builder stores in the same dataset. This is backlog 048's
bug through a meta-model door. The cascade does not have the hazard because it only deletes
`dependent`-typed nodes.

### F4 — Shape sync and the registry

- Shapes are written by `NodeShape.create(data)` on core's own SHACL meta-model, using
  `buildNodeShapeData` and `buildPropertyShapeData` in `src/shapes/syncShapes.ts`. There is no
  separate RDF serializer. IRIs are deterministic: the shape is `getNodeShapeUri(pkg, name)` =
  `{base}shape/{pkg}/{Name}` and a property shape is `${shapeIri}/${label}`. Path nodes are
  `{psIri}/inv`, `/alt`, `/alt/{i}`, `/seq/{i}` (`serializePathToNodeData`).
- `syncShapes` enumerates `getAllShapeClasses()` and skips `@_linked/core`. A data-only NodeShape is
  never written. Each shape is one thunk: `DeleteBuilder.from(NodeShape,{id})` (the cascade cleans the
  PropertyShape, List and PathNode subtree), then `NodeShape.create(data).withId(iri)`.
- Pruning: `orphanScope` `'none'` (default), `'all'` or `'ownedNamespaces'` (the IRI prefix up to the
  last `/` or `#`). Backlog 046 proposes a `materializedBy` provenance tag. Backlog 032 made shape
  names explicit (`@linkedShape({name})`). Backlog 047: the shape-sync live suite is order-dependent
  and flaky once.
- The meta-model has **no `sh:targetObjectsOf`** accessor on NodeShape (`Package.ts` L616-895).
- `rdf:first` is **not** `contains` (`List.class.ts` L16), so a `PathNode` nested inside a
  **sequence** list is not reached by the sync delete cascade. This is a latent issue for user paths
  like `{seq: [{inv: p}, q]}`, and it shapes Decision 1.
- CN `src/utils/shapeCatalogQuery.ts` `fetchShapeCatalog` (L61) reads **every** `sh:NodeShape`
  unfiltered and loads it into the project catalog and runtime registry (`ProjectProvider.ts`
  L404-419). shape-ui only uses `getShapeClass`, so it is unaffected.
  CN duplicates `collectContainment` in `src/utils/ownedProperties.ts` L19.

## Architecture context

`npx semantu-agents docs architecture` lists core's `docs/architecture`: `ontologies.md`,
`publishing.md` and `runtime-instances.md`. Applicable constraints:

- **ontologies.md.** Core's own vocabulary (`core:contains`, `core:dependent`, `core:displayHidden`)
  lives in `src/ontologies/linked-core.ts`. A new marker term (`core:generated`) belongs there, and
  SHACL terms (`sh:targetObjectsOf`) belong in `src/ontologies/shacl.ts`.
- **runtime-instances.md.** Shape identity is `getNodeShapeUri(packageName, name)`. A generated
  shape's IRI must derive from that same stable identity (backlog 032), not from anything
  process-local.
- **publishing.md.** Release goes through a changeset. Run only with explicit consent; this plan
  only writes the `.changeset` file.

## Test surfaces

| Gate | Command | Source |
|---|---|---|
| Quick, per file | `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/<file>.test.ts` | `package.json` `test` script |
| Full unit and typecheck | `npm test` (jest, then `tsc -p tsconfig-tests.json`) | `package.json` |
| Build | `npx linked build` (from the core root) | workspace CLAUDE.md |
| Live Fuseki | `npm run test:fuseki`, or any jest run: `ensureFuseki()` **auto-starts** `src/tests/docker-compose.test.yml` (Fuseki on :3939) when Docker is up | `package.json`, `src/test-helpers/fuseki-test-store` |

Docker is running locally (verified 2026-10-12). A jest run started the `tests-fuseki-1` container on
:3939 by itself. Backlog 009 still applies: without Docker the live suites return early and pass
silently. A live phase is only done when the output shows the container started and the live tests
did not early-return. Stop the container afterwards with
`docker compose -f src/tests/docker-compose.test.yml down`.

## Decisions (resolved by priority: 1 maintainability and simplicity, 2 scalability, 3 performance)

### Decision 1 of 8 — Where the generated single-owner constraint lives

- **(a) A property shape on the value shape** (`ImageObject sh:property [ sh:path ^(…) ; sh:maxCount 1 ]`).
  - Pro: it is the literal form of A4.
  - Con: it mutates a shape owned by another package (`@_linked/schema`).
  - Con: what gets written depends on which declaring shapes happen to be registered in the process
    that syncs ImageObject. Two processes fight over the same node.
  - Con: the declaring package's sync cannot write it, and pruning has no owner.
- **(b) A standalone generated NodeShape per declaring shape**, with
  `sh:targetObjectsOf p1, p2 …` and the A4 property shape.
  - Pro: exactly the A4 constraint form, and idiomatic SHACL that any validator understands.
  - Pro: owned and written by the declaring package, and needs no change to another package's
    shape.
  - Pro: `targetObjectsOf` matches core's registry-wide, per-predicate `contains` semantics.
  - Pro: inverse and alternative paths nest only through `PathNode`/`rdf:rest` contains edges, so
    the sync delete cascade cleans them fully (F4).
  - Con: it needs one meta-model accessor (`sh:targetObjectsOf`).
  - Con: it is a second NodeShape that CN's unfiltered catalog would read.
- **(c) A property shape on the declaring shape** with path `(p1|p2)/^(p1|p2)` and `sh:maxCount 1`.
  The owners of my owned values must be only me.
  - Pro: no new meta-model, and it rides the declaring shape's lifecycle.
  - Con: it is not the A4 form.
  - Con: it leaks as an extra *property* into every reader of the declaring shape, including the
    query proxy once CN reloads the catalog.
  - Con: the sequence puts PathNodes under `rdf:first`, which the sync cascade does not reach (F4).
    A change of the contains set would then corrupt the stored path.
- **(d) `sh:node` from each contains property shape to a constraint node.** Rejected: `sh:node` is
  already `valueShape`, so readers would misread it.

**Choice: (b).** It is the only option that is both correct under re-sync and owned by the package
that declares `contains`. Its two costs are small and contained: one accessor, and one marker
that lets readers skip it (Decision 4). It also avoids building synthetic shapes into the in-memory
registry.

### Decision 2 of 8 — Which predicates are grouped in one `sh:alternativePath`

- (a) All `contains` predicates in the registry.
  - Con: the group depends on what the process happens to import, so re-sync output varies by
    process and stops being idempotent.
- (b) **The declaring shape's own and inherited (flattened) `contains` properties that have a simple
  path.** These are the same property shapes `buildNodeShapeData` already flattens.
  - Pro: deterministic from code.
  - Con: two packages whose `contains` predicate sets share **no** predicate cannot see each
    other's ownership.
- (c) Per predicate, with no grouping.
  - Con: misses the Project.image plus Project.attachments double-ownership case.

**Choice: (b).** It is deterministic, and it already covers the cross-package case whenever the
predicate sets overlap. Example: Workspace owns X via `schema:image` and Project owns X via
`ex:attachments`. Project's constraint targets objects of `ex:attachments` and counts inverse
`(ex:attachments|schema:image)` edges: two, so it is a violation.

Rules for building the group:
- Predicates are **sorted by IRI** so that declaration order cannot churn the stored list.
- Contains properties with complex paths are skipped, as in `collectContainment`.
- A shape with no qualifying contains property gets no generated shape.
- Subclasses each get their own constraint. That is redundant but harmless and keeps the rule
  local.

Accepted limitation: predicate sets with no overlap across packages are not cross-checked.

### Decision 3 of 8 — Deterministic IRI and lifecycle of the generated shape

- **IRI:** `${shapeIri}.singleOwner`, e.g. `{base}shape/my-pkg/Project.singleOwner`.
  - `.` cannot appear in a class-derived name.
  - It stays in the package namespace, so `'ownedNamespaces'` pruning treats it like the package's
    other shapes.
  - It cannot collide with the property shapes at `${shapeIri}/label`.
  - At sync time, throw if a registered shape IRI equals a generated IRI (an explicit
    `@linkedShape({name})` containing `.singleOwner`).
- The property shape is `${genIri}/owners`, and its path nodes are `${genIri}/owners/inv`,
  `…/inv/alt`, `…/inv/alt/{i}` (from `serializePathToNodeData`).
- **Lifecycle:** it is folded into the declaring shape's existing sync thunk, in the order
  delete main, **always** delete generated, create main, then create generated only if the group is
  non-empty.
  - A shape that loses its last `contains` property loses its constraint on the next sync, with no
    extra pruning logic.
  - `syncShapes` still returns one thunk per shape, so `materializeShapes`' count and log line
    stay correct.
  - `syncShape(target)` gets the same behaviour for free.
  - `'all'` pruning adds every user shape's generated IRI to `localShapeIris`, so it is never
    pruned as an orphan.
  - Backlog 046 provenance tagging, when it lands, tags the generated shape like any other.

### Decision 4 of 8 — Visibility to the in-memory registry and to consumers

- The generated shape is **built only at sync time** (`buildSingleOwnerShapeData`) and is **never
  registered** in memory. `getAllNodeShapes`, `getSubShapes`, `getPropertyShapes`, forms and
  validation are unchanged, and `collectContainment` is unaffected.
- It is marked **`core:generated true`**, a new boolean on NodeShape, and has **no `sh:targetClass`**.
  Any catalog reader can then skip it with one check. `displayHidden` was rejected as the marker: it
  means "hide in UIs", not "not a user shape".
- **CN follow-up (outside core):** `fetchShapeCatalog` should filter `core:generated` NodeShapes.
  Until then CN would read a NodeShape with no targetClass. Record it in CN's backlog when this
  ships; core does not edit CN. How CN does it is [Decision 8](#decision-8-of-8--cn-catalog-follow-up).

### Decision 5 of 8 — F2: should subject delete delete the immediately-owned child?

- (a) **Yes, match the README and the replace semantics.**
  - Pro: one rule: "when a `contains` edge goes away, the owned node goes" holds for replace,
    remove and delete alike.
  - Pro: stops orphan images on every project delete.
  - Cost: one UNION block per qualifying contains property, which adds solutions rather than
    multiplying them (the reason in the `deleteToAlgebra` comment).
- (b) The README is wrong: document "delete only cascades `dependent` nodes".
  - Pro: zero code.
  - Con: two rules, and orphans keep accumulating.
  - Con: the workaround (mark ImageObject `dependent`) needs a change in another package.

**Choice: (a).** For each of the deleted shape's **own flattened** contains properties that
**declare a valueShape** (Decision 6), add a block that deletes the child's own one-hop triples:
`{ <s> <p> ?dN . ?dN ?dNp ?dNo }`. There is no type guard and no reference check (A5). The
existing dependent cascade is unchanged.

The deleted shape's own properties are used rather than registry-wide predicates. A delete is
rooted at a typed subject whose shape is known, and this reuses `shapeHasContainsProperty`'s
reading. It is the narrower of the two readings.

**This is a behaviour change.** A node linked by `{id}` into a contains slot is now deleted with its
owner, which ownership-by-linking (A1) implies. It ships as a minor bug fix, with a changeset line
that says so. **Confirmed by the lead developer (2026-10-12)**, on the condition that core refuses
to link a node of the wrong class into such a slot ([Decision 7](#decision-7-of-8--class-check-for-ids-linked-into-a-contains-property)).
Without that check, a Person linked by mistake into `Project.image` would be deleted with the
project.

### Decision 6 of 8 — F3: `contains` properties without a valueShape

- (a) Keep today's behaviour. Rejected: it wipes a non-owned predicate IRI.
- (b) **The value shape decides.**
  - A `contains` property with a valueShape gets the self-delete (replace, remove and delete).
  - A `contains` property without one, a polymorphic slot like `sh:path`, deletes the immediate
    value only when it is `dependent`-typed. That is the rule the cascade already applies to every
    reached node.
  - Implementation: `buildOwnedCascade`'s path changes from `(c…)+` to `(c…)*`, so the root
    itself is matched when it is dependent-typed, and self-delete is skipped for valueShape-less
    fields.
  - Pro: one small, uniform change.
  - Con: on a subject delete, `*` also matches the subject. That is harmless, because it is being
    deleted anyway.
- (c) Add a `rdf:type` guard to the self-delete. Rejected by A5 (no type guard).

**Choice: (b).** It closes F3 without a new mechanism, and `PathNode`/`List` roots of a replaced
`sh:path` are still cleaned up. `*` and `+` evaluate the same in Fuseki, so performance is unchanged.

### Decision 7 of 8 — Class check for ids linked into a `contains` property

Context. A1 allows linking an existing node by `{id}` into a `contains` slot. With Decision 5 a
linked node is deleted on replace, on remove and with its owner. F1 shows that nothing validates
`sh:class` on write. So if "Alice", a `schema:Person`, is linked into `Project.image` (value shape
`ImageObject`) by mistake, the next image replace or project delete wipes Alice. The lead developer
asked for a core check. It supersedes A3 for `contains` properties.

**Where it runs.** In `SparqlDataset.createQuery` and `SparqlDataset.updateQuery`, after `lower()`
and before the update is sent.
- The check needs the store, so it cannot live in `validate()`, which is pure and also runs on the
  client.
- `SparqlDataset` is the one place that holds both the lowered IR and a query channel
  (`executeSparqlSelect`). `FusekiStore` (both copies) and every other SPARQL store inherit it.
  `BackendAPIStore` forwards mutations to the server, where the server's `SparqlDataset` runs the
  check.
- A non-SPARQL `IDataset` implementation is not covered. It has no generic query channel. This is
  recorded as a limitation.

**Scope: (a) `contains` properties only**, versus (b) every object property with a value shape.
- (a) Pro: it guards exactly the destructive case (the owner deletes what it holds). Every other
  mutation skips the query.
- (a) Pro: plain references are never questioned. In CN they often point at nodes in another
  dataset (CN routes shapes to different datasets) or at external IRIs, where the dataset that runs
  the mutation cannot see the node.
- (b) Con: a round trip on most updates that set any reference.
- (b) Con: a value shape on a plain reference is often a hint, for example a polymorphic `author`.
  Checking it strictly would refuse data the shapes accept today. That is a breaking change for a
  data-quality issue that SHACL validation (A3) is the right tool for.
- **Choice: (a).** It is the smallest rule that closes the hazard Decision 5 creates (priority 1),
  and it costs nothing on mutations that link no owned value (priorities 2 and 3).

**Which properties.** A field is checked when its property shape has `contains: true` and a
`valueShape` whose targetClass resolves (`getTargetClassId`). A `contains` property without a value
shape (`PropertyShape.path`) has no expected class and is not checked. Decision 6 already keeps
those slots from deleting anything that is not `dependent`-typed.

**Acceptable classes.** The value shape's targetClass, the targetClass of every registered sub-shape
(`getSubShapes(valueShape)`), and the property's `sh:class` if it declares one. Only the registry is
consulted, never `rdfs:subClassOf` in the store. That keeps the check independent of whether the
ontology is loaded in the dataset. An RDFS-inferring store adds superclass types anyway, which can
only make a node pass.

**Ids that do not exist, or have no `rdf:type`: allowed.** The check refuses a node only when the
store holds at least one `rdf:type` for it and none of those types is acceptable.
- `rdf:nil` is linked into `List.rest`, which is `contains` with value shape `List`, on every shape
  sync. It is never typed. Refusing untyped ids would break shape sync. `rdf:nil` is also skipped
  statically, so a shape sync never pays for a query because of it.
- Upload-then-attach keeps working whatever the write order, and so does a node that another
  request creates later.
- An untyped id is no evidence of the wrong kind of thing. The Alice case is a typed node and is
  refused.
- Limitation, recorded: an id linked while untyped and typed `Person` later is not caught. SHACL
  validation (`sh:class`) is the backstop.

**What counts as a link.** A bare `{id}` (a `NodeReferenceValue` with no `shape` or `fields`) in a
`contains` field:
- as a single value, as an item of an array overwrite, or as an item of a set `add`;
- in `create`, `update`, `upsert` and `update_where` (`.where()` and `.forAll()`) mutations;
- at any depth inside nested creates, because a nested create's own fields can link too.

Not links:
- a nested create, even with a predefined id, because the mutation writes its type itself;
- set `remove` items;
- `delete*` mutations.

**Cost.** Collecting the links is a walk over the IR, with no I/O. With no links, no query is sent.
Otherwise the check sends one SELECT per mutation for all distinct ids, then compares the types in
memory:

```sparql
SELECT ?id ?type WHERE { VALUES ?id { <a> <b> } ?id <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?type }
```

**Error.** It is thrown before the update is sent, so nothing is written. Every violation is listed:

```
Cannot link <http://ex/alice> into the contains property "image" of <…/shape/my-pkg/Project>:
it is typed <https://schema.org/Person>, but "image" only owns instances of
<https://schema.org/ImageObject> (or a registered sub-shape). An owner deletes what it contains
when the value is replaced or removed, or when the owner is deleted.
```

### Decision 8 of 8 — CN catalog follow-up

Recorded for CN; nothing is implemented in this repository.
- CN's `fetchShapeCatalog` hides `core:generated` NodeShapes **only together with** an
  "owned/contained" flag in CN's shape UI. The flag mirrors the decorator's `contains: true` on a
  property shape.
- If CN's shape UI has no such flag yet, it is added in the same CN change.
- The reason: hiding the generated shape removes the only visible trace of the single-owner rule,
  so the UI has to show ownership where it is declared.
- A read-only check of CN is done separately. The follow-up goes into CN's backlog in wrap-up
  (Phase 6), with consent.

Read-only check of CN (2026-10-12):
- CN's `projectShapeCatalog` (`src/utils/shapeCatalogQuery.ts` L339-341) already drops NodeShapes
  without `sh:targetClass`. The generated single-owner shape is therefore hidden from CN's catalog
  today, but only incidentally. An explicit `core:generated` filter is still recommended.
- CN reads `contains` in the catalog (`shapeCatalogQuery.ts` L106, L400), but no UI component
  displays it. The CN change is therefore: show an owned flag on properties in the shape UI, plus
  the explicit `core:generated` filter.
- CN `src/data/shapeInstances.ts` L24, L65 calls core's `registerRuntimeShapes(catalog)` directly,
  bypassing `runtimeShapeRegistry.ts`'s `withoutOwnership`. Project-authored shapes may leak
  ownership (`contains`) into the runtime registry that way. Recorded as a CN follow-up.

### Remaining open items

None. Decision 5 is confirmed together with Decision 7, and the CN catalog follow-up is
Decision 8.

---

# Plan

## Architecture summary

1. **S1 keep list.**
   - `buildOwnedSelfDelete(subject, prop, old, prefix, keep?)` and
     `buildOwnedCascade(root, prefix, anchor?, keep?)` wrap each block in
     `FILTER(?old NOT IN (<k1>, …))` when `old` is a variable and `keep` is non-empty.
   - `processUpdateFields` collects `keep` per field: the bare `NodeReferenceValue`s (`{id}` only,
     with no `shape`/`fields`) of the single value or of the overwrite array.
   - Set-remove drops a removed id from the self-delete and cascade when the same id is in `add`.
   - A nested create that carries an id is never kept (A6).
2. **Self-delete only where a valueShape is declared** (Decision 6). The cascade path becomes
   `(c…)*`.
3. **Subject delete one-hop** (Decision 5) in `deleteToAlgebra`.
4. **Single-owner SHACL generation** (Decisions 1-4):
   - a pure helper computes the group and data;
   - the meta-model gains `targetObjectsOf` and `generated` on NodeShape;
   - `syncShapes` folds the generated shape into each shape's thunk.
5. **Class check for linked owned ids** (Decision 7):
   - a pure module collects the bare `{id}` links of `contains` fields from a lowered mutation and
     judges them against the types the store returns;
   - `SparqlDataset.createQuery`/`updateQuery` run one SELECT per mutation with links and throw
     before the update is sent.

## Contracts

### C1 — owned-delete helpers (`src/sparql/irToAlgebra.ts`)

```ts
export function buildOwnedSelfDelete(
  subjectTerm: SparqlTerm, propertyTerm: SparqlTerm, oldTerm: SparqlTerm,
  varPrefix: string, keep?: SparqlTerm[],            // NEW, iri terms only
): {deletePatterns: SparqlTriple[]; whereOptionals: SparqlAlgebraNode[]};

export function buildOwnedCascade(
  rootTerm: SparqlTerm, varPrefix: string, anchor?: SparqlTriple,
  keep?: SparqlTerm[],                               // NEW
): {deletePatterns: SparqlTriple[]; whereOptionals: SparqlAlgebraNode[]};
```

- When `keep` is non-empty and `oldTerm`/`rootTerm` is a variable, each returned block is
  `{type:'filter', expression:{kind:'in_expr', negated:true, value:{kind:'variable_expr', name}, list: keep.map(iri_expr)}, inner: bgp}`.
- With an IRI root, `keep` is ignored. The set-remove case filters statically instead.
- Existing callers are unchanged (the parameter is optional).

### C2 — emitted SPARQL for S1

Example: `Project.update({image: {id: img1}}).for(p1)` where `p1 image img1` already holds.

```sparql
DELETE { <p1> <image> ?old_image .
         ?old_image ?uc0_sp ?uc0_so .
         ?uc0_own0 ?uc0_op0 ?uc0_ov0 . … }
INSERT { <p1> <image> <img1> . }
WHERE {
  OPTIONAL {
    { <p1> <image> ?old_image . }
    UNION
    { <p1> <image> ?old_image . ?old_image ?uc0_sp ?uc0_so .
      FILTER(?old_image NOT IN (<img1>)) }
    UNION
    { <p1> <image> ?old_image .
      ?old_image (sh:property|…|<attachments>|<image>)* ?uc0_own0 .
      ?uc0_own0 rdf:type sh:PropertyShape . ?uc0_own0 ?uc0_op0 ?uc0_ov0 .
      FILTER(?old_image NOT IN (<img1>)) }
    UNION …
  }
}
```

Net effect when `?old_image = img1`: the edge is deleted and re-inserted, which is a no-op. img1's
own triples and its subtree are untouched. When the old value is `img0`, behaviour is identical to
today.

Array overwrite: `attachments: [{id:a},{id:b}]` with `a` present → `FILTER(?old_attachments NOT IN (<a>, <b>))`
on the self-delete and cascade blocks. A removed `c` is still deleted.

Set-mod: `{add:[{id:x}], remove:[{id:x}]}` emits no self-delete or cascade for x. The edge
delete and re-insert is a net no-op.

### C3 — emitted SPARQL for subject delete (Decision 5)

Each qualifying property `p` (own flattened, contains, has a valueShape, simple path) adds one UNION
block, and the delete template gains the child's triples:

```sparql
DELETE { … ?d0 ?d0_p ?d0_o . }
WHERE { <p1> rdf:type <Project> .
  { <p1> ?p ?o } UNION { ?s ?p2 <p1> }
  UNION { <p1> <image> ?d0 . ?d0 ?d0_p ?d0_o . }
  UNION { <p1> <attachments> ?d1 . ?d1 ?d1_p ?d1_o . }
  UNION …dependent cascade blocks (unchanged, path now `*`)… }
```

Multi-id deletes use the existing `${idx}` suffix (`?d0_1`). Variable names: `d{n}{idx}`.

### C4 — single-owner shape data (`src/shapes/singleOwnerConstraint.ts`, new)

```ts
/** The deterministic IRI of a declaring shape's generated single-owner NodeShape. */
export function singleOwnerShapeIri(shapeIri: string): string;      // `${shapeIri}.singleOwner`
/** Sorted simple-path IRIs of the shape's own+inherited `contains` properties. */
export function ownedPredicateGroup(nodeShape: NodeShapeData): string[];
/** Create-pipeline data for the generated NodeShape, or null when the group is empty. */
export function buildSingleOwnerShapeData(
  nodeShape: NodeShapeData, shapeIri: string,
): Record<string, unknown> | null;
```

`buildSingleOwnerShapeData` returns
`{generated: true, targetObjectsOf: group.map(id => ({id})), properties: [{__id: `${gen}/owners`, label: 'owners', maxCount: 1, path: serializePathToNodeData({inv: group.length === 1 ? {id: group[0]} : {alt: group.map(id => ({id}))}}, `${gen}/owners`)}]}`.

These are exported from `src/shapes/index.ts` (barrel) so that CN or validators can recompute the
IRI.

### C5 — meta-model additions

- `src/ontologies/shacl.ts`: add `targetObjectsOf` if it is missing.
- `src/ontologies/linked-core.ts`: add `generated = ns('generated')`.
- `src/utils/Package.ts` (NodeShape accessors, near `targetClass` / `dependent`):
  - `createPropertyShape({path: shacl.targetObjectsOf}, 'targetObjectsOf', shacl.IRI, NodeShape)`
    (multi-valued);
  - `createPropertyShape({path: coreOntology.generated, datatype: xsd.boolean, maxCount: 1}, 'generated', shacl.Literal, NodeShape)`.
  - Follow the exact helper signature used by the neighbouring accessors.
- `NodeShapeData` type (`src/shapes/nodeShapeData.ts` / `SHACL.ts`): **no change**. The generated
  data is plain create data and is never registered.

### C6 — persisted triples (S4), concrete example

Code:

```ts
@linkedShape({name: 'Project'})
class Project extends Shape {
  @objectProperty({path: schema.image, shape: ImageObject, maxCount: 1, contains: true}) declare image: ImageObject;
  @objectProperty({path: ex.attachments, shape: ImageObject, contains: true}) declare attachments: ImageObject[];
}
```

After `syncShapes()`, in addition to Project's normal triples, with
`ex: <http://example.org/>`, `schema: <https://schema.org/>`,
`@base <https://linked.cm/shape/my-pkg/>`, and the group sorted by IRI (`ex:attachments` before
`schema:image`):

```turtle
<Project.singleOwner> a sh:NodeShape ;
    core:generated true ;
    sh:targetObjectsOf ex:attachments, schema:image ;
    sh:property <Project.singleOwner/owners> .

<Project.singleOwner/owners> a sh:PropertyShape ;
    rdfs:label "owners" ;
    sh:maxCount 1 ;
    sh:path <Project.singleOwner/owners/inv> .

<Project.singleOwner/owners/inv> a core:PathNode ;
    sh:inversePath <Project.singleOwner/owners/inv/alt> .

<Project.singleOwner/owners/inv/alt> a core:PathNode ;
    sh:alternativePath <Project.singleOwner/owners/inv/alt/0> .

<Project.singleOwner/owners/inv/alt/0> a rdf:List ;
    rdf:first ex:attachments ; rdf:rest <Project.singleOwner/owners/inv/alt/1> .
<Project.singleOwner/owners/inv/alt/1> a rdf:List ;
    rdf:first schema:image ; rdf:rest rdf:nil .
```

With a single predicate the path collapses to `sh:path <…/owners/inv>` with
`<…/owners/inv> sh:inversePath schema:image`. The list's `rdf:type` triples come from the existing
`List` create path. Pin whatever it writes today in the test rather than re-specifying it.

SHACL reading: every object of `ex:attachments` or `schema:image` may have at most one subject
pointing at it through either predicate. Plain references through other predicates are not
counted (A4, A5).

### C7 — owned-link class check (`src/sparql/ownedLinkCheck.ts`, new)

```ts
/** One bare `{id}` linked into a `contains` field that declares a value shape. */
export type OwnedLink = {
  id: string;
  property: string;          // property-shape id
  label: string;             // property label, for the message
  shape: string;             // declaring node-shape id
  acceptedClasses: string[]; // value shape targetClass + registered sub-shapes' + sh:class
};
/** Pure IR walk: every owned link in a create/update/upsert/update_where mutation. */
export function collectOwnedLinks(
  ir: IRCreateMutation | IRUpdateMutation | IRUpsertMutation | IRUpdateWhereMutation,
): OwnedLink[];
/** `SELECT ?id ?type WHERE { VALUES ?id { … } ?id rdf:type ?type }` for the distinct ids. */
export function ownedLinkTypesQuery(ids: string[]): string;
/** Throws the Decision 7 error for every link whose id is typed and has no accepted class. */
export function assertOwnedLinkTypes(
  links: OwnedLink[], typesById: ReadonlyMap<string, ReadonlySet<string>>,
): void;
```

`SparqlDataset` gains `protected async checkOwnedLinks(ir)`. It returns without I/O when
`collectOwnedLinks` is empty. Otherwise it sends `ownedLinkTypesQuery` through
`executeSparqlSelect`, maps the bindings and calls `assertOwnedLinkTypes`. `createQuery` and
`updateQuery` (every kind) await it before `executeSparqlUpdate`. Links to `rdf:nil` are never
collected.

## Files expected to change

| File | Change |
|---|---|
| `src/sparql/irToAlgebra.ts` | `keep` on both helpers. Collect `keep` in `processUpdateFields` (replace, array, set-mod). Skip self-delete for valueShape-less contains fields. Change the cascade path from `oneOrMore` to `zeroOrMore`. Add the one-hop child blocks in `deleteToAlgebra`. Update the section comments. |
| `src/sparql/ownedLinkCheck.ts` (new) | C7 |
| `src/sparql/SparqlDataset.ts` | `checkOwnedLinks` before every create and update (C7) |
| `src/tests/owned-link-check.test.ts` (new) | C7 unit tests (stub dataset) and live Fuseki test |
| `src/shapes/singleOwnerConstraint.ts` (new) | C4 |
| `src/shapes/syncShapes.ts` | `buildSyncThunk` deletes and creates the generated shape. Add generated IRIs to `localShapeIris`. Throw on an IRI collision. |
| `src/shapes/index.ts` | Export C4 |
| `src/utils/Package.ts`, `src/ontologies/shacl.ts`, `src/ontologies/linked-core.ts` | C5 |
| `src/tests/shacl-cascade.test.ts` | S1, Decision 5 and Decision 6 unit and live tests |
| `src/tests/single-owner-constraint.test.ts` (new) | C4 and sync-data unit tests |
| `src/tests/sparql-fuseki-shape-sync.test.ts` | Live persistence and idempotence of the generated shape |
| `src/tests/sparql-mutation-golden.test.ts` | Only if a golden string changes (the cascade `+` → `*`); update it deliberately |
| `README.md` | "Owned properties" section |
| `.changeset/owned-replace-noop-single-owner.md` (new) | minor |
| `docs/backlog/048-*.md` → removed; `docs/reports/032-owned-replace-noop-and-single-owner-shacl.md` (new); this plan removed | wrap-up |

## Pitfalls

- **FILTER placement.** The filter must sit *inside* each UNION branch, next to the edge triple that
  binds `?old`. A filter outside the OPTIONAL would remove the edge-only branch too and break the
  delete of a genuinely replaced value. Check the rendered string, not just the algebra.
- **`algebraToString` of `filter` inside `union`.** Verify that it renders as `{ … FILTER(…) }`.
  `in_expr` is supported at L200.
- **`(c…)*` with an IRI root in set-remove.** The root is matched only if it is dependent-typed, and
  the edge-confirming anchor still applies. Re-run the existing List/PathNode cascade tests.
- **Sync delete cascade must reach the generated subtree.** NodeShape → `sh:property` (contains) →
  PropertyShape (dependent) → `sh:path` → PathNode → `sh:inversePath`/`sh:alternativePath` →
  List → `rdf:rest`. Every hop is contains, and no PathNode sits under `rdf:first` (F4). Assert
  zero leftover triples under `<…Project.singleOwner>` after a sync with the contains property
  removed.
- **Golden tests** that print cascade paths will change `)+` to `)*`. Update them deliberately and
  check `shacl-cascade` "`/\)\+ /`" assertions.
- **Delete performance.** One extra UNION block per qualifying property. The UNION adds solutions;
  keep it a UNION, never an OPTIONAL chain (the 27k-solution regression in the
  `deleteToAlgebra` comment).
- **Shape-sync deletes now also run one-hop child deletes** for NodeShape's `sh:property`
  (valueShape PropertyShape) and `sh:in` (List). Those are already deleted by the dependent cascade.
  The duplicate DELETE is set-idempotent, but re-run the shape-sync live suite. Note backlog 047
  flakiness: on a red run, capture the output before changing anything.
- **Backlog 009.** A green live suite without Docker proves nothing. Confirm the container started.
- **The live "delete WHERE size" test** in `shacl-cascade.test.ts` counts solutions exactly. With
  Decision 5, `TBox.owns` (value shape `TCell`) adds one block that matches `cell0`'s own triples,
  so the expected count grows by those triples. Update it deliberately; the remaining-triples
  assertion must not change.
- **Class check and existing suites (Decision 7).** Live suites that link `{id}`s into `contains`
  slots must still pass. Untyped ids are allowed, so only a wrongly typed seed would fail; such a
  failure is a finding, not something to work around.

## Test strategy

- Impacted package: `@_linked/core` only.
- Quick gate per phase: the targeted jest files (seconds), plus `npx tsc -p tsconfig-tests.json --noEmit`.
- Full gate (review): `npm test` and `npx linked build`, with Docker up so live suites run.

---

# Tasks

Dependency graph: **P1 ∥ P1b ∥ P2** (independent files: `irToAlgebra.ts`; `ownedLinkCheck.ts` and
`SparqlDataset.ts`; `syncShapes` and the meta-model) → **P3** (live tests for P1 and P2; P1b carries
its own live test) → **P4** (README) ∥ **P5** (changeset) → **P6** (wrap-up docs). P4 and P5 only
need the contracts, so they can start after P1, P1b and P2 are merged. Each phase is one commit.

## Phase 1 — Owned-delete fixes in `irToAlgebra` (S1, Decisions 5, 6)

Tasks:
1. Add `keep?: SparqlTerm[]` to `buildOwnedSelfDelete` and `buildOwnedCascade` (C1). Wrap each
   block in a `filter` with a negated `in_expr` when the old or root term is a variable and `keep`
   is non-empty.
2. `processUpdateFields`:
   - store `{oldVar, propertyTerm, keep, hasValueShape}` in `containsOldVars`;
   - compute `keep` from the bare `{id}` refs of a single value or of each array item (items
     with `shape`/`fields` excluded);
   - skip `buildOwnedSelfDelete` when the field's PropertyShape has no `valueShape`, but keep the
     cascade.
3. Set-mod branch: build `addIds` from bare-ref `add` items, and skip self-delete and cascade for a
   `remove` id in `addIds`. Apply the same valueShape rule.
4. `buildOwnedCascade`: `oneOrMore` → `zeroOrMore` (Decision 6), with the comment updated.
5. `deleteToAlgebra`: for the shape's own flattened contains properties with a valueShape and a
   simple path, add a UNION block and delete pattern per C3.

Tests (`src/tests/shacl-cascade.test.ts`, reusing the TCard/TPlainCell/TBox fixtures; add a
fixture with a valueShape-less `contains` property `TSlot.anyPath`):
- `replace with the current {id} filters the old value` asserts that the self-delete branch
  contains `FILTER(?old_holds NOT IN (<…#plain1>))` inside the same `{…}` as
  `#holds> ?old_holds`. Also asserts that the edge-only branch has no FILTER.
- `replace with a different {id} keeps the filter harmless` asserts that the filter lists only the
  new id.
- `array overwrite keeps the retained ids`: `cells: [{id:a},{id:b}]` asserts
  `NOT IN (<…a>, <…b>)` on the self-delete and cascade branches.
- `nested create with the current id is a full rewrite`: `holds: {id: plain1, label: 'x'}` asserts
  that **no** `NOT IN` is present and that the wildcard delete of `?old_holds` remains.
- `set-mod add+remove of the same id emits no node delete` asserts that no `<…x> ?\w+ ?\w+` pattern
  appears in DELETE, while the edge delete remains.
- `buildOwnedSelfDelete with keep` (unit, as in the existing helper test) asserts that
  `whereOptionals[0].type === 'filter'`, `expression.negated === true`, and that `inner.triples`
  is unchanged.
- `buildOwnedCascade with keep` makes the same assertion for every block.
- `cascade path includes the root (zero-or-more)` asserts `/\)\* /` and no `/\)\+ /` (update the
  existing `toMatch(/\)\+ /)` assertions).
- `valueShape-less contains field: no self-delete` (`TSlot.update({anyPath: {id: p}})`) asserts
  that no `?old_anyPath ?\w+ ?\w+ .` delete appears without a dependent-type triple in its block.
- `subject delete removes immediately-owned non-dependent children`
  (`DeleteBuilder.from(TCard, {id})`) asserts the blocks `#holds> ?d0 . ?d0 ?d0_p ?d0_o` and
  `#cells> ?d1` inside the UNION, and that the WHERE has no `OPTIONAL`.
- `subject delete skips valueShape-less contains properties` asserts that a TSlot delete has no
  `?d` block for `anyPath`.
- `multi-id delete suffixes child vars` asserts `?d0_1`.
- Live `delete WHERE size` (existing): the expected solution count includes the new `owns` one-hop
  block (see Pitfalls).

Validation:
- Quick: `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/shacl-cascade.test.ts src/tests/sparql-mutation-golden.test.ts src/tests/sparql-mutation-algebra.test.ts` exits 0. Any golden change must be the intended `+`→`*` or the new blocks.
- `npm run typecheck` exits 0.
- Full (review): `npm test`.

### Phase 1 status: done

Built as planned: `keep` on `buildOwnedSelfDelete`/`buildOwnedCascade` (a `keepFilter` wraps each
block in `FILTER(?old NOT IN (…))` next to the edge that binds `?old`), `keptReferences` for the
single value and the overwrite array, the re-added-id skip in set-modification, self-delete only
for `contains` fields with a `valueShape`, the cascade path `(c…)*`, and the one-hop
`<s> <p> ?dN . ?dN ?dN_p ?dN_o` blocks in `deleteToAlgebra` (`ownedValueShapePredicates`).

Validation (2026-10-12):
- Quick gate (`shacl-cascade`, `sparql-mutation-golden`, `sparql-mutation-algebra`): 3 suites,
  80 tests passed. 13 tests are new in `shacl-cascade.test.ts`. No golden string changed.
- `npm test` (jest + `tsc -p tsconfig-tests.json`): `[ensureFuseki] Fuseki is ready`; 95 suites
  passed, 4 skipped; 2142 tests passed, 120 skipped. Typecheck exit 0.
- `npx linked build`: Build successful.

Deviations (no contract change):
- The set-remove cascade now leads with the owning edge (`<s> <p> <x>`), as the self-delete
  already did. It had no anchor. With the `*` path the removed node is itself a match, and it must
  only be deleted while the subject still owns it. This is what the Pitfalls entry assumed.
- Two live solution-count tests changed deliberately:
  - `shacl-cascade` "delete WHERE size": +2 for the new `owns` one-hop block (cell0's type and
    `next`);
  - `mutation-where-union` "replacing a contains property": a dependent-typed old value of a
    property with a value shape is now matched by both the self-delete and the `*` cascade.
    That overlap is added (+ its own triples), never multiplied, and the deleted triples are
    unchanged.
- Not changed, recorded for wrap-up: `deleteAll`/`deleteWhere` (bulk deletes) do not cascade or
  delete owned children. That was already true before this plan.

## Phase 1b — Class check for linked owned ids (Decision 7, C7) ∥ Phase 1, Phase 2

Tasks:
1. New `src/sparql/ownedLinkCheck.ts` (C7):
   - `collectOwnedLinks` walks `data.fields` recursively (nested creates included). For each field
     whose property shape (`findPropertyShapeById`) is `contains` with a `valueShape` and a
     resolvable targetClass, it collects the bare `{id}`s of a single value, of an array, and of a
     set `add`. `remove` items, nested creates and `rdf:nil` are not collected.
   - `acceptedClasses` = the value shape's targetClass, every `getSubShapes(valueShape)`
     targetClass, and `ps.class`.
   - `ownedLinkTypesQuery` emits full IRIs (`assertSafeIri`), deduplicated, in first-seen order.
   - `assertOwnedLinkTypes` collects every violation and throws one `Error` with the C7 message
     lines.
2. `SparqlDataset`: `checkOwnedLinks(ir)` is called in `createQuery` (after the id is assigned) and in
   `updateQuery` for `update`, `upsert` and `update_where`, before `executeSparqlUpdate`.

Tests (`src/tests/owned-link-check.test.ts`, new; fixtures: `TPhoto` (targetClass `ex:Photo`),
`TPanorama extends TPhoto` (`ex:Panorama`), `TPerson` (`ex:Person`), and `TAlbum` with `cover`
(`contains`, shape TPhoto, maxCount 1), `photos` (`contains`, shape TPhoto) and `featured`
(**not** contains, shape TPhoto), plus `TSlotHolder.any` (`contains`, no shape)):
- `collect: single, array, set-add` asserts ids and `property` labels for
  `cover: {id:a}`, `photos: [{id:b},{id:c}]` and `photos: {add:[{id:d}], remove:[{id:e}]}`;
  `e` is absent.
- `collect: nested create is not a link, its fields are` asserts that
  `cover: {id: n1, …nested fields}` yields nothing for n1, while a nested album's `cover: {id:x}`
  inside a create yields x.
- `collect: non-contains, shape-less contains and rdf:nil are skipped` asserts an empty list for
  `featured: {id}`, `any: {id}` and a link to `rdf:nil`.
- `collect: update_where` (`UpdateBuilder.from(TAlbum).forAll().set({cover:{id:a}})`) yields a.
- `acceptedClasses includes registered sub-shapes` asserts `ex:Photo` and `ex:Panorama`.
- `query` asserts the exact `SELECT ?id ?type WHERE { VALUES ?id { <a> <b> } … }` string, with
  duplicate ids appearing once.
- Stub dataset (`class StubDataset extends SparqlDataset`, records selects and updates, answers
  selects from a map):
  - `no links → no select`: an update of a literal field sends 0 selects and 1 update;
  - `one select for many links`: `photos: [{id:a},{id:b},{id:c}]` sends exactly 1 select;
  - `wrong type refuses and writes nothing`: a typed `ex:Person` → rejects with a message containing
    `"cover"`, the id and `<http://example.org/olc#Photo>`; 0 updates sent;
  - `sub-shape class passes`, `untyped or unknown id passes`, `one of several types matching passes`;
  - `create checks too`: `CreateBuilder.from(TAlbum).set({cover:{id: alice}})` rejects.
- Live Fuseki (`ensureFuseki`; container confirmed in the output): seed `alice a ex:Person` and
  `p1 a ex:Photo`, then through `FusekiStore`:
  - an update linking alice into `cover` rejects, and `album1` has no `cover` edge afterwards;
  - linking p1 succeeds and the edge exists.

Validation:
- Quick: `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/owned-link-check.test.ts src/tests/sparql-fuseki.test.ts src/tests/sparql-fuseki-shape-sync.test.ts` exits 0, with `[ensureFuseki] Fuseki is ready` (or the running container) in the output.
- `npm run typecheck` exits 0.

### Phase 1b status: done

Built as planned: `src/sparql/ownedLinkCheck.ts` (C7) and `SparqlDataset.checkOwnedLinks`, awaited in
`createQuery` (after the id is assigned) and in `updateQuery` for every kind, before
`executeSparqlUpdate`.

Validation (2026-10-12):
- Quick gate (`owned-link-check`, `sparql-fuseki`, `sparql-fuseki-shape-sync`): `[ensureFuseki]
  Fuseki is ready`; 3 suites, 113 tests passed. `owned-link-check.test.ts` has 13 tests (7
  collect/assert, 5 stub dataset, 1 live). The live test was confirmed to run its assertions, not
  early-return, with a temporary log line, which was then removed.
- `npm test`: exit 0. 96 suites passed, 4 skipped; 2155 tests passed, 120 skipped. Shape sync and
  every other live suite pass with the check in place.
- `npx linked build`: Build successful.

Deviations (additive, no contract change):
- `OwnedLink` also carries `expectedClass` (the value shape's targetClass) so that the message
  names that class and lists the other accepted classes separately:
  `… only owns instances of <Photo> (or of <Panorama>, a registered sub-shape or sh:class).`
- An extra export `ownedLinkTypesFromResults(json)` maps the SELECT answer. It rejects an ASK
  response.
- Fixtures: the shape-less `contains` field is `TAlbum.any`, not a separate `TSlotHolder`. A
  `TAlbum.subAlbum` (`contains`, shape TAlbum) covers links nested inside a nested create.
- The live test follows the repository's `if (!fusekiAvailable) return` pattern (backlog 009).

## Phase 2 — Single-owner SHACL generation and persistence (S4, Decisions 1-4) ∥ Phase 1

Tasks:
1. C5 meta-model terms and accessors.
2. New `src/shapes/singleOwnerConstraint.ts` (C4) and the barrel export.
3. `syncShapes.ts`:
   - `buildSyncThunk` runs delete main → delete `singleOwnerShapeIri(iri)` → create main → create
     generated if non-null;
   - `syncShapes` adds the generated IRIs to `localShapeIris`;
   - throw `Shape IRI <x> collides with a generated single-owner shape` when a registered IRI ends
     with `.singleOwner` and equals a generated one.

Tests (`src/tests/single-owner-constraint.test.ts`, new, with fixtures `Project`
(image + attachments contains ImageObject), `Workspace` (image only) and a subclass `SubProject
extends Project`):
- `ownedPredicateGroup sorts and flattens` returns `[ex:attachments, schema:image]` for Project and
  SubProject, and `[schema:image]` for Workspace.
- `no contains → null`: `buildSingleOwnerShapeData` returns `null` for a shape without contains.
- `complex-path contains is skipped`: a `contains` with `{seq:[…]}` path is not in the group.
- `two-predicate data` asserts `generated === true`, the `targetObjectsOf` ids, property `__id`
  `…Project.singleOwner/owners`, `maxCount === 1`, and `path.__id === '…/owners/inv'` with
  `inversePath.alternativePath` a List whose `first`s are the two ids in order.
- `single-predicate data` asserts `path.inversePath` is `{id: schema:image}` (no alt).
- `IRI` asserts `singleOwnerShapeIri('…/Project') === '…/Project.singleOwner'`.
- `not registered`: after import, `getAllNodeShapes()` has no key ending `.singleOwner`, and
  `getPropertyShapes(Project.shape, true)` has no `owners` label.
- `sync thunk plan`: with a stub dataset recording calls, `syncShape(Project)()` issues the deletes
  for main and generated, then the creates for main and generated. For a shape without contains,
  only the generated *delete* is issued.
- `prune keeps generated` (stub ds returning existing ids incl. `…Project.singleOwner`):
  `syncShapes(ds, {orphanScope:'all'})` emits no orphan delete for it.

Validation:
- Quick: `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/single-owner-constraint.test.ts src/tests/shape-wire-idempotence.test.ts src/tests/metadata.test.ts` exits 0.
- `npm run typecheck` exits 0.

### Phase 2 status: done

Built as planned: `targetObjectsOf` and `generated` on the NodeShape meta-model (`shacl.ts`,
`linked-core.ts`, `Package.ts`), `src/shapes/singleOwnerConstraint.ts` (C4), and `buildSyncThunk`
running delete main → delete generated → create main → create generated (if non-null).
`syncShapes` adds every user shape's generated IRI to `localShapeIris` and throws
`Shape IRI <x> collides with a generated single-owner shape`.

Validation (2026-10-12):
- Quick gate (`single-owner-constraint`, `shacl-syncshapes`, `shape-wire-idempotence`,
  `metadata`): 4 suites, 44 tests passed. `single-owner-constraint.test.ts` has 11 tests.
- Live `sparql-fuseki-shape-sync.test.ts` re-run with the new thunk: `[ensureFuseki] Fuseki is
  ready`, 3 tests passed.
- `npm test` (jest + `tsc -p tsconfig-tests.json`): exit 0. 95 suites passed, 4 skipped;
  2129 tests passed, 120 skipped (the skipped count is unchanged from before the phase).
- `npx linked build`: Build successful.

Deviations (no contract change):
- The C4 helpers are exported from `src/index.ts`, next to `syncShapes`, not from
  `src/shapes/index.ts`. That barrel is side-effect-only by design ("Nothing is exported from
  here"). They are also reachable as `@_linked/core/shapes/singleOwnerConstraint`.
- `targetObjectsOf` is declared `{path: shacl.targetObjectsOf, shape: Shape}`, the same form as
  the neighbouring `targetNode` and `ignoredProperties` accessors (values are predicate IRIs).
- `syncShape(target)` also throws on the collision (it checks whether `<iri>.singleOwner` is a
  registered shape), since its thunk deletes that IRI too.
- The existing `shacl-syncshapes.test.ts` assertions on exact delete lists now include the
  `<iri>.singleOwner` delete, which is the intended behaviour.

## Phase 3 — Live Fuseki tests (after P1 and P2)

Precondition: Docker running. Jest auto-starts `tests-fuseki-1` on :3939. Confirm
`[ensureFuseki] Fuseki is ready` or an already-running container in the output (backlog 009).

Tasks and tests:
- `shacl-cascade.test.ts` live:
  - `re-sending the current id keeps the owned node`: seed card1 holds plain1 (2 triples), apply
    `replaceHolds('plain1')`, assert `countTriples('plain1') === 2` and that the edge exists.
  - `array overwrite keeps retained, deletes dropped`: seed cells a, b, c, overwrite with `[a, b]`,
    assert a and b each keep 2 triples and c has 0.
  - `subject delete removes owned child, keeps referenced-only nodes`: seed card1 holds plain1 and
    a TBox `ref` → plain2, delete card1, assert plain1 has 0 triples and an unrelated node is
    untouched. Dangling refs to plain1 from other subjects are accepted (A5); assert that the
    *referencing* subject's own triples are untouched.
  - `replacing a valueShape-less contains value keeps a plain predicate IRI`: seed
    `<pred> rdfs:label "x"`, give the TSlot `anyPath <pred>`, replace it, assert `<pred>` still has
    its label.
- `sparql-fuseki-shape-sync.test.ts` live:
  - `generated single-owner shape is persisted`: after sync, ASK
    `<…Project.singleOwner> core:generated true ; sh:targetObjectsOf ex:attachments, schema:image ; sh:property/sh:path/sh:inversePath/sh:alternativePath/rdf:rest*/rdf:first ?p`
    and assert two `?p`.
  - `re-sync is idempotent`: count triples under `<…Project.singleOwner>` (subjects
    `STRSTARTS(STR(?s), "…Project.singleOwner")`), sync again, and assert the count is equal.
  - `losing the last contains property removes the constraint`: re-register a variant without
    contains (or call `syncShape` on a contains-free fixture whose generated IRI was seeded) and
    assert the count is 0.
  - Optional: if the test Fuseki exposes a SHACL endpoint (`POST /{ds}/shacl?graph=default`),
    validate a double-owned image and expect `sh:conforms false`. Otherwise skip with a visible
    `test.skip` note, not a silent return.

Validation:
- `npm run test:fuseki` exits 0, with the new tests listed as passed (not early-returned) in the
  `--verbose` output.
- Afterwards: `docker compose -f src/tests/docker-compose.test.yml down`.

### Phase 3 status: done

Added the planned live tests:
- `shacl-cascade.test.ts` (in the backlog-032 live block): re-sending the current id keeps the
  owned node; array overwrite keeps retained ids and deletes the dropped one; subject delete
  removes the owned child, keeps an unowned node, and leaves the referencing subject (with its now
  dangling reference) untouched; replacing a value-shape-less `contains` value keeps the plain
  predicate IRI and its label.
- `sparql-fuseki-shape-sync.test.ts` (new `single-owner constraint e2e` block, fixtures
  `E2EImage`, `E2EProject` with `schema:image` + `ex:attachments`, `E2EOwnerLoss` with one
  `contains` property): the generated shape is persisted (`core:generated true`, both
  `sh:targetObjectsOf`, no `sh:targetClass`, `owners` with `sh:maxCount 1`, two alternative-path
  members); re-sync is idempotent (triple count under `<…E2EProject.singleOwner>` unchanged);
  removing the last `contains` property and re-running `syncShape` leaves 0 generated triples.
- The SHACL endpoint test is a visible `test.skip`: the test Fuseki's admin-created datasets
  expose only `gsp-r`, `gsp-rw`, `query` and `update` (checked through `/$/datasets/<name>`).

Validation (2026-10-12):
- Targeted (`sparql-fuseki-shape-sync`, `shacl-cascade`): `[ensureFuseki] Fuseki is ready`; 2
  suites, 35 passed, 1 skipped. Every live test was confirmed to get past its availability guard
  with a temporary `throw` after the guard (12 failures as expected), which was then removed.
- `npm run test:fuseki`: 3 suites, 214 passed, 1 skipped; the script stops the container itself.
- `npm test`: 96 suites passed, 4 skipped; 2162 tests passed, 121 skipped (the extra skip is the
  SHACL endpoint test). Typecheck exit 0.

Deviations (no contract change):
- The ownership-loss case uses a dedicated `E2EOwnerLoss` fixture and filters its property shapes,
  the same way Phase B mutates `E2EPerson`, rather than seeding a generated IRI.

## Phase 4 — README "Owned properties" (after P1 and P2) ∥ Phase 5

Tasks (README.md "Owned properties (`contains` / `dependent`)"):
- **Replace and patch in place.** A nested object replaces the owned value: a new node is created and
  the old one deleted. Re-sending the current `{id}` is a no-op. `{id: current, ...fields}`
  rewrites that node completely. To patch, use `ImageObject.update({...}).for(id)`.
- **Linking by id.** `{image: {id}}` is allowed and transfers ownership. The linked node is deleted
  when replaced, removed or when the owner is deleted. Non-owning references elsewhere are not
  checked and may dangle.
- **Delete.** `parent.delete()` deletes immediately-owned children of properties that declare a
  `shape`. `dependent` extends the cascade further down. A `contains` property without a `shape`
  only deletes `dependent`-typed values.
- **Single-owner constraint.** Shape sync writes `<Shape>.singleOwner`
  (`sh:targetObjectsOf` + inverse `sh:maxCount 1`), with a short turtle excerpt from C6.
- **Class check.** Linking a node into a `contains` property that declares a `shape` is refused when
  the node is typed and none of its types is the shape's class (or a registered sub-shape's). Untyped
  and not-yet-existing ids are allowed.
- **Caveat.** Core does not check the single-owner rule, or `sh:class` on non-owning references, at
  write time. The default Fuseki setup does not validate SHACL on write. Run a SHACL validator to
  enforce them.

Validation: the README renders. Manually check that the code samples match the final API names:
`grep -n "singleOwner" README.md` shows the section.

### Phase 4 status: done

README "Owned properties (`contains` / `dependent`)" now covers, after the existing intro: replace
versus patch in place (`ImageObject.update({...}).for(id)`), the re-sent-id no-op and array
overwrite, `{id: current, ...fields}` as a full rewrite, linking by `{id}` (upload then attach) and
the ownership it transfers, the class check with its scope (only `contains` properties with a
`shape`; untyped and nonexistent ids allowed) and an abridged error, what a subject delete removes
(including the `shape`-less `contains` rule), dangling non-owning references, the persisted
`<Shape>.singleOwner` turtle, and the not-enforced-on-write caveat.

Validation: `grep -n "singleOwner" README.md` shows the section (L312-330). The API names in the
samples match the code: `singleOwnerShapeIri`, `ownedPredicateGroup` and
`buildSingleOwnerShapeData` are exported from `src/index.ts`; the error text follows
`ownedLinkCheck.ts`.

Deviation: the turtle shows the path with blank-node syntax for readability, with a note that the
stored path nodes have deterministic IRIs under `…/owners/inv` (C6 has the exact form).

## Phase 5 — Changeset ∥ Phase 4

Task: create `.changeset/owned-replace-noop-single-owner.md` by hand (`npx changeset` is
interactive):

```md
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
```

Validation: `npx changeset status` lists `@_linked/core` as minor.

### Phase 5 status: done

`.changeset/owned-replace-noop-single-owner.md` written by hand with the text above.

Validation (2026-10-12):
- `changeset status`: "Packages to be bumped: minor — @_linked/core". Run from a throwaway clone
  outside the CN workspace with a local `main` branch: inside `packages-local/` the CLI resolves
  the CN workspace root and reports "There is no .changeset folder".
- `npm test`: exit 0. `[ensureFuseki] Fuseki is ready`; 96 suites passed, 4 skipped; 2162 tests
  passed, 121 skipped. Typecheck exit 0.
- `npx linked build`: Build successful.

## Phase 6 — Wrap-up docs (last)

Tasks:
1. Write `docs/reports/032-owned-replace-noop-and-single-owner-shacl.md` (next free report number):
   problem, the decisions above, the emitted SPARQL and turtle as built, the files changed, the S3
   finding and the follow-ups.
2. Delete `docs/backlog/048-owned-property-replace-deletes-any-node.md` and this plan, as was done
   for report 025.
3. Record the follow-ups in the report:
   - CN `fetchShapeCatalog` filters `core:generated` only together with an owned/contained flag in
     CN's shape UI (Decision 8);
   - CN `ownedProperties.ts` duplicates `collectContainment`;
   - enable SHACL validation (on write or on demand) in the CN stack;
   - `rdf:first`-nested PathNodes in sequence paths are not cascade-cleaned on sync (F4);
   - the class check (Decision 7) does not cover non-SPARQL `IDataset` implementations, nor ids
     typed only after they were linked.
   Ask before creating any of these as backlog items.

Validation:
- `npm test` exits 0 with Docker up.
- `npx linked build` exits 0.
- `git status` shows only the intended files.

---

# Review

Reviewed 2026-10-12 against the accepted decisions (A1-A7, Decisions 1-8) and contracts C1-C7.
Evidence came from the diff (`git diff main...HEAD`), the SPARQL emitted by a throwaway jest
scratch test (deleted afterwards), and a trace of the write path through `_linked-fuseki`,
`_linked-server` and CN.

## Test run

- `npm test`: `[ensureFuseki] Fuseki is ready` (test container on :3939). 96 suites passed and 4
  skipped (type-only suites); 2162 tests passed and 121 skipped. Typecheck exit 0. The test
  container was stopped afterwards and :3030 was not touched.
- Architecture: `core:generated` is in `linked-core.ts`, `sh:targetObjectsOf` is in `shacl.ts`, the
  generated IRI derives from `getNodeShapeUri`, and the release goes through a changeset only. No
  violations of ontologies.md, runtime-instances.md or publishing.md were found.

## Intent check

- **S1 (no-op re-send):** met for a single value, an array overwrite and set add+remove. The
  `FILTER NOT IN` sits inside each UNION branch, as the pitfall requires. The emitted SPARQL for
  `forAll()` and for two `contains` fields in one update was checked.
- **Decision 5:** met for the id delete (`deleteToAlgebra`). **Not** applied to `deleteAll` or
  `delete().where()` (H2).
- **Decision 6:** met. `PropertyShape.path`-style slots no longer self-delete. The cascade uses `*`.
- **Decision 7:** met on every DSL write path. One gap is caused by the predicate-level `contains`
  rule (H1).
- **S4:** met. The shape is persisted, re-sync is idempotent, `'all'` pruning keeps generated
  shapes, and nothing is registered in memory.

## Write path (question 1)

Every DSL create, update, upsert and update-where reaches `SparqlDataset.createQuery` or
`updateQuery`.
- `_linked-fuseki/src/shapes/FusekiStore.ts:66` extends `SparqlDataset` and implements only
  `executeSparqlSelect` and `executeSparqlUpdate`.
- Upsert is a flag on `UpdateBuilder` (`UpdateBuilder.ts:308`), so it goes through `updateQuery`.
- The server (`_linked-server/src/backend.ts:67-84`) runs `fromJSON`, then `LinkedStorage.*Query`.
- In CN, `linked.backend.storage.js:86-118` creates `FusekiStore`s. `AppDataRouter` forwards
  through `ExecutionGateway` to the store's own `createQuery`/`updateQuery`, and
  `HostAgentForwarder` extends `SparqlDataset`.
- No code outside `SparqlDataset.ts` calls `createToSparql`, `updateToSparql`, `upsertToSparql` or
  `updateWhereToSparql`.
- No in-memory or other `IDataset` exists in core, `packages-local` or CN.

Raw SPARQL (`rawQuery(...,'update')`, `fetch` to `/update`, Graph Store imports) skips the check,
as designed. Callers include CN `DraftProvider.ts` and the translation writes in
`ProjectProvider.ts`.

## Findings

### High

**H1. The class check is per property; the owned delete is per predicate.**
- `processUpdateFields` decides `isContainsField` from the registry-wide predicate set
  (`irToAlgebra.ts:1971`). Its `hasValueShape` (`:1976`) only asks whether *this* property shape
  has a value shape.
- `buildRule` (`ownedLinkCheck.ts:109-110`) returns null unless *this* property shape has
  `contains`.
- So for a shape that declares the same predicate **without** `contains`, the check is skipped
  but the replace still self-deletes the old value. Scratch evidence: `ROther.img`, plain, shares
  `ex:img` with `ROwner.img`, which is `contains`. `collectOwnedLinks` returns `[]`, and
  `updateToSparql` emits `?old_img ?uc0_sp ?uc0_so` plus the cascade.
- This is concrete for CN. `@_linked/schema` `Thing.image` is `contains`. CN strips `contains` from
  project-authored shapes (`runtimeShapeRegistry.ts:38-52`), so a project shape declaring
  `schema:image` links unchecked, and its next replace deletes whatever was linked.
- Backlog 048's "decided by predicate across the whole registry" root cause is therefore still
  open. The README's claim, "core checks the class of every id linked into a `contains`
  property", does not hold here.
- **Fix:** apply one rule to both. Either run the check for any field whose predicate is in
  `collectContainment().containsPreds` and that has a value shape, or make the replace
  self-delete per property (`ps.contains`).

**H2. `deleteAll` and `delete().where()` do not delete owned children.**
- `deleteAllToAlgebra` and `deleteWhereToAlgebra` (`irToAlgebra.ts:2766-2860`) have neither the
  Decision 5 one-hop blocks nor the dependent cascade. Scratch `DeleteBuilder.from(ROwner).all()`
  emits only `?a0 ?p ?o`.
- The README ("`parent.delete()` deletes the immediately-owned children") and the changeset
  ("deleting a subject now deletes its immediately-owned children") read as if all deletes do. Bulk
  deletes still orphan every owned image.
- **Fix:** add the same per-predicate UNION blocks, rooted at `?a0`, to both bulk paths. If that is
  deferred, narrow the README and changeset to "delete by id".

### Medium

**M1. Breaking behaviour for consumers, under-signalled for a minor.**
- With `Thing.image` `contains`, deleting any schema-derived entity by id now deletes its linked
  ImageObject. That includes an image shared across entities through `{id}`, which existing data
  may already hold.
- Linking a node typed only with an unregistered subclass of `schema:ImageObject` is now refused,
  unless the store infers the supertype.
- A `contains` property without a shape no longer deletes a typed non-dependent old value, so it
  orphans now.
- The changeset lists these in one sentence each, with no warning.
- **Fix:** add a "Behaviour changes" block to the changeset that names `Thing.image` and asks apps
  to check for shared images before upgrading. Consider whether this warrants a major.

**M2. Missing live negative tests.**
- The live tests assert triples (good), but they do not cover:
  - set-remove of an id the subject does not own. The new anchor is what makes that safe:
    `irToAlgebra.ts:2017`, which before this change cascaded from any IRI.
  - a kept id that has a dependent subtree. The subtree must survive.
  - upsert and `forAll()` with a kept id.
  - a two-owner (stolen `{id}`) delete.
- Live tests also `return` silently when Fuseki is down (backlog 009).
- **Fix:** add these four live cases, and fail rather than return when `CI` is set.

**M3. The single-owner group includes `contains` properties without a value shape.**
- `ownedPredicateGroup` (`singleOwnerConstraint.ts:46-52`) filters only on `ps.contains`. Decisions
  6 and 7 treat shape-less slots as polymorphic, and their values may be shared IRIs.
- A user shape with such a slot gets an `sh:maxCount 1` inverse constraint that a validator will
  report on legitimate sharing.
- **Fix:** require `ps.valueShape` in the group, or document why shape-less slots are included.

### Low

**L1. Sync deletes whatever NodeShape sits at `<iri>.singleOwner`, generated or not**
(`syncShapes.ts:121`). The collision check only covers registered shapes, not store-only (CN
project) shapes. **Fix:** guard the delete with `core:generated true`, or extend the collision
check to the store.

**L2. Sync is four non-atomic updates per shape, and every sync adds a DELETE round trip for each
shape, with or without `contains`** (`syncShapes.ts:120-124`). A crash between "create main" and
"create generated" leaves the constraint missing until the next sync, which heals it (benign).
**Fix:** skip the generated delete when the store has no generated shape, or fold both into one
UPDATE.

**L3. The check is a separate SELECT before the UPDATE (TOCTOU)** (`SparqlDataset.ts:203-211`).
A node typed concurrently is not caught. **Fix:** document it with the existing "typed later"
limitation.

**L4. Stale comments.**
- `irToAlgebra.ts:2406` still says `(c1|c2|…)+`.
- The `deleteToAlgebra` docstring (`:2596-2599`) omits the immediate-child blocks.
- The `buildOwnedSelfDelete` docstring (`:2556-2566`) omits `keep`, and does not say that callers
  skip it for shape-less properties.
- `SHACL.ts:204-207` (`contains` doc) does not mention the class check or the subject-delete rule.
- **Fix:** update these four comments.

**L5. Backlog 048 now describes fixed behaviour.** H1 is its still-open part. **Fix:** in wrap-up,
carry H1 (if deferred) into the report and delete 048 as planned.

**L6. Performance is acceptable.**
- No SELECT is sent without links (verified, stub test), and `rdf:nil` is skipped.
- Each `NOT IN` filter is evaluated after the edge triple binds `?old`.
- `*` with a bound root costs the same as `+`.
- Each delete gains one UNION block per owned predicate.
- No action needed.

---

# Iteration 1 — Ideation

Source: the [Review](#review) above. Six gaps are taken into this iteration. The approach for each
was chosen by the lead developer (2026-10-12); the alternatives are recorded so that the choice can
be revisited. L1 and L2 stay follow-ups, L5 belongs to wrap-up, and L6 needs no action.

## Gap 1 of 6 — The class check and the owned delete use different ownership rules (H1)

**Context.** The replace self-delete decides ownership **per predicate**, across the whole registry
(`collectContainment().containsPreds`, `processUpdateFields`), and needs a value shape on the
property being written. The class check (`ownedLinkCheck.ts` `buildRule`) decides it **per
property** (`ps.contains`). A shape that declares a `contains` predicate *without* `contains`
therefore links unchecked, and its next replace deletes whatever was linked. In CN this is
concrete: `@_linked/schema` `Thing.image` is `contains`, CN strips `contains` from
project-authored shapes, so a project shape with `schema:image` links any node unchecked.

**Approaches.**
- **(a) The class check follows the delete's predicate rule.** A field is checked when its simple
  path predicate is in `containsPreds` and its property declares a value shape whose targetClass
  resolves. The accepted classes are unchanged (value shape, registered sub-shapes, `sh:class`).
  - Pro: one rule for "this field owns its value" in both places; it closes the CN hole with no
    change to what any mutation deletes.
  - Pro: no new registry scan (`collectContainment` is memoized on the registry version).
  - Con: a plain property that shares a predicate with another shape's `contains` property is now
    checked, which costs a SELECT and can refuse a link its author did not think of as owning. That
    is the honest outcome: the replace would delete that value.
- **(b) The delete follows per-property ownership (`ps.contains`).**
  - Pro: ownership is readable from the property alone.
  - Con: it changes the registry-wide predicate semantics that `collectContainment`, the cascade
    path, the single-owner `sh:targetObjectsOf` and CN's `ownedProperties.ts` rely on.
  - Con: CN project shapes (contains stripped) would stop cleaning up replaced images: the
    backlog 032 orphans come back.
- (c) Check per property and per predicate (union of both). Same result as (a), since every
  `contains` property with a simple path is in `containsPreds`; (a) is the simpler statement.

**Chosen: (a).** Rationale: it makes the check exactly as wide as the destructive operation it
guards (priority 1), without a semantics change. **Follow-up for the lead developer:** whether
ownership should become per property everywhere (option (b), including the cascade and
`collectContainment`). That is a design change, not a bug fix, and is not part of this plan.

Remaining asymmetry, recorded: the subject delete (Decision 5) uses the deleted shape's *own*
`contains` properties. A shape whose plain property shares a `contains` predicate deletes the old
value on replace but not on subject delete. That is the safe direction (nothing extra is deleted).

## Gap 2 of 6 — Bulk deletes do not delete owned children (H2)

**Context.** `deleteAllToAlgebra` and `deleteWhereToAlgebra` emit the root wildcard and the
blank-node blocks only: no Decision 5 child blocks and no dependent cascade. The README and the
changeset read as if every delete removes owned children.

**Approaches.**
- **(a) The same blocks, rooted at the bulk subject variable `?a0`.** For a shape with a
  `contains` property: one block per `ownedValueShapePredicates` predicate
  (`?a0 <p> ?dN . ?dN ?dN_p ?dN_o`) and the `buildOwnedCascade` blocks, all in the existing UNION
  next to the root wildcard and the blank-node blocks.
  - Pro: one rule for every delete; README and changeset hold as written.
  - Con: one UNION block per owned predicate and per dependent type. They add solutions.
- (b) Narrow README and changeset to "delete by id".
  - Pro: no code. Con: bulk deletes keep orphaning every owned image; two rules.
- (c) Lower a bulk delete into "SELECT the ids, then delete by id".
  - Con: two round trips, an unbounded id list, and a non-atomic delete.

**Chosen: (a).** Correctness and cost notes:
- Every new block starts with the subject's type triple (`?a0 rdf:type <S>`). With ARQ's usual
  linear join the triple is redundant; if a store evaluates a UNION branch on its own, it keeps
  `?a0 (c…)* ?own` from running with both ends unbound (a zero-or-more path with an unbound
  subject matches every node in the graph).
- `delete().where()`: the blocks are joined with the filtered pattern, so only matched subjects'
  children are deleted.
- With the `*` path, `?a0` itself is matched when its shape is `dependent`. Its triples are already
  in the delete template; DELETE works on a set of triples, so nothing is deleted twice and nothing
  extra is deleted.
- Shapes without a `contains` property emit exactly what they emit today (golden tests unchanged).
- Unchanged and recorded: bulk deletes do not delete *incoming* references (`?s ?p ?a0`), unlike
  the by-id delete. That difference predates this plan.

## Gap 3 of 6 — Behaviour changes are under-signalled for a minor (M1)

**Approaches.** (a) Keep minor, add an explicit "Behaviour changes" section to the changeset.
(b) Release as major.

**Chosen: (a).** Rationale:
- No API or type changes. Every behaviour change either implements behaviour the README already
  promised (delete removes owned children) or prevents data loss (the re-sent-id wipe, the
  wrong-type link, the shape-less slot deleting a shared predicate IRI).
- Data that shares one image between two owners already breaks the documented single-owner rule.
- A major makes every consumer wait for a manual Renovate approval for a bug-fix release.

The section names the three changes concretely: by-id and bulk deletes now delete owned children
(`Thing.image` from `@_linked/schema`: linked ImageObjects are deleted with their parent, including
ones linked by `{id}`); linked `{id}`s into owned properties are class-checked (a node typed only
with an unregistered subclass is refused; the fix is to register a shape for that class, or
declare `sh:class`); `contains` properties without a value shape no longer delete the old value's
own triples (they may leave orphans).

## Gap 4 of 6 — Missing live negative tests (M2)

**Chosen:** add live Fuseki tests for
1. set-remove of an id the subject does not own (the node must survive);
2. a kept id that has a dependent subtree (the subtree survives);
3. upsert with a kept id;
4. `update().forAll()` and `update().where()` with a kept id;
5. a delete where two owners point at the same node (the resulting behaviour is documented);
6. bulk delete deletes owned children (Gap 2);
7. the class check under the predicate rule (Gap 1).

Each run is proven with a temporary `throw` after the availability guard (or the
`[ensureFuseki] Fuseki is ready` line). Turning the silent `return` into a failure on `CI`
(the second half of M2) is backlog 009's subject and is not part of this iteration.

## Gap 5 of 6 — The single-owner group includes shape-less `contains` properties (M3)

**Approaches.** (a) Require `ps.valueShape` in `ownedPredicateGroup`. (b) Document why they are
included.

**Chosen: (a).** It is consistent with Decisions 6 and 7: a shape-less `contains` slot is
polymorphic, its value may be a shared IRI, and the delete and the class check already treat it as
not owning that value. A validator would otherwise report legitimate sharing. The README turtle is
unaffected (both of its properties declare a shape).

## Gap 6 of 6 — Stale comments and README gaps (L3, L4)

**Chosen:** update
- the owned-subtree section comment in `irToAlgebra.ts` (`(c1|c2|…)+` → `*`);
- the `deleteToAlgebra` docstring (immediate-child blocks; the bulk paths);
- the `buildOwnedSelfDelete` docstring (`keep`; callers skip it for shape-less properties);
- the `contains` doc in `SHACL.ts` (class check, delete rule, single-owner shape);
- README: the L3 race (the check is a SELECT before the UPDATE; a node typed in between is not
  caught) next to the "typed later" limitation, the predicate rule of the class check, and bulk
  delete behaviour.

---

# Iteration 1 — Plan

## Decisions

| Gap | Decision |
|---|---|
| 1 (H1) | Class check per predicate: `getSimplePathId(ps.path) ∈ containsPreds` and `ps.valueShape`. Delete semantics unchanged. |
| 2 (H2) | `deleteAll` / `delete().where()` get the child blocks and the cascade, rooted at `?a0`, each block led by the type triple. |
| 3 (M1) | Minor, with a "Behaviour changes" section in the changeset. |
| 4 (M2) | Seven live cases (Gap 4 list); the CI failure mode stays with backlog 009. |
| 5 (M3) | `ownedPredicateGroup` requires a value shape. |
| 6 (L3, L4) | Comments and README as listed in Gap 6. |

## File changes

| File | Change |
|---|---|
| `src/sparql/irToAlgebra.ts` | Export `collectContainment` (read-only use by the class check). `bulkDeleteUnion` gains the owned blocks. Comments (Gap 6). |
| `src/sparql/ownedLinkCheck.ts` | `buildRule` uses the predicate rule; the message names the shared predicate when the property itself is not `contains`. |
| `src/shapes/singleOwnerConstraint.ts` | `ownedPredicateGroup` skips properties without a value shape. |
| `src/shapes/SHACL.ts` | `contains` doc. |
| `src/tests/owned-link-check.test.ts` | Unit and live tests for the predicate rule. |
| `src/tests/shacl-cascade.test.ts` | Bulk delete unit tests; live cases 1-6. |
| `src/tests/single-owner-constraint.test.ts` | Shape-less `contains` is not in the group. |
| `README.md`, `.changeset/owned-replace-noop-single-owner.md` | Gaps 2, 3 and 6. |

## Contracts

### C8 — class check rule (`ownedLinkCheck.ts`)

A field is checked when **all** hold: its property shape has a simple path whose predicate is in
`collectContainment().containsPreds`; it declares a `valueShape`; that value shape's targetClass
resolves. `OwnedLink` gains one optional field:

```ts
/** Set when the property is not `contains` itself but shares this `contains` predicate. */
sharedPredicate?: string;
```

The message for such a link says why the property owns its value:

```
Cannot link <…/alice> into the property "img" of <…/ROther>, whose predicate <ex:img> is a
contains predicate (another shape owns its values through it): it is typed <…/Person>, but
"img" only owns instances of <…/Image>. …
```

### C9 — bulk delete (`deleteAllToAlgebra`, `deleteWhereToAlgebra`)

For a shape with a `contains` property (`shapeHasContainsProperty`), e.g. `DeleteBuilder.from(TCard).all()`:

```sparql
DELETE { ?a0 ?p ?o . ?d0 ?d0_p ?d0_o . ?d1 ?d1_p ?d1_o . ?c_own0 ?c_op0 ?c_ov0 . … }
WHERE { ?a0 rdf:type <TCard> .
  { ?a0 ?p ?o . }
  UNION { …blank-node blocks (unchanged)… }
  UNION { ?a0 rdf:type <TCard> . ?a0 <holds> ?d0 . ?d0 ?d0_p ?d0_o . }
  UNION { ?a0 rdf:type <TCard> . ?a0 <cells> ?d1 . ?d1 ?d1_p ?d1_o . }
  UNION { ?a0 rdf:type <TCard> . ?a0 (c1|c2|…)* ?c_own0 . ?c_own0 rdf:type <Dep0> . ?c_own0 ?c_op0 ?c_ov0 . }
  UNION … }
```

`delete().where()` has the same UNION, joined with the filtered pattern as the blank-node UNION
already is. A shape without a `contains` property emits exactly today's SPARQL.

### C10 — single-owner group

`ownedPredicateGroup(nodeShape)` = the sorted simple-path predicates of the flattened properties
with `contains` **and** a `valueShape`.

---

# Iteration 1 — Phases

Phases 7-12, in order, one commit each. 7, 8 and 9 touch different files and could run in
parallel; they are run in sequence here because they share the test runs.

## Phase 7 — Class check per predicate (Gap 1, C8)

Tasks: export `collectContainment`; `buildRule` uses the predicate rule and fills
`sharedPredicate`; message per C8.

Tests (`owned-link-check.test.ts`): a fixture `TScrapbook` with a plain (non-`contains`)
`ex:cover` property of shape TPhoto, and a plain shape-less property on a `contains` predicate.
- collect: the plain `cover` link is collected with `sharedPredicate = ex:cover`; the shape-less
  one is not;
- stub dataset: linking alice into `TScrapbook.cover` rejects with the C8 message; 0 updates;
- live (Gap 4 case 7): the same update through `FusekiStore` rejects and writes no edge.

Validation: the targeted jest file passes with `[ensureFuseki] Fuseki is ready`; typecheck exit 0.

### Phase 7 status: done

Built as planned: `collectContainment` is exported from `irToAlgebra.ts`; `buildRule` checks a
field when its simple-path predicate is in `containsPreds` and it declares a value shape, and sets
`sharedPredicate` when the property is not `contains` itself; the message follows C8.

Validation (2026-10-12):
- `owned-link-check.test.ts`: `[ensureFuseki] Fuseki is ready`; 17 passed (4 new: collect by the
  predicate rule, the check and the replace delete agree, stub refusal with the C8 message, live
  refusal). The new live test was proven to run with a temporary `throw` after its guard, removed
  afterwards.
- `sparql-fuseki`, `sparql-fuseki-shape-sync`, `shacl-cascade`: 3 suites, 132 passed, 1 skipped.
- `npm run typecheck`: exit 0.

Deviations: none. The extra test "the check and the replace delete agree" pins the two rules
against each other (the replace through `TScrapbook.cover` self-deletes; the shape-less
`TLooseBook.cover` neither self-deletes nor is checked).

## Phase 8 — Bulk deletes delete owned children (Gap 2, C9)

Tasks: `bulkDeleteUnion` adds the child blocks and the cascade blocks (type-triple-led) for a
shape with a `contains` property; both bulk paths use it.

Tests (`shacl-cascade.test.ts`):
- unit: `TCard.all()` has a `#holds> ?d0 . ?d0 ?d0_p ?d0_o` and a `#cells> ?d1` branch, each led by
  the type triple, no `OPTIONAL`; `TBox.all()` has the cascade `)* ?c_own`; `TSlot.all()` has no
  `?d` block; `where()` has the same blocks; a shape without `contains` is unchanged (existing
  `mutation-where-union` assertions);
- live (Gap 4 case 6): `TCard.all()` deletes both cards and their held/cells children and keeps an
  unowned TPlainCell; `TBox.where(...)`/`all()` deletes the dependent chain; `where()` deletes only
  the matched subject's children.

Validation: targeted `shacl-cascade`, `mutation-where-union`, `sparql-mutation-golden`,
`sparql-mutation-algebra` pass with Fuseki confirmed; typecheck exit 0.

### Phase 8 status: done

Built as planned: `bulkDeleteUnion` takes the type triple and, for a shape with a `contains`
property, adds one `?a0 rdf:type <S> . ?a0 <p> ?dN . ?dN ?dN_p ?dN_o` block per
`ownedValueShapePredicates` predicate and the `buildOwnedCascade(?a0, 'c_', typeTriple)` blocks.
`deleteAllToAlgebra` and `deleteWhereToAlgebra` both use it; a shape without `contains` emits
the same SPARQL as before (no golden or `mutation-where-union` string changed).

Validation (2026-10-12):
- `shacl-cascade`, `mutation-where-union`, `sparql-mutation-golden`, `sparql-mutation-algebra`:
  `[ensureFuseki] Fuseki is ready`; 4 suites, 101 passed. New in `shacl-cascade`: 3 unit
  (deleteAll blocks, dependent cascade and shape-less slot, `where()`), 3 live (deleteAll of
  cards with children and an unowned node, deleteAll into a dependent chain, `where()` deletes
  only the matched card's child). The 3 live tests were proven to run with a temporary `throw`
  (3 failures), removed afterwards.
- `npm run typecheck`: exit 0.

Deviation (fixture only): `TCard` gains a `title` literal so that `where()` has something to
match on.

## Phase 9 — Single-owner group requires a value shape (Gap 5, C10)

Tasks: filter in `ownedPredicateGroup`; doc comment.

Tests (`single-owner-constraint.test.ts`): a shape with a shape-less `contains` property and one
with a shape → the group holds only the latter; a shape with only a shape-less `contains` → `null`.

Validation: `single-owner-constraint`, `shacl-syncshapes`, `sparql-fuseki-shape-sync` pass; typecheck.

### Phase 9 status: done

Built as planned: `ownedPredicateGroup` skips `contains` properties without a `valueShape`; its
doc comment says why. README: the single-owner paragraph says the group holds `contains`
properties that declare a `shape`. The turtle example is unchanged (both of its properties
declare a shape).

Validation (2026-10-12):
- `single-owner-constraint`, `shacl-syncshapes`, `sparql-fuseki-shape-sync`,
  `shape-wire-idempotence`: `[ensureFuseki] Fuseki is ready`; 4 suites, 40 passed, 1 skipped (the
  SHACL endpoint `test.skip`). New: `shape-less contains is skipped` (fixtures `Folder` with a
  shape-less and a shaped `contains` property → only `schema:image`; `LooseFolder` with only a
  shape-less one → empty group and `null` data).
- `npm run typecheck`: exit 0.

Deviations: none.

## Phase 10 — Live negative tests (Gap 4, cases 1-5)

Tests (`shacl-cascade.test.ts`, live block):
1. set-remove of an id card1 does not own (card2 owns it) → the node and card2's edge survive;
2. `TBox.owns` re-sent as the current id with a dependent `next` chain → every cell survives;
3. upsert with the current id → the node survives;
4. `forAll()` and `where()` with the current id → the kept node survives, other cards' old values
   are deleted;
5. two owners point at one node, delete one owner → the node's own triples are deleted; the other
   owner's edge stays and dangles (A5). Documented in README.

Validation: the targeted file passes; every live test gets past its guard (temporary `throw`
proof, removed afterwards).

### Phase 10 status: done

Added the five live cases to the backlog-032 live block of `shacl-cascade.test.ts`:
1. set-remove of `x`, owned by card2, through card1: `x` keeps its 2 triples and card2's edge;
   card1's own cell is untouched;
2. `TBox.owns` re-sent as the current `cell0` with a dependent `next` chain: every cell keeps its
   triples;
3. upsert with the current id: the node keeps its triples;
4. `forAll()` with the current id: the kept node survives, card2's old value is deleted and both
   cards hold the kept node; `where(title = 'x')`: only card1 is touched, card2 and its value are
   unchanged;
5. two owners of one node (a stolen `{id}`), delete one owner by id: the node's own triples are
   deleted; the other owner's edge stays and dangles (A5). The README records this in Phase 11.

Validation (2026-10-12):
- `shacl-cascade.test.ts`: `[ensureFuseki] Fuseki is ready`; 40 passed. The 5 new tests were
  proven to run with a temporary `throw` after their guard (5 failures), removed afterwards.
- `npm run typecheck`: exit 0.

Deviations: none. No code change was needed: every case behaved as the plan expected.

## Phase 11 — Comments and README (Gap 6)

Tasks: the comment updates and README additions of Gap 6, plus the two-owner result of Phase 10.

Validation: `grep` shows no `(c1|c2|…)+` left in `irToAlgebra.ts`; README section reads
consistently with C8, C9 and C10; `npx linked build` exits 0.

### Phase 11 status: done

- `irToAlgebra.ts`: the owned-subtree section comment says `(c1|c2|…)*` and states which rule
  each path uses (predicate rule for replace, set-remove and the class check; the deleted
  shape's own shaped `contains` properties for subject deletes). `buildOwnedSelfDelete`
  documents `keep` and that callers skip it for shape-less properties. `deleteToAlgebra`
  documents the immediate-child blocks and points at `bulkDeleteUnion`; `deleteAllToAlgebra` and
  `deleteWhereToAlgebra` document the owned cleanup.
- `SHACL.ts` `contains`: the predicate rule, the replace/remove/delete behaviour with and
  without a `shape`, the class check and the generated single-owner shape.
- README "Owned properties": bulk deletes delete owned children (and do not delete incoming
  references); the class check's predicate rule; the unregistered-subclass refusal and its fix;
  the limits (typed later, typed between the `SELECT` and the `UPDATE`, raw SPARQL); the
  shape-less `contains` slot leaving a non-dependent old value in place; the two-owner result
  from Phase 10.

Validation (2026-10-12): `grep ")+" src/sparql/irToAlgebra.ts` finds no cascade path comment;
`npx linked build`: Build successful. Comment and doc changes only (no test run needed beyond the
build; the full suite runs in Phase 12).

Deviations: none.

## Phase 12 — Changeset "Behaviour changes" (Gap 3)

Tasks: rewrite `.changeset/owned-replace-noop-single-owner.md` (still minor) with the section.

Validation: full `npm test` exits 0 with Fuseki confirmed; `npx linked build` exits 0; the test
container is stopped afterwards (:3030 untouched).

### Phase 12 status: done

`.changeset/owned-replace-noop-single-owner.md` stays `minor` (rationale in Gap 3). Its summary
now covers bulk deletes and the predicate rule, and a **Behaviour changes** section names the
three changes: deletes (by id and bulk) delete owned children, with `Thing.image` and shared
images as the example; linked `{id}`s are class-checked, with the unregistered-subclass case and
its fix (register a shape for the subclass, or declare `sh:class`); shape-less `contains`
properties leave a non-dependent old value in place.

Validation (2026-10-12):
- `npm test` (jest + typecheck): exit 0. `[ensureFuseki] Fuseki is ready`; 96 suites passed,
  4 skipped; 2178 tests passed, 121 skipped (16 more passing than the review run's 2162; the
  skipped count is unchanged).
- `npx linked build`: Build successful.
- The :3939 test container was stopped (`docker compose -f src/tests/docker-compose.test.yml
  down`); :3030 was not touched.

Deviations: none.

## Iteration 1 — open follow-ups (for the lead developer)

- Whether ownership should become per property everywhere (Gap 1 option (b)), including the
  cascade and `collectContainment`.
- The subject deletes use the deleted shape's own `contains` properties, the replace uses the
  predicate rule (Gap 1, remaining asymmetry; the safe direction).
- Bulk deletes do not delete incoming references, unlike the delete by id (pre-existing).
- L1 (sync deletes any NodeShape at `<iri>.singleOwner`) and L2 (four non-atomic updates per
  shape) from the Review.
- Live suites still return silently without Fuseki outside `CI` handling (backlog 009).

---

# Review (iteration 1)

Reviewed 2026-10-12: `git diff a906af7..HEAD` (df98528..e323c30), checked against C8-C10 and the
first review's findings. The evidence includes a throwaway live probe against the test Fuseki
(deleted afterwards).
- 20,000 `ROwner` subjects, each with an owned non-dependent image and an owned dependent node.
- 20,000 unrelated `Other` subjects that link their own images through the same `contains`
  predicate.

## Test run

- `npm test`: `[ensureFuseki] Fuseki is ready`. 96 suites passed and 4 skipped (type-only); 2178
  tests passed and 121 skipped. Typecheck exit 0, `EXIT=0`. The :3939 container was stopped
  afterwards; :3030 was not touched.

## Status of earlier findings

| Finding | Status | Evidence |
|---|---|---|
| H1 check vs delete rule | **Resolved** | `ownedLinkCheck.ts:117-120` uses `collectContainment().containsPreds` plus the value shape, the same rule as `irToAlgebra.ts:1971-1976`. Unit test "the check and the replace delete agree…", plus a live refusal test. |
| H2 bulk deletes | **Resolved** | `bulkDeleteUnion` (`irToAlgebra.ts:2774-2799`). See the live probe below. |
| M1 changeset | **Resolved** | A "Behaviour changes" block names `Thing.image`, the subclass refusal and the shape-less orphans. The changeset is still a `minor`; that is the lead developer's call. |
| M2 live negatives | **Mostly resolved** | Live tests now cover the unowned set-remove, a kept subtree, upsert, forAll/where and two owners. The 14 live tests in `shacl-cascade.test.ts` still `return` silently without Fuseki (listed as a follow-up). |
| M3 group | **Resolved** | `singleOwnerConstraint.ts:53` requires `ps.valueShape`, with a test. |
| L1, L2 | Open | Listed as follow-ups. |
| L3 | Resolved | It is documented in the README. |
| L4 stale comments | **Resolved** | The cascade header, the `buildOwnedSelfDelete`, `deleteToAlgebra` and `deleteAll` docstrings, and `SHACL.ts` `contains` are all updated. |

## Live probe (bulk delete scope and cost)

- **`delete().where(name = 'n7')`** took 21 ms. It deleted exactly one owner, its image and its
  dependent node. Afterwards there were 19,999 owners, 39,999 images and 19,999 dependents. The
  filter scopes the owned blocks correctly.
- **`deleteAll()`** deleted all owners, their images and their dependents. The 20,000 `Other`
  subjects and their 20,000 images survived, and the remaining 60,000 triples are exactly those.
  Nothing outside the matched subjects was deleted. Each owned branch is led by `?a0 rdf:type`,
  so `?a0 (c…)*` is never evaluated with both ends unbound.
- **Cost:** 2.5 s for the new `deleteAll`, against 0.5 s for the old root-only form on the same
  data. That is about 5× for 20k subjects with 4 dependent types.

## Findings

### Critical / High

None found. I found no regression that deletes more than intended.

### Medium

**M4. Bulk delete cost grows with subject count × (owned predicates + dependent types).**
(`irToAlgebra.ts:2783-2796`)
- Every bulk delete of a shape that owns anything now runs one property-path closure per subject
  per dependent type. Through `Thing.image`, that is every schema-derived shape.
- Measured at about 5× (0.5 s → 2.5 s) for 20k subjects. Large CN `deleteAll`/`where` calls, such
  as a project reset, will slow down by a similar factor.
- **Fix:** emit the dependent-cascade blocks only when a dependent type is actually reachable
  from the shape's own `contains` value shapes, rather than from every registered dependent type.
  Alternatively, record the cost in the README.

### Low

**L7. The asymmetry is still open, in the safe direction.**
- Subject deletes use the deleted shape's own `contains` properties
  (`ownedValueShapePredicates`).
- Replace and the class check use the predicate rule.
- So a plain property that shares a `contains` predicate deletes its value on replace, but not
  when its subject is deleted.
- **Fix:** decide this with the per-property follow-up, and document the difference in the README
  "What a delete removes" paragraph meanwhile.

**L8. The predicate rule now class-checks plain properties in other packages.**
(`ownedLinkCheck.ts:120`)
- For example, a CN project shape that declares `schema:image` without `contains`.
- This is intended. However, a project shape whose value shape is a class that the linked nodes
  are typed with only through an unregistered subclass is now refused where it was accepted.
- **Fix:** add one sentence to the changeset that the check applies to non-`contains` properties
  on a `contains` predicate.

**L9. Live suites still pass silently without Fuseki** (14 `if (!fusekiAvailable) return;` in
`shacl-cascade.test.ts`, backlog 009). **Fix:** throw when `process.env.CI` is set.

### New issues

Only M4, L7 and L8 are new; L9 is the unresolved part of M2.
- `ownedLinkCheck.ts` → `irToAlgebra.ts` adds an import edge but no cycle.
- The owned and cascade variables (`d{n}`, `c_*`) do not collide with blank-node (`bn{n}`,
  `p{n}`, `o{n}`) or where-clause (`a{n}_…`) variables.

---

# Iteration 2 — Ideation

Source: [Review (iteration 1)](#review-iteration-1) (M4, L7, L8). Approaches chosen by the lead
developer (2026-10-12). L9 (silent live suites, backlog 009) stays a follow-up.

## Gap 1 of 3 — Bulk delete cost grows with every registered dependent type (M4)

**Context.** `bulkDeleteUnion` and `deleteToAlgebra` call `buildOwnedCascade`, which emits one
block per dependent type in the *whole registry* (4 in a process with core's PropertyShape, List
and PathNode plus one app type). Each block is a property-path closure per subject. Baseline,
measured again on the iteration-1 code with a scratch probe (20,000 owners, each with an owned
image, plus 20,000 unrelated subjects linking their own images through the same predicate):

| Shape | Cascade blocks | Root-only DELETE | `deleteAll` (2 runs) |
|---|---|---|---|
| `ROwner` (image + dependent node) | 4 | 552 ms | 2194 / 1854 ms |
| `RImgOnly` (image only) | 4 | 197 ms | 1256 / 1219 ms |

The by-id delete has the same fan-out: one cascade block per id per registered dependent type.

**Approaches.**
- **(a) Emit only the dependent types reachable from the deleted shape.** Walk from the shape (and
  its registered sub-shapes) through every property on a `contains` predicate to its value shape
  and that shape's sub-shapes, transitively; collect the `dependent` targetClasses met. A property
  on a `contains` predicate **without** a value shape is polymorphic and could reach anything, so
  it keeps every dependent type (this keeps the shape-sync delete exact: `PropertyShape.path`).
  - Pro: a shape that reaches no dependent type (every `Thing.image` owner) emits exactly the
    pre-iteration-1 bulk SPARQL plus the child blocks; no closure at all.
  - Pro: no change for shape sync, whose NodeShape delete reaches a shape-less slot.
  - Con: data whose edges are not described by the reached shapes (a `contains` predicate used on
    a node whose shape does not declare it) is no longer cascaded from a bulk or by-id delete.
    Accepted: the cascade is shape-driven everywhere else, and the replace path is unchanged.
- (b) Document the cost in the README. Pro: no code. Con: every schema-derived bulk delete stays ~5×
  slower than needed.
- (c) One closure block with `VALUES ?type { … }` for all dependent types. Pro: one path
  evaluation. Con: it changes the solution shape of every cascade and the shape-sync delete, and
  still pays for the closure when nothing is reachable.

**Chosen: (a)**, for bulk and by-id deletes. The replace/remove cascade is not narrowed (it runs
for one old value, not per subject).

## Gap 2 of 3 — The changeset does not say plain properties are now checked (L8)

**Chosen:** add a Behaviour-changes bullet: a property *without* `contains` on a predicate that is
`contains` anywhere in the registry (a CN project shape that declares `schema:image` plainly) is
class-checked too, and how to resolve a refusal (link a node of the value shape's class or a
registered sub-shape's class, register a shape for the subclass, declare `sh:class`, or use a
predicate that no shape owns).

## Gap 3 of 3 — The README does not state the delete/replace rule difference (L7)

**Chosen:** the README "What a delete removes" paragraph says that subject deletes use the
deleted shape's *own* `contains` properties, whereas replace and the class check use the
registry-wide predicate rule; a plain property on a `contains` predicate therefore deletes its
old value on replace but not when its subject is deleted. Whether ownership should be per
property everywhere is an open design question.

---

# Iteration 2 — Plan

| Gap | Decision |
|---|---|
| 1 (M4) | Cascade blocks of subject deletes (bulk and by id) only for the dependent types reachable from the deleted shape (C11). |
| 2 (L8) | Changeset bullet on plain properties on `contains` predicates. |
| 3 (L7) | README sentence on the delete versus replace rule. |

## Contracts

### C11 — reachable dependent types (`irToAlgebra.ts`)

```ts
/** The dependent targetClasses a delete of `shapeId` can reach, in `collectContainment` order. */
function reachableDependentTypes(shapeId: string): string[];

export function buildOwnedCascade(
  rootTerm, varPrefix, anchor?, keep?,
  dependentTypes?: string[],   // NEW: restrict the blocks to these types (default: all)
);
```

- Start: the shape and its registered sub-shapes. Edge: a flattened property whose simple path is
  in `containsPreds`. With a value shape, visit it and its sub-shapes; without one, return every
  dependent type. Collect the `dependent` shapes' targetClasses. Memoized per shape on the
  registry version.
- `deleteToAlgebra` and `bulkDeleteUnion` pass the result; an empty result emits no cascade block.
- Variable names stay `c_own{i}` with `i` the index in the narrowed list.

Files: `src/sparql/irToAlgebra.ts`, `src/tests/shacl-cascade.test.ts`,
`.changeset/owned-replace-noop-single-owner.md`, `README.md`.

---

# Iteration 2 — Phases

## Phase 13 — Narrow the subject-delete cascade (Gap 1, C11)

Tests (`shacl-cascade.test.ts`):
- `TCard` (owns non-dependent `TPlainCell`) by id and `all()`: no `?c_own` block; child blocks stay;
- `TBox` (owns dependent `TCell`): exactly one cascade block, for `TCell`;
- `TSlot` (shape-less `contains`): every dependent type;
- `NodeShape` delete (shape sync): every dependent type, unchanged;
- existing live tests (delete WHERE size, bulk and by-id deletes) unchanged.

Validation: targeted `shacl-cascade`, `mutation-where-union`, `sparql-mutation-golden`,
`sparql-fuseki-shape-sync`, `shacl-syncshapes` pass with Fuseki confirmed; typecheck. The scratch
20k probe is re-run for timings and correctness, then deleted.

## Phase 14 — Changeset and README (Gaps 2, 3)

Validation: full `npm test` exits 0 with Fuseki confirmed; `npx linked build` exits 0; :3939
stopped, :3030 untouched.

### Phase 13 status: done

Built per C11: `reachableDependentTypes(shapeId)` (memoized on the registry version) and an
`onlyTypes` parameter on `buildOwnedCascade`; `deleteToAlgebra` and `bulkDeleteUnion` pass the
reachable types and emit no cascade block when there are none. The by-id delete had the same
fan-out (one block per id per registered dependent type) and is narrowed the same way.

Validation (2026-10-12):
- Targeted (`shacl-cascade`, `mutation-where-union`, `sparql-mutation-golden`,
  `sparql-mutation-algebra`, `sparql-fuseki-shape-sync`, `shacl-syncshapes`, `owned-link-check`):
  `[ensureFuseki] Fuseki is ready`; 148 passed, 1 skipped. New test "subject-delete cascade: only
  reachable dependent types" (TCard none; TBox/TBag only TCell; TCell into itself; TSlot and the
  shape-sync `NodeShape` delete every type). Two iteration-1 assertions changed deliberately:
  TCard `all()`/`where()` now have no `?c_own` block; the type-triple-led cascade is asserted on
  TBox instead. No live count changed (the "delete WHERE size" count is the same).
- `npm run typecheck`: exit 0.
- Scratch probe (20,000 owners with an owned image, plus 20,000 unrelated `Other` subjects with
  their own images on the same predicate; deleted afterwards):

  | Shape | Cascade blocks before → after | Root-only | `deleteAll` before | `deleteAll` after |
  |---|---|---|---|---|
  | `ROwner` (image + dependent node) | 4 → 1 | 571 ms | 2194 / 1854 ms | 1367 / 913 ms |
  | `RImgOnly` (image only) | 4 → 0 | 196 ms | 1256 / 1219 ms | 374 / 359 ms |

  Correctness is unchanged in both runs: every owner, its image and its dependent node deleted;
  the 20,000 `Other` subjects and their images survive (exactly 60,000 triples left);
  `where(n7)` deletes one owner and its image only (4–8 ms).

Deviation: a dependent start shape counts as reachable only when an owned edge leads back to it
(TCell `next` → TCell), so a TCell delete still cascades its chain.

### Phase 14 status: done

- Changeset: a Behaviour-changes bullet says plain properties on a predicate that is `contains`
  anywhere in the registry (a project shape declaring `schema:image` without `contains`) are
  class-checked too, and lists how to resolve a refusal.
- README "What a delete removes": subject deletes use the deleted shape's own `contains`
  properties, replace/set-remove/class check use the registry-wide predicate rule; per-property
  ownership is an open design question; the cascade only covers reachable dependent shapes.

Validation (2026-10-12):
- `npm test` (jest + typecheck): exit 0. `[ensureFuseki] Fuseki is ready`; 96 suites passed,
  4 skipped; 2179 tests passed, 121 skipped.
- `npx linked build`: Build successful.
- :3939 test container stopped; :3030 not touched.

Deviations: none.

---

# Review (iteration 2)

Reviewed 2026-10-12: `git diff 04212d3..HEAD` (c0f116d, a02b388, ee6ea1b).

## Test run

- `npm test`: `[ensureFuseki] Fuseki is ready`. 96 suites passed and 4 skipped (type-only); 2179
  tests passed and 121 skipped. `EXIT=0`. :3939 was stopped afterwards and :3030 was untouched.

## Is the cascade narrowing a regression against `main`?

`reachableDependentTypes` (`irToAlgebra.ts:2491`) starts at the deleted shape and its sub-shapes.
It follows each flattened property on a `contains` predicate to that property's value shape and
the value shape's sub-shapes. A shape-less property sets `everything` and keeps every dependent
type.

Callers I checked:
- **Shape sync and the meta-model are unchanged.**
  - `NodeShape` → `sh:property` → `PropertyShape` → `sh:path` (shape-less) gives every type. The
    unit test asserts that `NodeShape` and `PropertyShape` deletes keep every dependent type.
  - `PathNode` has shape-less `contains` slots, so it also gets every type.
  - `List` → `rdf:rest` → `List` gives `rdf:List`. On `main` a List spine reaches only Lists,
    because `rdf:first` is not `contains`. No change.
  - The generated `.singleOwner` delete is a NodeShape delete, so every type.
- **CN.** The only dependent shapes in CN's registry are core's (PropertyShape, List, PathNode).
  CN declares no `contains` of its own and no `dependent` shape.
  - Its deletes of shaped data are `Shape.delete({id})` (Conversation, Bookmark, Project,
    Application, …), `DeleteBuilder.from(shapeIri, id)` (`InstanceProvider.ts:326`) and
    `OntologyPropertyShape.delete` (`OntologyQueryService.ts:559,768,826`, no `contains`, so no
    cascade on `main` either).
  - The Thing-derived shapes own only `ImageObject`, which is not dependent. On `main` their
    cascade could only match if such an entity carried `sh:property`, `sh:path`, `sh:in`,
    `rdf:rest` or `sh:*Path` edges, i.e. if the entity were itself a SHACL or list node.
  - Shapes are written through core's `NodeShape` (shape sync), so I found no such data path.
- **Quantified:** no existing caller relied on undeclared edges. The behaviour is lost only for
  data that the shapes do not describe. Both cases are hypothetical:
  - an instance with a `contains`-predicate edge that none of the reached shapes declare;
  - a dependent shape that shares the targetClass of a non-dependent value shape without
    extending it (dependent types are matched by targetClass).
  - No test on `main` changed expectations except the bulk-delete tests, which now assert *no*
    closure for `TCard`.

## Status of earlier findings

| Finding | Status |
|---|---|
| M4 bulk-delete cost | **Resolved** for the common case: a shape owning only non-dependent values (every `Thing.image` owner) emits no closure block, as the `TCard` assertions show. Shapes that reach dependents still pay per reachable type, which is required. |
| L7 asymmetry | **Documented** accurately (README "Subject deletes and replaces decide ownership differently"); still an open design question. |
| L8 plain properties checked | **Resolved**: the changeset bullet names the `schema:image` / `Thing.image` case and four ways out. Accurate against `ownedLinkCheck.ts:117-120`. |
| L9 silent live suites | Open (follow-up). |
| L1, L2 | Open (follow-ups). |
| H1, H2, M1-M3, L3, L4 | Remain resolved. |

## New findings

### Critical / High / Medium

None.

### Low

**L10. The narrowing trusts the shapes over the data.**
- Dependent nodes reached only through undeclared `contains` edges, or typed with a dependent
  class that the value shape does not extend, are no longer cascaded; they orphan rather than
  being deleted. That is the safe direction.
- The code comment notes it (`irToAlgebra.ts:2480-2489`), but the README sentence does not.
- **Fix:** add "only through the properties the shapes declare" to that README sentence.

**L11. `reachableCache` is a second registry-version cache next to `containmentCache`.**
- Both are invalidated by the same `getRegistryVersion()`, so they cannot disagree, but the
  pattern is duplicated.
- **Fix (optional):** fold both into one memo keyed on the version.

---

# Iteration 3 — Ideation

The lead developer changed Decisions 1 and 2 (2026-10-12). L10 was addressed by the lead in the
README (7f1660e). L1 and L2 are taken up here because the sync lifecycle changes anyway.

## Gap 1 of 1 — Single-owner constraint per accessor

**Context.** Decisions 1-2 generate one constraint per declaring shape, grouping its own *and
inherited* `contains` predicates in one `sh:alternativePath`.
- Grouping only adds value when one node is the value of two owned predicates. That requires
  overlapping value shapes, which is rare, and a wrongly typed link is now refused by the class
  check (Decision 7).
- Grouping over the flattened properties duplicates the constraint in every subclass:
  `Thing.image` yields one generated shape for each of the hundreds of schema shapes that
  inherit it.
- The grouping was partial anyway: it never crosses classes or packages (Decision 2's accepted
  limitation).

**Approaches.**
- (a) Keep per-shape grouping, but only over own properties. Still one constraint per declaring
  shape, but a shape with two owned properties keeps the alternative path. Con: the IRI depends on
  the shape, not the property, so renaming one accessor churns the other's constraint.
- **(b) One constraint per declared `contains` property** (own properties only, with a value
  shape and a simple path), at the property shape's IRI plus `.singleOwner`, with a plain
  `sh:inversePath p`.
  - Pro: one constraint per accessor, written once by the class that declares it; subclasses add
    nothing.
  - Pro: the simplest SHACL (no alternative path, no list).
  - Con: cross-predicate double ownership (one node owned through `p1` by A and through `p2` by B)
    is not caught. Documented limitation.

**Chosen: (b)** (lead developer).

**Sync lifecycle.**
- The declaring shape's thunk deletes and re-creates its generated shapes. Old ones are found by
  one SELECT of the `core:generated true` NodeShapes, filtered to IRIs under `${shapeIri}/`, so a
  removed or renamed accessor's constraint is cleaned up. Only shapes the store marks
  `core:generated` are deleted, which resolves **L1** (a hand-written NodeShape at a generated
  IRI is no longer deleted).
- Pruning: generated IRIs of in-code shapes are in `localShapeIris` ('all' never prunes them);
  for 'ownedNamespaces' a generated IRI's namespace is its declaring shape's namespace.
- Collision check: throw when a registered shape IRI equals one of the generated IRIs.

**L2 (one SPARQL request per shape).** Not done. `IDataset` exposes only DSL-level
`selectQuery`/`createQuery`/`updateQuery`/`deleteQuery`, with no batch or raw-update entry
point. Joining the steps with `;` would mean lowering the builders to SPARQL inside
`syncShapes` and sending them past the dataset, which breaks routing (`LinkedStorage`), the
`BackendAPIStore` forwarding and every non-SPARQL dataset. Instead the thunk no longer issues an
unconditional generated delete: the delete runs only when the SELECT finds generated shapes. The
cost per shape is SELECT + delete + create (+ one delete and one create per generated shape).
Recorded as a follow-up: an optional `IDataset.batch` would allow one request.

---

# Iteration 3 — Plan

## Contracts

### C12 — per-accessor constraint (`src/shapes/singleOwnerConstraint.ts`)

```ts
/** `${propertyShapeIri}.singleOwner`. */
export function singleOwnerShapeIri(propertyShapeIri: string): string;
/** The shape's OWN `contains` properties with a value shape and a simple path. */
export function singleOwnerProperties(nodeShape: NodeShapeData): PropertyShapeData[];
/** One `{iri, data}` per such property; the property shape IRI is `${shapeIri}/${label}`, as sync writes it. */
export function buildSingleOwnerConstraints(
  nodeShape: NodeShapeData, shapeIri: string,
): Array<{iri: string; data: Record<string, unknown>}>;
```

`ownedPredicateGroup` and `buildSingleOwnerShapeData` are removed (unreleased). Data:
`{generated: true, targetObjectsOf: [{id: p}], properties: [{__id: `${gen}/owners`, label: 'owners', maxCount: 1, path: serializePathToNodeData({inv: {id: p}}, `${gen}/owners`)}]}`.

### C13 — persisted triples

```turtle
<…/Thing/image.singleOwner> a sh:NodeShape ; core:generated true ;
    sh:targetObjectsOf schema:image ; sh:property <…/Thing/image.singleOwner/owners> .
<…/Thing/image.singleOwner/owners> a sh:PropertyShape ; rdfs:label "owners" ; sh:maxCount 1 ;
    sh:path <…/Thing/image.singleOwner/owners/inv> .
<…/Thing/image.singleOwner/owners/inv> a core:PathNode ; sh:inversePath schema:image .
```

### C14 — sync thunk

SELECT generated NodeShapes → keep those under `${iri}/` → delete main → delete those (if any) →
create main → create each constraint.

Files: `singleOwnerConstraint.ts`, `syncShapes.ts`, `src/index.ts`, tests
(`single-owner-constraint`, `shacl-syncshapes`, `sparql-fuseki-shape-sync`), `README.md`,
changeset.

---

# Iteration 3 — Phases

## Phase 15 — Per-accessor constraint and sync lifecycle (C12, C14)

Unit tests: data for `Project.image` / `Project.attachments` (separate IRIs, plain inverse path);
`SubProject` and other subclasses produce none; shape-less and complex-path skipped; thunk plan
with a stub (select → deletes only generated under the prefix → creates); prune keeps generated
IRIs ('all') and treats a stale generated IRI by its declaring namespace ('ownedNamespaces');
collision throws.

Validation: `single-owner-constraint`, `shacl-syncshapes`, `shape-wire-idempotence`, `metadata`
pass; typecheck.

### Phase 15 status: done (Phases 15 and 16 in one commit)

Built per C12 and C14:
- `singleOwnerConstraint.ts`: `singleOwnerShapeIri(propertyShapeIri)`, `singleOwnerProperties`
  (own `contains` properties with a value shape and a simple path) and
  `buildSingleOwnerConstraints` (one `{iri, data}` per property, plain `sh:inversePath`).
  `ownedPredicateGroup` and `buildSingleOwnerShapeData` are removed; `src/index.ts` exports the
  new three.
- `syncShapes.ts`: the thunk runs SELECT of `core:generated true` NodeShapes (filtered to
  `${iri}/`) → delete main → delete those, only if any (one multi-id delete) → create main →
  create each constraint. `localShapeIris` holds every in-code generated IRI; `shapeNamespace`
  maps a `….singleOwner` IRI to its declaring shape's namespace for `'ownedNamespaces'`; the
  collision check compares each generated IRI with the registered shapes.
- **L1 resolved:** sync deletes only NodeShapes the store marks `core:generated`; a
  hand-written NodeShape at a generated-looking IRI survives (live test).
- **L2 not done** (see Iteration 3 Ideation): no batch entry point on `IDataset`. The
  unconditional generated delete is gone; a shape without stored generated shapes costs SELECT +
  delete + create.

Validation (2026-10-12):
- Unit: `single-owner-constraint` (12 tests, rewritten: IRIs, per-property data, subclass adds
  none, skips, thunk plan with stored generated shapes under and outside the prefix, prune 'all'
  and 'ownedNamespaces', collision), `shacl-syncshapes` (the exact delete lists lose the
  unconditional `.singleOwner` delete): 45 passed with `shape-wire-idempotence` and `metadata`.
- Live `sparql-fuseki-shape-sync`: 8 passed, 1 skipped (SHACL endpoint). New: persisted per
  accessor (C13 triples, no `sh:alternativePath`), subclass adds none, idempotent re-sync per
  constraint, removed accessor cleaned up while the kept one is unchanged, hand-written NodeShape
  survives. All 5 proven to run with a temporary `throw` (5 failures), removed afterwards.
- `npm test`: exit 0. `[ensureFuseki] Fuseki is ready`; 96 suites passed, 4 skipped; 2181 tests
  passed, 121 skipped. `npx linked build`: Build successful.

Deviation: the live tests (planned Phase 16) are in the same commit, so that no commit leaves
the live shape-sync suite red against the new IRIs. Phase 16 is therefore the docs phase;
Phase 17 is not used. Old per-shape `<Shape>.singleOwner` shapes written by earlier commits of
this unreleased branch are not cleaned up by the thunk (they are not under `${iri}/`); an
`'all'` prune removes them.

## Phase 16 — Live sync tests

`sparql-fuseki-shape-sync`: persisted per accessor (C13 triples); idempotent re-sync triple
count; a removed accessor's constraint is cleaned up and a kept one survives; a subclass adds no
constraint; a hand-written non-generated NodeShape at a generated-looking IRI survives (L1).

Validation: the suite passes with Fuseki confirmed; new live tests proven to run.

## Phase 17 — Docs (done as Phase 16, see the Phase 15 deviation)

README turtle and limitation sentence (cross-predicate double ownership), changeset text,
docstrings. Validation: `npm test` exits 0 with Fuseki confirmed; `npx linked build` exits 0;
:3939 stopped, :3030 untouched.

### Phase 16 status: done (docs)

- README "The single-owner constraint": one generated shape per shaped `contains` property,
  written by the declaring class only, at `<property shape IRI>.singleOwner`; the C13 turtle for
  `Thing.image`; the sync lifecycle (removed accessors cleaned up, only `core:generated` shapes
  deleted); the new exports; the limitation that ownership through two different `contains`
  predicates is not reported.
- Changeset: the single-owner paragraph describes the per-accessor constraint and its lifecycle.
- `SHACL.ts` `contains` doc: the per-property generated shape. `singleOwnerConstraint.ts` and
  `syncShapes.ts` docstrings were updated in Phase 15.

Validation (2026-10-12):
- `npm test`: exit 0. `[ensureFuseki] Fuseki is ready`; 96 suites passed, 4 skipped; 2181 tests
  passed, 121 skipped.
- `npx linked build`: Build successful.
- :3939 stopped; :3030 not touched.

Deviations: none beyond the phase renumbering recorded under Phase 15.

---

# Review (iteration 3)

Reviewed 2026-10-12: `git diff 847a43b..HEAD` (7f1660e, f5b0934, 3a2a169, dc7e9df).

## Test run

- `npm test`: `[ensureFuseki] Fuseki is ready`. 96 suites passed and 4 skipped (type-only); 2181
  tests passed and 121 skipped. `EXIT=0`. :3939 was stopped afterwards and :3030 was untouched.

## Data-deletion safety of the new select + delete

- **Only generated shapes are deleted.** `storedGeneratedShapes` (`syncShapes.ts:104-118`) selects
  `NodeShape where generated = true` and keeps the ids under `${iri}/`. A hand-written NodeShape
  is never selected.
- **Prefix matching across shapes.** `…/Project/` is not a prefix of `…/ProjectX/…`, because the
  trailing slash prevents it. Package slugs contain no `/` (`packageNameToSlug`, `SHACL.ts:57-63`).
  A shape name, however, is not validated (`getNodeShapeUri`, `SHACL.ts:734`), so
  `@linkedShape({name: 'Project/Sub'})` puts `Sub`'s constraints under `…/Project/` (L12).
- **Collisions** are checked per generated IRI against registered shapes. A property label is a JS
  accessor name with no `.`, so `${psIri}.singleOwner` cannot equal a real property shape IRI.
- **Pruning:**
  - `'all'` keeps the current generated IRIs (`localShapeIris`).
  - A stale generated shape of a removed accessor is deleted by its owner's thunk, and also by the
    prune thunk. The double delete is harmless.
  - `'ownedNamespaces'` maps `…/Thing/image.singleOwner` to `…/pkg/` through the suffix special
    case (`syncShapes.ts:197-206`).
  - `'none'` keeps a removed shape's constraints together with the shape itself, consistent with
    `main`.
- **Idempotence:** a re-sync selects, deletes and re-creates the same deterministic IRIs. The live
  tests cover re-sync and accessor removal.

## Status of earlier findings

| Finding | Status |
|---|---|
| L1 (sync deletes any NodeShape at the generated IRI) | **Resolved**: only `core:generated true` is deleted. |
| L2 (non-atomic, extra round trip) | **Worse**: see M5. |
| L10 | **Resolved** (7f1660e README). |
| L9, L11 | Open (follow-ups). |
| Others | Remain resolved. |

## Findings

### Critical / High

None. No path deletes a non-generated NodeShape or another package's shape.

### Medium

**M5. Sync cost regression.** (`syncShapes.ts:104-118,146-152`)
- Every shape now costs 1 SELECT, 1 DELETE and 1 CREATE, plus 1 DELETE when stale constraints
  exist and 1 CREATE per constraint. On `main` it was 2 requests.
- The SELECT has no IRI filter in SPARQL. Each thunk fetches every generated NodeShape in the
  dataset and filters in JS, so N shapes × G generated rows per sync.
- This applies to shapes without `contains` too.
- **Fix:** adopt the owned-constraint alternative below. Otherwise run one SELECT per
  `syncShapes` call and filter with `STRSTARTS` in SPARQL.

### Low

**L12. A shape name containing `/` breaks the prefix ownership.** The parent's sync deletes the
child's constraints. If the child's thunk ran first, those constraints stay missing until the
next sync. **Fix:** match `^${iri}/[^/]+\.singleOwner$`, or reject `/` in shape names.

**L13. Constraints are written in separate requests after the main create.** A crash leaves them
missing until the next sync, which heals it. **Fix:** the alternative below makes them atomic with
the main create.

**L14. The `shapeNamespace` special case keys on the `.singleOwner` string suffix**
(`syncShapes.ts:200-203`). It is harmless today. **Fix:** derive the namespace from the declaring
IRI when it is known.

## Verdict on the alternative: owned constraints via `core:generatedShape`

The proposal: add `NodeShape.generatedShape`, `contains: true`, value shape `NodeShape`. Create
the constraints nested in the main create, and delete them with the main shape.

**It is sound, and I recommend it.** Checked against the code:

1. **Delete removes everything in one request.**
   - `deleteToAlgebra` adds a Decision 5 one-hop block for every own `contains` property with a
     value shape. `generatedShape` qualifies, so each generated NodeShape's own triples go: type,
     `core:generated`, `sh:targetObjectsOf` and the `sh:property` edge.
   - The cascade for `NodeShape` already covers every dependent type, because it reaches
     `PropertyShape.path`, which is shape-less. Its path alternation includes the new predicate,
     so it reaches `…/owners` (PropertyShape, dependent) and `…/owners/inv` (PathNode, dependent).
   - `sh:inversePath schema:image` is a shape-less slot, and only dependent nodes are deleted, so
     the predicate IRI is never touched.
2. **Creation.** A nested create with `__id` is the same pipeline the property shapes already use.
   It is not a link, so the class check sends no SELECT.
3. **Single-owner rule.** `NodeShape` lives in `@_linked/core`, which sync skips, so no constraint
   is generated for `core:generatedShape` itself. The new predicate joins the registry-wide
   cascade alternation, which costs next to nothing.
4. **Pruning, the one requirement.** Generated shapes are still `a sh:NodeShape`. Prune must keep
   skipping them, either by keeping their IRIs in `localShapeIris` or by skipping
   `core:generated`. Otherwise `'all'` deletes them after every sync. A generated shape whose
   owner is pruned goes with the owner's cascade.
5. **CN catalog.** Generated shapes still have no `sh:targetClass`, so `projectShapeCatalog`
   drops them. Main NodeShapes gain a `core:generatedShape` edge. That is harmless unless a
   reader walks every object value of a NodeShape. Worth one CN check.
6. **SHACL semantics are unchanged.** Validators ignore the unknown predicate. The generated
   shapes stay standalone shapes, targeted with `sh:targetObjectsOf`.

**Outcome:**
- Back to 2 requests per shape, the same as `main`.
- No SELECT and no prefix matching, which removes M5, L12 and L14.
- Constraints are created atomically with the main shape (L13).
- A removed accessor's constraint disappears with the main delete.

Add a live test that asserts zero triples under `${psIri}.singleOwner` after a NodeShape delete.

---

# Iteration 4 — Ideation

Source: [Review (iteration 3)](#review-iteration-3) (M5, L12, L13, L14). The lead developer
adopted the reviewed alternative (2026-10-12).

## Gap 1 of 1 — Sync cost and fragility of separately managed generated shapes

**Context.** Iteration 3's thunk costs SELECT + DELETE + CREATE per shape, plus one DELETE when
stale constraints exist and one CREATE per constraint (M5; `main` costs 2). The SELECT fetches
every generated NodeShape and filters by IRI prefix in JS (M5), which a shape name containing
`/` defeats (L12). Constraints are created in separate requests after the main create (L13), and
`shapeNamespace` recognises them by the `.singleOwner` suffix (L14).

**Approaches.**
- (a) One SELECT per `syncShapes` call, filtered with `STRSTARTS` in SPARQL. Pro: small change.
  Con: still ≥3 requests per shape, still prefix ownership (L12), still non-atomic (L13).
- **(b) Owned constraints: `NodeShape.generatedShapes` → `core:generatedShape`**, `contains: true`,
  value shape `NodeShape`. The main shape owns its generated shapes.
  - Delete: the subject delete's one-hop block (Decision 5) deletes each generated NodeShape's own
    triples; the NodeShape cascade (every dependent type, via shape-less `PropertyShape.path`)
    follows the new predicate to `…/owners` (PropertyShape) and `…/owners/inv` (PathNode).
    `sh:inversePath schema:image` is a shape-less slot, so the predicate IRI is never touched.
  - Create: the constraints are nested under `generatedShapes` in the main create, with their
    fixed IRIs. A nested create is not a link, so the class check sends no SELECT.
  - Pro: 2 requests per shape again, as on `main`; atomic with the main shape (L13); no SELECT,
    no prefix matching (M5, L12); a removed accessor's constraint goes with the main delete; a
    removed shape's constraints go with its orphan delete through the cascade.
  - Con: one more meta-model predicate, which joins the registry-wide cascade alternation
    (negligible); main NodeShapes carry one more edge that catalog readers may see.
- **Chosen: (b).**

**Pruning.** Generated shapes are still `a sh:NodeShape`, so the orphan sweep reads them.
- Option 1: protect the IRIs derived from the in-code shapes' constraints (`localShapeIris`, as
  today, with no suffix recognition).
- Option 2: skip every NodeShape that is the object of a `core:generatedShape` edge whose subject
  is an in-code shape. Needs the edges, i.e. a richer read than the id-only SELECT.
- **Chosen: option 1.** It is a pure in-memory derivation from the same function that builds the
  constraints, needs no extra read, and is exactly the set the thunks write. A stale generated
  shape (removed accessor or removed shape) is not protected: its owner's delete cascades it, and
  `'all'` may also delete it directly, which is harmless. `'ownedNamespaces'` needs no special
  case (L14): an in-code generated IRI is protected, and a stale one goes with its owner.

**Single-owner constraint for `core:generatedShape` itself:** none. `NodeShape` is declared in
`@_linked/core`, which sync never materializes, so no generated shape is built for it.

**CN check (read-only, 2026-10-12).** `fetchShapeCatalog` (`src/utils/shapeCatalogQuery.ts`
L61-110) selects named NodeShape fields only (`label`, `targetClass`, …, `properties`), so it does
not see `generatedShapes`; generated shapes have no `sh:targetClass` and are dropped by
`projectShapeCatalog`. `PATH_STRUCTURE_QUERY` (L210) reads the path structure of every
`sh:path` in the store, including the generated `…/owners` paths; no catalog property shape
refers to them, so they are unused (already true since iteration 1). `shaclParser.ts` parses
Turtle text, not the store. No CN reader walks every value of a NodeShape. Nothing to change in
CN; the follow-up (explicit `core:generated` filter, Decision 8) stands.

---

# Iteration 4 — Plan

## Contracts

### C15 — meta-model

- `src/ontologies/linked-core.ts`: `generatedShape = ns('generatedShape')`.
- `src/utils/Package.ts`: `createPropertyShape({path: coreOntology.generatedShape, shape:
  NodeShape, contains: true}, 'generatedShapes', shacl.IRI, NodeShape)` (multi-valued), next to
  `targetObjectsOf` / `generated`.

### C16 — sync (`src/shapes/syncShapes.ts`)

- `buildNodeShapeData` adds `generatedShapes: buildSingleOwnerConstraints(...).map(({iri, data}) =>
  ({__id: iri, ...data}))` when non-empty.
- Thunk: `DeleteBuilder.from(NodeShape, {id: iri})` → `NodeShape.create(data).withId(iri)`.
  Exactly 2 requests.
- Removed: `storedGeneratedShapes`, prefix matching, the `.singleOwner` case in
  `shapeNamespace`. Kept: `localShapeIris` gets the in-code generated IRIs; the collision check.

### C17 — persisted triples

C13 plus `<…/Thing> core:generatedShape <…/Thing/image.singleOwner>`.

Files: `linked-core.ts`, `Package.ts`, `syncShapes.ts`, `singleOwnerConstraint.ts` (docs),
tests (`single-owner-constraint`, `shacl-syncshapes`, `sparql-fuseki-shape-sync`), `README.md`,
changeset.

---

# Iteration 4 — Phases

## Phase 18 — Owned generated shapes (C15-C17)

Unit: a SPARQL stub dataset records requests for `syncShape(Project, ds)()`: exactly 1 DELETE
and 1 INSERT, no SELECT (the nested create sends no class-check query); the INSERT contains
`core:generatedShape` edges to both constraint IRIs and their triples; the DELETE contains the
one-hop `generatedShape` block. Thunk plan with the dispatch mock: delete main, create main.
Prune: `'all'` and `'ownedNamespaces'` keep in-code generated IRIs.

Live: a NodeShape delete leaves zero triples under its generated shapes (`…singleOwner`,
`…/owners`, `…/owners/inv`) while `schema:image` and its label survive; re-sync idempotent;
removed accessor cleaned up; subclass adds none; hand-written NodeShape at a generated-looking
IRI survives; `'all'` and `'ownedNamespaces'` syncs keep in-code generated shapes.

Validation: targeted suites pass with Fuseki confirmed (new live tests proven to run);
typecheck; `npx linked build`.

### Phase 18 status: done

Built per C15-C17: `core:generatedShape` in `linked-core.ts`; `NodeShape.generatedShapes`
(`contains`, value shape NodeShape) in `Package.ts`; `buildNodeShapeData` nests the constraints
under `generatedShapes`; the thunk is delete main → create main. `storedGeneratedShapes`, the
prefix matching and the `.singleOwner` case in `shapeNamespace` are removed. Pruning protects the
in-code generated IRIs derived in memory (option 1).

Validation (2026-10-12):
- `single-owner-constraint` (11): thunk plan is delete + create; a recording `SparqlDataset`
  receives exactly 2 updates and 0 selects for `Project` (DELETE has the
  `<Project> core:generatedShape ?dN` block; INSERT has both edges, `sh:targetObjectsOf` and the
  `…/owners/inv` inverse path) and for `ImageObject` (no edge); `'all'` and `'ownedNamespaces'`
  keep the in-code generated IRI; `syncShape(NodeShape)` is refused (no constraint for the
  meta-model).
- `shacl-syncshapes`: unchanged expectations still hold (delete + create per shape).
- Live `sparql-fuseki-shape-sync` (12: 11 passed, 1 skipped): new — a NodeShape delete leaves 0
  triples under both generated shapes and under the shape's IRI, `schema:image`'s label and
  another shape's path to it survive; `'all'` and `'ownedNamespaces'` syncs keep both generated
  shapes; a live sync is 2 updates and 0 selects. The iteration-3 tests (persisted, subclass adds
  none, idempotent, removed accessor, hand-written NodeShape) pass unchanged. All 8 single-owner
  live tests proven to run with a temporary `throw` (8 failures), removed afterwards.
- `npm test`: exit 0. `[ensureFuseki] Fuseki is ready`; 96 suites passed, 4 skipped; 2183 tests
  passed, 121 skipped. `npx linked build`: Build successful.

Deviations: none. Shapes written by iterations 1-3 of this unreleased branch without the
`core:generatedShape` edge are not removed by a sync (only by an `'all'` prune, or by re-syncing
the same IRI, which re-links it).

## Phase 19 — Docs

README sync-lifecycle text, changeset, docstrings; M5/L12/L13/L14 marked resolved. Validation:
`npm test` exits 0 with Fuseki confirmed; `npx linked build`; :3939 stopped, :3030 untouched.

### Phase 19 status: done

- README "The single-owner constraint": the `core:generatedShape` ownership edge, sync as two
  requests (delete removes them, create writes them nested), removed accessors and pruned shapes
  take their constraints with them, unowned NodeShapes are never touched.
- Changeset: the single-owner paragraph describes the ownership edge and the two-request sync.
- Docstrings: `singleOwnerConstraint.ts` module doc, `linked-core.ts` `generated` comment;
  `buildSyncThunk`, `Package.ts` and the `generatedShape` term were documented in Phase 18.

Review findings: **M5 resolved** (2 requests per shape, no SELECT), **L12 resolved** (no prefix
matching; ownership is the edge), **L13 resolved** (constraints are created in the same request
as the shape), **L14 resolved** (no suffix recognition in `shapeNamespace`).

Validation (2026-10-12):
- `npm test`: exit 0. `[ensureFuseki] Fuseki is ready`; 96 suites passed, 4 skipped; 2183 tests
  passed, 121 skipped.
- `npx linked build`: Build successful.
- :3939 stopped; :3030 not touched.

Deviations: none.

---

# Review (iteration 4)

Reviewed 2026-10-12: `git diff d7ce8b3..HEAD` (e1156dc, f37f6d2, 00a76d6).

## Test run

- `npm test`: `[ensureFuseki] Fuseki is ready`. 96 suites passed and 4 skipped (type-only); 2183
  tests passed and 121 skipped. `EXIT=0`. :3939 was stopped afterwards and :3030 was untouched.
- New live tests:
  - a NodeShape delete removes its generated shapes completely, and not the predicate IRI;
  - `'all'` and `'ownedNamespaces'` pruning keep the generated shapes of in-code shapes;
  - a sync is two requests and sends no class-check query.

## Data-deletion safety

- **The owned-child block deletes only nodes linked from this shape by `core:generatedShape`.**
  - `NodeShape.generatedShapes` (`Package.ts:913-918`) is `contains` with value shape NodeShape.
  - Only sync writes that edge, and only to `${iri}/${label}.singleOwner`. That IRI is unique per
    declaring shape and accessor; subclasses write none.
  - So no generated shape has two owners through sync.
- **The cascade** adds `core:generatedShape` to the path alternation. It still deletes only
  dependent-typed nodes, and NodeShape is not dependent, so no other shape is reachable through it.
  `sh:inversePath <predicate>` is shape-less, so the predicate IRI is kept (live-tested).
- **Class check:** generated shapes are nested creates, so they are not links. Their
  `targetObjectsOf {id}` is on a non-`contains` predicate, and `inversePath {id}` has no value
  shape. No SELECT is sent (live-tested).
- **Single-owner rule:** `NodeShape` lives in `@_linked/core`, which sync skips, so
  `core:generatedShape` gets no constraint of its own.
- **Pruning:** generated IRIs are computed in memory (`syncShapes.ts:231-233`).
  - A stale generated shape goes with its owner's delete.
  - Under `'all'` it is also pruned directly. The double delete is harmless.
  - Under `'ownedNamespaces'`, a generated shape whose owner edge is gone is never pruned: its
    namespace is now `…/Thing/` (L16).

## Status of all findings

| Finding | Status |
|---|---|
| H1 class check vs delete rule | Resolved (iteration 1) |
| H2 bulk deletes | Resolved (iteration 1) |
| M1 changeset behaviour changes | Resolved (iteration 1). The changeset is still `minor`, which is the lead developer's call. |
| M2 live negatives | Resolved, except L9 |
| M3 group without value shape | Resolved (iteration 1; per-accessor since iteration 3) |
| M4 bulk-delete cost | Resolved (iteration 2) |
| M5 sync cost | **Resolved**: 2 requests per shape, live-tested |
| L1 sync deletes non-generated | Resolved (iteration 3); superseded by ownership |
| L2 / L13 non-atomic constraint writes | **Resolved**: written nested in the main create |
| L3 TOCTOU | Documented |
| L4 stale comments | Resolved |
| L5 backlog 048 | Open: wrap-up deletes it |
| L6 performance | No action |
| L7 delete vs replace rule | Documented; an open design question |
| L8 plain properties checked | Resolved |
| L9 silent live suites | Open (follow-up) |
| L10 README narrowing | Resolved (7f1660e) |
| L11 two registry caches | Open (optional) |
| L12 prefix matching | **Resolved**: no prefix matching remains |
| L14 suffix special case | **Resolved**: removed |

## New findings

### Critical / High / Medium

None.

### Low

**L15. A store-only NodeShape that already sits at a generated IRI would be adopted, then wiped.**
- The collision check only compares registered shapes (`syncShapes.ts:137-147`).
- A store-only NodeShape at the same IRI, for example a CN project shape, gets linked by the
  nested create. The next sync's owned-child block then deletes all of its triples.
- It needs a hand-made NodeShape at `…/<Shape>/<accessor>.singleOwner`, which is unlikely.
- **Fix:** document it, or have the collision check also ASK the store for an unowned NodeShape
  at that IRI.

**L16. Under `'ownedNamespaces'`, a generated shape without its owner edge is never pruned.**
- Removing the special case makes its namespace `…/Thing/`.
- This only happens to data written before iteration 4 (unreleased) or to an owner removed by raw
  SPARQL.
- **Fix:** none needed before release; note it in the report.

**L17. One README line is far over the wrap width.** It is the line that ends "…is never touched.
`singleOwnerShapeIri`, …". **Fix:** rewrap it.

## Verdict

M5, L12, L13 and L14 are resolved. Nothing outside a shape's own subtree can be deleted through
the new edge. Ready for wrap-up. L5, L9, L11, L15, L16 and L17 remain as minor follow-ups.
