---
date: 2026-10-25
summary: >
  `update().for({id})` on an absent id (or an untyped half-node) writes nothing: its WHERE requires
  `FILTER(EXISTS { <id> rdf:type ?t })`, and a routed change's graph lookup finds the subject by its
  type (backlog 039, deleted). Routed reads through `^<p>` read the stored triple in the linked
  node's graph, in selects, where clauses, counts and asks; other complex paths between graphs are
  refused, as on writes (backlog 073, narrowed). Unrouted reads compile byte for byte as before.
  Backlog 079 is new. Minor, with one breaking change.
packages: [core]
---

# 078 — Update on an absent id, routed complex-path reads

## PR

### Summary

Two fixes in core's write and read compilers.

- **Backlog 039: update on an absent id.**
  - Before this change, `update().for({id})` on a node that does not exist wrote its properties
    with no `rdf:type` when the update ran unrouted or under `WITH <g>`. No shape-scoped select can
    find such a node.
  - With a multi-graph route it wrote nothing, and still returned success.
  - Now an update on an absent id is a no-op in every case. Upsert is unchanged.
- **Backlog 073: routed complex-path reads.**
  - Under graph routing, a read through `^<p>` was scoped to the subject's graph. The stored triple
    sits in the other shape's graph, so the read came back empty. Example: `Writer.articles =
    ^author`, with writers in a people graph and articles in an articles graph.
  - Such a read now follows the stored triple.
  - Other complex paths between graphs are refused, as writes already refuse them.

### Changes

**Update on an absent id** (`src/sparql/irToAlgebra.ts` `buildDeleteInsertPlan`, `src/sparql/algebraToString.ts` `graphInWhere`).
- The WHERE of an update by id is wrapped in `FILTER(EXISTS { <id> rdf:type ?t })` (any type).
  - It sits inside `WITH <g>` and inside `GRAPH ?g_w`, so the type is required in the subject's graph.
  - The FILTER form, not a required `<id> a ?t` triple, keeps one solution per node however many types it has. A required triple gave one row per type; a computed `UUID()`/`RAND()` field then wrote several values (review, low).
  - `?t` is renamed if the update already uses that name.
- **The multi-graph lookup** is now `{ SELECT DISTINCT ?g_w … GRAPH ?g_w { <s> rdf:type ?g_w_o } }`, which replaces `<s> ?p ?o`.
  - An untyped half-node no longer counts as the subject, for update, upsert and delete alike.
  - An upsert next to a half-node in another graph of the set creates the node in its routed graph.
  - Delete by id already required `rdf:type <targetClass>` in its WHERE, so its result does not change.
- **A shape without a targetClass is exempt.** Its WHERE stays bare, and its lookup keeps `<s> ?p ?o` (`graphIn.untyped`).
  - The case: core's `ClassAxioms`, which the ontology sync and the hierarchy probe use to write `rdfs:subClassOf` on class nodes that need not be typed.
  - Such a shape cannot be selected, created, upserted or deleted, only updated by id, so "absent" has no meaning for it.
  - Without the exemption, `ontology-sync.test.ts` failed: the default-graph sync wrote no hierarchy.
- **What the result reports.** `mapSparqlUpdateResult` still echoes the id and the fields it was given. A SPARQL update returns no count, so knowing whether anything was updated would cost a second round trip. This is documented in `Shape.update`, `documentation/dsl-json.md` and the changeset, which point to `upsert()`.

**Routed complex-path reads** (`irToAlgebra.ts` `routedPathsTheStoredWay`, called in `selectToAlgebra` before `scopeAlgebraToGraphs`).
- **Which links it collects:**
  - every `traverse` pattern (`traverseNodesIn`, factored out of `mutationTraversals`);
  - every `property_expr` that reads a path as a value (`w.articles`, `w.articles.size()`), bound to the variable the registry gave it;
  - from the projection, the where clause (`EXISTS` included) and `orderBy`.
- **The graph set of each end:**
  - the routed read scope's set;
  - for a node bound only inside `EXISTS`/`MINUS`, its link's value shape's read set (its owner's through `contains`), as `linkedGraphSets` does for writes.
- **What it does with each link:**
  - Ends that both read the same one graph are left alone.
  - A pure `^<p>` is written the stored way round with `storedWayRound`, which reuses the write side's `mapAlgebraTriples` rewrite.
  - Any other complex path is refused by `inverseTraversals(…, 'read')` with `GraphQueryError('unsupported-query-kind')` and a read-specific message. A select wraps it as its error's `cause`.
- **What is not judged:**
  - a literal property (nodeKind `sh:Literal`);
  - an alternative of forward IRIs (`storedWithItsSubject`). Its triples are stored with their subject.
  - On the write side this lifts a refusal: a write through `<a>|<b>` into another graph now runs.
- **Coverage:** count and ask reuse the select algebra, so they are covered too. The pass runs only when routing gives a read scope, so unrouted reads (and `.from()` reads) compile as before.

**Docs.**
- `docs/architecture/ontologies.md`: §Graph routing, reads and writes.
- `documentation/dsl-json.md`: update and upsert.
- Doc comments: `Shape.update`/`upsert`, `IRUpsertMutation`, `ClassAxioms`.
- Changeset `update-absent-id-routed-paths.md`, minor. It states the breaking change.
- Backlog 039 is deleted.
- Backlog 073 is narrowed to what is left (Follow-ups).
- Backlog 079 is new.

**Tests.**
- `update-absent-id.test.ts`:
  - golden SPARQL, unrouted, with one graph (`WITH`) and with several graphs (`GRAPH ?g_w`);
  - the upsert's WHERE, the FILTER after a computed field's BIND, and the targetClass-less shape;
  - `[fuseki]`, in all three cases: an absent id writes nothing, an untyped half-node is not updated, a present id is updated;
  - `[fuseki]`: an upsert still creates an absent node, also next to a half-node.
- `reads-across-graphs-paths.test.ts`:
  - golden SPARQL without routes (taken from the compiler before the change) and with routes, for `Writer.select(w => w.articles.title)`, `.where(w => w.articles.some(…))`, and that where in a count and in an ask;
  - ids and `size()` of the inverse path;
  - an inverse path inside one graph, a sequence inside `EXISTS` within one graph, a literal and an object alternative of forward IRIs (not refused);
  - the sequence refusal (projection, value, where, count);
  - `[fuseki]` for each read, plus the refusal.
- `writes-across-graphs-paths.test.ts`: a write through an alternative of forward IRIs into another graph.
- Goldens updated for the FILTER and the typed lookup: `sparql-mutation-golden`, `mutation-where-union`, `sparql-mutation-algebra`, `graph-routing`, `writes-across-graphs`, `writes-across-graphs-paths`.

### Verification

- **Setup:**
  - a standalone clone at `~/web/scratch/fix-core-a/core`, rebased on `origin/main` at `b17569a`;
  - its own Fuseki, `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3340 (compose project `fuseki-fixa`);
  - every jest run with `FUSEKI_BASE_URL=http://localhost:3340 FUSEKI_ADMIN_PASSWORD=admin FUSEKI_TEST_PORT=3340 LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-fixa REQUIRE_FUSEKI=1` exported.
- **The new tests fail without the fix.** Run with `origin/main`'s `src/sparql`: `Tests: 17 failed, 13 passed, 30 total`. The failures include:
  - `[fuseki]`: `Writer.select(w => w.articles.title)`, the where/count/ask read, the unrouted and one-graph absent ids, and the half-nodes;
  - every routed golden.
- **The review-fix tests fail on the commit before each fix:**
  - `property_expr` links and the EXISTS sets: `4 failed, 14 passed`;
  - literal and alternative paths: `2 failed, 18 passed`.
- **A Jena quirk found on the way.** `WITH <g> … WHERE { OPTIONAL { … } }` matches nothing while graph `<g>` does not exist yet. A probe on a scratch dataset of :3340, since dropped, returned count `0` before the graph existed and `1` after. So the one-graph `[fuseki]` cases seed every routed graph first, or they would pass without the fix.
- **Full gate, after the rebase:**
  - `npx linked build`: `✔ Build successful`.
  - `npm test` (jest 30, then `npm run typecheck`), exit 0:
    - `Test Suites: 4 skipped, 146 passed, 146 of 150 total`;
    - `Tests: 122 skipped, 2951 passed, 3073 total`;
    - `[fuseki] live tests: 415 total — 413 passed, 0 failed, 2 skipped`;
    - the 2 skipped need `LINKED_SECOND_FUSEKI_URL`.
  - `npm run check:dts`: clean.
- **One flaky failure** before the rebase, in one full run: `shape-graphs-fuseki.test.ts` › "a sub-shape's instances still validate against the super-shape" got `sh:conforms true`.
  - It passed alone and in the four full runs since.
  - It validates in a SHACL dataset that other suites share. It is not touched here (report 056 saw the same file flake).

### Deviations

- **Shapes without a targetClass are exempt** from the type requirement (above). The decided fix did not cover them; without the exemption core's own ontology sync breaks.
- **`FILTER(EXISTS { <id> a ?t })` instead of a required `<id> a ?t` triple.** The semantics are the same, with one solution per node (review, low).
- **Reads also judge `property_expr` links,** and EXISTS-only nodes are judged by their value shape (review, medium ×2). An alternative of forward IRIs and a literal are not judged (re-review, medium: a literal alternative path was refused, a regression).

### Review

The reviewer was independent, read-only and ran opus.

- **First review.** Quoted: "2 medium findings and 0 high findings open; not ready to merge until findings 1 and 2 are fixed".
  - Medium: `^<p>` as the last step of a path (`w.articles`, `w.articles.size()`) was neither rewritten nor refused. Fixed, with golden and `[fuseki]` cases.
  - Medium: a complex path inside `EXISTS` whose ends share one graph was falsely refused. Fixed, with a golden case.
  - Lows fixed:
    - one solution per type (FILTER EXISTS);
    - the targetClass-less probe;
    - the misplaced constant;
    - the 073 report reference.
  - Lows answered:
    - delete by id always required its type;
    - `_p` is used again by the untyped probe.
- **First re-review.** Quoted: "1 open medium finding (literal properties with non-simple paths refused under routing, a regression) and 0 high".
  - Fixed: literals are not judged, and an alternative of forward IRIs is stored with its subject. Golden and `[fuseki]` cases added.
  - Lows recorded:
    - a sequence whose ends share one graph (backlog 073);
    - aggregates inside `EXISTS` and in `orderBy`. These were already on `main`; they are backlog 079.
- **Second re-review.** Quoted: "0 open medium/high findings (3 low, 1 info)".
  - Low fixed: a test for a write through an alternative of forward IRIs.
  - Lows not changed:
    - `<p>?` and a negated set of forward IRIs are still refused across graphs, which is conservative;
    - an `sh:IRIOrLiteral` property without a value shape is still judged.

### Follow-ups

- **Backlog [073](../backlog/073-routed-paths-across-graphs.md), narrowed:**
  - a complex path whose ends share one graph but whose middle node lives in another (including a path to a literal through another node);
  - inverse paths under a `.from()` of several graphs;
  - the wide `VALUES` of EXISTS-only nodes;
  - referrers without a value shape;
  - an update-where's shared nested owned node.
- **Backlog [079](../backlog/079-aggregates-inside-exists.md):** a count inside `EXISTS` compiles to an aggregate in a `FILTER`, and `orderBy` on a count orders by the plain variable. Both are on `main` too.
