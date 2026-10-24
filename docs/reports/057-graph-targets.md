---
summary: >
  Configurable graph targets: `ontologyGraph` and `shapeGraph` store settings ('package', 'default'
  or a shared graph IRI; env LINKED_ONTOLOGY_GRAPH / LINKED_SHAPE_GRAPH filled by hosts). Shared
  graphs rebuilt whole; 'default' replaces every package-owned term in the default graph in one
  update; readers follow the mode; other modes' data is warned about, never moved.
packages: [core]
---

# 057 — Graph targets for ontologies and shapes

## PR

### Summary

The owner's decisions of 2026-10-24: where the ontology and shape syncs write is a per-store
setting, one string each.

- `ontologyGraph` / `shapeGraph`: `'package'` (default, unchanged), `'default'`, or an absolute
  graph IRI. Set by `SparqlOptions`, `store.setGraphTargets()`, or a datasets config entry's
  `config` (`loadStores`). A host fills unset ones from `LINKED_ONTOLOGY_GRAPH` /
  `LINKED_SHAPE_GRAPH` through `graphTargetOptionsFromEnv(env)` or `loadStores(config,
  {graphTargets})`; core never reads `process.env` for them. Invalid values fail when the store is
  built, naming the setting and its source.
- **Shared IRI.** One `OntologyGraph` (`feedsHierarchy` true) or `ShapesGraph` holds every package,
  rebuilt whole in one graph query when the combined hash changes. The record lists `packageHashes`
  (new field `core:packageHash`, `"{package} {sha256}"`) and `sources` (`{package}/{file}`).
- **`'default'`.** Ontology: one update (`IDataset.replaceDefaultGraphTerms`, new and optional,
  implemented by `SparqlDataset`) deletes every package-owned term (subjects under a registered
  ontology namespace plus the subjects of the current Turtle, with outgoing triples and blank nodes
  down to 8 steps, through blank nodes only) and inserts every package's data and the combined hash
  (`https://linked.cm/pkg/core/ontology-sync/default-graph`). Shapes: `syncShapes`, whose rewrite now
  keeps the links others hold to the shape (`_keepingIncoming`).
- **Readers.** `expandReadGraphs` maps `graphs.allOntologies` / `graphs.allShapes` through the
  store's targets (package graphs, the shared graph, or the default graph).
- **No copies.** Each sync reads the other modes' markers and logs one warning naming what it found;
  it never moves data. The package mode's existing one-time cleanup of the old default-graph layout
  stays.
- **Probe.** Unchanged for package and shared modes (only before a write). `'default'` mode uses
  `probeDefaultGraphInference`: an axiom and instance written into the default graph, asked through
  the `OntologySync` shape, removed. Warns only.
- Results gain `target` and `fallback`. Docs: README "Store requirements" and the new "Ontology and
  shape graphs" section (modes, env variables, Turtle as the source of a package's terms, clearing
  before switching, CN-managed apps use `package`); `docs/architecture/ontologies.md`.

### Changes

- New: `src/utils/graphTargets.ts`, `src/queries/defaultGraphTerms.ts`,
  `src/sparql/defaultGraphTerms.ts`.
- `src/ontology/syncOntologies.ts` (shared and default modes, warnings, `target`),
  `src/shapes/syncShapeGraphs.ts` (the same), `src/shapes/syncShapes.ts` (keep-incoming rewrite),
  `src/ontology/hierarchy.ts` (`defaultGraphTermsFromTurtle`), `src/ontology/hierarchyProbe.ts`
  (`probeDefaultGraphInference`), `src/sparql/SparqlDataset.ts` (options, `graphTargets`,
  `setGraphTargets`, `replaceDefaultGraphTerms`, readers), `src/utils/graphRegistryCache.ts`,
  `src/utils/loadStores.ts`, `src/interfaces/IDataset.ts`, `src/queries/graphRecords.ts`,
  `src/shapes/NamedGraph.ts`, `src/data/core.ttl`, `src/ontologies/linked-core.ts`.
- Tests: `graph-targets.test.ts` (values, env, store option, `loadStores`, readers, golden sweep
  SPARQL `fixtures/default-graph-terms.sparql`, blank-node analysis), `graph-targets-fuseki.test.ts`
  (every mode × ontology and shapes, the sweep, unchanged syncs, the shared rebuild, warnings, the
  default-graph probe), `graph-targets-measure-fuseki.test.ts`. Existing sync tests use
  `toMatchObject` (results carry `target`); `core-shapes.ttl` golden gains `packageHashes`.
- Changeset `graph-targets.md` (minor).

### Verification

Worktree `gmode`, own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3318 (compose project
`fuseki-gmode`), env `FUSEKI_BASE_URL=http://localhost:3318 FUSEKI_TEST_PORT=3318
LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-gmode REQUIRE_FUSEKI=1` exported before each jest run.

- `npx linked build`: `✔ Build successful`.
- `npm test`: `Test Suites: 1 failed, 4 skipped, 142 passed, 143 of 147 total`, `Tests: 122 skipped,
  2819 passed, 2941 total`, `[fuseki] live tests: 398 total — 396 passed, 0 failed, 2 skipped`. The
  failed suite is `two-copies-built.test.ts`: `Module cache already has entry
  …/lib/esm/shapes/SHACL.js. This is a bug in Jest` (backlog 060, known).
- `npm run typecheck`, `npm run check:dts`: clean.
- Measurement: `[measure] ontologyGraph 'default', 20000 instance triples beside it: first sync 152
  ms, changed 157 ms (1 update), unchanged 15 ms (0 updates); 953 schema.org triples`.

### Deviations

- `packageHashes` is a new record field (`core:packageHash`) rather than an encoding inside
  `sources`, so the decision's "package hashes on the record" has a field of its own.
- The `'default'` ontology mode refuses, before writing: a blank node no IRI subject links to, a
  structure deeper than 8 blank-node steps, a namespace that does not end in `/` or `#` or that holds
  the data root or a registered shape, and a store without `replaceDefaultGraphTerms`. In the shared
  and default modes an unreadable package skips the rebuild with a warning.
- Shared IRIs that name a package's own graph (`…/pkg/{slug}/graph/{ontology|shapes}`) are refused.
- The shared shape graph always includes the app's generated shapes; `packages` names every package
  it holds.

### Review

An independent read-only review found one high and four medium findings.

- Fixed (high): `packages` in the shared shape mode — documented as naming every package the graph
  holds (the server passes all packages with Turtle); written/pruned report it.
- Fixed (medium): a shared shape sync without `appShapes` dropped the app's shapes; they are always
  part of the shared graph now (test added).
- Fixed (medium): the README now says what the `'default'` sweep cannot see (a foreign subject a
  package drops, terms of an unregistered package) and that those need clearing by hand.
- Fixed (medium): the earlier default-graph sync's `OntologySync` nodes, which a `'default'` rebuild
  replaces with core's namespace, are named in its warning.
- Measured (medium, sweep performance): above.
- Low, applied: wording of the blank-node walk and the probe leftover, `appGraphOf` excludes the
  shared graph, `'default'` shapes ignoring `packages`/`orphanScope` documented, namespace and
  shared-IRI checks.
- Incident: the reviewer ran a unit test file, and jest's global setup reached the default
  `http://localhost:3939` store (another agent's, `tests-fuseki-1`): it ran `reapTestDatasets`
  (datasets named `nashville-test-*` and the probe dataset) and the inference probe, then aborted.
  The reviewer's environment did not have the Fuseki env exported.

### Follow-ups

- `@_linked/fuseki`'s `FusekiStore` does not pass `ontologyGraph` / `shapeGraph` from its config to
  `SparqlOptions`; it gets them from `loadStores` (entry config) or the server (env). A fuseki
  change could take them in its constructor too.
- `'default'` mode could record the subjects it wrote on the hash node and sweep them next time,
  so dropped foreign subjects and unregistered packages' terms go too (beyond the decisions).
