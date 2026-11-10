---
summary: Serialize code-registered NodeShapes to the store as SHACL via the query engine — a containment cascade (contains + dependent) for clean re-sync, List/PathNode shapes, an rdfList() helper, a PathExpr→sh:path translator, and syncShapes() that returns delete+recreate query thunks. @_linked/core only.
---

# SHACL Shape Serialization & Sync — Report

Implements `docs/ideas/015`. **All work in `@_linked/core`.** Shapes defined in code are
materialized into the store as SHACL data via the existing query engine — the forward
(code → graph) direction of "code as canonical":
**code is canonical, the store is a rebuildable projection.**

## Architecture overview

`syncShapes()` walks every code-registered (non-framework) `NodeShape`, builds a data object per
shape, and returns **built-but-unexecuted thunks**. Each thunk runs `delete(shapeIri) →
create(data).withId(shapeIri)`; the delete cascade-cleans the shape's old property shapes / list /
path subtrees, the create rebuilds them. Shapes in the store but no longer in code are deleted as
orphans. Serialization reuses the engine itself: `NodeShape.create({...})` over the existing
meta-model (no parallel triple emitter, no new mutation primitive).

Pipeline: `syncShapes` → `buildNodeShapeData`/`buildPropertyShapeData` (+ `serializePathToNodeData`,
`rdfList`) → `NodeShape.create(...)` / `DeleteBuilder` → IR → `irToAlgebra` (with the **owned-subtree
cascade**) → SPARQL → store.

## Key design decisions (with rationale)

- **Output is queries, not an RDF artifact.** `syncShapes()` returns thunks; the caller controls
  execution/batching (`await Promise.all(plan.map(r => r()))`). Per-shape `delete→create` is chained
  inside one thunk so ordering is guaranteed; shapes parallelize.
- **Delete + recreate, not in-place update.** Re-sync deletes then recreates each shape. `update`
  only replaces predicates present in the data, so a *removed* constraint would leave a stale triple;
  delete+recreate handles removals for free and needs only an identity read (existing shape IRIs) for
  orphan detection. (The general update cascade still exists — see below — it just isn't what sync uses.)
- **Reuse the existing `Package.ts` meta-model.** `NodeShape`/`PropertyShape` already carry property
  shapes (applied externally in `Package.ts` due to circular deps). We extended that meta-model rather
  than adding parallel `SHACL*` meta-shape classes, and serialize via `NodeShape.create(...)`.
- **Composition via two declarative flags (`contains` + `dependent`).** A property marked `contains`
  is an edge the cascade follows; a shape marked `dependent` is an instance the cascade may delete.
  The cascade deletes a reached node only if its asserted `rdf:type` is in the dependent set — which
  naturally spares shared predicate IRIs (a simple `sh:path`) and `rdf:nil` (never typed). One shared
  helper (`buildOwnedCascade`) is wired into **both** delete and update.
- **Writes reuse nested-create + a public `rdfList()` helper.** An `rdf:List` is a nested `List`
  node-data chain the existing create lowering already serializes — no `{__rdfList}` IR primitive.
- **`sh:path` polymorphism handled by a dedicated translator.** `sh:path` may be a predicate IRI, an
  `rdf:List` (sequence), or a `PathNode` (inverse/alt/cardinality). The `path` meta-model accessor has
  **no** `valueShape` (so the factory uses each value's own shape); `serializePathToNodeData` produces
  the right node-data per `PathExpr` form.
- **Default graph.** Named-graph writes aren't implemented (idea 005); graph isolation deferred.

## File structure

| File | Responsibility |
|---|---|
| `src/ontologies/shacl.ts` | + `sh:equals/disjoint/hasValue/order/group/closed/ignoredProperties` |
| `src/ontologies/linked-core.ts` | + `contains`, `dependent`, `PathNode` terms |
| `src/shapes/SHACL.ts` | `PropertyShape.contains`; `NodeShape.dependent/closed/ignoredProperties`; `contains` on object-property config |
| `src/shapes/List.ts` | `List` (`rdf:List` cell: `first` value, `rest` contains+dependent); public `rdfList(items, {base?})` helper |
| `src/shapes/PathNode.ts` | operator node (`linked:PathNode`) for inverse/alt/cardinality paths; all edges `contains`, shape `dependent` |
| `src/shapes/serializePathToNodeData.ts` | `PathExpr → {id} \| List \| PathNode` node-data |
| `src/shapes/syncShapes.ts` | enumerate → identity-read → delete+recreate / orphan-delete thunks |
| `src/utils/Package.ts` | `ShapeConfig.dependent/closed/ignoredProperties` read in `applyLinkedShape`; extended meta-model accessors; `contains` on `sh:property`/`sh:path`/`sh:in`; `PropertyShape` `dependent` |
| `src/sparql/irToAlgebra.ts` | `buildOwnedCascade`, `collectContainment`, `shapeHasContainsProperty`; cascade wired into `deleteToAlgebra` + `processUpdateFields` |
| `src/index.ts` | exports `syncShapes`, `syncShape`, `rdfList`, `serializePathToNodeData`, `PathNode` |

## Public API

```ts
// Sync all code-registered shapes into the store:
import {syncShapes} from '@_linked/core';
const plan = await syncShapes();                 // Array<() => Promise<void>>
await Promise.all(plan.map((run) => run()));      // delete+recreate per shape + orphan deletes

// Sync ONE shape (scoped — no store-wide orphan sweep; see ideas/025):
import {syncShape} from '@_linked/core';
await syncShape(Person)();                         // by class
await syncShape(Person.shape.id)();                // or by NodeShape IRI
// composes/batches with itself (each returns one unexecuted thunk):
await Promise.all([syncShape(Person), syncShape(Address)].map((run) => run()));

// Ordered RDF lists (sh:in, sequences, or any user property):
import {rdfList} from '@_linked/core';
Playlist.create({ tracks: rdfList([t1, t2, t3]) });          // → rdf:first/rest/nil chain
rdfList(items, {base: `${psIri}/in`});                        // deterministic cell ids

// Composition flags:
@linkedShape({dependent: true}) class Cell extends Shape { /* … */ }
@objectProperty({path, shape: Cell, contains: true}) get owned(): Cell[] {}
@linkedShape({closed: true, ignoredProperties: [ex('x')]}) class S extends Shape {}

// Path translation (used internally by syncShapes):
import {serializePathToNodeData} from '@_linked/core';
serializePathToNodeData(pathExpr, baseIri);
```

### Update — `syncShape(target)` (ideas/025)

Scoped single-shape counterpart to `syncShapes()`: materializes one code-registered NodeShape
(delete → recreate, cascade-cleaning its owned subtrees) with **no store-wide orphan sweep**, so
sibling shapes in the store are untouched. Accepts a shape class or NodeShape IRI; throws for
framework/meta and unregistered shapes. The shared per-shape thunk was factored into a private
`buildSyncThunk`, which now rebuilds its node-data **per invocation** (the create pipeline mutates
the data by stripping nested `shape` keys, so a thunk must rebuild to be safely re-runnable —
this also hardened `syncShapes()`). Covered by `src/tests/shacl-syncshapes.test.ts`.

## Owned-subtree cascade (the core mechanism)

`collectContainment()` reads the registry for all `contains` predicate IRIs and all `dependent`
targetClasses. `buildOwnedCascade(root, prefix)` emits, per dependent type, an
`OPTIONAL { <root> (c1|c2|…)+ ?owned . ?owned a <Type> . ?owned ?p ?o }` and deletes `?owned ?p ?o`.
The `(contains)+` property path (incl. `rdf:rest`) walks the whole owned graph in one pattern;
requiring `?owned a <dependentType>` is the safety filter (shared IRIs / `rdf:nil` are untyped → kept).

- **Delete:** `deleteToAlgebra` runs the cascade per id, gated by `shapeHasContainsProperty(query.shape)`.
  In `syncShapes` the delete is `DeleteBuilder.from(NodeShape, {id})`, so `query.shape` is the **meta**
  NodeShape (which has `contains sh:property`) → cascade fires → cleans the shape's `sh:PropertyShape`
  (dependent) children and their list/path subtrees.
- **Update:** `processUpdateFields` cascades each replaced `contains` property's old value (and each
  removed value of a set-modification) from its bound term.

`sh:path`/`sh:in` mapping: simple path → predicate IRI; sequence → `rdf:List`; inverse/alt/cardinality
→ `PathNode` (alt's operand is an `rdf:List`); `sh:in` → `rdf:List` of literals or IRIs.

## Test coverage

Unit (jest): `shacl-serialization-ontology` (terms), `shacl-serialization-flags`
(contains/dependent/closed/ignoredProperties stored), `shacl-list-pathnode` (rdfList golden + List/
PathNode flags), `shacl-cascade` (delete & update cascade incl. set-modification; safety: simple-path
predicate not followed), `shacl-path-translator` (every `PathExpr` form), `shacl-metamodel`
(NodeShape.create golden + contains flags), `shacl-syncshapes` (routing/ordering/framework-exclusion,
mocked dispatch). E2E (jest + Fuseki, `npm run test:fuseki`): `sparql-fuseki-shape-sync` — **Phase A**
materialize (NodeShape/targetClass/constraints/`sh:in` list/sequence path/`closed`/`ignoredProperties`),
**Phase B** mutate + re-sync (constraint change, add/remove property, simple↔complex path swap, shrunk
list, orphan shape — all cleaned; shared predicate/enum IRIs survive), **Phase C** update-cascade.

Totals: `npm test` **1135 passed** (114 Fuseki-gated skipped), `npm run test:fuseki` **87 passed**,
`yarn build` exit 0.

## Bugs found & fixed during review

- **Base `Shape` would be synced** — it's registered without `applyLinkedShape` (no `packageName`);
  `syncShapes` now skips shapes with no `packageName`.
- **Set-modification on a `contains` property** pushed an unbound `old_` cascade var (dead OPTIONAL,
  no cleanup); now each removed value cascades from its bound IRI. Covered by a unit test.

## Known limitations / follow-ups

- **Host app wiring:** `syncShapes()` is exported but nothing calls it yet (host app follow-up; out of scope).
- **`sortBy` / `defaultValue`** PropertyShape fields are not serialized (non-SHACL extras).
- **Cascade scope is global** (all contains preds + dependent types) — correct but broad; a
  shape-scoped alternation is a possible optimization.
- **Full-graph churn:** delete+recreate rewrites every shape each sync (acceptable; a skip-unchanged
  optimization is possible later).
- **Backlog (open):** `editInline` review — decide whether `contains` subsumes it.

## Out of scope (closed, not deferred)

- **Reverse import (SHACL RDF → NodeShape)** — will be built in **the host app**, not core.
- **`{__rdfList}` IR/mutation-engine primitive** — won't build; `rdfList()` is the complete API and a
  primitive would add a second same-output mechanism to core lowering for no functional gain.

## Architecture compliance

Follows the host app's architecture: code is canonical (forward materialization), the storage
model (writes via queries → IDataset; default graph), and its testing conventions
(jest unit + Fuseki integration, matching core's `sparql-fuseki.test.ts` convention). No architecture
changes required; reverse import deferred to the host app.


### Update — `orphanScope` on `syncShapes()`

The store-wide orphan sweep described above assumes the sync is the **only writer**. In a
multi-writer dataset — app-data written by more than one package — that assumption is wrong in a
destructive direction: every shape another writer owns looks like an orphan, and the sweep
deletes it.

`syncShapes(shapes, {orphanScope})` scopes the sweep:

- `'all'` *(default, unchanged)* — prune every store-only shape. Correct when the sync owns the
  dataset.
- `'ownedNamespaces'` — prune only shapes in namespaces this sync owns.
- `'none'` — never prune.

Additive: omit the option and behaviour is exactly as documented above. This is a middle ground
between the two extremes already in this report — the store-wide sweep of `syncShapes()` and the
no-sweep-at-all of `syncShape(target)` — for the case where a writer owns *some* of a shared
store and needs removals to still take effect within its own namespaces.
