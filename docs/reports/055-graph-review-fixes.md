---
summary: >
  Fixes from the plan-071 overview review of named graphs and graph routing. The ontology sync
  probes the store before it moves the hierarchy out of the default graph. Graph query conditions
  are now inside the update. A create of a populated unregistered graph is refused. Record-only
  updates report `changed: true`. The registry cache is on `globalThis`. Receivers can refuse
  `keepIncoming`. `'own'` routes work for a package slugged `import`. Live echo folding pairs each
  change with one echo.
---

# 055 — Graph review fixes

## PR

### Summary

The plan-071 overview review (context: reports 048–054, CN report 119) found eight issues in
core. Each was re-checked against the code first; all eight held.

1. **Old-store guard (high).** The ontology sync moved the hierarchy into package graphs and
   deleted the default-graph copy without checking that the store infers from them. On a store
   that does not, class inference stopped silently. Core now probes the store first, by
   behaviour, never by product or version, and moves the hierarchy only when the probe shows the
   store infers from registered graphs.
2. **Conditional create (medium).** The registration check was a separate `ASK` before the
   write. The condition is now part of the update: of concurrent creates exactly one writes and
   the others get `graph-exists`. A replace or patch that loses a race with a drop writes nothing.
3. **Create on a populated graph without a record (low).** It used to drop the content silently.
   It is now refused with `graph-exists`.
4. **Record-only update (low-medium).** It reported `changed: false`. It now reports `true`
   whenever a record field is written (`feedsHierarchy` changes what the store infers, and CN's
   gateway invalidates catalogs on `changed`).
5. **Registry cache across copies (medium-low).** Its state moved to `globalThis` through
   `sharedState`.
6. **`keepIncoming` from clients (low).** The flag is still serialisable. Receivers can now
   refuse it with `{refuseKeepIncoming: true}`.
7. **`'own'` route of a package slugged `import` (low).** It is now allowed. Only a graph named
   exactly like an imported graph is refused.
8. **Live echo folding (low).** Only a local change folds with a remote one, one echo per change.

### Changes

- `src/ontology/hierarchyProbe.ts` (new): `probeHierarchyInference(ds?)` →
  `'named-graphs' | 'default-graph' | 'none'`, plus `resetHierarchyInference(ds?)` and
  `warnOnceForDataset`. The answer is cached per dataset object on `globalThis`. The probe works
  like this:
  1. Sweep probe records older than five minutes (a crashed probe), with their default-graph
     axioms.
  2. Create two temporary `OntologyGraph`s: a data graph
     `{data root}/graph/import/linked-inference-probe-{random}-data` (`feedsHierarchy false`)
     holding `probe:named a probe:Named` and `probe:default a probe:Default`, and a hierarchy
     graph `…-{random}` holding `probe:Named ⊑ sd:NamedGraph`.
  3. Ask, through the `NamedGraph` shape `.from()` the data graph, whether `probe:named` is found.
  4. If it is not, write `probe:Default ⊑ sd:NamedGraph` into the default graph and ask about
     `probe:default`.
  5. In `finally`, best effort: remove the axiom and drop both graphs. When the axiom cannot be
     removed, the graphs stay as the marker for the next sweep.
- `src/ontology/syncOntologies.ts`: the sync acts on the probe's answer.
  - `'named-graphs'`: package graphs, and the default-graph hierarchy is removed, as before.
  - `'default-graph'` and `'none'`: package graphs plus the default-graph sync. The sync nodes are
    kept, and one warning per dataset says what degrades.
  - A probe refused with `unsupported-query-kind`: the existing default-graph fallback.
  - Any other probe failure: one warning, then handled as `'none'`.
  - A package-graph create refused with `graph-exists` (another process won the race, or the graph
    holds triples without an `OntologyGraph` record) is replaced, or dropped and created again.
  - The `wroteGraph` flag is gone, because the probe is now the first graph query.
- `src/sparql/graphQueryToSparql.ts`: every operation carries its condition.
  - Create: `DELETE … WHERE { … FILTER NOT EXISTS {record} FILTER NOT EXISTS {GRAPH g {?s ?p ?o}} }`,
    then `INSERT { body + record + claim } WHERE { same filters }`.
  - Replace and patch: every `DELETE` joins the record pattern (`sd:name`, plus
    `a <recordClass>` unless the class is `sd:NamedGraph`), and every `INSERT` has
    `WHERE { FILTER EXISTS {record} }` (at most one solution, so a body's blank nodes are written
    once). `DROP` became a conditional `DELETE`.
  - New helpers: `graphCreateOutcomeQuery`, `graphCreateClaimRemoval` and `GRAPH_CREATE_CLAIM`.
- `src/sparql/SparqlDataset.ts` `graphQuery`:
  - Create: no pre-`ASK`. The update runs, then one SELECT reads `?claimed ?registered ?populated`
    (`true` or `1`), then the claim is removed (best effort) or the create is refused.
  - The default registry key counter is in `sharedState`, so two copies of core never mint the
    same key now that the cache is shared.
  - Replace and patch keep their pre-`ASK` for the typed `graph-not-registered`.
  - `changed` is also true when record fields are written.
- `src/queries/IntermediateRepresentation.ts`: `GraphResult.changed` doc.
- `src/utils/graphRegistryCache.ts`: `sharedState('@_linked/core', 'graphRegistryCache', …)`.
- `src/queries/MutationSerialization.ts`: `InboundMutationOptions` (`refuseKeepIncoming`), taken
  by `readKeepIncoming`, `DeleteBuilder.fromJSON`, `fromJSON` (`FromJSONOptions`) and
  `lowerMutationJSON`. It is exported from the root.
- `src/utils/graphRouting.ts`: `'own'` paths go through `checkOwnPath`. It refuses only
  `graph/import/{lower-case slug}`. `dataGraph()` and full IRIs keep the old check.
- `src/live/LiveQueryStore.ts`, `src/live/changes.ts`: `_recentChanges` holds a list per hash.
  A change folds only with the opposite side (local ↔ `feed`/`app`) and uses up the entry it
  folds with.
- Docs:
  - `README.md` "Store requirements" is rewritten: what core needs, what polymorphic reads need,
    stores that infer over all graphs, what degrades without inference, and that the Fuseki image
    is one implementation.
  - `docs/architecture/ontologies.md`: the probe, the conditional graph queries, `changed`, and
    `'own'` routes.
  - `documentation/dsl-json.md`: `refuseKeepIncoming`.
- Tests:
  - New `hierarchy-probe.test.ts`, with stub stores for each outcome, the cache, cleanup on
    failure and the sync per outcome.
  - `ontology-sync-fuseki.test.ts` adds outcome `'none'` on a `mem` dataset of the image, which
    runs in CI. With `LINKED_SECOND_FUSEKI_URL` it also runs against a second server.
  - `graph-query-fuseki.test.ts`: four concurrent creates ×5 rounds, replace vs drop ×8 rounds,
    and create on a populated unregistered graph.
  - Unit tests: `graph-query.test.ts` (exact SPARQL), `read-graphs.test.ts` (cache on
    `globalThis`), `change-sources.test.ts` (folding), `graph-routing-nested.test.ts` (`'own'` of
    `import`, `refuseKeepIncoming`), and `two-copies-built.test.ts` (registry cache across copies).
  - Helpers: `graphCreateOutcomeAnswer`, `inferenceProbeAnswer` and `isInferenceProbeGraph` in
    `test-utils.ts`, and a `dbType`/`baseUrl` option on `createDataset`.
- Changeset `graph-review-fixes.md` (patch).

### Verification

Worktree `chard`. The run used its own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3312
(compose project `fuseki-chard`), with `FUSEKI_BASE_URL=http://localhost:3312
LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-chard REQUIRE_FUSEKI=1` exported. A second server ran on
:3313 (compose project `fuseki-chard-old`).

- Without the graph-query fix (`SparqlDataset.ts` and `graphQueryToSparql.ts` from `origin/main`),
  the new live tests fail: `✕ of two concurrent creates of one graph exactly one writes; the other
  gets graph-exists`, `✕ a replace racing a drop leaves the graph either replaced or gone, never a
  half record`, `✕ create of a graph that holds triples without a record is refused and keeps them`.
  With it, they pass.
- The probe on real stores:
  - `6.2.0-2` answers `named-graphs`.
  - A `mem` dataset on it answers `none`.
  - Stock `secoresearch/fuseki:6.2.0` on :3313 (`LINKED_SECOND_FUSEKI_URL=http://localhost:3313`)
    answers `none`: `✓ the probe answers what the store infers from, and leaves nothing behind`,
    `✓ the sync keeps the hierarchy in the default graph and warns once`.
  - `ghcr.io/linked-fw/fuseki:6.2.0-1` on :3313 (`LINKED_SECOND_FUSEKI_EXPECTS=default-graph`)
    answers `default-graph`, and both tests pass.
- `npx linked build`: `✔ Build successful`. `npm run check:dts`: clean. `npm run typecheck`: clean.
- `npm test`: `Test Suites: 1 failed, 4 skipped, 135 passed, 136 of 140 total`, `Tests: 120
  skipped, 2724 passed, 2844 total`, `[fuseki] live tests: 366 total — 366 passed, 0 failed, 0
  skipped`. The one failed suite is `two-copies-built.test.ts`: `Module cache already has entry
  …/lib/esm/shapes/SHACL.js. This is a bug in Jest` (backlog 060). It fails the same way in the
  main checkout on `main`.

### Deviations

- Outcome `'default-graph'` behaves like `'none'`: package graphs plus the default-graph
  hierarchy. That was the coordinator's answer to a question the first version raised, so
  `graphs.allOntologies` reads the same on every store with named graphs.
- A create cannot learn from a SPARQL update whether its condition held. It therefore writes a
  one-time claim (`core:graphCreateClaim "<uuid>"`) on the record, reads it back and removes it.
  A create is three requests (update, SELECT, claim removal) instead of two (ASK, update). If a
  process dies between the update and the removal, one claim triple stays on the record. Readers
  ignore it, and the next drop removes it.
- The probe graphs are named `{data root}/graph/import/linked-inference-probe-{random}[-data]`,
  import-kind names, both recorded as `OntologyGraph` (import graphs are ontologies fetched by
  URL). CN's gateway rule is being changed to admit `OntologyGraph` records under `graph/import/…`.
  Their records name the package `@_linked/inference-probe`.
- A create on a populated graph without a record uses the existing `graph-exists` code, with its
  own message, so no new error code is added.

### Review

An independent read-only review found two high and five medium findings.

- Fixed (high): the per-instance registry key counter was module state, so two copies would
  both mint `sparql-dataset:0` in the shared cache. It is in `sharedState` now.
- Fixed (high): the probe put the instance in the graph that holds the axiom, so a store that
  infers only within each graph would pass. The instances are now in a second graph that does not
  feed the hierarchy. Re-measured: 6.2.0-2 still answers `named-graphs`, 6.2.0-1
  `default-graph`, stock 6.2.0 `none`.
- Fixed (medium): a package-graph create that loses a race, or meets a record-less graph, no longer
  fails the sync.
- Fixed (medium): the create outcome accepts `1` as well as `true`.
- Fixed (medium): probe cleanup is best effort in `finally` and is backed by the stale-probe sweep;
  claim removal is best effort.
- Fixed (medium): `'default-graph'` writes package graphs too (the coordinator's decision).
- Not changed (medium): "a replace that loses a race with a drop reports success". The replace's
  call started before the drop committed, so ordering it before the drop is a valid
  linearisation, and the final state (graph and record gone) is the same.
  `noteGraphQuery` does not touch the cache for a replace, so nothing is resurrected there.
- Low, applied: `FILTER EXISTS` on inserts; warnings keyed like the probe cache, shared across
  copies and reset with it. Not applied: one shared regex for the import slug (core and CN keep
  the same pattern), and a retry for stores that apply `feedsHierarchy` asynchronously
  (`resetHierarchyInference` re-probes).

### Follow-ups

- CN passes `{refuseKeepIncoming: true}` on its gateway and generic plane, in a CN change. CN's
  `appGatewayRoutes` already invalidates catalogs on `changed`, which now covers record-only
  updates.
- `two-copies-built.test.ts` crashes in jest locally: backlog 060.
