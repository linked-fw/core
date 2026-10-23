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
  Store-native names are refused the same way: `SparqlDataset` has a protected hook
  `isReservedGraphName(iri): boolean`, checked on every graph write before any SPARQL is built;
  the default refuses the `urn:x-arq:` prefix (Jena's `DefaultGraph`, `UnionGraph`), and a store
  extends it (F2's `FusekiStore` keeps the default; another store adds its own names). Decided
  2026-10-23 on K1's review.
- `feedsHierarchy` is an `OntologyGraph` field, not settable on `DraftGraph`/`ShapesGraph`
  (always false there). `replaceContent`/`patchContent` through a subclass check the stored
  record's class (`graph-not-registered` when it differs); `NamedGraph.*` accepts any record.
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


### Ontology sync (provider K3; consumers V1, C2)

- `syncOntologies(ds?, {force?, packages?, orphanScope?})` → `{written, skipped, pruned}`
  (signature kept).
- Per package: hash `sha256Hex('linked-ontology-sync/2\n' + texts.join('\n'))` over the raw file
  texts in registered order; compare with the registry record's `core:contentHash` (read through
  `OntologyGraph.select()`); unchanged → no write (an unforked branch stays unforked); changed or
  missing or `force` → `create(...).withContent` or `update(...).set({version}).replaceContent`
  with the N-Triples body (P3). Then P4's cleanup of the plan-070 default-graph triples and node.
- Orphans (`orphanScope: 'all'`): `OntologyGraph.delete(iri)` for records whose package is not
  registered.
- On `unsupported-query-kind`: plan 070's default-graph diff, unchanged (`OntologySync` nodes,
  hash prefix `/1`).
- `OntologySync`, `ClassAxioms` and their exports stay (deprecated) for the fallback.

### Reads with `.from()` and the generator (provider K2, extended by K4; consumers F2, C2, C4)

- DSL: `.from(graph | graph[])` on select, count and ask builders; DSL-JSON field `graphs:
  string[]`; IR field `graphs?: string[]` on `IRSelectQuery`, `IRAskQuery`, `IRCountQuery`. Reads
  may carry it over the wire (decision 8).
- The generator per decision 9: one `GRAPH ?gN` block per subject group; the store adds
  `FROM NAMED` for the expanded set; one graph → `GRAPH <iri>`.
- `SparqlOptions` gains `isolateLinkedTypeChecks?: boolean` (default false) and a hook
  `mapGraphName(iri): string | null` (portable name → store name; `null` refuses).
- The store expands `graphs.allOntologies` (and in phase 2 `graphs.allShapes`) from a registry cache
  (owner, 2026-10-23):
  - **per process, per dataset:** one `SELECT ?g` over `graphs.registry` by class, cached for each
    dataset the process reads;
  - **own writes:** a process that changes a graph (any `graphQuery` through its store) updates its
    own cache for that dataset in the same step, so its next read sees the change;
  - **CN-managed apps:** every graph write of an app under CN passes through CN's gateway, so CN
    pushes an invalidation for that dataset to the app over its control channel after the write
    (arch-07 §Host Agent ↔ app control: the app's `/admin/*` routes with `CN_APP_ADMIN_SECRET`).
    C1 sends it, V1 adds the route and drops the cache; core exposes the drop as a public call
    on the store (`invalidateGraphRegistry(dataset?)`, K2) for V1 to use;
  - **backstop:** an entry older than 30 seconds is re-read, for writes that bypass CN (scripts,
    standalone apps, and an app in a Docker container, which has no control channel yet);
  - writes never depend on the cache.
- Test (core, `[fuseki]`): the same queries with `isolateLinkedTypeChecks` on and off return
  identical rows.

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

1. `assertGraphWritable(q.graph)` (an absolute IRI; portable names and the registry →
   `graph-name-read-only`), then `isReservedGraphName(q.graph)` (default: `urn:x-arq:` →
   `graph-name-read-only`).
2. Kinds other than the four → `unsupported-query-kind`.
3. `graph_create`, `graph_replace`, `graph_patch`: one `ASK { GRAPH <registry> { <g> <sd:name> <g> } }`;
   create on a registered graph → `graph-exists`; replace or patch on an unregistered one →
   `graph-not-registered`. Through a record class other than `sd:NamedGraph` the ASK also
   requires `a <recordClass>`, so a record of another class is `graph-not-registered`. (The check and the write are two requests; the write itself is one
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

Landed (report [048](../reports/048-graph-query-and-the-graph-api.md)). Deviations from this
section: the review added the store-reserved name hook (`isReservedGraphName`, master §Contracts
updated at CN `d10d95b69`), made `feedsHierarchy` an `OntologyGraph` field only, and made replace
and patch through a subclass check the stored record's class. The registration check also
refuses relative graph names and empty patches. Full gate: 2530 passed, 330/330 `[fuseki]`;
`two-copies-built` still fails (backlog 060). Open note for K4: routing takes the first shape that
targets the record class.

## K3 — the ontology sync on package graphs

Master §K3 is the scope and §Ontology sync (above) the contract; this is its plan-mode detail.
Found in the code at `named-graphs` (`75162c1`, K1 landed). Line numbers drift; search for the
symbol.

### Design in the code

- `syncOntologies(ds?, options)` keeps its signature and result. It parses every registered
  package once (`readPackageOntologies`, as today; the parse still sets the in-memory hierarchy),
  then runs the **graph path**; the first `GraphQueryError('unsupported-query-kind')` (from the
  store, or from `resolveGraphQuery`'s guard for a dataset without a `graphQuery` function)
  switches the run to the **fallback**, plan 070's default-graph diff, moved unchanged into a
  private function. An explicit `ds` without a `graphQuery` function goes to the fallback
  without reading the registry. A store either supports graph queries or not, so the switch
  happens at the first graph write, before anything was written through the graph path.
- **Graph path, per package** (sorted by name, sequential: one update each, schema.org's body is
  ~1 MB):
  1. `hash = ontologyGraphHash(texts)` = `sha256Hex('linked-ontology-sync/2\n' +
     texts.join('\n'))` over the raw texts in registration order (`PackageOntologyData.texts`).
  2. The stored records come from one `OntologyGraph.select(r => [r.package, r.contentHash])`
     at the start of the run, keyed by the record's subject (the graph IRI).
  3. Equal hash and no `force` → `skipped`, no write.
  4. Otherwise the body is built: each text parsed with N3.js (permissive parser, as the
     hierarchy reader) with a per-file blank-node prefix (`f<i>_`), default-graph quads only,
     serialised line by line as N-Triples, deduped (P3). The graph IRI is
     `OntologyGraph.iriFor(pkg)`. No record → `OntologyGraph.create({id, package, sources})
     .withContent(body, {contentHash: hash})`; a record → `OntologyGraph.update(id).set({sources})
     .replaceContent(body, {contentHash: hash})`. The caller-supplied hash is the one recorded,
     so the next run compares like with like. `sources` are the registrations' `files` with
     leading `./` and `../` segments removed (`data/schema.ttl`).
  5. P4 cleanup (below), then `written`.
- **`version`** is not recorded: core knows no package's version (`OntologyRegistration` has
  none, `linkedPackage` takes none). The field stays optional; recording it needs the version in
  the registration (core backlog 064).
- **P4 cleanup.** The stored plan-070 nodes come from one `OntologySync` select at the start of
  the run. For every package in scope that still has a node and whose graph is written or
  skipped as unchanged (so an interrupted cleanup is finished by the next run), the sync removes
  from the default graph each line the node lists unless another remaining node lists it, one
  `ClassAxioms` update per subject class (the existing `diffUpdates`, at most eight in flight),
  then deletes the node. Nodes are removed from the "remaining" set as their package is cleaned,
  so a triple two packages listed goes with the second. A package whose data cannot be read keeps
  its node (and so its triples). The cleanup runs after the package's graph is written, so the
  hierarchy never loses a class in between. Reading of P4's "or the package graph does not
  replace": a listed line the package no longer has is removed as well (plan 070 would have
  removed it on the change); otherwise the default graph would keep a stale axiom no node lists,
  and master Verify's "empty default-graph hierarchy for synced packages" would not hold.
- **Orphans** (`orphanScope: 'all'`, no `packages`): `OntologyGraph.delete(iri)` for every record
  whose `package` is not registered (→ `pruned`), and the plan-070 cleanup above for every node
  whose package is not registered (→ `pruned`, once per package name).
- **Fallback**: today's code, unchanged (`/1` hash, `OntologySync` nodes, `ClassAxioms` diffs).
  `ontologySyncHash`, `ontologyTriplesText`, `ontologySyncNodeIri`, `toNTriplesLine`,
  `OntologySync` and `ClassAxioms` stay exported, marked deprecated (fallback only).

### Files

| File | What changes |
|---|---|
| `src/ontology/syncOntologies.ts` | the graph path, `ontologyGraphHash`, `ONTOLOGY_GRAPH_HASH_PREFIX`, P4 cleanup, orphan records; the plan-070 path moved into a private fallback; module doc |
| `src/ontology/hierarchy.ts` | `nTriplesFromTurtle(texts, sources?)` → the N-Triples body (per-file blank-node prefix, default graph only, deduped), sharing the parser loader |
| `src/shapes/OntologySync.ts`, `src/shapes/ClassAxioms.ts` | doc: deprecated, used by the fallback and the cleanup only |
| `src/tests/ontology-sync.test.ts` | unit, graph path against a recording double (`graphQuery` captured, record select answered); fallback tests on a double whose `graphQuery` throws `unsupported-query-kind` and on one without `graphQuery` |
| `src/tests/ontology-sync-fuseki.test.ts` | `[fuseki]` on image `6.2.0-2`: master Verify; the measurement of schema.org's first and second sync |
| `docs/architecture/ontologies.md` | §The ontology sync rewritten for package graphs, the fallback kept in brief |
| `.changeset/*.md` (new) | minor; breaking: the sync requires `ghcr.io/linked-fw/fuseki:6.2.0-2` or a store that builds its hierarchy from the registry; ontology data moves out of the default graph |
| `docs/backlog/064-*.md` (new) | the package version in registrations and records |
| `docs/reports/050-ontology-sync-on-package-graphs.md` (new) | the record |

### Pitfalls

- **Old image, new core** (P5): on `6.2.0-1` the hierarchy is read from the default graph only,
  which the cleanup empties. The `[fuseki]` tests need `LINKED_FUSEKI_IMAGE=linked-fuseki:071`;
  the changeset says so; the owner's `:3030` moves before this lands.
- **The hash is over raw bytes, the body is N-Triples**: the record must carry the sync's hash
  (`contentHash` option), not the store's hash of the body, or every boot rewrites.
- **Blank nodes across files** (OWL restrictions, lists): one parser per file with its own
  prefix, so `_:b0` of two files never merge.
- **Cleanup must not delete what still feeds**: only lines a node lists, never one another
  remaining node lists; graph first, cleanup second.
- **K2 works in parallel** on `SparqlDataset.ts`/`irToAlgebra.ts`; this step does not touch them
  (`OntologyGraph.select()` already reads the registry through K1's `storedInGraph`). Whoever
  lands second rebases.
- **Shape sync** runs after the ontology sync; nothing here changes it.
- **Server** (`src/utils/ontologySync.ts`) calls `syncOntologies(ds, {orphanScope})` and logs
  `written`/`skipped`/`pruned`: the result shape stays.

### Tests

- Quick gate (after each phase), from the core worktree, with the Fuseki env exported first:
  `FUSEKI_BASE_URL=http://localhost:3174 FUSEKI_TEST_PORT=3174
  LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-071-k3 LINKED_FUSEKI_IMAGE=linked-fuseki:071`, then
  `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs
  src/tests/ontology-sync.test.ts src/tests/ontology-sync-fuseki.test.ts` and `npm run typecheck`.
- Full gate: `npm test` (`two-copies-built` known red, backlog 060; typecheck run separately),
  `npm run test:fuseki`, `npm run check:dts`, `npx linked build`.
- Unit: the `/2` hash vector; first sync → one `graph_create` per package with the N-Triples
  body, `contentHash` = the sync hash, `sources`; an equal record → no graph query; a changed
  text → `graph_replace` with the record; `force` writes despite an equal hash; blank nodes of two
  files stay apart; orphan records dropped only under `orphanScope: 'all'`; P4: node lines
  removed except those another node lists, node deleted, cleanup on a skipped package with a
  node left; the fallback on `unsupported-query-kind` and on a dataset without `graphQuery`
  sends exactly today's updates.
- `[fuseki]` (master Verify): first sync writes N graphs with records and returns them in
  `written`; second sync `skipped` with zero updates; a label change rewrites only that package;
  a store with plan-070 data (written by the fallback path) ends with an empty default-graph
  hierarchy for synced packages, a hand-written axiom kept, `ASK { ?x a Super }` still true; a
  store double without `graphQuery` takes the old path; measurement of schema.org's first and
  second sync.

### Phases

1. **Graph path, cleanup and fallback:** hash, body, records, create/replace, P4 cleanup,
   orphans, the fallback switch; unit tests.
2. **The live tests:** the `[fuseki]` suite and the measurement on `linked-fuseki:071`.
3. **Docs and record:** `ontologies.md`, deprecations, backlog 064, changeset, report 050,
   Outcome.

### Outcome

Landed (report [050](../reports/050-ontology-sync-on-package-graphs.md)). Deviations: no
`version` in the record (core knows none; backlog 064); P4 removes every line a node lists unless
another remaining node lists it (the reading written above); the cleanup moved into phase 1. Full
gate: 2547 passed, 333/333 `[fuseki]`; `two-copies-built` still fails (backlog 060). schema.org's
first sync: one update, 743 ms.

## K2 — reads from graphs

Master §K2 is the scope; this is its plan-mode detail, written against `named-graphs` at
`75162c1` (K1 landed). Line numbers drift; search for the symbol.

### Files

| File | What changes |
|---|---|
| `src/queries/IntermediateRepresentation.ts` | `graphs?: string[]` on `IRSelectQuery`, `IRAskQuery`, `IRCountQuery` (the names as the caller wrote them; a store expands them) |
| `src/queries/readGraphs.ts` (new) | `normalizeReadGraphs(input)`: the one check of a `.from()` argument and of a JSON `graphs` field (a non-empty list of absolute IRIs, deduplicated, order kept) |
| `src/queries/QueryBuilder.ts` | `SelectBuilder.from(graph \| graph[])` (instance method; the static `from(shape)` stays), cloned like every field; `toJSON`/`fromJSON` carry `graphs`; `toRawInput` passes it; `toCount()` and `.exists()` keep it (`_patternSpec`) |
| `src/queries/CountBuilder.ts`, `CountQuery.ts`, `AskBuilder.ts`, `AskQuery.ts` | `graphs` in the spec, raw input and JSON envelope; `.from()` on both builders returns a new builder |
| `src/queries/IRDesugar.ts` (`RawSelectInput`), `IRPipeline`/`buildSelectQuery`, `src/queries/lower.ts` | the raw input's `graphs` reaches the IR of select, count and ask (shapeless asks included) |
| `src/sparql/SparqlAlgebra.ts` | `SparqlGraph` takes an IRI or a variable; `SparqlSelectPlan` and `SparqlAskPlan` gain `dataset?: {fromNamed: string[]}` |
| `src/sparql/algebraToString.ts` | `GRAPH ?g { … }`; `FROM NAMED <g>` lines after `SELECT …` and after `ASK` |
| `src/sparql/graphScope.ts` (new) | `scopeAlgebraToGraphs(algebra, graphs, options)`: no names → unchanged; one name → `GRAPH <iri> { whole pattern }`; several → each BGP split into one `GRAPH ?g_<subject> { … }` block per subject (every BGP, inside OPTIONAL, MINUS, UNION, sub-selects and EXISTS filters), plus the `FROM NAMED` set; with `isolateLinkedTypeChecks`, a linked subject's `rdf:type` triples go in a second block on the same variable after its stored triples. Refuses an empty set and names only a store can expand (`graphs.default`, `union`, `allOntologies`, `allShapes`). The "why the second block" explanation lives here |
| `src/sparql/irToAlgebra.ts` | `selectToAlgebra` reads `query.graphs`, else the shape's `storedInGraph` (P2: `NamedGraph.select()` reads `graphs.registry` through the same path), and returns the `dataset` field; `askToAlgebra` (shapeless asks too) and `countToAlgebra` carry it |
| `src/sparql/sparqlUtils.ts` | `SparqlOptions.isolateLinkedTypeChecks?: boolean`, `SparqlOptions.mapGraphName?(iri): string \| null` |
| `src/utils/graphRegistryCache.ts` (new, pure) | per process, keyed by dataset: `readGraphRegistry(key, load)` (one load at a time, re-read after `GRAPH_REGISTRY_MAX_AGE_MS` = 30 s), `noteGraphQuery(key, query)` (own writes: a create adds the graph under its record class, a drop removes it), `invalidateGraphRegistry(key?)`, `expandReadGraphs(names, {registry, mapGraphName})` |
| `src/sparql/SparqlDataset.ts` | `selectQuery`/`askQuery` expand `ir.graphs` before compiling (portable names through `mapGraphName`, `allOntologies`/`allShapes` from the cache, `graphs.registry` as itself); `[graphs.default]` alone reads the default graph plainly; an empty expansion answers `[]`/`0`/`false` without a request; the registry load is one `SELECT ?g ?c` on `graphs.registry`; `graphQuery` notes its own write; public `invalidateGraphRegistry(dataset?)`; protected `graphRegistryKey()` (default: one key per instance; a store overrides it with its dataset's identity) |
| `src/test-helpers/FusekiStore.ts` | maps `graphs.default`/`union` to Jena's names (what F2's `FusekiStore` will do) and keys the cache by its dataset |
| `src/index.ts` | export `invalidateGraphRegistry`, `GRAPH_REGISTRY_MAX_AGE_MS` |
| `src/tests/read-graphs.test.ts` (new) | builders, JSON round trip, lowering, golden SPARQL (one block per subject, two blocks, one graph, `FROM NAMED` on select/count/ask, `storedInGraph`), store expansion with a stub transport (`allOntologies` expanded, `mapGraphName`, refusals, empty set), cache (own write, `invalidateGraphRegistry`, 30 s expiry with a fake clock) |
| `src/tests/read-graphs-fuseki.test.ts` (new) | `[fuseki]`: two package graphs registered with `OntologyGraph.create(...).withContent`, a third unlisted graph; joins through a link to a subclass instance; identical rows with the option on and off; a class in an unlisted graph never returns |
| `docs/architecture/ontologies.md` | reading graphs: `.from()`, the expansion, the cache, the option |
| `.changeset/*.md` (new) | minor, with the breaking list |
| `docs/reports/049-reads-from-graphs.md` (new) | the record |

### Pitfalls

- **Linked type checks.** Decision 9's second block applies to "a group reached through a link
  that needs an inferred type check". Today's generator emits `rdf:type` only for the root (and
  `MINUS` shape exclusions on the root); a traversal never type-checks its target. The option is
  implemented for any linked subject block that holds a type triple, so it changes no query the
  DSL builds today; its unit and `[fuseki]` tests add such a triple to a generated algebra. The
  DSL-level identical-rows test therefore compares identical text. Recorded as a follow-up
  (backlog 065) for whoever adds linked type checks (K4's routing by sub-shape, if it needs them).
- **An empty `FROM NAMED` is no restriction.** `GRAPH ?g` without `FROM NAMED` ranges over every
  named graph; an expansion to no graph must never compile. The store answers without a request,
  and the generator refuses an empty set.
- **The default graph is not named.** `FROM NAMED` makes the query's default graph empty, so a
  set naming `graphs.default` needs the store's name for it (`urn:x-arq:DefaultGraph`) through
  `mapGraphName`; without the hook only `[graphs.default]` alone is readable (as today).
- **Variable scope.** A graph variable is per subject and the same in every block of that
  subject, so an OPTIONAL block for a bound subject joins on its graph. Inside a sub-select the
  variable is local (the sub-select projects only its child).
- **Catalog field.** The IR's catalog is non-enumerable: a store that copies the IR to swap the
  expanded set must re-attach it (`attachCatalog`).
- **Property paths** follow a path inside the subject's graph only (one graph per subject).
- **K3 works in parallel** on `SparqlDataset.ts`, `irToAlgebra.ts` and the ontology files;
  whoever lands second rebases.

### Tests

- Quick gate (after each phase), from the core worktree, with the env below exported first:
  `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs <files>`, plus
  `npm run typecheck`.
- Full gate (before landing): `npm test` (jest; `two-copies-built` is backlog 060), `npm run
  typecheck`, `npm run test:fuseki`, `npm run check:dts`, `npx linked build`.
- Isolation: `FUSEKI_TEST_PORT=3173`, `FUSEKI_BASE_URL=http://localhost:3173`,
  `LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-071-k2`, `LINKED_FUSEKI_IMAGE=linked-fuseki:071`.
- Verify (master): golden SPARQL for one block, two blocks, one graph, `graphs.allOntologies`
  expanded; cache: a `graphQuery` through the store makes the next read see the new graph without
  a re-read by expiry, `invalidateGraphRegistry` forces a re-read, an entry older than 30 s is
  re-read (fake clock); `[fuseki]`: identical rows both ways, a class in an unlisted graph never
  returns.

### Phases

1. **DSL, JSON and IR:** `readGraphs.ts`, `.from()` on the three builders, JSON, raw inputs,
   lowering. Quick gate: the new unit tests for builders, JSON and lowering; the wire and builder
   suites.
2. **The generator:** algebra types, `graphScope.ts`, `irToAlgebra.ts`, `algebraToString.ts`,
   `SparqlOptions`. Quick gate: golden tests; the select, ask, count and graph-query suites.
3. **The store, docs and record:** `graphRegistryCache.ts`, `SparqlDataset`, the test
   `FusekiStore`, exports, the `[fuseki]` suite, `ontologies.md`, changeset, report 049, backlogs
   065 and 066, Outcome.

### Outcome

Landed (report [049](../reports/049-reads-from-graphs.md)). Deviations from this section:
`graphs.default`/`graphs.union` together with other graphs are refused (Jena's `FROM NAMED
<urn:x-arq:DefaultGraph>` matches nothing; backlog 066 for K4), so `mapGraphName` serves
`graphs.union` alone; `graphs.allShapes` is expanded already; the store method is
`resolveReadGraphs`; backlogs are 065 (linked type checks) and 066 (K3 took 064). Full gate:
2580 passed, 339/339 `[fuseki]`; `two-copies-built` still fails (backlog 060).

## K4 — graph routing (sensitive)

Master §K4 is the scope; this is its plan-mode detail, written against `named-graphs` at
`8b4c4db` (core 2.38.1 released, phase 1 complete). Line numbers drift; search for the symbol.

### Contract (provided; repeated from the master §Contracts)

**Graph routing (provider K4; consumers V2, C3, C4)**

- `LinkedStorage.setDatasetForShapes(dataset, shapes, {graph?})` and the datasets config's
  per-shape `graph` key (`linked.backend.datasets.json`: `{datasets: {alias: {store, config,
  graphs?: {<shape IRI>: <graph IRI>}}}}`, settled: open question 5); default: the default
  graph, as today.
- Reads: routing gives each subject group its graph set (sub-shapes included); generator per
  decision 9 with `VALUES` and the default graph's store name in the set — through `VALUES ?g`,
  since Jena's `FROM NAMED <urn:x-arq:DefaultGraph>` matches nothing (core backlog 066).
- Writes: mutation plans carry the routed graph; `.into(graph)` only server-side and only to a
  graph the routing allows for that shape; DSL-JSON never carries a write graph (the receiver
  derives it). Owned walks and `checkOwnedLinks` run in the subject's graph; live-query
  dependencies and change events carry the graph.

### How it works (inside the contract)

- **Where the routes live.** A per-dataset table on the shared global (beside `LinkedStorage`'s
  routing state, for the same two-copies reason), keyed by the dataset object, mapping a shape
  IRI to one graph IRI. `setDatasetForShapes(dataset, [shapes], {graph})` pins the shapes and
  records their graph; the old variadic form `setDatasetForShapes(dataset, ...shapes)` stays.
  `loadStores` records an alias's `graphs` for the store it builds. A store reads the routes of
  its own instance; a composite dataset (CN's router, C3) registers routes on the store it
  forwards to with the exported `setShapeGraphs(dataset, {shape: graph})`.
- **A shape's graph** is its own route, else its nearest routed super-shape's, else the default
  graph. **Its read set** is its graph plus the graph of every registered sub-shape (decision 9:
  "including the graphs of sub-shapes"). The graph-record shapes keep `storedInGraph` (reads of
  `NamedGraph` read `graphs.registry`; writes of records go through `graphQuery` only).
- **Reads.** With no `.from()` and routes registered, the store hands the compiler a routing
  object; each subject group's set comes from its alias's shape (the root's shape, a traversal's
  value shape; a subject with no known shape gets the union of the query's sets). No group with a
  named graph → the query is unchanged (today's SPARQL, byte for byte). Otherwise:
  - every group in one same single graph → `GRAPH <g> { whole pattern }` (as K2's one graph);
  - all sets named: `FROM NAMED` the union; a group with one graph → `GRAPH <g>`; a group whose
    set is the union → `GRAPH ?g_x`; a group with a narrower set and a type check (the root's
    scan, a `MINUS` exclusion) → `VALUES ?g_x { … }` with `GRAPH ?g_x` (decision 9's "overlaps
    their classes": core cannot know which classes another graph holds, so a type-checked group
    is restricted whenever its set is narrower); a linked group without a type check needs no
    `VALUES` (its data lives in one graph, `FROM NAMED` bounds it);
  - some set holds the default graph and some a named graph: **no `FROM NAMED`** (probed on
    `6.2.0-2`: with any `FROM NAMED` the default graph is unreachable, in `VALUES`, in
    `GRAPH <urn:x-arq:DefaultGraph>` and as plain triples); a default-only group is plain
    triples, a one-graph group `GRAPH <g>`, any other group `VALUES ?g_x { … }` with the default
    graph's store name (`mapGraphName(graphs.default)`; refused without it).
  - `.from()` sets use the same code with one set for every group, so `graphs.default` with other
    graphs now reads (backlog 066 closed); `graphs.union` with other graphs stays refused.
- **Linked type checks (backlog 065): not needed.** A group's set comes from its value shape, and
  a linked subject's data lives in one graph, so `FROM NAMED` (or `VALUES`) finds it without a
  type check; adding one would be a semantic change to every select. `isolateLinkedTypeChecks`
  stays as it is (inert for generated queries).
- **`named-graph-uri`.** `SparqlOptions.namedGraphUriParameter` (default false): the set goes to
  the transport instead of `FROM NAMED` text, through a protected
  `executeSparqlSelectWithNamedGraphs(sparql, graphs)` whose default throws (a transport that
  ignored the list would read every named graph).
- **Writes.** Mutation IR kinds gain `graph?: string`. The store sets the plan's graph: the
  `.into()` graph if given, else the shape's routed graph; the default graph leaves the plan as
  today. `insert_data` writes `GRAPH <g>`, `delete_insert` `WITH <g>` (K1), so an update's
  `WHERE`, an owned walk and a delete's incoming-reference cleanup run in the subject's graph.
  `checkOwnedLinks` reads the linked ids' types in that graph.
- **`.into(graph)`** on create, update and delete builders: carried to the IR, never into
  DSL-JSON (`toJSON` omits it, `fromJSON` never reads one), so only code in the store's own
  process can use it. "A graph the routing allows for that shape" = the shape's read set (a write
  there is found by the shape's routed reads); anything else, a portable name, the registry or a
  store-reserved name → `GraphQueryError('graph-not-routed')` (new code) or the existing
  `graph-name-read-only`.
- **Live queries.** `QueryDependencies.graphs?: Set<string>` (the `.from()` names, or the routed
  sets' union when the dataset `LinkedStorage` resolves for the root has routes; absent =
  unknown) and `MutationEffects.graph?: string` (the `.into()` graph or the routed graph, same
  condition; `graphs.default` for an unrouted shape of a routed dataset). The matcher skips a
  template only when both are known, the dependencies hold no store-resolved name, and the graph
  is not among them. `effectsHash` and the JSON revival carry the graph.

### Files

| File | What changes |
|---|---|
| `src/utils/graphRouting.ts` (new) | the per-dataset table on the shared global; `setShapeGraphs(dataset, map)`, `getShapeGraphs(dataset)`, `unsetShapeGraphs(shapeIri)`; `graphRoutingFor(dataset)` → `{graphForShape(id), readGraphsForShape(id)}` or `undefined` when the dataset has no routes; graph IRIs checked (absolute, not portable, not the registry) |
| `src/utils/LinkedStorage.ts` | `setDatasetForShapes(dataset, shapes[], {graph?})` beside the variadic form; `unsetDatasetForShape` drops that shape's graph routes |
| `src/utils/parseDatasetsConfig.ts`, `src/utils/loadStores.ts` | `DatasetEntry.graphs?: Record<string, string>` validated; `loadStores` records it for the store |
| `src/sparql/sparqlUtils.ts` | `SparqlOptions.namedGraphUriParameter?`; `SparqlCompileOptions` (= options + `routing`) |
| `src/sparql/graphScope.ts` | per-subject graph sets: union `FROM NAMED`, fixed `GRAPH <g>`, `VALUES`, the default graph without `FROM NAMED`; `.from()` through the same path |
| `src/sparql/irToAlgebra.ts` | alias → shape → set for select (count and ask reuse it); mutation `graph` → `plan.graph` for every mutation kind |
| `src/sparql/SparqlDataset.ts` | `protected graphRouting()`; reads compiled with it; write graph resolution and the `.into()` check; `checkOwnedLinks` in the graph; the `named-graph-uri` path |
| `src/sparql/ownedLinkCheck.ts` | `ownedLinkTypesQuery(ids, graph?)` |
| `src/utils/graphRegistryCache.ts` | `expandReadGraphs` keeps `graphs.default` in a mixed set when the store maps it |
| `src/queries/IntermediateRepresentation.ts`, `mutationLowerSpec.ts`, `lower.ts`, `CreateBuilder.ts`, `UpdateBuilder.ts`, `DeleteBuilder.ts` | `graph?` on the mutation IR kinds; `.into(graph)` on the builders (immutable, kept by every fluent call, not serialized) |
| `src/queries/graphQuery.ts` | refusal code `graph-not-routed` |
| `src/queries/queryDependencies.ts`, `src/live/changes.ts`, `src/live/matcher.ts` | `graphs` in dependencies, `graph` in effects, the matcher's graph filter |
| `src/index.ts` | export `setShapeGraphs`, `getShapeGraphs`, `graphRoutingFor` |
| `src/tests/graph-routing.test.ts` (new) | table and config; golden SPARQL per form (unchanged without routes, one graph, `FROM NAMED` + `GRAPH ?g`, `VALUES`, default graph mixed, sub-shapes, `.from()` with the default graph, `named-graph-uri`); writes per mutation kind; `.into()` allowed and refused, not in JSON; owned-link check in the graph; dependencies, effects and matcher |
| `src/tests/graph-routing-fuseki.test.ts` (new) | `[fuseki]`: a write lands in the routed graph; routed reads (join across graphs, sub-shape graph, default graph mixed, count, ask); an owned delete stays in its graph; `.into()` refused; identical rows with `isolateLinkedTypeChecks` on and off |
| `docs/architecture/ontologies.md` | graph routing |
| `docs/backlog/065…`, `066…` | resolved by this step |
| `.changeset/graph-routing.md` (new) | minor, with the breaking list |
| `docs/reports/051-graph-routing.md` (new) | the record |

### Pitfalls

- **Nothing may change without routes.** Every golden suite must pass untouched: the routing
  object is only passed when the dataset has routes, and a query whose groups all read the
  default graph compiles exactly as today.
- **`FROM NAMED` empties the default graph** (probed above): a query that mixes the default graph
  with named graphs must not carry `FROM NAMED`, and then every named group needs `VALUES` or a
  fixed graph (`GRAPH ?g` alone would range over every named graph).
- **Two copies.** The table lives on the shared global and is keyed by the dataset object and the
  shape IRI, never by a class object.
- **Across graphs, writes stay in one graph.** A delete by id removes incoming references only in
  the subject's graph; an `update_where`/`delete_where` filter or a computed update that traverses
  into a linked node in another graph does not see it. Recorded as a backlog item.
- **Owned nodes live in the owner's graph** (decision 9's fixture does the same): nested creates go
  into the plan's graph, whatever their own shape's route.
- **`.into()` over the wire.** A builder with `.into()` sent through a remote dataset loses it by
  design; the receiving side derives the graph.
- **The registry and portable names** are never write targets; reserved store names
  (`isReservedGraphName`) neither.
- **K5** shares `irToAlgebra.ts` and `syncShapes.ts`: it rebases on this step.

### Tests

- Quick gate (after each phase), with the env below exported first:
  `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs <files>`, plus
  `npm run typecheck`.
- Full gate (before landing): `npm test` (jest; `two-copies-built` is backlog 060), `npm run
  typecheck`, `npm run test:fuseki`, `npm run check:dts`, `npx linked build`.
- Isolation: `FUSEKI_TEST_PORT=3182`, `FUSEKI_BASE_URL=http://localhost:3182`,
  `LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-071-k4`, `LINKED_FUSEKI_IMAGE=ghcr.io/linked-fw/fuseki:6.2.0-2`.
- Verify (master): golden SPARQL per form; `[fuseki]`: decision 9's fixture (10 of 100 graphs,
  ~1M quads, loaded into a dataset of the step's own store) read through routed DSL queries
  returns exactly the rows the same queries return on the ideal dataset (only the 10 graphs' data
  in the default graph), for point, page, count, join, walk and label, with median timings of
  both; a write lands in the routed graph; an owned delete stays in its graph; `.into()` to a
  graph the routing forbids refused.

### Phases

1. **Routes:** `graphRouting.ts`, `LinkedStorage`, config and `loadStores`, exports. Quick gate:
   the routing-table and config tests; `load-stores-loader`, `dataset-pin-identity`.
2. **Routed reads:** `graphScope.ts`, `irToAlgebra.ts` reads, `SparqlDataset` reads, the
   `named-graph-uri` path, `expandReadGraphs`. Quick gate: the golden routing tests; the select,
   ask, count, `read-graphs` suites.
3. **Routed writes:** IR `graph`, `.into()`, plan graphs, the write check, owned-link check.
   Quick gate: the write tests; the mutation suites.
4. **Live queries:** dependencies, effects, matcher. Quick gate: the live tests and
   `query-dependencies`, `mutation-effects`, `live-matching`.
5. **Live store, fixture, docs and record:** the `[fuseki]` suite, decision 9's fixture,
   `ontologies.md`, backlogs, changeset, report 051, Outcome.

### Outcome

Landed (report [051](../reports/051-graph-routing.md)). Deviations from this section: a shape's
read set includes its owners' graphs, and a traversal through `contains` reads the owner's set
(owned nodes live in their owner's graph); on review the owner decided the write rule (master
§Contracts, Graph routing, "As decided on K4's review"): a change to an existing subject runs in the
graph that holds it, found in the same update (`graphIn`: `SELECT DISTINCT ?g_w … GRAPH ?g_w`), a
delete of several ids is one operation per id, and the owned-link check refuses a node that lives
outside its owner's graph; a MINUS right side writes its own `VALUES`. Backlogs 065 and 066 are
resolved; 067 records writes across graphs. Full gate: 2632 passed, 349/349 `[fuseki]`;
`two-copies-built` still fails (backlog 060).

## K5 — shape graphs

Master §K5 is the scope; this is its plan-mode detail, written against `named-graphs` at
`556803b` (K4 landed). Line numbers drift; search for the symbol.

### Contract (provided; repeated from the master §Contracts)

**Shape graphs (provider K5 + L1 + V2; consumers C4, every package)**

- `shapesToTurtle(shapes, {prefixes})` (core, server-only): deterministic (fixed prefix block,
  subjects sorted, `a` first, predicates sorted, one per line), shapes as declared plus
  `core:isExtending`, blank nodes only for `sh:inversePath` and sequence paths, each hanging off one
  IRI subject.
- `lib/esm/data/shapes.ttl` in every package build (L1). Hash prefix `linked-shape-graph/1`.
- `syncShapeGraphs(ds, {force?})` replaces `ShapesGraph.iriFor(pkg)` whole on a mismatch; the
  app's generated single-owner shapes go in `{DATA_ROOT}/graph/shapes` (`ShapesGraph`,
  `feedsHierarchy` false), regenerated at boot. The default-graph shape sync is removed after a
  one-time cleanup of the shapes it wrote (by `core:shapeHash` nodes).
- `patchContent` on a shape graph: the unit is the shape's CBD (deleted as a pattern through the
  IRI subject, inserted anew).

### How it works (inside the contract)

- **One data builder.** `shapesToTurtle` reuses the create data the shape sync already builds
  (`buildNodeShapeData`) and lowers it through core's own create pipeline (`createToAlgebra`), so
  the triples in `shapes.ttl` are exactly the ones a `NodeShape` read expects; only the generated
  single-owner shapes and `core:shapeHash` are left out. The Turtle writer then serialises those
  triples deterministically.
- **As declared (13b).** `buildNodeShapeData` writes the shape's own property shapes
  (`getPropertyShapes(shape)`, overrides included), no inherited copies; the default-graph
  `syncShapes` (the fallback, below) writes the same. `SHAPE_HASH_VERSION` 2 → 3 with the golden
  and the ledger, so every default-graph store rewrites once. Readers: core reads no stored shape
  except the sync's hash read; a data-only shape (a catalog built from stored shapes) inherits
  through `extends` already (`getSuperShapes`), and the one thing it got only from the flattened
  copies, the root `Shape`'s `label` and `type`, it now inherits from the built-in root: the
  property readers (`getPropertyShapes(…, true)`, `getPropertyShape`) end a data-only chain at the
  root `Shape`, as a class-backed chain does.
- **Blank nodes only for paths.** Complex `sh:path` values stay blank (SHACL requires blank path
  nodes: inverse, alternative, the repetition paths; sequence lists are blank-celled `rdf:List`s).
  `sh:and`/`sh:xone` lists of shapes, blank today, get IRI cells (`{shape IRI}/and/0`, as `sh:in`
  already has `{property IRI}/in/0`). Each blank structure is the object of exactly one triple;
  the writer refuses anything else.
- **The Turtle form.** A fixed prefix block (`core`, `rdf`, `rdfs`, `sh`, `xsd`, plus the caller's
  `prefixes`, sorted by prefix; a caller's prefix may not rebind a fixed one), then one block per
  IRI subject, sorted by IRI: the subject on its own line, then one `predicate object` per line
  (`a` first, then predicates by IRI, then objects by their written form), `;`-separated, `.` at
  the end, one blank line between blocks. A blank node is written inline on its parent's line
  (`[ sh:inversePath ex:p ]`, `( ex:a ex:b )` for a blank-celled list), with its own predicates in
  the same order. Literals: plain for `xsd:string`, `@lang`, else `"…"^^dt`. An IRI is compacted
  only when the local part is a safe `PN_LOCAL` (`Prefix.isValidLocalName`). Ends with `\n`.
- **API** (`src/shapes/shapesToTurtle.ts`, subpath `@_linked/core/shapes/shapesToTurtle`, not in the
  browser index):
  - `shapesToTurtle(shapes: Array<typeof Shape | NodeShapeData>, options?: {prefixes?:
    Record<string, string>}): string` — the given shapes, as declared.
  - `packageShapes(packageName): NodeShapeData[]` — the registered shapes of a package (for
    `@_linked/core`, its built-ins only; core's test shapes are never included), the selection
    `syncShapes` uses.
  - `packageShapesTurtle(packageName, options?): string | undefined` — `shapesToTurtle` of
    `packageShapes`, `undefined` when the package has none. This is the call L1's build and the
    sync both make, so a built `shapes.ttl` and an in-process generation are the same bytes.
  - `singleOwnerShapesTurtle(shapes, options?): string | undefined` — the generated single-owner
    shapes of the given shapes (with the owners' `core:generatedShape` links), for the app graph.
- **`syncShapeGraphs(ds?, options?)`** (`src/shapes/syncShapeGraphs.ts`) → `{written, skipped,
  pruned, cleaned, appGraph?, defaultGraph?}`. Options: `force`, `packages` (npm names),
  `turtleFor(pkg)` (the bytes of a package's `shapes.ttl`, or `undefined` to generate;
  V2 reads the file), `appShapes: {graph, package?}` (the app's `{DATA_ROOT}/graph/shapes`; core
  knows no `DATA_ROOT`), `orphanScope: 'none' | 'all'`.
  - Per package (sorted): `hash = sha256Hex('linked-shape-graph/1\n' + text)`; compared with the
    `ShapesGraph` record's `core:contentHash` (one `ShapesGraph.select()` per run); equal → skipped;
    else `ShapesGraph.create({id, package, sources: 'data/shapes.ttl'}).withContent(turtle,
    {contentHash})` or `update(id).set({sources}).replaceContent(…)`.
  - The app graph: `singleOwnerShapesTurtle` of every registered shape, hashed the same way,
    replaced whole on a mismatch (a `ShapesGraph` record with the caller's `package`); dropped
    when there is nothing to write and a record exists. Without `appShapes` it is not written.
  - **Cleanup (one-time):** after the graphs, every shape the run writes (the packages' shapes and
    the generated ones) that the default graph still holds with a `core:shapeHash` is deleted there
    with its owned subtree (`DeleteBuilder` on `NodeShape`, the existing cascade); one select finds
    them, so a cleaned store costs one read. Shapes another writer put in the default graph are
    not touched.
  - Orphans (`orphanScope: 'all'`, no `packages`): `ShapesGraph.delete` of every record whose
    `package` is not registered (the app graph excepted).
  - **Fallback**, as the ontology sync: a dataset without `graphQuery`, or
    `unsupported-query-kind` before the first graph write → the default-graph `syncShapes` (its
    thunks run; `defaultGraph` = how many). `syncShapes`/`syncShape` stay exported for it and for
    existing callers.
- **CBD patches** (`graphQueryToSparql.ts`). `patch.delete` may hold blank nodes: its ground
  triples go in `DELETE DATA` as today; each triple `<s> <p> _:b` with an IRI subject, together
  with the statements of `_:b` and recursively of every blank node under it, becomes one
  `DELETE { GRAPH <g> { … } } WHERE { GRAPH <g> { … } FILTER(isBlank(?b0) && …) }`, blank nodes
  as variables. Refused (as the plain errors of the body parser today): a blank node that is the
  object of more than one triple, a blank subject no IRI subject reaches, a cycle. The insert side
  is unchanged (`INSERT DATA` mints fresh blank nodes).

### Files

| File | What changes |
|---|---|
| `src/shapes/syncShapes.ts` | declared property shapes only; `sh:and`/`sh:xone` with IRI cells; `buildNodeShapeData` exported (internal) with an option to leave out generated shapes; `SHAPE_HASH_VERSION` 3; doc |
| `src/shapes/nodeShapeData.ts`, `src/utils/ShapeClass.ts` | data-only shapes inherit the root `Shape`'s property shapes in the property readers |
| `src/shapes/shapesToTurtle.ts` (new) | the writer, `shapesToTurtle`, `packageShapes`, `packageShapesTurtle`, `singleOwnerShapesTurtle`, the fixed prefixes |
| `src/shapes/syncShapeGraphs.ts` (new) | `syncShapeGraphs`, `SHAPE_GRAPH_HASH_PREFIX`, `shapeGraphHash`, cleanup, fallback |
| `src/sparql/graphQueryToSparql.ts` | CBD deletes in `graph_patch` |
| `src/index.ts` | nothing new in the browser index (the new modules are subpaths) |
| `src/tests/shape-sync-output-equivalence.test.ts`, `shacl-syncshapes.test.ts`, others asserting flattened copies | golden and ledger for version 3; declared-only expectations |
| `src/tests/shapes-to-turtle.test.ts` (new) | the form; byte-identical across runs; golden `src/tests/fixtures/core-shapes.ttl` for core's own shapes; blank nodes only for paths; parses back (N3.js) to the create pipeline's triples |
| `src/tests/shape-graphs.test.ts` (new) | the sync against a recording double: create, skip, replace, force, app graph, cleanup, orphans, fallback |
| `src/tests/graph-query.test.ts` | CBD golden SPARQL and refusals |
| `src/tests/shape-graphs-fuseki.test.ts` (new) | `[fuseki]`: sync written then skipped; cleanup of old default-graph shapes; CBD patch on an `sh:inversePath` shape leaves no orphan blank node; SHACL targeting of a sub-shape's instances by the super-shape with shapes as declared |
| `docs/architecture/ontologies.md` | shape graphs |
| `.changeset/shape-graphs.md` (new) | minor, with the breaking list |
| `docs/reports/052-shape-graphs.md` (new) | the record |

### Pitfalls

- **Hash churn.** The graph hash is over the Turtle bytes; anything non-deterministic in the
  writer (map order, prefix registry, blank labels) rewrites every graph at every boot. The writer
  uses only the fixed and passed prefixes, never `Prefix`'s global map.
- **The default-graph golden.** Declared-only changes what `syncShapes` writes: bump
  `SHAPE_HASH_VERSION`, update the golden, append to the ledger (never edit an entry).
- **Two copies.** The shape enumeration reads the shared registry (`getAllShapeClasses`), as
  `syncShapes` does; nothing keyed by class objects.
- **Readers in other repositories** (CN's catalogs, server) read the default graph until V2/C4;
  inherited properties stored as copies disappear from what the default-graph sync writes. CN's
  catalog follows `extends` through its registry (C4, CN backlog 131).
- **CBD deletes and inference.** The pattern's `rdf:type` triples could match by inference; the
  `DELETE` template only removes stored triples, so an inferred match deletes nothing extra.
- **K4 shares `syncShapes.ts`/`irToAlgebra.ts`**: this step changes no routing code; it rebases
  on `named-graphs` before landing.

### Tests

- Quick gate (after each phase), with the env below exported first:
  `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs <files>`, plus
  `npm run typecheck`.
- Full gate (before landing): `npm test` (jest; `two-copies-built` is backlog 060), `npm run
  typecheck`, `npm run test:fuseki`, `npm run check:dts`, `npx linked build`.
- Isolation: `FUSEKI_TEST_PORT=3183`, `FUSEKI_BASE_URL=http://localhost:3183`,
  `LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-071-k5`, `LINKED_FUSEKI_IMAGE=ghcr.io/linked-fw/fuseki:6.2.0-2`.
- Verify (master): golden `shapes.ttl` for core's own shapes (byte-identical across runs); sync
  written then skipped; a CBD patch on a shape with an `sh:inversePath` leaves no orphan blank
  node; a select of a sub-shape's instances still validates against the super-shape (SHACL
  targeting).

### Phases

1. **Declared shapes and the writer:** declared-only data, IRI-celled `sh:and`/`sh:xone`, version
   3, root inheritance for data-only shapes, `shapesToTurtle` and friends, the core golden. Quick
   gate: `shapes-to-turtle`, `shape-sync-output-equivalence`, `shacl-syncshapes`,
   `shape-sync-hash`, `shape-catalog`, `tighten-only`.
2. **CBD patches:** `graphQueryToSparql`, unit and `[fuseki]` tests. Quick gate: `graph-query`,
   `graph-query-fuseki`, the CBD part of `shape-graphs-fuseki`.
3. **Shape graph sync:** `syncShapeGraphs`, cleanup, fallback, orphans; unit and `[fuseki]` tests
   (written then skipped, cleanup, SHACL targeting). Quick gate: `shape-graphs`,
   `shape-graphs-fuseki`, `sparql-fuseki-shape-sync`.
4. **Docs and record:** `ontologies.md`, changeset, report 052, Outcome; full gate and Verify.
