---
summary: >
  Routed writes across graphs (backlog 067). A delete by id removes the links to its subject in
  every graph that may hold one (`GRAPH ?g_in`). Where clauses (EXISTS included) and computed
  fields read a linked node in its shape's graphs, in a block nested in the mutation's graph. An
  inverse path is read the stored way round; other complex paths into another graph are refused.
  An update-where that links an owned node is checked against the owners' graph, or refused when
  the owners may live in several. Unrouted SPARQL is unchanged byte for byte.
packages: [core]
---

# 056 — Writes across graphs

## PR

### Summary

Under graph routing a mutation ran in one graph (`WITH <g>`, or `GRAPH ?g_w { … }` when the
subject's graph is found at write time). With persons in a people graph and articles in an
articles graph, that broke three things:

- `Person.delete({id})` left the article's `author` link behind.
- `Article.update(…).where((a) => a.author.name.equals('x'))` and the matching `deleteWhere`
  matched nothing.
- A computed update (`a.author.name.ucase()`) read nothing.

This change fixes all three by the owner's direction of 2026-10-24. It is still one update per
mutation, and apps without routes compile the same SPARQL, byte for byte.

### Changes

**Delete by id.**
- The links to the subject are removed in every graph that may hold one: the read sets of the
  shapes that declare a property whose value shape is the deleted shape, a super-shape or a
  sub-shape of it, plus the subject's own graph set.
- Code: `referringGraphsForShape` in `utils/graphRouting.ts`, `incomingReferenceGraphs` in
  `irToAlgebra.ts`.
- The WHERE gets a UNION branch `VALUES ?g_in { … } GRAPH ?g_in { ?s ?p2 <id> }` inside the plan's
  graph, and the DELETE gets a `GRAPH ?g_in { … }` template (`SparqlDeleteInsertPlan.deleteInGraphs`).
  Rows from the other branches leave `?g_in` unbound, so that template is skipped for them.
- A delete that keeps incoming links and the bulk deletes are unchanged; bulk deletes never removed
  incoming links.
- When the set is only the plan's own graph, the old form is kept.

**Linked nodes in a WHERE** (`update_where`, `delete_where`, computed fields of `update`/`update_where`).
- The traversals come from `traversalPatterns`, `wherePatterns` and the patterns of `EXISTS`
  expressions (`mutationTraversals`).
- Each variable bound through a link gets its value shape's read set (`linkedGraphSets`).
  - Through `contains`, a variable keeps its owner's graph.
  - A property without a value shape gives every graph.
- `scopeMutationWhere` (`graphScope.ts`, a mutation mode of the routed reads' scoper) leaves the
  subject's patterns in the plan's graph and nests a block for each linked node:
  - plain triples when the node's set is the subject's one graph;
  - `GRAPH <g>` for one other graph (the default graph under the store's name for it);
  - `VALUES ?g { … } GRAPH ?g { … }` for several.
- The templates stay in the subject's graph. A plan whose links all stay in the subject's one graph
  is returned unchanged.
- **Inverse paths.** An inverse path `^<p>` into another graph is rewritten as the stored triple
  `?linked <p> ?subject` and read with the linked node.
- **Other complex paths** (a sequence, an alternative, a repetition) into a node in another graph
  are refused with `GraphQueryError('unsupported-query-kind')`. Their middle nodes have no graph to
  be read in.

**An update-where that links an existing node into a `contains` property** (`checkOwnedLinks`).
- **The rule:** an owned node lives in its owner's graph.
- **One graph:** when the shape's read set is one graph, or `.into()` names one, the node must be
  typed in that graph, as for a change by id. Before this change nothing was checked.
- **Several graphs:** the owners may live in any of them and the node in one, so the update-where
  is refused with `GraphQueryError('unsupported-query-kind')` before any query is sent. The message
  points at `.into()` and `.for(id)`.

**The upsert case of backlog 067 is unreachable.**
- The backlog item: an upsert's `OPTIONAL { GRAPH ?g_w { … } }` wrapper, where a computed value
  through a traversal would no longer stop the constant inserts.
- An upsert refuses expression-valued fields (`assertNoExpressionFields` in `IRMutation.ts`, on the
  builder path and the DSL-JSON path alike), so its IR never carries traversals. Nothing was changed.

**Live queries.** `MutationEffects.graph` is unknown for a routed delete by id whose links may be
held in another graph (`queryDependencies.ts`).

**Docs and changeset.**
- `docs/architecture/ontologies.md` §Graph routing, writes.
- Backlog 067 deleted.
- Backlog 073 is new: routed paths across graphs.
- Backlog 070 gains the delete scan.
- Report 051 and plan 004 point here.
- Changeset `writes-across-graphs.md`, minor: it lists the behaviour changes.

**Tests.**
- `writes-across-graphs.test.ts`:
  - golden SPARQL for eight mutations without routes, equal to the strings the compiler produced
    before this change;
  - the same eight with routes;
  - an unrouted shape's delete, keep-incoming, the `mapGraphName` refusal, and live-query effects.
- `writes-across-graphs-paths.test.ts`:
  - golden SPARQL for an inverse path with EXISTS, the default graph under `WITH`, a traversal from
    a linked node, `contains` below a linked node, the `GRAPH ?g_w` form, and both refusals;
  - golden SPARQL for a computed field through an inverse path, by id and in an update-where;
  - `[fuseki]` cases for each of these.
- `writes-across-graphs-owned.test.ts`: the update-where owned-link rule.
- `writes-across-graphs-fuseki.test.ts`: the four cases asked for, plus a default-graph subject, a
  cover found in its owner's graph, and an employee found at write time.

### Verification

Worktree `../wt/c067` (`main--c067`, rebased on `origin/main` at `7faa99f`), own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3311
(compose project `fuseki-c067`). Every jest run used a wrapper that exports
`FUSEKI_TEST_PORT=3311 FUSEKI_BASE_URL=http://localhost:3311
LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-c067 REQUIRE_FUSEKI=1`, except the incidents below.

- **Unrouted byte-identity, measured before the tests were written:**
  - Eight mutations were compiled without routes on `main` (changes stashed) and with the change;
    `cmp` printed `UNROUTED-IDENTICAL`.
  - The eight mutations: delete by id, delete of two ids, update-where and delete-where through a
    link, the same through `some()`, a computed update by id, and a computed update-where.
  - These strings are the golden values in `writes-across-graphs.test.ts`.
- **The new tests fail without the fix:**
  - Fuseki suite on the code before the change: `Tests: 9 failed, 1 passed, 10 total`; the one that
    passes is keep-incoming.
  - Owned-link suite without the `SparqlDataset` change: `3 failed, 2 passed`.
  - Paths suite on the first commit, before the inverse fix: `3 failed, 7 passed`.
  - Paths suite without the computed-field inverse fix: `2 failed, 10 passed` (its two new cases).
- **Full gate**, after the rebase:
  - `npx linked build`: `✔ Build successful`.
  - jest without `two-copies-built`: `Test Suites: 4 skipped, 139 passed, 139 of 143 total`,
    `Tests: 122 skipped, 2771 passed, 2893 total`, `[fuseki] live tests: 380 total — 378 passed, 0
    failed, 2 skipped`.
  - The 2 skipped are `ontology sync on a second store`, which needs `LINKED_SECOND_FUSEKI_URL`
    (from `origin/main`).
  - `npm run typecheck`: clean. `npm run check:dts`: clean.
  - `two-copies-built.test.ts` alone: `Module cache already has entry
    …/lib/esm/shapes/SHACL.js.` (backlog 060, known).
- **One flaky failure:**
  - `shape-graphs-fuseki.test.ts` failed once in one full run, and passed alone and in the next
    three full runs. It writes shape graphs, not routed data mutations.
  - Its message was not captured.

**Jena probes**, raw updates on a scratch dataset of :3311 (since dropped). These are what the
nested design rests on:
- Inside `WITH <g>` or `GRAPH ?g_w { … }`, a nested `GRAPH <urn:x-arq:DefaultGraph>` reads the real
  default graph, and so does `VALUES ?g { <urn:x-arq:DefaultGraph> … } GRAPH ?g`.
- A `GRAPH ?g_in` template with `?g_in = urn:x-arq:DefaultGraph` under `WITH` deletes from the
  default graph and creates no named graph.
- A first version dropped the wrapper and wrote the subject's patterns as separate `GRAPH ?g_w`
  blocks. On Fuseki it did not delete a default-graph photo found through the lookup: `?g_w` was
  not carried into the later blocks. It was replaced before review.

**Incidents.**
- **One run reached :3939.** A probe jest run started without the env reached
  `http://localhost:3939`. Its global setup deleted any `nashville-test-*` datasets and the
  inference probe dataset there, found that store does not infer, and stopped. After that, every
  run went through the self-contained wrapper.
- **Some runs may have reached :3315.** Early on, the env file in the shared session scratchpad was
  overwritten by another agent with `FUSEKI_BASE_URL=http://localhost:3315`. Some early probe and
  suite runs that sourced it may have run against :3315: they created and dropped
  `nashville-test-*` datasets there and deleted leftovers with that prefix.
- **What could not be checked.** Reading the datasets on :3939 and :3315 was refused by the session
  permissions. Data outside the `nashville-test-` prefix is never touched by these helpers.

### Deviations

- **The base `Shape` counts as a super-shape** (as directed). Core's own shapes declare properties
  whose value shape is `Shape`, so under any routes a delete by id also removes links in the default
  graph. That means:
  - a routed store needs `mapGraphName` for deletes (documented in the changeset);
  - routed deletes never carry a `MutationEffects.graph`.
- **Properties without a value shape** are not counted as referrers (backlog 073).
- **An inverse path is rewritten, other complex paths are refused.** The direction did not cover
  complex paths; the review found the inverse case (below).

### Review

Independent read-only review (opus) of the first commit, quoted: "Verdict: two medium findings are
open (1 and 2) and no high ones."

- **Medium — inverse and complex paths in where clauses still read in the subject's graph.**
  - Fixed: an inverse step is read the stored way round in the linked node's graph, and other
    complex paths into another graph are refused.
  - Tests: golden and `[fuseki]` "an inverse path into the articles graph matches the writer". It
    fails without the fix.
  - The same issue in routed reads, and a sequence whose target is in the subject's graph:
    backlog 073.
- **Medium — the tests do not prove EXISTS across graphs, the default graph under `WITH`, the
  `GRAPH ?g_w` form, nested traversals, `contains` below a linked node or the `mapGraphName`
  refusal.**
  - Fixed: golden cases for each, and `[fuseki]` cases for the inverse EXISTS, the default graph
  under `WITH`, the two-hop EXISTS and the owned avatar below a linked author.
  - A property without a value shape is not reachable through the DSL beyond an id comparison,
    which reads nothing in another graph, so it has no test.
- **Low findings.**
  - Fixed:
    - the scoper reserves the plan's graph variable and its companions;
    - the subject aliases are passed in by the callers;
    - stale comments are updated;
    - the incoming-links refusal has its own message.
  - Recorded:
    - the per-delete shape scan (backlog 070);
    - referrers without a value shape and the update-where's shared nested owned node
      (backlog 073);
    - the base-`Shape` consequence (Deviations).

**Re-reviews (same reviewer).**
- **First re-review**, quoted: "Verdict: one medium finding is open (computed-field inverse first
  hop); there are no high findings."
  - The finding: the rewrite matched on the subject alias, while a computed field's first hop
    starts from `<id>` or `?a0`. It removed the old value and inserted nothing.
  - Fixed: the rewrite now matches the traversal's target alias. Golden and `[fuseki]` cases fail
    without the fix.
- **Second re-review**, quoted: "Verdict: no medium or high findings are open."
  - Lows fixed: this section, the gate numbers, and the golden check, which now names the subject
    of each run.

### Follow-ups

- Backlog [073](../backlog/073-routed-paths-across-graphs.md): routed reads through inverse and
  complex paths, sequences whose target is in the subject's graph, referrers without a value
  shape, and an update-where's shared nested owned node.
- Backlog [070](../backlog/070-graph-routing-per-read-cost.md): the delete's referrer scan, with the
  routing cache.
