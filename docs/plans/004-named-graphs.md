---
summary: >
  Core's sub-plan for CN plan 071 (named graphs and graph routing): K1 (`graphQuery`, the four
  graph kinds, the `IDataset` method changes, `NamedGraph`/`OntologyGraph`/`ShapesGraph`/
  `DraftGraph` with the graph API and automatic registry records, portable graph names, terms,
  `SparqlDataset.graphQuery`, typed refusals, the `deleteInsertPlanToSparql` graph fix), then K2
  (`.from()` reads), K3 (the ontology sync on package graphs), K4 (graph routing) and K5 (shape
  graphs).
status: Implementation
packages: [core]
---

# 004 — Named graphs

Sub-plan of CN plan 071, `create-now/docs/plans/071-named-graphs-and-graph-routing.md` (the
**master plan**; locally `~/web/create_now/docs/plans/071-named-graphs-and-graph-routing.md` on
the integration branch `named-graphs`). Its §Decisions are the design; this document does not
redesign them. Read the master's §Decisions, §Plan choices, §How to use, §Rules and this
sub-plan; the contracts core provides are repeated below verbatim.

Integration branch: `named-graphs` (this repository's main checkout
`~/web/create_now/packages-local/_linked-core`). A step works in
`~/web/wt/<step>/packages-local/_linked-core` on `named-graphs--<step>` (made by
`npx linked worktree add <step> --with @_linked/core …` from CN's main checkout) and lands with
`git rebase named-graphs`, the gate again, `git -C ~/web/create_now/packages-local/_linked-core
merge --ff-only named-graphs--<step>`, then `npx linked build` in that main checkout. No PR per
step; one release PR per phase (master R1, R2).

Records: K1 → report 048, K2 → 049, K3 → 050, K4 → 051, K5 → 052 (`docs/reports/`). Backlog
follow-ups from 063.

## Contracts

Repeated verbatim from the master plan §Contracts as of this writing. The master is the
authority; a step that changes a contract updates both copies in its landing. K2-K5 add the
contracts they provide or consume when their plan-mode detail is written.

### Graph IRIs and vocabulary (provider K1; consumers F1, K3, V1, C1, C2, B1, K5)

- Package graph: `{package IRI}/graph/{kind}`; `kind` ∈ `ontology` (phase 1), `shapes` (phase 2).
  Package IRI per arch-02: `https://linked.cm/pkg/{publicSlug}` or
  `https://{ws}.id.create.now/pkg/{slug}`. `OntologyGraph.iriFor(packageName)` and
  `ShapesGraph.iriFor(packageName)` build them from the registered package.
- Dataset-owned graph: `{DATA_ROOT}/graph/{kind}`: `drafts`, `shapes`, `import/{slug}`.
- Registry: `https://linked.cm/pkg/core/graph/registry` (= `graphs.registry`).
- Portable names (`@_linked/core/ontologies/graphs`): `graphs.default`, `graphs.union`,
  `graphs.allOntologies`, `graphs.allShapes`, `graphs.registry` under `https://linked.cm/pkg/core/graph/`;
  each name matches its IRI: `…/graph/all-ontologies`, `…/graph/all-shapes`, `…/graph/registry`
  (owner, 2026-10-23). Core's own package
  graphs stay `…/graph/ontology` and `…/graph/shapes`.
- Terms, in core's `data/core.ttl` and `ontologies/linked-core.ts` (core namespace
  `https://linked.cm/ont/core/`): classes `core:OntologyGraph`, `core:ShapesGraph`,
  `core:DraftGraph` (each `⊑ sd:NamedGraph`); properties `core:contentHash`,
  `core:feedsHierarchy` (`xsd:boolean`), `core:package` (the npm package name, string),
  `core:version`. Standard terms used: `sd:NamedGraph`, `sd:name`
  (`http://www.w3.org/ns/sparql-service-description#`), `dcterms:modified`, `dcterms:source`.
  Core declares the two `sd:` terms in a small term module (`ontologies/sd.ts`, no data file: core
  does not mirror SD).
- A record's subject is the graph IRI; `sd:name` repeats it.

```turtle
# in GRAPH <https://linked.cm/pkg/core/graph/registry>
<https://linked.cm/pkg/schema/graph/ontology> a core:OntologyGraph ;
  sd:name <https://linked.cm/pkg/schema/graph/ontology> ;
  core:package "@_linked/schema" ; core:version "1.7.0" ;
  core:contentHash "3f9c…" ; core:feedsHierarchy true ;
  dcterms:modified "2026-10-30T10:12:00Z"^^xsd:dateTime ;
  dcterms:source "data/schema.ttl", "data/schema-added.ttl" .
```

### `graphQuery` and the graph API (provider K1; consumers K3, F2, U1, V1, C1, B1, K5)

```ts
type GraphQueryKind = 'graph_create' | 'graph_replace' | 'graph_patch' | 'graph_drop';
interface GraphContent { mediaType: 'text/turtle' | 'application/n-triples'; text: string }
interface GraphQuery {
  kind: GraphQueryKind;
  graph: string;                       // the graph IRI
  recordClass: string;                 // class IRI from the static's receiver
  record?: Record<string, unknown>;    // the class's own fields ({package, version}); automatic fields excluded
  content?: GraphContent;              // create, replace
  patch?: { insert?: GraphContent; delete?: GraphContent };   // patch
  contentHash?: string;                // optional caller-supplied hash (13c: the file's new hash)
}
interface GraphResult { graph: string; contentHash?: string; modified?: string; changed: boolean }
```

- `IDataset.graphQuery(q)` is required; `selectQuery`, `updateQuery`, `createQuery`,
  `deleteQuery` required; `askQuery` the one optional method: `LinkedStorage` answers an ask on a
  dataset without it with a select `LIMIT 1` (true when it returns a row).
- Core's callers guard at runtime: a dataset without a `graphQuery` function is treated as throwing
  `unsupported-query-kind`.
- Statics (server-only; a browser import throws on call, not on import): `NamedGraph.replaceContent(iri, c)`,
  `NamedGraph.patchContent(iri, {insert, delete})`, `<Class>.create({id, ...own}).withContent(c)`,
  `<Class>.update(iri).set({...own})` (alone: `graph_patch` with a record and no body, hash
  unchanged) optionally chained with `.replaceContent(c)` / `.patchContent(p)`, `<Class>.delete(iri)`.
  `<Class>.select()` reads records (P2). Each call → exactly one `graphQuery`.
- Refusals (typed, branded with `linkedError`): `unsupported-query-kind` (store), `graph-not-registered`
  (replace or patch of a graph with no record), `graph-name-read-only` (any write to a portable
  name or to `graphs.registry` itself), `graph-exists` (create of a registered graph).
- Automatic record fields: `sd:name`, `core:contentHash` = `sha256Hex` of the content text (or the
  caller's `contentHash`), `dcterms:modified` = now; `feedsHierarchy` default: `OntologyGraph`
  true, `ShapesGraph`, `DraftGraph` false.
- `SparqlDataset.graphQuery` emits one SPARQL update per call, e.g. `graph_replace`:

```sparql
DROP SILENT GRAPH <g> ;
INSERT DATA { GRAPH <g> { …content… } } ;
DELETE WHERE { GRAPH <registry> { <g> core:contentHash ?h } } ;
DELETE WHERE { GRAPH <registry> { <g> dcterms:modified ?m } } ;
INSERT DATA { GRAPH <registry> { <g> core:contentHash "…" ; dcterms:modified "…"^^xsd:dateTime } }
```

  (Large bodies: an implementation may send the body by GSP `PUT` only if record and body still
  land in one transaction; otherwise the single update stands. K1 measures schema.org's ~16k
  triples both ways and records it.) `graph_patch` deletes `patch.delete` as `DELETE DATA`
  (blank-node subjects: phase 2's CBD rule, K5) and inserts `patch.insert`.
- `deleteInsertPlanToSparql` honours `plan.graph` (latent bug fixed in K1).

Example (the sync, K3):

```ts
import {OntologyGraph} from '@_linked/core/shapes/NamedGraph';
const g = OntologyGraph.iriFor('@_linked/schema');
await OntologyGraph.update(g).set({version: '1.7.0'}).replaceContent({mediaType: 'application/n-triples', text});
```


## K1 — `graphQuery` and the graph API (sensitive)

Master §K1 is the scope; this is its plan-mode detail. Found in the code at `named-graphs`
(`a8688fc`, core 2.37.2). Line numbers drift; search for the symbol.

### Files

| File | What changes |
|---|---|
| `src/queries/IntermediateRepresentation.ts` | `GraphQueryKind`, `GraphContent`, `GraphQuery`, `GraphResult` exactly as §Contracts (the canonical form: a graph query needs no lowering) |
| `src/queries/graphQuery.ts` (new) | `GRAPH_QUERY_KINDS`, `isGraphQueryKind`, `parseGraphQuery(json)` (the DSL-JSON boundary: validates kind, IRIs, media types, field types; `v` checked by `assertWireVersion`), `GraphQueryError` with `code: GraphQueryErrorCode` (`unsupported-query-kind`, `graph-not-registered`, `graph-name-read-only`, `graph-exists`), branded with `brandLinkedError`, `isGraphQueryError(err, code?)`, `assertGraphWritable(iri)` |
| `src/queries/graphRecords.ts` (new) | the record classes a store can write: class IRI → `{feedsHierarchy default, own fields: name → {path, datatype, many?}}` for `sd:NamedGraph` (`sources`: `source` is a reserved DSL name), `core:OntologyGraph` and `core:ShapesGraph` (`package`, `version`), `core:DraftGraph`; `graphRecordTriples(q, now)` → the record's automatic and own fields as predicate/literal pairs, refusing an unknown class, an unknown field or an automatic field passed by the caller; `graphContentHash(q)` |
| `src/queries/queryDispatch.ts` | `QueryDispatch.graphQuery?` (optional: a dispatch set by an older copy lacks it), event kind `'graph'`, `resolveGraphQuery(target, q)` (the runtime guard: no `graphQuery` function → `GraphQueryError('unsupported-query-kind')`), `resolveExistence` answers through `selectQuery` with `limit: 1` when the target has no `askQuery` (shaped asks only; a shapeless ask without `askQuery` is refused) |
| `src/queries/fromJSON.ts` | an envelope whose `kind` is a graph kind is refused with a pointer to `parseGraphQuery` (it is not a builder) |
| `src/queries/lower.ts` | unchanged: a `GraphQuery` is already canonical |
| `src/interfaces/IDataset.ts` | `graphQuery(query: GraphQuery): Promise<GraphResult>` required; `updateQuery`, `createQuery`, `deleteQuery` required; `askQuery?` optional, docs for the fallback |
| `src/utils/LinkedStorage.ts` | `graphQuery(q)` routes by the record shape (the shape whose target class is `q.recordClass`, its pin found through the prototype chain, so a pin of `NamedGraph` covers every subclass), else the default dataset; goes through `resolveGraphQuery`; `setDefaultDataset` adds `graphQuery` to the dispatch |
| `src/shapes/NamedGraph.ts` (new) | `NamedGraph` (targets `sd:NamedGraph`), `OntologyGraph`, `ShapesGraph`, `DraftGraph`; the statics and builders (below); `iriFor`; registered under `@_linked/core` with explicit names |
| `src/shapes/index.ts`, `src/utils/ShapeCatalog.ts` | import `NamedGraph.js`; `BUILT_IN_NAMES` gains the four names |
| `src/sparql/irToAlgebra.ts` | select, count and ask whose root shape class declares `static storedInGraph` wrap their WHERE in `GRAPH <iri> { … }` (P2: only the graph-record shapes declare it; K2 generalises reads with `.from()`) |
| `src/ontologies/graphs.ts` (new) | `graphs.{default, union, allOntologies, allShapes, registry}` and `PORTABLE_GRAPH_NAMES` |
| `src/ontologies/sd.ts` (new) | `sd.NamedGraph`, `sd.name`; prefix `sd`; no data file |
| `src/ontologies/linked-core.ts`, `src/data/core.ttl` | `OntologyGraph`, `ShapesGraph`, `DraftGraph` (each `rdfs:subClassOf sd:NamedGraph`), `contentHash`, `feedsHierarchy` (`xsd:boolean` range), `package`, `version` |
| `src/sparql/graphQueryToSparql.ts` (new) | `graphQueryToSparql(q, {registered, now})` → the one update string; content parsed with N3.js (imported dynamically) and re-serialised as N-Triples, so no request text reaches the update unparsed |
| `src/sparql/SparqlDataset.ts` | `graphQuery(q)`: refusals, one `ASK` on the registry (create, replace, patch), then one update; returns `GraphResult` |
| `src/sparql/algebraToString.ts` | `deleteInsertPlanToSparql` emits `WITH <g>` before `DELETE` when `plan.graph` is set |
| `src/test-helpers/*`, test doubles in `src/tests/*` | implement the now-required methods; graph-less doubles throw `unsupported-query-kind` |
| `src/tests/graph-query.test.ts` (new) | unit: each static → exactly one `GraphQuery` (capture dataset), refusals, JSON round trip, routing by the record shape and the runtime guard, the ask fallback, the update strings per kind, `WITH` in `deleteInsertPlanToSparql`, browser call refused |
| `src/tests/graph-query-fuseki.test.ts` (new) | `[fuseki]`: the master's Verify list and the large-body measurement |
| `src/index.ts` | export `graphs`, `GraphQueryError`, `isGraphQueryError`, the graph types |
| `docs/architecture/ontologies.md`, `docs/backlog/005-named-graph-support.md`, `docs/backlog/025-storage-config-and-graph-management.md` | graphs, the registry, the API; backlogs point here |
| `.changeset/*.md` (new) | minor, with the breaking list |
| `docs/reports/048-graph-query-and-the-graph-api.md` (new) | the record |

### The graph API in code

- `NamedGraph extends Shape` through a base typed without Shape's mutation statics (`create`,
  `update`, `delete`, `upsert`, `deleteAll`, `deleteWhere`), because a graph record's are graph
  queries with other signatures. `upsert`, `deleteAll` and `deleteWhere` throw on a graph-record
  class: a record changes only through graph queries. Registration calls `linkedShape({name})`
  on the class (the decorator's `T extends typeof Shape` does not accept the narrowed statics).
- `static storedInGraph = graphs.registry` on `NamedGraph` (inherited): `select()` reads the
  registry (P2).
- `static feedsHierarchy` is not on the shapes; the default per class is in `graphRecords.ts`,
  so a store that only receives a `GraphQuery` (CN's gateway) knows it.
- Builders are thenables with `exec(target?: IDataset)`; `await` runs `exec()`. Each `exec` sends
  exactly one `GraphQuery`:
  - `X.create({id, ...own})` → `graph_create` (no content: an empty graph is registered);
    `.withContent(c)` → `graph_create` with content.
  - `X.update(iri).set(own)` → `graph_patch` with `record` and no `patch`;
    `.replaceContent(c)` → `graph_replace` with `record`; `.patchContent(p)` → `graph_patch` with
    `record` and `patch`.
  - `X.replaceContent(iri, c)` → `graph_replace`; `X.patchContent(iri, p)` → `graph_patch`.
  - `X.delete(iri)` → `graph_drop`.
  - `recordClass` is the receiver's `targetClass`; an optional `{contentHash}` on content calls is
    forwarded as `contentHash`.
- Every call checks `assertGraphWritable(iri)` before sending (and the store checks again), and
  refuses in a browser (`typeof window !== 'undefined' && typeof document !== 'undefined'`) on
  call, never on import.
- `OntologyGraph.iriFor(pkg)` = `getPackageUri(pkg) + '/graph/ontology'`; `ShapesGraph.iriFor` the
  same with `shapes`.

### `SparqlDataset.graphQuery`

1. `assertGraphWritable(q.graph)` (portable names and the registry → `graph-name-read-only`).
2. Kinds other than the four → `unsupported-query-kind`.
3. `graph_create`, `graph_replace`, `graph_patch`: one `ASK { GRAPH <registry> { <g> <sd:name> <g> } }`;
   create on a registered graph → `graph-exists`; replace or patch on an unregistered one →
   `graph-not-registered`. (The check and the write are two requests; the write itself is one
   update and one transaction. A concurrent create between them is the only race, and it ends in
   two identical records being written over each other.)
4. One update per call:
   - create: `DROP SILENT GRAPH <g>`, `INSERT DATA { GRAPH <g> { body } }`, then
     `INSERT DATA { GRAPH <registry> { <g> a <class> ; sd:name <g> ; core:feedsHierarchy … ;
     core:contentHash … ; dcterms:modified … ; own fields } }`.
   - replace: as the master's example, plus each own field passed: `DELETE WHERE` its old value,
     `INSERT DATA` the new.
   - patch with a body: `DELETE DATA { GRAPH <g> { delete } }` (a blank node in the delete body is
     refused: SPARQL's `DELETE DATA` cannot name one; the CBD rule is K5's), `INSERT DATA { GRAPH
     <g> { insert } }`, hash and modified replaced, own fields as replace.
   - patch without a body (record only): own fields only; hash and modified kept.
   - drop: `DROP SILENT GRAPH <g>`, `DELETE WHERE { GRAPH <registry> { <g> ?p ?o } }` (no refusal
     for an unregistered graph).
5. Hash: the caller's `contentHash`, else `sha256Hex(content.text)` for create and replace, and
   for a patch `sha256Hex` of its delete text, a newline and its insert text (a patch has no whole
   content text; this keeps the hash a function of what was sent and makes every patch change it).
   `modified` = now (`xsd:dateTime`, ISO). `GraphResult.changed` is true when the body was written
   or dropped, false for a record-only update.
6. Large bodies: one update (record and body in one transaction). The GSP `PUT` alternative takes
   two transactions (body, then record), so it is only measured: schema.org's ~16k triples both
   ways, recorded in report 048.

### Pitfalls

- **Implementers outside core break on types** until their steps land: server's `RemoteDataset`
  (V1), fuseki's `FusekiStore` (F2, through `SparqlDataset` it inherits `graphQuery`; check), CN's
  `AppDataRouter`, `ExecutionGateway`, `withAccess` (C1) and webid.email. Core never calls a
  missing method: `resolveGraphQuery` and `resolveExistence` guard at runtime, and
  `resolveMutationDispatch` keeps its check. CN's running dev server (`:4040`, main checkout on
  the integration tip) must not crash at runtime after the landing: check it.
- **Browser bundles.** `NamedGraph.ts` imports neither `n3` nor `crypto` (the hasher is pure JS
  and runs in the store); `graphQueryToSparql.ts` imports `n3` dynamically.
- **Injection.** Graph IRIs go through `assertSafeIri`; content is parsed and re-serialised; record
  literals through `escapeSparqlString`.
- **Static-side typing.** Overriding `create`/`update`/`delete` with other signatures fails the
  class's static-side check against `typeof Shape`; the narrowed base avoids it without
  `@ts-ignore`.
- **Inference in the registry on `6.2.0-1`.** The select of `NamedGraph` returning an
  `OntologyGraph` record needs `core:OntologyGraph rdfs:subClassOf sd:NamedGraph` in the default
  graph (the `6.2.0-1` hierarchy); the test writes it there, so it does not depend on F1.
- **Shape sync** writes core's built-in shapes into datasets: the four new ones are built-ins, so
  the shape-catalog and sync tests that count built-ins change.
- **The ask fallback** reverses a documented "never rewrite an ask as a select": the doc comments
  on `IDataset.askQuery`, `resolveExistence` and `LinkedStorage.askQuery` change with it.

### Tests

- Quick gate (after each phase), from the core worktree:
  `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs <files>` with the
  phase's test files, plus `npm run typecheck`.
- Full gate (before landing): `npm test` (jest + typecheck), `npm run test:fuseki`
  (`REQUIRE_FUSEKI=1`), `npm run check:dts`, `npx linked build`.
- Isolation: `FUSEKI_BASE_URL=http://localhost:3171`, `LINKED_CORE_TEST_COMPOSE_PROJECT=core-071-k1`,
  `LINKED_FUSEKI_IMAGE=ghcr.io/linked-fw/fuseki:6.2.0-1` (K1 does not depend on F1's image).
- Verify (master): create → record with hash and modified; replace on an unregistered graph
  refused; patch changes the hash; `update().set()` alone keeps the hash; delete removes graph and
  record; a write to `graphs.union` refused; a select of `NamedGraph` returns an `OntologyGraph`
  record (inference).

### Phases

1. **Interface and dispatch:** IR types, `graphQuery.ts`, `IDataset`, `queryDispatch.ts`,
   `LinkedStorage`, `fromJSON` refusal, test doubles. Quick gate: the new unit tests for parse,
   guard, routing, ask fallback; the touched suites.
2. **Names, terms and shapes:** `graphs.ts`, `sd.ts`, terms and `core.ttl`, `graphRecords.ts`,
   `NamedGraph.ts`, built-ins, `storedInGraph` reads. Quick gate: graph-query unit tests, catalog
   and sync suites.
3. **The SPARQL store:** `graphQueryToSparql.ts`, `SparqlDataset.graphQuery`, the
   `deleteInsertPlanToSparql` fix, the `[fuseki]` suite and the measurement.
4. **Docs and record:** `ontologies.md`, backlogs 005 and 025, changeset, report 048, Outcome.

### Outcome

(Filled in when K1 lands.)
