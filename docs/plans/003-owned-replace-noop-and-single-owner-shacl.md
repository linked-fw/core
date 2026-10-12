---
summary: >
  Owned (`contains`) values. Re-sending the current `{id}` becomes a no-op instead of wiping the
  node. Deleting a subject now deletes its immediately-owned children, as the README already says.
  `contains` properties without a value shape fall back to the `dependent` rule. Shape sync persists
  a generated single-owner SHACL constraint per declaring shape. Store-side SHACL validation is not
  enforced today; this is recorded as a limitation.
status: Tasks
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
| A3 | **S3 (wrong-type link) gets no SPARQL check in core.** Rely on the store's SHACL validation (`sh:class`). See [Findings](#findings): the store does not validate on write today. |
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

### Decision 1 of 6 — Where the generated single-owner constraint lives

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

### Decision 2 of 6 — Which predicates are grouped in one `sh:alternativePath`

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

### Decision 3 of 6 — Deterministic IRI and lifecycle of the generated shape

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

### Decision 4 of 6 — Visibility to the in-memory registry and to consumers

- The generated shape is **built only at sync time** (`buildSingleOwnerShapeData`) and is **never
  registered** in memory. `getAllNodeShapes`, `getSubShapes`, `getPropertyShapes`, forms and
  validation are unchanged, and `collectContainment` is unaffected.
- It is marked **`core:generated true`**, a new boolean on NodeShape, and has **no `sh:targetClass`**.
  Any catalog reader can then skip it with one check. `displayHidden` was rejected as the marker: it
  means "hide in UIs", not "not a user shape".
- **CN follow-up (outside core):** `fetchShapeCatalog` should filter `core:generated` NodeShapes.
  Until then CN would read a NodeShape with no targetClass. Record it in CN's backlog when this
  ships; core does not edit CN.

### Decision 5 of 6 — F2: should subject delete delete the immediately-owned child?

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
that says so. **Flagged for the lead developer to confirm.**

### Decision 6 of 6 — F3: `contains` properties without a valueShape

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

### Remaining open items

None blocking. Two confirmations for the lead developer: Decision 5 (delete behaviour change) and
the CN catalog follow-up in Decision 4.

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

## Files expected to change

| File | Change |
|---|---|
| `src/sparql/irToAlgebra.ts` | `keep` on both helpers. Collect `keep` in `processUpdateFields` (replace, array, set-mod). Skip self-delete for valueShape-less contains fields. Change the cascade path from `oneOrMore` to `zeroOrMore`. Add the one-hop child blocks in `deleteToAlgebra`. Update the section comments. |
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

## Test strategy

- Impacted package: `@_linked/core` only.
- Quick gate per phase: the targeted jest files (seconds), plus `npx tsc -p tsconfig-tests.json --noEmit`.
- Full gate (review): `npm test` and `npx linked build`, with Docker up so live suites run.

---

# Tasks

Dependency graph: **P1 ∥ P2** (independent files: `irToAlgebra.ts` versus `syncShapes`/meta-model) →
**P3** (live tests for both) → **P4** (README) ∥ **P5** (changeset) → **P6** (wrap-up docs). P4 and
P5 only need the contracts, so they can start after P1/P2 are merged. Each phase is one commit.

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

Validation:
- Quick: `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/shacl-cascade.test.ts src/tests/sparql-mutation-golden.test.ts src/tests/sparql-mutation-algebra.test.ts` exits 0. Any golden change must be the intended `+`→`*` or the new blocks.
- `npm run typecheck` exits 0.
- Full (review): `npm test`.

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
- **Caveat.** Core does not check `sh:class` of linked ids or the single-owner rule at write time,
  and the default Fuseki setup does not validate SHACL on write. Run a SHACL validator to enforce
  them.

Validation: the README renders. Manually check that the code samples match the final API names:
`grep -n "singleOwner" README.md` shows the section.

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
- a `contains` property without a value shape only deletes `dependent`-typed values.
Shape sync now also writes a generated `<Shape>.singleOwner` SHACL NodeShape (`core:generated`)
that limits each owned value to one owner across the shape's `contains` predicates.
```

Validation: `npx changeset status` lists `@_linked/core` as minor.

## Phase 6 — Wrap-up docs (last)

Tasks:
1. Write `docs/reports/032-owned-replace-noop-and-single-owner-shacl.md` (next free report number):
   problem, the decisions above, the emitted SPARQL and turtle as built, the files changed, the S3
   finding and the follow-ups.
2. Delete `docs/backlog/048-owned-property-replace-deletes-any-node.md` and this plan, as was done
   for report 025.
3. Record the follow-ups in the report:
   - CN `fetchShapeCatalog` should filter `core:generated`;
   - CN `ownedProperties.ts` duplicates `collectContainment`;
   - enable SHACL validation (on write or on demand) in the CN stack;
   - `rdf:first`-nested PathNodes in sequence paths are not cascade-cleaned on sync (F4).
   Ask before creating any of these as backlog items.

Validation:
- `npm test` exits 0 with Docker up.
- `npx linked build` exits 0.
- `git status` shows only the intended files.
