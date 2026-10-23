---
summary: >
  `IDataset.graphQuery` (required) with the kinds `graph_create`, `graph_replace`, `graph_patch`,
  `graph_drop`; `updateQuery`/`createQuery`/`deleteQuery` required and `askQuery` optional (an ask
  on a dataset without it is a select `LIMIT 1`); the built-in shapes `NamedGraph`,
  `OntologyGraph`, `ShapesGraph`, `DraftGraph` with the graph API and automatic registry records;
  portable graph names; registry terms; `SparqlDataset.graphQuery` as one SPARQL update per
  query; typed refusals; `deleteInsertPlanToSparql` honours `plan.graph`. CN plan 071, sub-plan
  004.
packages: [core]
---

# 048 — `graphQuery` and the graph API

## Why

CN plan 071 puts each package's ontology data in its own named graph, recorded in a graph
registry, and has every store and caller change whole graphs through one interface method. This
step provides that method, the API that builds its queries, the vocabulary, and the SPARQL
implementation; the later steps read graphs (`.from()`), sync ontologies into them, carry graph
queries through the server and CN, and route data to graphs. Sub-plan
[004](../plans/004-named-graphs.md) holds the plan-mode detail and the contracts.

## What

**Interface** (`src/interfaces/IDataset.ts`). `graphQuery(query: GraphQuery): Promise<GraphResult>`
is required, as are `updateQuery`, `createQuery`, `deleteQuery`; `askQuery` is the one optional
method. The types (`src/queries/IntermediateRepresentation.ts`) are the contract's:

```ts
type GraphQueryKind = 'graph_create' | 'graph_replace' | 'graph_patch' | 'graph_drop';
interface GraphContent { mediaType: 'text/turtle' | 'application/n-triples'; text: string }
interface GraphQuery { kind; graph; recordClass; record?; content?; patch?: {insert?, delete?}; contentHash? }
interface GraphResult { graph: string; contentHash?: string; modified?: string; changed: boolean }
```

**Dispatch and routing** (`src/queries/queryDispatch.ts`, `src/utils/LinkedStorage.ts`).
`resolveGraphQuery(target, q)` is the runtime guard: a target without a `graphQuery` function (a
dataset class built against an older core) is refused with `unsupported-query-kind`, exactly like
a store without graph support. `LinkedStorage.graphQuery` routes by the record shape (the shape
whose target class is `recordClass`, its pin found through the prototype chain, so a pin of
`NamedGraph` covers every subclass), else the default dataset. `resolveExistence` answers an ask
on a dataset without `askQuery` by sending the same pattern to `selectQuery` with `limit: 1`; a
shapeless ask is refused there. The dispatch reports graph queries to listeners as kind `'graph'`.

**Boundary** (`src/queries/graphQuery.ts`). `GraphQueryError` (branded, `code`:
`unsupported-query-kind`, `graph-not-registered`, `graph-name-read-only`, `graph-exists`),
`isGraphQueryError(err, code?)`, `unsupportedGraphQuery(q)`, `assertGraphWritable(iri)` and
`parseGraphQuery(json)`, which checks a graph query that arrived as JSON (kind, absolute IRIs,
media types, field types, wire version). `fromJSON` refuses a graph query envelope and names
`parseGraphQuery`.

**Shapes and the graph API** (`src/shapes/NamedGraph.ts`). `NamedGraph` (`sd:NamedGraph`: `name`,
`contentHash`, `feedsHierarchy`, `modified`, `sources`), `OntologyGraph` and `ShapesGraph` (add
`package`, `version`, and `iriFor(pkg)`), `DraftGraph`; all four are built-ins. Each call sends
exactly one graph query (builders are thenables with `exec(target?)`):

| Call | Query |
|---|---|
| `X.create({id, ...own})`, `.withContent(c)` | `graph_create` |
| `X.update(iri).set(own)` | `graph_patch` with `record`, no body |
| `.set(own).replaceContent(c)` / `.patchContent(p)` | `graph_replace` / `graph_patch` with `record` |
| `X.replaceContent(iri, c)`, `X.patchContent(iri, p)` | `graph_replace`, `graph_patch` |
| `X.delete(iri)` | `graph_drop` |

`recordClass` is the receiver's target class; content calls take `{contentHash}`. The statics
refuse a portable name before sending and refuse to run in a browser (the import is fine).
`NamedGraph` extends `Shape` through a base typed without Shape's mutation statics, so
`create`/`update`/`delete` can be graph queries without `@ts-ignore`; `upsert`, `deleteAll` and
`deleteWhere` throw. `select()` of these shapes reads `graphs.registry` (`static storedInGraph`,
wrapped as `GRAPH <registry> { … }` in `irToAlgebra.ts`; counts and asks reuse the select
algebra).

**Records** (`src/queries/graphRecords.ts`). The record classes a store can write, with each
class's `feedsHierarchy` default (`OntologyGraph` true, others false) and own fields; unknown
classes, unknown fields and automatic fields passed by a caller are refused.
`graphContentHash(q)`: the caller's hash, else `sha256Hex` of the content text, and for a patch
`sha256Hex(delete text + '\n' + insert text)`; none for a record-only update or a drop.

**Names and terms.** `src/ontologies/graphs.ts` (`graphs.default`, `union`, `allOntologies` ↔
`…/all-ontologies`, `allShapes` ↔ `…/all-shapes`, `registry`), `src/ontologies/sd.ts`
(`sd.NamedGraph`, `sd.name`), and in `linked-core.ts` and `data/core.ttl`:
`core:OntologyGraph`, `core:ShapesGraph`, `core:DraftGraph` (each `rdfs:subClassOf
sd:NamedGraph`), `core:contentHash`, `core:feedsHierarchy` (`xsd:boolean`), `core:package`,
`core:version`.

**SPARQL** (`src/sparql/graphQueryToSparql.ts`, `SparqlDataset.graphQuery`). One `ASK` on the
registry (create, replace, patch), then one update: create drops and fills the graph and writes
the whole record (`a <class>`, `sd:name`, `feedsHierarchy`, hash, `dcterms:modified`, own
fields); replace is the contract's update plus each own field passed; a patch is `DELETE DATA`
then `INSERT DATA` (a blank node in the delete body is refused) plus hash and load time; a
record-only patch changes own fields only; drop removes graph and record. Every body is parsed
with N3.js (imported on demand) and re-serialised as N-Triples, so no caller text enters the
update unparsed; relative IRIs and quads are refused. `deleteInsertPlanToSparql` emits
`WITH <g>` when `plan.graph` is set.

### Large bodies

Measured on `ghcr.io/linked-fw/fuseki:6.2.0-1` (own store on :3171), schema.org's
`schema.ttl` (16,211 triples, 0.99 MB Turtle) replacing a registered graph:

| Run | One update (body + record, one transaction) | GSP `PUT` + record update (two transactions) |
|---|---|---|
| `graph-query-fuseki.test.ts` alone | 996 ms | 408 ms |
| inside `npm run test:fuseki` | 1371 ms | 751 ms |
| inside `npm test` (all suites in parallel) | 2445 ms | 2109 ms |
| synthetic 16,000 N-Triples lines, alone | 818 ms | 397 ms |

The GSP route is about twice as fast alone but takes two transactions, which the contract does
not allow; the single update stands. The update time includes parsing and re-serialising the
body in the process.

## Breaking changes (changeset `graph-query-and-graph-api.md`, minor)

- `IDataset.graphQuery` required; `updateQuery`, `createQuery`, `deleteQuery` required;
  `askQuery` optional (select `LIMIT 1` fallback).
- Four new built-in shapes, which shape sync writes like the other built-ins.

Implementers outside core that the type change breaks until their steps land (no runtime break:
core never calls a missing method):

| Repository | Implementer | Missing | Step |
|---|---|---|---|
| server | `RemoteDataset` (`src/shapes/quadstores/RemoteDataset.ts`) | `graphQuery` | V1 |
| CN | `AppDataRouter` (`src/data/AppDataRouter.ts`) | `graphQuery` | C1 |
| CN | `ExecutionGateway` (`packages/execution-gateway/src/ExecutionGateway.ts`) | `graphQuery` | C1 |
| CN | `withAccess` (server-utils `QueryAccess.ts`, generic proxy) | the graph arm (types compile) | U1, C1 |
| CN, react, shape-ui | test doubles typed `IDataset` (`cnMainStore.test.ts`, `appGatewayRoutes.test.ts`, `AppDataRouter.requireWrite.test.ts`, `ExecutionGateway.test.ts`, react `tests/fixtures.ts`, shape-ui `catalog.test.ts`) | the now-required methods | C1 (CN); core backlog 063 (react, shape-ui) |
| webid.email | no `IDataset` implementer found in `webid.email/src` or `semantu-webid-email/src` | — | — |

Subclasses of `SparqlDataset` inherit a working `graphQuery`: fuseki's `FusekiStore` (and CN's
`AppDataFusekiStore` through it) and CN's `HostAgentForwarder` (which would forward the update to
the host agent; C1 decides whether that arm is allowed).

## Verification

Before the review fixes (worktree `named-graphs--k1`, own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-1`
on :3171, compose project `core-071-k1`):

- `npm test`: `Test Suites: 1 failed, 4 skipped, 125 passed, 126 of 130 total`, `Tests: 120
  skipped, 2519 passed, 2639 total`, `Time: 25.901 s`, `[fuseki] live tests: 328 total — 328
  passed`. The one failing suite is `two-copies-built.test.ts` ("Module cache already has entry …
  This is a bug in Jest"), backlog 060, reproduced unchanged in the main checkout at `a8688fc`.
  Because jest exits non-zero, `npm test` stops before its typecheck; run separately below.
- `npm run typecheck`: clean, 3.2 s. `npm run test:fuseki`: `Tests: 2349 skipped, 328 passed`,
  8.6 s. `npm run check:dts`: clean, 1.6 s. `npx linked build`: `✔ Build successful`, 6.0 s.
- `lib/esm`: no static `n3` import; `import('n3')` only in `sparql/graphQueryToSparql.js` (and the
  existing `ontology/hierarchy.js`); `shapes/NamedGraph.js` and `queries/graphRecords.js` have no
  `node:crypto`.

Full gate at landing (after the review fixes and the decided refusal), same store:

- `npm test`: `Test Suites: 1 failed, 4 skipped, 125 passed, 126 of 130 total`, `Tests: 120
  skipped, 2530 passed, 2650 total`, `Time: 30.658 s`, `[fuseki] live tests: 330 total — 330
  passed, 0 failed, 0 skipped` (the failing suite is backlog 060's, as above).
- `npm run typecheck`: clean, 3.5 s. `npm run test:fuseki`: `Tests: 2358 skipped, 330 passed,
  2688 total`, `Time: 8.029 s`. `npm run check:dts`: clean, 1.5 s. `npx linked build`:
  `✔ Build successful`, 6.0 s.
- Measurement in these runs: schema.org one update 2784 ms (all suites in parallel) and 1332 ms
  (`test:fuseki`); GSP `PUT` + record update 809 ms and 400 ms.

## Review

An independent read-only review of the diff against master §K1 and §Contracts:

> Verdict: There are two open medium findings and no high ones. The first is that the ask
> fallback (`queryDispatch.ts:92-110`) throws for subject asks against any store using core's
> result mapping, because `singleResult` returns a row or `null`, not an array. It is a code fix
> with a test and needs no design choice. The second is that store-native graph names such as
> `urn:x-arq:DefaultGraph` and `urn:x-arq:UnionGraph` are not refused by the graph API
> (`graphQuery.ts:93` / `SparqlDataset.ts:263`), so a create or replace can likely write into or
> drop the real default graph. That one needs an owner or master decision on where the refusal
> lives (`SparqlDataset` hook or F2's `FusekiStore`) and a §Contracts note.

Fixed: the ask fallback (a row or `null` is answered; test against a `SparqlDataset` without
`askQuery`), `nullSubject` in the fallback, absolute graph IRIs in `assertGraphWritable`, an empty
patch refused at the boundary and treated as record-only by the store, the "leaf module" comment,
the sub-plan's `sources` wording, the changeset's dispatch-event line.

**Decided and fixed** (coordinator, recorded in master §Contracts at CN `d10d95b69`):
store-native names are refused by `SparqlDataset`'s protected `isReservedGraphName(iri)`, checked
on every graph query before any SPARQL is built (default: `urn:x-arq:` → `graph-name-read-only`;
tests for `urn:x-arq:DefaultGraph` and `urn:x-arq:UnionGraph`, unit and `[fuseki]`).
`feedsHierarchy` is an `OntologyGraph` field only (always false on `DraftGraph`, `ShapesGraph`).
Replace and patch through a subclass check the stored record's class (`graph-not-registered` on a
mismatch); `NamedGraph.*` accepts any record.

**Left as a note (low):** `LinkedStorage.graphQuery` routes through the first shape that targets
`recordClass`; an app shape that also targets `sd:NamedGraph` or a core graph class could be
picked first and change where graph queries go. Graph routing is K4's; revisit there.
