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
