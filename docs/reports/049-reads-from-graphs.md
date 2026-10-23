---
summary: >
  `.from(graph | graph[])` on select, count and ask builders (DSL-JSON and IR field `graphs`);
  `SparqlDataset` expands portable names (`graphs.allOntologies`/`allShapes` from a per-process,
  per-dataset graph-registry cache updated by its own graph queries, dropped by
  `invalidateGraphRegistry`, re-read after 30 s; `graphs.default` alone as today; `graphs.union`
  through `mapGraphName`) and compiles one graph as `GRAPH <iri>`, several as `FROM NAMED` with one
  `GRAPH ?g` block per subject; the store option `isolateLinkedTypeChecks` (second block for a
  linked type check, inert today). CN plan 071, sub-plan 004.
packages: [core]
---

# 049 — Reads from graphs

## Why

CN plan 071 moves each package's ontology data into its own named graph. Readers of labels and
classes (CN's term readers first) must then read those graphs, and the routed reads of phase 2
need the generator that does it cheaply. Decision 9 of the master plan settled the form: one
`GRAPH ?gN` block per subject group inside a `FROM NAMED` set the store adds, a fixed `GRAPH
<iri>` for one graph, and a store option for a second block on linked type checks. Sub-plan
[004](../plans/004-named-graphs.md) §K2 holds the plan-mode detail and the contract.

## What

**DSL, JSON and IR.** `SelectBuilder.from(graph | graph[])` (an instance method; the static
`from(shape)` stays), `CountBuilder.from`, `AskBuilder.from` (shapeless asks too); `.count()`
and `.exists()` keep the set. The names are checked once (`queries/readGraphs.ts`: a non-empty
list of absolute IRIs, duplicates dropped, order kept), travel as `graphs: string[]` in each
envelope (a non-array is refused on receipt) and land on `IRSelectQuery`/`IRCountQuery`/
`IRAskQuery.graphs` as written. Lowering attaches them after the pattern pipeline.

**The generator** (`sparql/graphScope.ts`, called at the end of `selectToAlgebra`; counts and
asks reuse it). No set: unchanged. One graph: `GRAPH <iri> { whole pattern }`. Several: each basic
graph pattern is split into one `GRAPH ?g_<subject> { … }` block per subject, in first-appearance
order, inside OPTIONAL, MINUS, UNION, sub-select and EXISTS patterns alike; the graph variable is
per subject, so an OPTIONAL block of a bound subject joins on its graph; graph variables never
reuse a query variable. The plan gets `dataset: {fromNamed}` and `algebraToString` writes
`FROM NAMED <g>` after `SELECT …` / after `ASK`. `SparqlGraph` takes `{variable}` besides `{iri}`.
The generator refuses an empty set and the names only a store resolves. `NamedGraph.select()`
reads `graphs.registry` through the same path (the shape's `storedInGraph` is the default set).

**`isolateLinkedTypeChecks`** (`SparqlOptions`, per store): in a block of a subject reached
through a link (a variable that is some triple's object) holding a type triple and a stored
triple, the type triples move to a second block on the same variable. The decision-9
explanation sits next to the code. The select generator emits no linked type check today (only
the root's, and `MINUS` shape exclusions on the root), so the option changes no query the DSL
builds; the tests add a type triple to a generated algebra (backlog 065).

**The store** (`SparqlDataset`). `selectQuery` and `askQuery` resolve `ir.graphs` before
compiling (`resolveReadGraphs`, through `utils/graphRegistryCache.ts`'s `expandReadGraphs`):

| Name | Read as |
|---|---|
| a graph IRI, `graphs.registry` | itself |
| `graphs.allOntologies`, `graphs.allShapes` | every graph the registry lists with an `OntologyGraph` / `ShapesGraph` record, sorted |
| `graphs.default` alone | the default graph, exactly as without `.from()` |
| `graphs.union` alone | `mapGraphName(graphs.union)` (Jena `urn:x-arq:UnionGraph`); refused without it |
| `graphs.default` or `graphs.union` with other graphs | refused, `unsupported-query-kind` (below) |

A set that expands to no graph answers `[]`, `0` or `false` without a request (an empty
`FROM NAMED` would be no restriction at all).

**The registry cache** (`utils/graphRegistryCache.ts`, pure). Per process, keyed by dataset: one
`SELECT ?g ?c WHERE { GRAPH <registry> { ?g sd:name ?g ; a ?c } }` per load, concurrent reads
share one load; `noteGraphQuery` after every successful `graphQuery` of the store (a create adds
the graph under its record class, a drop removes it; with a load in flight the entry is dropped);
`invalidateGraphRegistry(key?)` (package export) and `SparqlDataset.invalidateGraphRegistry(dataset?)`
(default: the store's key) drop it, and an invalidation during a load is not undone by that load;
an entry older than `GRAPH_REGISTRY_MAX_AGE_MS` (30 000) is re-read. A store keys the cache with
the protected `graphRegistryKey()`: one key per instance by default; core's test `FusekiStore`
uses `{baseUrl}/{dataset}` (F2's `FusekiStore` should do the same, and V1's push passes that key).

## Deviations from the sub-plan

- **`graphs.default` (and `graphs.union`) in a set with other graphs is refused.** Measured on
  the step's store (`linked-fuseki:071`), Jena's `FROM NAMED <urn:x-arq:DefaultGraph>` matches
  nothing while `GRAPH <urn:x-arq:DefaultGraph>` alone and `VALUES ?g { <urn:x-arq:DefaultGraph>
  … }` work; `FROM NAMED <urn:x-arq:UnionGraph>` matches nothing too. Decision 9's phase-2 limit
  ("the store adds it to the set under its own name") does not hold on Jena; K4 must use `VALUES`
  or another form (backlog 066, with the probe output). `mapGraphName` is therefore only used for
  `graphs.union` alone.
- `graphs.allShapes` is expanded already (the same registry read; it lists nothing until K5).
- The DSL-level identical-rows test compares identical text (backlog 065); a second
  `[fuseki]` test runs both forms of a generated algebra with a linked type check added.

## Breaking changes (changeset `reads-from-graphs.md`, minor)

- `SparqlGraph` is `{iri} | {variable}`; code reading `node.iri` of a graph node must handle the
  variable form (no dependent in CN's checkouts reads it).
- `.from()` with `graphs.default`/`graphs.union` among other graphs is refused.

## Contract notes for the master

§Contracts "Reads with `.from()`" is implemented as written; additions inside it:
`invalidateGraphRegistry` is both a `SparqlDataset` method (`dataset?` defaults to the store's
key) and a package export by key; the key is `graphRegistryKey()`, which F2 and V1 should set to
the dataset identity CN pushes. Decision 9's limit and §Graph routing's "the default graph's
store name in the set" need `VALUES`, not `FROM NAMED`, on Jena (backlog 066).

## Verification

Worktree `named-graphs--k2` rebased on `named-graphs` at `e1a9364` (K3 landed), own Fuseki
`linked-fuseki:071` on :3173 (compose project `fuseki-071-k2`, started and removed by jest's
global setup), env `FUSEKI_TEST_PORT=3173 FUSEKI_BASE_URL=http://localhost:3173
LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-071-k2 LINKED_FUSEKI_IMAGE=linked-fuseki:071` exported
before the first jest run.

Quick gates:

- Phase 1 (builders, JSON, lowering; 8 suites): `Tests: 3 skipped, 380 passed, 383 total`,
  `Time: 7.117 s` (16.5 s wall); `npm run typecheck` clean, 3.1 s.
- Phase 2 (golden and SPARQL suites; 11 suites): `Tests: 378 passed, 378 total`, `Time: 3.734 s`
  (14.9 s wall); typecheck clean, 3.6 s.
- Phase 3 (`read-graphs` unit and `[fuseki]`): `Tests: 33 passed, 33 total`.

Full gate (after the rebase):

- `npm test`: `Test Suites: 1 failed, 4 skipped, 127 passed, 128 of 132 total`, `Tests: 120
  skipped, 2580 passed, 2700 total`, `Time: 22.107 s` (32.0 s wall), `[fuseki] live tests: 339
  total — 339 passed, 0 failed, 0 skipped`. The failing suite is `two-copies-built.test.ts`
  ("Module cache already has entry …/lib/esm/shapes/SHACL.js. This is a bug in Jest"), backlog
  060. The first run of the gate, started straight after a build, also had one failed test in
  `graph-query-fuseki.test.ts` (`[fuseki] live tests: 339 total — 338 passed, 1 failed`; its log
  was not kept); the suite passes alone, and five further full runs (two `npm test`, three
  `jest`) were all green, so it is recorded as a one-off under load.
- `npm run typecheck`: clean, 7.5 s. `npm run test:fuseki`: `Tests: 2399 skipped, 339 passed,
  2738 total`, `Time: 19.688 s`. `npm run check:dts`: clean, 3.4 s. `npx linked build`: `✔ Build
  successful`, 6.7 s. `lib/esm/utils/graphRegistryCache.js`, `sparql/graphScope.js`,
  `queries/readGraphs.js`: no `n3` or `node:` import.

Verify (master §K2), `read-graphs.test.ts` and `read-graphs-fuseki.test.ts` (`Tests: 33 passed`,
`Time: 2.513 s`):

```
✓ one graph: the whole pattern in GRAPH <iri>, no FROM NAMED
✓ several graphs: FROM NAMED and one GRAPH ?g block per subject group
✓ a required group keeps its triples in one block; EXISTS patterns are scoped too
✓ count and ask carry the dataset clause
✓ isolateLinkedTypeChecks: a linked subject’s type check moves to a second block
✓ the option changes no query the DSL builds today (no linked type checks)
✓ graphs.allOntologies: every OntologyGraph the registry lists, sorted
✓ no graph of that kind registered: the read matches nothing, without a query
✓ a graph query through the store updates its cache: no re-read, the next read sees it
✓ invalidateGraphRegistry forces a re-read
✓ an entry older than 30 seconds is re-read (fake clock)
✓ graphs.allOntologies: a join across package graphs to a subclass instance (69 ms)
✓ a filter through the link, a count and an exists (74 ms)
✓ a class in an unlisted graph never returns; it does when that graph is named (76 ms)
✓ the default graph alone reads as today; the union graph by its store name (66 ms)
✓ a graph created through the store is read at once, without waiting for the expiry (90 ms)
✓ isolateLinkedTypeChecks: a linked type check in a second block returns identical rows (22 ms)
[fuseki] live tests: 6 total — 6 passed, 0 failed, 0 skipped
```

Every `[fuseki]` read in `read-graphs-fuseki.test.ts` runs on a store with
`isolateLinkedTypeChecks` off and one with it on and asserts identical rows: the join of alice
(graph A) to bob, an `Employee` in graph B, read as `Person` through inference; eve (a draft
graph) and frank (the default graph) never return from `graphs.allOntologies`. With the type
check added to the generated algebra the two forms differ in text and return the same row
(`alice bob Alice`).

## Follow-ups

- Backlog [065](../backlog/065-linked-type-checks-in-graph-reads.md): the generator emits no
  linked type check, so `isolateLinkedTypeChecks` is inert; K4 decides whether routing needs one.
- Backlog [066](../backlog/066-default-graph-in-a-named-graph-set.md): the default graph in a set
  of named graphs (`VALUES`, not `FROM NAMED`, on Jena), for K4.
- F2: `FusekiStore` sets `isolateLinkedTypeChecks: true`, `mapGraphName` (Jena's names) and
  overrides `graphRegistryKey()` with its dataset identity (master §F2 lists the first two).
