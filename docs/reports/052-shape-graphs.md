---
summary: >
  Shape graphs: shapes are stored as declared (own property shapes plus `core:isExtending`, no
  inherited copies; `SHAPE_HASH_VERSION` 3); `shapesToTurtle` writes shapes as deterministic Turtle
  (`packageShapesTurtle(pkg)` is a package's `shapes.ttl`, `singleOwnerShapesTurtle` the app's
  generated shapes); `syncShapeGraphs` replaces `{package IRI}/graph/shapes` whole on a hash
  mismatch (`linked-shape-graph/1`), writes the app graph, cleans the old default-graph shapes once
  and falls back to `syncShapes`; a graph patch deletes a blank-node structure as a pattern through
  its IRI subject (CBD). CN plan 071, sub-plan 004.
packages: [core]
---

# 052 — Shape graphs

## Why

CN plan 071 decision 13: each package's shapes live in their own named graph, written from a
deterministic `shapes.ttl` that `linked build` emits (L1) and the server syncs by hash (V2). 13b
stores shapes as declared, 13c makes a shape edit a patch of that shape's statements, and the
blank-node rule makes the patch unit the shape's concise bounded description. Sub-plan
[004](../plans/004-named-graphs.md) §K5 holds the plan-mode detail.

## What

**Shapes as declared** (`shapes/syncShapes.ts`). `buildNodeShapeData` (now exported, internal)
writes a shape's own property shapes (`getPropertyShapes(shape)`, overrides included, deduped by
label) and `core:isExtending`; the inherited copies are gone. `sh:and`/`sh:xone` lists get IRI
cells (`{shape IRI}/and/0`), as `sh:in` already had, so the only blank nodes left are complex
paths. `buildNodeShapeData(…, {generated: false})` leaves out the generated single-owner shapes.
`SHAPE_HASH_VERSION` 2 → 3, golden updated, ledger entry 3 appended
(`f378a932…`): the default-graph sync rewrites every stored shape once.

**Readers.** Core reads no stored shape except the sync's hash read. A shape known only as data
(a catalog built from stored shapes) already inherited through `extends` and the registry; the one
thing it had only from the copies, the root `Shape`'s `label` and `type`, it now gets from the
property readers: `getPropertyShapes(shape, true)` and `getPropertyShape` end a data-only chain at
the root `Shape` (`nodeShapeData.ts`, `inheritedShapes`), as a class-backed chain already does.
`getSuperShapes` is unchanged.

**`shapesToTurtle`** (`shapes/shapesToTurtle.ts`, subpath `@_linked/core/shapes/shapesToTurtle`,
not in the browser index). It builds each shape's create data, lowers it through core's create
pipeline (`createToAlgebra`), so the triples are exactly what a `NodeShape` read expects, and writes
them in the fixed form. The contract L1 and V2 build on:

- `shapesToTurtle(shapes: Array<typeof Shape | NodeShapeData>, options?: {prefixes?:
  Record<string, string>}): string`.
  - Prefix block: `core` `https://linked.cm/ont/core/`, `rdf`, `rdfs`, `sh`
    `http://www.w3.org/ns/shacl#`, `xsd` (`SHAPES_TURTLE_PREFIXES`), always declared, plus the
    caller's, all sorted by name; a fixed name cannot be rebound (throws), a bad name or a
    non-absolute namespace throws. Only these prefixes are used, never `Prefix`'s global map.
  - Then one block per IRI subject, sorted by IRI (code-unit order, so `…/Person` is followed by
    `…/Person/name`): the subject alone on a line, then `  predicate object` lines, `a` first, then
    by predicate IRI, then by the written object; ` ;` between, ` .` after the last; one blank
    line between blocks; the text ends with `\n`.
  - IRIs are compacted only when the local part is a safe `PN_LOCAL` (`Prefix.isValidLocalName`);
    literals: plain for `xsd:string`, `"…"@lang`, else `"…"^^dt` (so `"1"^^xsd:integer`,
    `"true"^^xsd:boolean`).
  - Shapes as declared (own property shapes, `core:isExtending`); no generated single-owner
    shapes, no `core:shapeHash`.
  - Blank nodes only for complex `sh:path` values (inverse, alternative, zero-or-more, one-or-more,
    zero-or-one, sequence): each the object of exactly one triple, written inline on its owner's
    line (`sh:path [ sh:inversePath ex:p ]`, `sh:path ( ex:a [ sh:inversePath ex:b ] )`). The writer
    throws on a blank node with two parents or none.
  - Same shapes (any input order) and same prefixes → same bytes, in any process.
- `packageShapes(pkg): NodeShapeData[]` — the package's registered shapes, sorted by IRI (for
  `@_linked/core`, its built-ins only); `packagesWithShapes(): string[]`.
- `packageShapesTurtle(pkg, options?): string | undefined` — `shapesToTurtle(packageShapes(pkg))`,
  `undefined` without shapes. **L1 writes `lib/esm/data/shapes.ttl` with this call and no
  `prefixes`** (after importing the package's shape modules), so a built file and the sync's
  in-process generation are the same bytes.
- `singleOwnerShapesTurtle(shapes, options?): string | undefined` — the generated single-owner
  shapes of the given shapes, with the declaring shapes' `core:generatedShape` links, for the app's
  graph. Their `sh:qualifiedValueShape [ sh:class C ]` is an inline blank node too (the app graph is
  regenerated, never patched).

**`syncShapeGraphs(ds?, options?)`** (`shapes/syncShapeGraphs.ts`, subpath
`@_linked/core/shapes/syncShapeGraphs`) → `{written, skipped, pruned, cleaned, appGraph?,
defaultGraph?}`. Options: `force`; `packages`; `turtleFor(pkg)` (the installed `shapes.ttl` bytes,
or `undefined` to generate); `appShapes: {graph, package?}` (the app's `{DATA_ROOT}/graph/shapes`;
core knows no `DATA_ROOT`); `orphanScope: 'none' | 'all'`.

- One `ShapesGraph.select()` reads the records. Per package (sorted): hash `shapeGraphHash(text)` =
  `sha256Hex('linked-shape-graph/1\n' + text)`; equal and no `force` → skipped, no write; else
  `ShapesGraph.create({id, package, sources: 'data/shapes.ttl'}).withContent(turtle, {contentHash})`
  or `update(id).set({sources}).replaceContent(…)` — one graph query, never a patch.
- The app graph: `singleOwnerShapesTurtle` of every registered shape, hashed and written the same
  way (`appGraph: 'written' | 'skipped'`, `'dropped'` when nothing is left and a record exists).
- Cleanup: the package shapes of the run that the default graph still holds with a
  `core:shapeHash` are deleted there (`DeleteBuilder` on `NodeShape`, the existing cascade takes
  property shapes, lists, paths and generated shapes). One select finds them, so a cleaned store
  costs one read.
- `orphanScope: 'all'` (no `packages`): `ShapesGraph.delete` of a record whose package is not
  registered, only for package graphs (`…/pkg/{slug}/graph/shapes`), never an app graph.
- Fallback, as the ontology sync: a dataset without `graphQuery`, or `unsupported-query-kind`
  before the first graph write, runs the default-graph `syncShapes` (`defaultGraph` = its writes).
  `syncShapes`/`syncShape` stay as they are (declared-only now).

**CBD patches** (`sparql/graphQueryToSparql.ts`). `patch.delete` may hold blank nodes. Its ground
triples go in `DELETE DATA` as before; each triple `<s> <p> _:b` with an IRI subject, plus the
statements of `_:b` and recursively of every blank node under it, becomes
`DELETE { GRAPH <g> { … } } WHERE { GRAPH <g> { … } FILTER(isBlank(?b0) && …) }` with the blank
nodes as variables, before the `INSERT DATA`, all in the one update. A blank node that is the
object of two triples, or that no IRI subject reaches (cycles included), is refused with a plain
error, as the parser's other refusals. `GraphQueryBodies` gains `deletePatterns`.

## Deviations from the sub-plan

- Blank-node labels are scoped per create inside the writer (each create labels from `_:b0`): found
  by the app-graph test, which writes several shapes with blank paths.
- Data-only root inheritance went into the property readers, not `getSuperShapes`: changing the
  canonical walk would have changed `isSubShapeOf` and the walk's own tests
  (`display-metadata.test.ts`) for something only the property readers need.
- Two existing tests asserted the old form and were updated: `shacl-metamodel-terms` (IRI cells for
  `sh:and`/`sh:xone`) and `sparql-fuseki-shape-sync` (a sub-shape no longer holds a copy of the
  inherited `image` property shape).

## Breaking changes (changeset `shape-graphs.md`, minor)

- Shapes are stored as declared; readers of stored shapes follow `core:isExtending`.
  `SHAPE_HASH_VERSION` 3: the next default-graph sync rewrites every stored shape once.
- `sh:and`/`sh:xone` lists have IRI cells.
- The property readers give a data-only shape the root `Shape`'s `label` and `type`.
- A `graph_patch` delete with blank nodes is no longer refused; a store implementing `graphQuery`
  itself must delete each structure through its IRI subject or refuse it.

## Contract notes for the master

- **Clarified:** "blank nodes only for `sh:inversePath` and sequence paths" reads as "only for
  complex `sh:path` values" (decision 13: "except where SHACL requires them"): SHACL requires a
  blank node for every complex path, so alternative and the repetition paths are blank too.
- **Added inside the contract:** `packageShapesTurtle(pkg)` (the call L1 makes), `packageShapes`,
  `packagesWithShapes`, `singleOwnerShapesTurtle`, `SHAPES_TURTLE_PREFIXES`; `syncShapeGraphs`
  options `packages`, `turtleFor`, `appShapes: {graph, package?}` (core knows no `DATA_ROOT`),
  `orphanScope`, and its result. The sub-plan's §K5 has the full text.
- **For C4 (catalog readers):** the default-graph `syncShapes` writes declared shapes now, so a
  catalog built from the default graph shows a sub-shape without its inherited property shapes
  unless the parent is registered in the same catalog (core's walk follows `extends` through the
  registry). This lands on `:4040` with this step: CN's shapes are rewritten once at its next
  boot (version 3), and CN backlog 131 (inherited properties by following `core:isExtending`) is
  C4's.
- **For V2:** `turtleFor` is where the installed `shapes.ttl` comes in; open question 6's warning
  (no file, so generated) belongs there. The graph hash covers the bytes passed.

## Verification

Worktree `named-graphs--k5`, own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3183 (compose
project `fuseki-071-k5`), env `FUSEKI_TEST_PORT=3183 FUSEKI_BASE_URL=http://localhost:3183
LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-071-k5 LINKED_FUSEKI_IMAGE=ghcr.io/linked-fw/fuseki:6.2.0-2`
exported before every jest run (from a sourced file; no run reached :3939).

Quick gates:

- Phase 1 (declared shapes and the writer; `shapes-to-turtle`, `shape-sync-output-equivalence`,
  `shacl-syncshapes`, `shape-sync-hash`, `shape-catalog`, `tighten-only`, `shacl-metamodel-terms`,
  `display-metadata`, `sparql-fuseki-shape-sync`): `Test Suites: 9 passed`, `Tests: 126 passed,
  126 total`, `[fuseki] live tests: 18 total — 18 passed`, 29.2 s wall; `npm run typecheck` clean,
  3.9 s.
- Phase 2 (CBD; `graph-query`, `graph-query-fuseki`, `shape-graphs-fuseki`): `Tests: 71 passed, 71
  total`, `13 total — 13 passed`, 16.8 s wall; typecheck clean, 7.8 s.
- Phase 3 (the sync; `shape-graphs`, `shape-graphs-fuseki`, `sparql-fuseki-shape-sync`,
  `shapes-to-turtle`): `Tests: 41 passed, 41 total`, `20 total — 20 passed`, 17.4 s wall; typecheck
  clean, 4.1 s.

Full gate (on `named-graphs--k5` over `named-graphs` at `556803b`, `npx linked build` first,
8.4 s, `✔ Build successful`):

- `npx jest`: `Test Suites: 1 failed, 4 skipped, 132 passed, 133 of 137 total`, `Tests: 120
  skipped, 2659 passed, 2779 total`, `[fuseki] live tests: 352 total — 352 passed, 0 failed, 0
  skipped`, 1:08.7 wall. The failing suite is `two-copies-built.test.ts` ("Jest worker encountered
  4 child process exceptions"), backlog 060.
- `npm run typecheck`: clean, 4.4 s. `npm run test:fuseki`: `352 total — 352 passed`, 40.3 s.
  `npm run check:dts`: clean, 1.8 s. `lib/esm/shapes/shapesToTurtle.js` and `syncShapeGraphs.js`
  import neither `n3` nor `node:`.

Verify (master):

- Golden `shapes.ttl` for core's own shapes, byte-identical across runs: `shapes-to-turtle.test.ts`
  compares `packageShapesTurtle('@_linked/core')` with `src/tests/fixtures/core-shapes.ttl` (814
  lines). Across processes, from the built `lib`, two separate `node` runs and the golden file:
  `fbe7639dff18268dff3dc282333c4e16396013bd8daaa0e54f2cd97cd3a1a7f8` three times.
- Sync written then skipped (`[fuseki]`): the first `syncShapeGraphs` returns `{written:
  ['@_linked/core', 'shape-graphs-live'], skipped: [], pruned: [], cleaned: 1, appGraph:
  'written'}` (the `cleaned` shape was written beforehand by `syncShape` into the default graph and
  is gone there afterwards), each record a `ShapesGraph` with `feedsHierarchy false`; a
  `NodeShape` select `.from(graphs.allShapes)` finds the shapes; the second returns `{written: [],
  skipped: [both], pruned: [], cleaned: 0, appGraph: 'skipped'}` with **0 updates**.
- CBD patch on a shape with an `sh:inversePath` (`[fuseki]`): after `patchContent` with the
  property shape's statements before (`inversePath ex:parent`) and after (`ex:mother`), the old
  path is gone, the new one present, the blank-node count unchanged, **0 orphan blank nodes**, and
  the property shape keeps exactly its 4 statements.
- SHACL targeting (`[fuseki]`): with `Employee` stored as declared (no `name` property shape of its
  own), a select of `SgEmployee` instances returns both, and Jena SHACL on the shapes Turtle reports
  `sh:conforms false` with a `MinCountConstraintComponent` result for `e1` from
  `…/SgPerson/name`, and none for `e2`.

## Follow-ups

- Backlog [068](../backlog/068-default-graph-shapes-of-removed-packages.md): default-graph shapes of
  packages no longer in code stay after the cleanup.
- L1: `linked build` writes `lib/esm/data/shapes.ttl` with `packageShapesTurtle(pkg)` (master §L1).
- V2: boot and re-sync through `syncShapeGraphs(ds, {turtleFor, appShapes})` (master §V2).
- C4: catalogs on `graphs.allShapes` plus the app graph, inherited properties through
  `core:isExtending` (master §C4, CN backlog 131); a shape edit's patch is the shape's statements as
  `shapes.ttl` holds them (the CBD rule above).
- Package versions in records: backlog 064, unchanged.
