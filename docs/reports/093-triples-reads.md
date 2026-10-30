---
date: 2026-10-30
summary: >
  Two shapeless reads in the DSL: a graph read (`NamedGraph.readContent(graph)`, every triple of
  one graph, routed like that class's graph queries) and a subject read
  (`TriplesBuilder.forNode({id}).from(graphs)`). Both are a `TriplesQuery` (plain data) sent to the
  new optional `IDataset.triplesQuery`, which `SparqlDataset` answers with one SELECT; the answer
  is `Triple[]` with IRIs as `{id}` and literals as `{value, datatype, language?}`. Minor. Covers
  part of backlog 004 (CONSTRUCT), which stays open.
packages: [core]
---

# 093 — Triples reads: a graph read and a subject read

## PR

### Summary

Create Now still reads some graphs with raw SPARQL because the DSL has no shape for the data: a
personal ontology draft graph, an import's staging graph, one node of unknown type. This adds two
reads that need no shape:

```ts
const draft = await DraftGraph.readContent(graph).limit(1001).exec(dataset); // every triple of a graph
const node = await TriplesBuilder.forNode({id}).from(graph).exec(dataset);   // one subject's triples
```

Both answer `Triple[]`: `{subject, predicate, object, graph?}`, an IRI `{id}`, a blank node
`{id: '_:label'}`, a literal `{value, datatype: {id}, language?}`.

### Changes

- `src/queries/triplesQuery.ts`: `TriplesQuery` (`{kind: 'triples', subject?, graphs?, limit?,
  recordClass?}`), `Triple`, `TripleObject`, `LiteralTerm`, `isLiteralTerm`, `isTriplesQuery`,
  `triplesQueryOf` (the builders' check) and `parseTriplesQuery` (the wire check). A read with
  neither a subject nor graphs is refused; a subject must be an absolute IRI (a `_:` label too is
  refused); a limit is a positive integer; graphs go through `normalizeReadGraphs`, so `.from()`
  takes what select's `.from()` takes.
- `src/queries/TriplesBuilder.ts`: `TriplesBuilder.forNode({id})`, `.from(graphs)`, `.limit(n)`,
  `toTriplesQuery()`, `exec(target?)`, awaitable. `.from()` on a graph read throws (it names its
  graph).
- `NamedGraph.readContent(iri)` (inherited by `OntologyGraph`, `ShapesGraph`, `ComponentsGraph`,
  `DraftGraph`): a graph read carrying the class IRI as `recordClass`, the routing key. It reads
  any graph, registered or not.
- `IDataset.triplesQuery?(query)`: optional, like `askQuery`, so every existing dataset class still
  type-checks. `queryDispatch.ts`: `resolveTriples` (refuses a target without the method, and a
  non-array answer), `dispatchTriplesQuery`, an instrumented arm, and a `'triples'` dispatch event.
- `LinkedStorage.triplesQuery`: a read with `recordClass` goes where that class's graph queries go
  (the lookup is now `resolveDatasetForRecordClass`, shared with `graphQuery`); a subject read
  goes to every dataset the router knows, in order, answers joined up to the limit, the way a
  shapeless ask is asked everywhere. A dataset that cannot answer fails the read.
- `src/sparql/triplesToSparql.ts`: `triplesToAlgebra`, `triplesToSparql`,
  `mapSparqlTriplesResult` (exported from `@_linked/core/sparql`). One pattern, `?s ?p ?o` or
  `<s> ?p ?o`, scoped by `scopeAlgebraToGraphs` exactly as other reads are: `GRAPH <g>` for one
  graph, `FROM NAMED` with a graph variable for several, `VALUES` with the store's default-graph
  name when the default graph is in the set, plain for the default graph. No `ORDER BY`.
- `SparqlDataset.triplesQuery`: expands the graphs like a `.from()` set (portable names, registry
  kinds; an empty expansion answers `[]` without querying), follows the store's routing for a
  subject read without graphs (as a shapeless ask does), sends `FROM NAMED` as `named-graph-uri`
  parameters under `namedGraphUriParameter`. `@_linked/fuseki`'s `FusekiStore` extends
  `SparqlDataset`, so it has the read with no change in that repo.
- `fromJSON` points a `{kind: 'triples'}` envelope to `parseTriplesQuery`, as it does for graph
  queries. README: "Triples reads (no shape)". Changeset `triples-reads.md` (minor).

### Verification

In `/Users/rene/web/wt/side-225--cg-core`, `npx linked build`:

```
✔ Build successful
```

Full jest (the live suites skipped, no Fuseki variables set):

```
[fuseki] live tests: 418 total — 0 passed, 0 failed, 418 skipped
Test Suites: 18 skipped, 141 passed, 141 of 159 total
Tests:       538 skipped, 2610 passed, 3148 total
```

The new unit suite, `src/tests/triples-read.test.ts`: 19 tests (builders, wire check, SPARQL text,
term mapping, registry expansion, routing, `namedGraphUriParameter`, dispatch refusals, the
`LinkedStorage` routes). The live suites against the local Fuseki on :3030, each in a
`linked-core-test-<file>` dataset the suite creates and drops (none left afterwards):

```
PASS src/tests/read-graphs.test.ts
PASS src/tests/triples-read-fuseki.test.ts
PASS src/tests/read-graphs-fuseki.test.ts (6.582 s)
PASS src/tests/graph-query-fuseki.test.ts (16.773 s)
[fuseki] live tests: 24 total — 24 passed, 0 failed, 0 skipped
Tests:       52 passed, 52 total
```

`tsc -p tsconfig-tests.json --noEmit` prints nothing.

### Deviations

The plan (CN plan 323, step CG) placed the reads "next to `graph_replace`/`graph_drop` in
`GraphQuery`". They are a query of their own instead, in the same plain-data style, because
`graphQuery` is the write channel: CN's `DraftsRouter.graphQuery` sends it to the writable store
(`writable('graph', …)`, which forks a branch on its first write) and `WorkspaceCnRouter` to its
writable one, and `GraphResult` is a write's answer (hash, modified, changed). A read on that
channel would fork branches for reads, or need every router to tell reads from writes. The graph
read keeps the graph statics' routing by putting the record class on the query.

### Follow-ups

- CN (step SQ2): `DraftsRouter`, `WorkspaceCnRouter`, `AppDataRouter`, `OntologyFileStore`, the
  execution gateway and `HostAgentForwarder` have no `triplesQuery`; a call site that goes through
  one needs an arm there (a read: to the store that holds the data, not a writable fork). The call
  sites below run on a concrete store already, except `documentStaging`'s `io.selectDrafts`.
- Backlog 004 (CONSTRUCT) stays open for pattern-based subgraphs and transforms; it records that
  these two reads cover whole-graph and one-subject extraction.

## Details

### API

| Call | Reads | Routed by `LinkedStorage` |
|---|---|---|
| `X.readContent(graph)` (`X` a graph-record class) | every triple of `graph` | where `X`'s graph queries go |
| `TriplesBuilder.forNode({id})` | `id`'s triples, where a shapeless ask looks | every dataset, joined |
| `….from(graphs)` | `id`'s triples in `graphs` | every dataset, joined |
| `….limit(n)` | at most `n` | |

`exec(dataset)` sends it to that dataset. A triple's `graph` is absent for the default graph. A
read on an inferring store returns the triples that store answers a `?s ?p ?o` pattern with,
inferred types included.

### Before and after, per Create Now call site

**`src/backend/shapes/ontologyDraftStore.ts` `get` (~159).** Before:

```ts
const json = (await dataset.rawQuery(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } LIMIT ${MAX_DRAFT_ROWS + 1}`, 'query')) as …;
const rows = json?.results?.bindings ?? [];
if (rows.length > MAX_DRAFT_ROWS) throw new ServerCallError(409, …);
return draftRecordOf(graph, ontology, rows);
```

After (`draftRecordOf` reads `Triple`s: `t.subject.id`, `isLiteralTerm(t.object)`,
`t.object.language`, `t.object.datatype.id`; `DraftDataset` no longer needs `rawQuery`):

```ts
const triples = await DraftGraph.readContent(graph).limit(MAX_DRAFT_ROWS + 1).exec(dataset);
if (triples.length > MAX_DRAFT_ROWS) throw new ServerCallError(409, …);
return draftRecordOf(graph, ontology, triples);
```

The read goes where `DraftGraph.replaceContent(graph, body).exec(dataset)` writes.

**`src/utils/documentStaging.ts` `readStagedInstance` (~357).** Before:

```ts
const rows = await io.selectDrafts(target, `SELECT ?p ?o WHERE { GRAPH <${graph}> { <${instanceId}> ?p ?o } }`);
```

After (`terms[p]` holds `TripleObject`s instead of SPARQL JSON bindings; `termValue` reads `{id}`
or `{value, datatype, language}`):

```ts
const triples = await TriplesBuilder.forNode({id: instanceId}).from(graph).exec(dataset);
for (const {predicate, object} of triples) { … }
```

**`src/utils/documentStaging.ts` `stagedSubjects` (~376).** Before:

```ts
const rows = await io.selectDrafts(target, `SELECT DISTINCT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
```

After (reads every triple of the staging graph, not only the distinct subjects: the API has no
projection; a staging graph is one import, so the cost is bounded by it):

```ts
const triples = await NamedGraph.readContent(graph).exec(dataset);
return [...new Set(triples.map((t) => t.subject.id))].filter(isSafeIri);
```

**`src/services/AppShapeIngestService.ts` `foreignSubjects` (~286), a node's types.** A subject
read gives one IRI's types and owner tag:

```ts
const triples = await TriplesBuilder.forNode({id: iri}).exec(cnMainDataset());
const types = triples.filter((t) => t.predicate.id === rdf.type.id).map((t) => t.object);
const owned = triples.some((t) => t.predicate.id === cnSh.ownerProjectId.id && isLiteralTerm(t.object) && t.object.value === projectId);
```

It does not replace the whole query: two of its branches match triples that point at the subject
(`?owner sh:property ?s`), which a subject read does not return, and it would be one read per IRI
where the query is one `VALUES` set. Those branches stay a query of their own (a select of
`NodeShape` by its `property`, or raw SPARQL) when SQ2 moves it.
