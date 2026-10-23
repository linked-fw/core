---
summary: >
  Graph routing: a route maps a shape to one named graph of one dataset
  (`LinkedStorage.setDatasetForShapes(ds, shapes, {graph})`, the datasets config's per-alias
  `graphs`); routed reads give each subject group its shape's read set (its graph, its
  sub-shapes' and its owners'), compiled as `GRAPH <g>`, `FROM NAMED` + `GRAPH ?g`, `VALUES` for a
  narrower type-checked subject, and without `FROM NAMED` when the default graph is in the mix;
  routed writes (`INSERT DATA { GRAPH <g> … }`, `WITH <g>`), `.into()` checked against the routing
  and never in DSL-JSON; live-query dependencies and effects carry graphs. CN plan 071, sub-plan 004.
packages: [core]
---

# 051 — Graph routing

## Why

CN plan 071 decision 8: storage rules pick the graph, per app, the way they pick the dataset, so
ordinary code never names one. Decision 9 settled how routed reads are written (one `GRAPH ?gN`
block per subject group, `FROM NAMED` from the routing, `VALUES` where a group's set differs, the
default graph's store name in the set). Phase 1 shipped `.from()` for one graph set per query
(report 049); this step adds the routes, routed reads and writes, `.into()` and graphs in live
queries. Sub-plan [004](../plans/004-named-graphs.md) §K4 holds the plan-mode detail.

## What

**Routes** (`utils/graphRouting.ts`). A per-dataset table on the shared global, keyed by the
dataset object and the shape IRI: `setShapeGraphs(dataset, {shape: graph})`,
`getShapeGraphs`, `unsetShapeGraph`, `graphRoutingFor(dataset)` (undefined without routes).
`LinkedStorage.setDatasetForShapes(dataset, [shapes], {graph})` pins and routes (the variadic form
stays); `unsetDatasetForShape` drops the routes with the pin. `parseDatasetsConfig` checks an
alias's `graphs` (shape IRI → graph IRI) and `loadStores` registers it for the store it builds. A
route never names a portable graph or the registry.

- A shape's **graph**: its route, else its nearest routed super-shape's, else the default graph.
- Its **read set**: its graph, every registered sub-shape's graph, and the read set of every shape
  that owns it through a `contains` property (owned nodes are written into the owner's graph).

**Routed reads.** With routes and no `.from()`, `SparqlDataset` passes the routing to the compiler
(`SparqlCompileOptions.routing`). Each subject variable gets the read set of its shape: the root's
shape, an object property's value shape, or, through `contains`, the owner's set; a subject of
unknown shape gets every routed graph and the default graph. `graphScope.ts` then writes:

| Situation | SPARQL |
|---|---|
| every subject reads only the default graph | unchanged, byte for byte |
| every subject reads one same graph | `GRAPH <g> { whole pattern }` |
| named graphs only | `FROM NAMED` the union (sorted); a one-graph subject `GRAPH <g>`, a whole-union subject `GRAPH ?g`, a type-checked subject with a narrower set `VALUES ?g { … }` + `GRAPH ?g` |
| the default graph with named graphs | no `FROM NAMED`; a default-only subject plain triples, a one-graph subject `GRAPH <g>`, any other `VALUES ?g { <store default name> … }` + `GRAPH ?g` |

`VALUES` is written where a subject's graph variable is first bound in a required pattern, not
again in the OPTIONAL blocks that join on it; an OPTIONAL, UNION, MINUS or EXISTS pattern and a
sub-select start from what was bound before them. Probed on `6.2.0-2`: with any `FROM NAMED` the
default graph is unreachable (plain triples, `GRAPH <urn:x-arq:DefaultGraph>` and `VALUES` all
match nothing), so the last row has none. `.from()` sets go through the same code with one set for
every subject, which lifts report 049's refusal: `graphs.default` among other graphs reads through
`VALUES` on a store with `mapGraphName` (backlog 066 closed; `graphs.union` with others stays
refused).

`SparqlOptions.namedGraphUriParameter`: the `FROM NAMED` set leaves the query text and goes to
`executeSparqlSelectWithNamedGraphs(sparql, graphs)`, which refuses by default (a transport that
dropped the list would read every named graph).

**Linked type checks (backlog 065): not needed, closed.** A subject's graphs come from its shape,
and a linked subject's data lives in one graph, so `FROM NAMED` (or `VALUES`) finds it without a
type check; adding one would change every select. `isolateLinkedTypeChecks` stays inert for
generated queries.

**Routed writes** (the write rule as decided on the review, master §Contracts at CN `48d5865ff`).
The mutation IR kinds carry `graph?` and, for changes to existing subjects, `writeGraphs?`;
`SparqlDataset.resolveWriteGraph` sets them:

- a create goes to the shape's routed graph: `INSERT DATA { GRAPH <g> { … } }`; nested (owned)
  nodes are created there too;
- an update, upsert or delete (by id or in bulk) of a shape whose read set is one graph runs in it,
  `WITH <g>` before `DELETE`/`INSERT`;
- when the read set holds several graphs (a sub-shape's or an owner's), the plan gets `graphIn` and
  the same update finds the subject's graph: templates in `GRAPH ?g_w { … }`, and in the WHERE
  `{ SELECT DISTINCT ?g_w WHERE { VALUES ?g_w { <read set> } GRAPH ?g_w { <s> ?p ?o } } }` then
  `GRAPH ?g_w { where }` (a subject in none of them matches nothing). An upsert makes the lookup
  OPTIONAL and binds `COALESCE(?g_w_found, <routed graph>)`, so a subject found nowhere is created
  in the routed graph. A bulk update or delete is `VALUES ?g_w { … } GRAPH ?g_w { where }`. A
  delete of several ids is one operation per id in one request (one transaction). The default
  graph in the set goes under the store's name for it (probed on `6.2.0-2`: `GRAPH ?g` templates
  with `?g = urn:x-arq:DefaultGraph` write the default graph and create no named graph);
- owned cascades run inside the subject's graph. Under routing an owned node lives in its owner's
  graph, which the owned-link check now enforces: one SELECT reads the types of the linked ids and
  of the owner in every graph, and a linked node typed only in another graph than the owner's is
  refused ("an owned node lives in its owner's graph"); class checks use the owner graph's types.
  So each owned child's own graph is its owner's, and the cascade reaches it.

**`.into(graph)`** on `CreateBuilder`, `UpdateBuilder` and `DeleteBuilder`: immutable, kept by
every fluent call, carried to the IR by `lower()`, never written by `toJSON` and never read by
`fromJSON`. Refused: a graph outside the shape's read set (`GraphQueryError('graph-not-routed')`,
a new code), a portable name or the registry, a store-reserved name (`graph-name-read-only`).

**Live queries.** `QueryDependencies.graphs` (the `.from()` names, or, when the dataset
`LinkedStorage` routes the root shape to has routes, the read sets of every shape the query
reads) and `MutationEffects.graph` (the `.into()` graph, a create's routed graph, or the one graph
of a change to existing subjects; unknown when the read set holds several, so every template that
reads the shape is matched). The
matcher skips a template only when both are known, the template reads no store-resolved name, and
the graph is not among its graphs; `effectsHash` and the JSON revival carry the graph.

## Deviations from the sub-plan

- **Owners' graphs in a read set.** The first `[fuseki]` run showed an album's owned cover (written
  into the album's graph) read back with no caption: the cover's group read the photo shape's
  graphs. A traversal through `contains` now reads the owner's set, and a shape's read set includes
  the read sets of the shapes that own it, so reads follow the graphs writes use (decision 9) for
  owned nodes too. Contract note below.
- `VALUES` is written once per binding scope instead of with every block (less text; same rows).
- A flaky test outside this step: `graph-query-fuseki.test.ts` compared a record's
  `dcterms:modified` as text and failed about one run in ten (Jena canonicalises `…17.560Z` to
  `…17.56Z`; report 049's "one-off under load"); it now compares instants.

## Breaking changes (changeset `graph-routing.md`, minor)

- Under routing, routed shapes (and shapes whose sub-shapes or owners are routed) leave the
  default graph: data written before a route was added is not read for that shape.
- `GraphQueryErrorCode` gains `graph-not-routed`.
- The mutation IR kinds gain an optional `graph`; a store that builds its own SPARQL from the IR
  must honour it.
- `.from([graphs.default, …])` reads on a store with `mapGraphName` instead of being refused.

No export was removed. `setDatasetForShapes`' variadic form is kept.

## Contract notes for the master

§Contracts "Graph routing" is implemented as written, with these fillings-in (also in the
sub-plan's K4 section):

- Routes are per dataset object; a composite dataset (C3's router) registers routes on the store
  it forwards to with `setShapeGraphs`, or overrides `SparqlDataset.graphRouting()`.
- A shape's read set adds the read sets of the shapes that own it (`contains`), and a traversal
  through `contains` reads the owner's set: owned nodes live in their owner's graph.
- "`.into()` only to a graph the routing allows for that shape" = the shape's read set.
- "`VALUES` for a group whose graph set differs and overlaps their classes": core cannot know
  which classes a graph holds, so a type-checked group gets `VALUES` whenever its set is narrower
  than the union; a linked group without a type check never needs it.
- With the default graph in the mix there is no `FROM NAMED` at all (Jena hides the default graph
  under any `FROM NAMED`).

## Verification

Worktree `named-graphs--k4`, own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3182 (compose
project `fuseki-071-k4`), env `FUSEKI_TEST_PORT=3182 FUSEKI_BASE_URL=http://localhost:3182
LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-071-k4 LINKED_FUSEKI_IMAGE=ghcr.io/linked-fw/fuseki:6.2.0-2`
exported before every jest run (one early run was started without it: its global setup reached
:3939, ran the inference probe there, which creates and drops its own probe dataset, and stopped;
:3939 then held only `/ds`).

Quick gates:

- Phase 1 (routes; `graph-routing`, `load-stores-loader`, `dataset-pin-identity`): `Tests: 21
  passed, 21 total`, `Time: 2.329 s` (5.4 s wall); `npm run typecheck` clean, 3.0 s.
- Phase 2 (routed reads; 12 suites: routing, `read-graphs` unit and `[fuseki]`, the select, ask,
  count and IR golden suites, algebra, graph query, count, nested select): `Tests: 385 passed, 385
  total`, `Time: 6.579 s`; typecheck clean, 3.0 s.
- Phase 3 (routed writes; 21 suites: routing and every mutation, owned, DSL-JSON, cascade suite):
  `Tests: 3 skipped, 528 passed, 531 total`, `Time: 5.881 s`; typecheck clean, 3.0 s.
- Phase 4 (live; 7 suites): `Tests: 141 passed, 141 total`, `Time: 3.806 s`; typecheck clean, 3.0 s.
- Phase 5 (`graph-routing` unit and `[fuseki]`): `Tests: 43 passed, 43 total`.

Full gate (final, after both reviews, on `named-graphs--k4` rebased on `named-graphs` at
`8b4c4db`, `npx linked build` first):

- `npm test`: `Test Suites: 1 failed, 4 skipped, 129 passed, 130 of 134 total`, `Tests: 120
  skipped, 2632 passed, 2752 total`, `Time: 23.108 s` (26.1 s wall), `[fuseki] live tests: 349
  total — 349 passed, 0 failed, 0 skipped`. The failing suite is `two-copies-built.test.ts`
  ("Module cache already has entry …/lib/esm/shapes/SHACL.js. This is a bug in Jest"), backlog 060.
- `npm run typecheck`: clean, 3.7 s. `npm run test:fuseki`: `349 total — 349 passed`, 14.6 s.
  `npm run check:dts`: clean, 1.7 s. `npx linked build`: `✔ Build successful`, 7.4 s;
  `lib/esm/utils/graphRouting.js`, `sparql/graphScope.js`: no `n3` or `node:` import.
- `npm run test:fuseki` (before the review): five runs `345 total — 345 passed`; one earlier run,
  and two of six further full `jest` runs, had `344 passed, 1 failed`: always
  `graph-query-fuseki.test.ts` comparing `dcterms:modified` as text (above); fixed in this step.

Verify (master §K4):

- Golden SPARQL per form, `graph-routing.test.ts`: unchanged without routes; one graph; `FROM
  NAMED` + `GRAPH ?g` per subject; fixed `GRAPH <g>` per one-graph subject; `VALUES` written once
  for a narrower type-checked root; the default graph mixed (no `FROM NAMED`, `VALUES` with
  `urn:x-arq:DefaultGraph`, plain triples for a default-only subject); refused without a store
  name; count and ask; `.from()` over routing; `named-graph-uri` sent to the transport and refused
  by a transport that does not send it.
- `[fuseki]`, `graph-routing-fuseki.test.ts` (every read on stores with `isolateLinkedTypeChecks`
  on and off, identical rows):

```
✓ a write lands in the routed graph; the album and the photo it owns
✓ reads join across routed graphs, through a sub-shape graph, and leave the decoys out
✓ a routed subject joined to a default-graph subject (VALUES, no FROM NAMED)
✓ an update changes only the copy in the routed graph
✓ an owned delete stays in its graph
✓ .into() a graph the routing allows; .into() a graph it forbids is refused and writes nothing
```

- **Decision 9's fixture, 10 of 100 graphs.** The benchmark's data (`gen2.mjs`, seed 4242:
  `G100.nq`, 1,016,216 quads in 108 graphs; `B10.nt`, only the 10 graphs' data plus ontology data
  in the default graph) loaded into datasets `k4g100` (10.9 s) and `k4b10` (1.0 s) of the step's
  store. The 10 graphs are routed through core: `CreativeWork`, two sub-shapes on the same class
  and the 18 class shapes of the read set each to their graph (`CreativeWork` → g00, `Article` →
  g00, `NewsArticle`/`BlogPosting` → g01, …), `Person` → g08 and a `Person` sub-shape → g09,
  `ImageObject` (owned through `CreativeWork.image`, `contains`) → g03, and `rdfs:Class` → the
  schema ontology graph. Each DSL query ran against the routed `k4g100` and, as the expected rows,
  against `k4b10` without routes; "merged" reads every named graph of `k4g100`
  (`.from(graphs.union)`, decision 9's "merge every graph"). Median of 20 warm runs, end to end
  through `SparqlDataset` (compile, HTTP, result mapping), after two warm-up runs (first run, before
  the write-rule fix):

```
| query | ideal rows | routed, isolate on | routed, isolate off | routed on ms | routed off ms | ideal ms | merged every graph ms (rows) |
|---|---|---|---|---|---|---|---|
| point | 1 | exact | exact | 5.0 | 5.5 | 5.1 | 6.1 (same rows) |
| page | 50 | exact | exact | 84.0 | 80.6 | 68.0 | 602.9 (same rows) |
| page off 1000 | 50 | exact | exact | 116.0 | 119.2 | 121.4 | 1181.0 (wrong: 50) |
| count | 14235 | exact | exact | 23.9 | 21.5 | 19.8 | 149.0 (wrong: 93653) |
| join | 2162 | exact | exact | 70.0 | 67.5 | 43.2 | 411.7 (wrong: 16713) |
| walk | 14235 | exact | exact | 275.6 | 277.7 | 197.7 | 1331.0 (wrong: 93653) |
| label | 1 | exact | exact | 4.6 | 4.7 | 5.0 | 4.3 (same rows) |
PASS src/tests/zz-k4-fixture.test.ts (19.738 s)
```

  Re-run after the write-rule fix (the read path is unchanged; the store was busier, so all forms
  are slower):

```
| point | 1 | exact | exact | 5.1 | 4.6 | 4.4 | 4.8 (same rows) |
| page | 50 | exact | exact | 102.4 | 98.0 | 80.6 | 733.5 (same rows) |
| page off 1000 | 50 | exact | exact | 147.0 | 143.6 | 150.9 | 1493.9 (wrong: 50) |
| count | 14235 | exact | exact | 50.2 | 30.2 | 27.9 | 190.3 (wrong: 93653) |
| join | 2162 | exact | exact | 83.6 | 77.7 | 50.4 | 469.1 (wrong: 16713) |
| walk | 14235 | exact | exact | 332.9 | 330.2 | 221.1 | 1540.5 (wrong: 93653) |
| label | 1 | exact | exact | 6.9 | 5.1 | 11.4 | 6.6 (same rows) |
PASS src/tests/zz-k4-fixture.test.ts (148.464 s)
```

  Every routed query returned exactly the ideal rows (compared deep, order-free). Queries: point
  `Photograph.select(8 properties).for(photo)` (`GRAPH <g03>` whole); page `CreativeWork.select(name)
  .orderBy(subject).limit(50)` (`FROM NAMED` g00-g09, `GRAPH ?g`); count `CreativeWork` (14,235,
  the benchmark's figure); join `Article.select(a => a.author.name)` (an OPTIONAL author, so 2,162
  rows rather than the benchmark's required-join 1,562; `VALUES ?g_a0 {g00 g01 g02}` for the root,
  `GRAPH ?g_a1` for the author); walk `CreativeWork.select(w => [w.image.name, w.image.contentUrl])`
  (the image reads its owner's graph); label `Photograph.select(p => p.type.label).for(photo)`
  (`GRAPH <g03>` for the photo, `GRAPH <schema ontology>` for the class labels). The DSL emits no
  linked type check, so "isolate on" and "off" compile to the same text. The script (a temporary
  test file, not committed) is in the session scratchpad as `k4/zz-k4-fixture.test.ts`.

## Review

Independent read-only review (opus) of the diff against the step section and §Contracts. Verdict,
quoted: "**Verdict: not clean. There is 1 high finding and 1 medium finding.**"

- **High (decided by the owner, then fixed): routed writes target only the shape's own graph, while
  reads of the same shape cover several graphs.** `resolveWriteGraph` writes by-id and bulk
  mutations into `graphForShape(shape)`, but a subject may live in another graph of the shape's
  read set: a sub-shape's graph (`Person.update(…).for(bob)` where bob was created as an `Employee`
  in the staff graph writes `WITH <people>`: a stray copy in people, staff unchanged;
  `Person.delete(bob)` deletes nothing) or its owner's graph (`GRPhoto.update(…).for(cover)` of a
  cover owned by an album in the albums graph writes the default graph). The reviewer's options:
  (a) find the subject's graph within the read set first (by id) and use `GRAPH ?g` with `VALUES`
  for bulk writes, `MutationEffects.graph` becoming a set; (b) refuse writes through a shape whose
  read set has more than one graph unless `.into()` names one; (c) accept and record it (backlog 067
  and the changeset). The step stopped unlanded; the owner chose (a), resolved inside the same
  update, recorded in master §Contracts at CN `48d5865ff`; implemented as above, with `[fuseki]`
  tests "an Employee changed or deleted as a Person changes only the staff graph" (update, upsert,
  upsert of a missing subject, delete of two ids, bulk delete through the super-shape) and "an
  owned node changed through its own shape is changed in its owner graph; an owned link to a node
  in another graph is refused".
- **Medium (fixed): MINUS with the default graph in the mix never removed default-graph rows.** A
  MINUS right side is evaluated on its own, so its bare `GRAPH ?g` ranged over named graphs only.
  It now starts from an empty binding scope and writes its own `VALUES`; `[fuseki]` test "a MINUS
  with the default graph in the set removes default-graph rows" fails without the fix and passes
  with it.
- Low: fixed — the owned-link check now reads every graph (above); re-pinning without `{graph}`
  keeps the route, now documented (`{graph: graphs.default}` removes it); the
  `namedGraphUriParameter` path no longer enters `withShapeCatalog(undefined)`; a route to a
  store-reserved name is refused at write time. Recorded — the server's
  `Record<GraphQueryErrorCode, number>` in `queryPlane.ts` breaks its typecheck on
  `graph-not-routed` (owned by V2, master §V2; also in the changeset). Accepted as is: OPTIONAL in the default-mixed mode
  relies on Jena substituting into a linear left join; a subject of unknown shape is read in the
  default graph only when every known subject is default-only (it keeps the query unchanged for
  routes that touch none of its shapes); `graphRoutingFor` (and the owner scan) is rebuilt on every
  read (one pass over the registered shapes; a cache needs invalidation on route and shape
  changes).

Re-review of the fixes (same reviewer, `2c894e3..adc163f`), quoted: "**Verdict: one open medium, and
it is a verification gap, not a confirmed defect: no `[fuseki]` test writes to a subject that lives
in the default graph when its shape's read set mixes the default graph with named graphs. The
earlier high and medium are resolved. No other open medium or high.**" Closed with the `[fuseki]`
test "a subject in the default graph, under a mixed read set, is changed and deleted there"
(update, upsert, delete of a person in the default graph and of the default-graph photo, all
landing there, nothing in a named graph). Its lows: `deleteToAlgebra` with several ids and
`writeGraphs` now refuses (`deleteToSparql` splits); the graph variable `g_w` avoids the plan's
variables; the `update_where` owned-link gap and the upsert-with-traversal wrapper are recorded in
backlog 067. Final verdict, quoted: "**Verdict: no open medium or high findings.** Commit e1b2d02
closes my last medium."

Notes: the published server's `Record<GraphQueryErrorCode, number>` in `queryPlane.ts` needs
`graph-not-routed` on its next core bump; master §V2 owns it.

Observed while testing (outside this step): `.minus((p) => p.name.equals('x'))` compiles to a MINUS
whose FILTER reads `?a0_name` without binding it inside the MINUS, so it removes nothing, with or
without graphs.

## Review fixes

Fixes from the final review of CN plan 071's phase 2 (core), in worktree `named-graphs--fixcore`.
Shape-graph fixes (3, 9) are recorded here too and cross-referenced from report 052; the
managed-graph refusal (4) from report 053.

1. **(High) Nested create of a node the mutation does not own.** `createToAlgebra` wrapped every
   triple of a create in the parent's `GRAPH <g>`, while reads find a node reached through a
   non-`contains` property in its value shape's read set. Now (as decided) each nested non-owned
   node is written into its own shape's routed graph in the same update, one `GRAPH` block per
   graph; the link triple stays in the holder's graph; owned (`contains`) and blank nested nodes
   stay with their holder. `SparqlDataset` compiles creates and updates with the routing
   (`writeOptions()`), `irToAlgebra.ts` places nested triples (`NestedPlacement`), and the plans
   carry the other blocks (`SparqlInsertDataPlan.elsewhere`, `SparqlDeleteInsertPlan.insertElsewhere`;
   plain triples for the default graph, the store's name for it under `WITH <g>`). The same holds for
   nested creates in update, upsert and update-where. The owned-link check of a link declared by a
   nested non-owned node reads that node's graph (`OwnedLink.nestedIn`), and `MutationEffects.graph`
   is unknown when a nested node goes to another graph. Fuseki scenario
   (`graph-routing-nested-fuseki.test.ts`): Article → articles, Person → people;
   `Article.create({author: {name: 'Ann', avatar}})` puts Ann and her owned avatar in people, the
   article and its `author` link in articles; `Article.select((a) => a.author.name)` returns "Ann",
   `Person.select()` finds her, `Person.update` changes her there; an update with a new nested
   author lands her in people too. Unit golden checks in `graph-routing-nested.test.ts`.
2. **(Medium) Owners of sub-shapes.** `ownersOf` now also collects the owners of every sub-shape,
   so a shape's read set includes them. Fuseki scenario: Album (albums) `contains cover: Panorama`,
   Panorama extends Photo; `Photo.select()` finds the cover, `Photo.update` and `Photo.delete` of
   the cover run in albums (`VALUES ?g_w { <default> <albums> }`), and the live dependencies of a
   photo read include the albums graph.
3. **(Medium) The one-time default-graph shape cleanup cut incoming links** (report 052).
   `DeleteBuilder.from(NodeShape, {id})` also removed `?s ?p <shape>`. The cleanup now deletes only
   each stale shape's own description (its triples, the blank nodes under them and its owned
   subtree: property shapes, lists, paths, generated shapes) through an internal delete by ids that
   keeps incoming links (`DeleteBuilder._keepingIncoming()`, `IRDeleteMutation.keepIncoming`;
   `toJSON` refuses it). The cleanup stays. `[fuseki]` test "the cleanup deletes a stale shape's own
   description and keeps the links shapes that stay hold to it": a staying default-graph shape keeps
   its `core:isExtending` and `sh:node` links to the cleaned shape (fails without the fix).
4. **(Medium) Routes to managed graphs** (report 053). A route is refused with
   `GraphQueryError('graph-name-read-only')` (the existing code: these graphs are written only by
   their own sync), naming the shape and the graph, when it names a portable name or the registry
   (now typed), a package ontology or shape graph (`…/pkg/{slug}/graph/…`), the app's
   `{DATA_ROOT}/graph/shapes` (`dataGraph('shapes')`) or `{DATA_ROOT}/graph/import/…`: at
   `setShapeGraphs` time for `'own'`, `dataGraph()` and IRIs, and, for a full IRI under the data
   root, when the routing is read (the root is known only then). **Not done: `{DATA_ROOT}/graph/drafts/…`.**
   CN routes its draft shapes (`FormDraft`, `OntologyDraft` and their fields and terms) to
   `{DATA_ROOT}/graph/drafts/forms` and `…/drafts/ontology` with `setShapeGraphs` on
   `AppDataFusekiStore` (`draftGraphRoutes`), so refusing drafts in core would break CN's drafts;
   left routable pending a decision (reported to the master).
5. **(Low) `toJSON` with `.into()`** now throws on create, update and delete builders
   (`queries/intoGraph.ts`), instead of dropping the graph. Published dependents checked: CN calls
   `.into()` only in `formDraftStore.ts` and `ontologyDraftStore.ts`, server-side on the branch
   store (no serialization); the server's `RemoteDataset` ships `toJSON()` and now refuses such a
   builder, which is the intent; server-utils, fuseki and webid.email do not call `.into()`. The test
   "DSL-JSON never carries a write graph: toJSON refuses .into()" replaces the old assertion.
6. **(Low) Echo folding.** `effectsHash` leaves the graph out; `LiveQueryStore` folds a change and
   its echo only when `graphsFold(a, b)` (a missing graph folds with any; two known graphs must be
   equal). Test in `change-sources.test.ts` (fails with the graph in the hash).
7. **(Low)** The dead `GRAPH` branch of `ownedLinkTypesQuery` (the no-routing path, where `ir.graph`
   is never set) is removed with its parameter.
8. **(Low)** Recorded: backlog [070](../backlog/070-graph-routing-per-read-cost.md) (route table
   and owner scan rebuilt on every read; cache per registration version).
9. **(Release)** `files` gains `"!lib/esm/tests"`: the build copies `src/tests` fixtures to
   `lib/esm/tests`. `npm pack --dry-run`: the only `.ttl` files are `lib/esm/data/core.ttl`,
   `npm.ttl` and `shapes.ttl` (412 files, 1.1 MB).

Also (coordinator's request): `DraftGraph`'s comment, its registered description and the
`core:DraftGraph` comment in `core.ttl` describe any draft graph a dataset owns
(`{DATA_ROOT}/graph/drafts/…`), not one app's; `core-shapes.ttl` golden updated.

Observed, not changed: a nested create without `__id` returns `id: ''` for the nested node in the
create result (`mapSparqlCreateResult` maps the IR, whose nested ids are minted only in the
compiler); the default-graph `syncShape` delete → create also removes incoming links of the
rewritten shape (the same cascade as finding 3, outside the cleanup).

Gate (worktree `named-graphs--fixcore` on `named-graphs` at `0797ff3`; own Fuseki
`ghcr.io/linked-fw/fuseki:6.2.0-2` on :3197, compose project `fuseki-071-fixcore`, env exported
before every jest run):

- `node …/_linked-cli/lib/esm/launch.js build`: `✔ Build successful`, 6.3 s.
- `jest`: `Test Suites: 1 failed, 4 skipped, 134 passed, 135 of 139 total`, `Tests: 120 skipped,
  2685 passed, 2805 total`, `Time: 23.359 s` (25.8 s wall), `[fuseki] live tests: 356 total — 356
  passed, 0 failed, 0 skipped`. The failing suite is `two-copies-built.test.ts` ("Jest worker
  encountered 4 child process exceptions, exceeding retry limit"), backlog 060.
- `npm run typecheck`: clean, 3.4 s. `npm run check:dts`: clean, 1.5 s. `npm run test:fuseki`:
  `356 total — 356 passed`, `Time: 9.454 s` (11.7 s wall).
- Without fixes 1 and 2 the new suites fail (`Tests: 10 failed, 9 passed, 19 total`).

## Follow-ups

- Backlog [067](../backlog/067-writes-across-graphs.md): a routed mutation runs in one graph;
  incoming references in other graphs and where-filters that traverse into another graph.
- Backlogs 065 and 066 are resolved here (no linked type checks needed; the default graph through
  `VALUES`) and removed.
- C3 (CN): `AppDataRouter`/the EG register the app's routes on the branch store with
  `setShapeGraphs` (or route through `graphRouting()`), from the clone's
  `linked.backend.datasets.json`.
