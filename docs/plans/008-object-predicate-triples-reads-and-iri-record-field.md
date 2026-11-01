---
summary: >
  K2 and K3 for Create Now's raw-SPARQL removal: triples reads by object (`TriplesBuilder.toNode`)
  and by predicate (`TriplesBuilder.withPredicate`, `.exists()` as the ask), and an IRI-valued
  graph-record field, `attributedTo` (`prov:wasAttributedTo`) on `NamedGraph`.
packages: [core]
status: Plan
---

# 008 — Object and predicate triples reads; an IRI-valued graph-record field

## Context

Create Now still runs raw SPARQL in three places this plan unblocks (CN's raw-SPARQL inventory,
rows G1, G2, G6):

- **G1** (`termUsage.ts:96-106`): per term, how many triples in the ontology graphs have the term
  as **object** (any predicate but `rdf:type`, subject not the term itself).
- **G2, property half** (`termUsage.ts:114-124`): does any subject in the data graphs use
  **predicate** P (`FILTER EXISTS`, stops at the first match).
- **G6** (`hubGraphSync.ts:98-108`): CN marks the graphs it wrote with `prov:wasAttributedTo
  <SYSTEM_ACTOR>` beside the registry record (an `INSERT DATA` after the write, a raw `SELECT` to
  find them), because a record field can only be a literal (`literalFor`).

Report 093 added the triples reads (`TriplesQuery`, `TriplesBuilder.forNode`, `readContent`): plain
data sent to the optional `IDataset.triplesQuery`, scoped like every read.

Other agents work in core at the same time: `core-order` (select lowering: sorting, result
mapping) and `core-tx` (transactions in `IDataset`, `LinkedStorage`, `RemoteDataset`). This plan
stays out of those: no change to the select lowering, and only a doc line in `IDataset`.

## Planning blockers and decisions

### Decision 1 of 6: how a read fixes its object and its predicate

- A. Two optional fields on `TriplesQuery`, `object` and `predicate` (IRIs), next to `subject`: the
  read is one triple pattern whose fixed positions are the fields given.
- B. A new query kind per read (`triples_by_object`, …).
- C. A general pattern list (several triple patterns, variables) — that is backlog 004's CONSTRUCT.

**Chosen: A.** One pattern with up to three fixed positions is the existing read, generalised by
the smallest step; the lowering, the routing and the answer mapping stay one code path. B would
duplicate every arm (dispatch, `LinkedStorage`, routers) for the same SELECT. C is a different
feature (backlog 004 stays open).

### Decision 2 of 6: the builder API

- `TriplesBuilder.toNode({id})`: the triples whose object is that node (`?s ?p <o>`).
- `TriplesBuilder.withPredicate({id})` (static): the triples with that predicate (`?s <p> ?o`).
- `.withPredicate({id})` (on a builder): narrows a node or graph read to one predicate, e.g.
  `toNode({id: t}).withPredicate(rdfs.subClassOf).from(g)`.
- `.from(graphs)`, `.limit(n)` as before.

The object is a node only (`{id}`, an absolute IRI); a literal object is not a read CN needs and
would need a literal term on the wire. A predicate is `{id}` like every IRI in the DSL.

### Decision 3 of 6: the ask

- A. `.exists()` on `TriplesBuilder`: the same triples read with `limit: 1`, answered `true` when a
  triple comes back. No new dataset method and no new query kind.
- B. `AskBuilder.forPredicate(p)`: an `AskQuery` with a predicate pattern, sent to `askQuery`.
- C. Only `.limit(1)`, the caller measures the array.

**Chosen: A.** The ask is the triples read bounded to one triple, so it travels the triples
channel every router already forwards, and a SPARQL store answers it with `SELECT … LIMIT 1`, which
stops at the first match as `ASK` does. B would need a predicate pattern in `AskQuery`'s IR, its
lowering and its wire form, and a shapeless-ask fallback that cannot exist (a dataset without
`askQuery` is asked through a select of a shape). C works but makes every caller restate the
check; `.exists()` names it, and `LinkedStorage` stops at the first dataset that answers.

### Decision 4 of 6: graph scoping (unchanged rules)

The existing rule: a read names a subject, graphs or both; without graphs a subject read looks
where a shapeless ask looks (the default graph, or every graph the store's routing knows); a read
of every triple of a store is never sent.

- An **object read** is a node read like a subject read: graphs optional, the same fallback.
- A **predicate read** without a node needs graphs: `withPredicate(p)` alone is refused at build
  and at the wire (`.from()` names where to look). `?s <p> ?o` over a whole store is an unbounded
  scan of the store, the case the existing rule refuses; it is not loosened.
- Everything else is the existing path: `.from()` expansion (portable names, registry kinds),
  `scopeAlgebraToGraphs`, `FROM NAMED` / `VALUES` / `GRAPH <g>`, `namedGraphUriParameter`.

### Decision 5 of 6: `supports` and the wire

A dataset or router built against an older core that has `triplesQuery` would not know `object`
or `predicate`: it would read a graph read or a subject read instead and answer triples that look
real. So a read that fixes an object or a predicate requires a new query feature,
**`triplesPattern`**, checked against `supports` before it is sent (`resolveTriples`, the one entry
point, as `assertQuerySupported` does for selects). `SparqlDataset` lists every feature;
`LinkedStorage`'s dispatch lists every feature and checks each dataset it routes to.

DSL-JSON: `WIRE_VERSION` 1.3 → **1.4** (minor: two optional fields on a triples read).
`parseTriplesQuery` checks them like `subject` (absolute IRIs, a `_:` label refused). A receiver
before 1.4 drops fields it does not know, which is the reason for the feature check on the
receiving dataset; documented in `dsl-json.md`.

### Decision 6 of 6: the IRI-valued record field (K3)

- A. A core field `attributedTo` on `NamedGraph` (`prov:wasAttributedTo`, an IRI node, maxCount
  1), inherited by every record class; the record write path accepts `{id}` for a field declared
  as a node.
- B. A host-registered general field (`registerGraphRecordField(cls, name, def)`).

**Chosen: A** (the owner's decision). The record table gets a node kind: a `GraphRecordField` is
either `{path, datatype}` (a literal) or `{path, nodeKind: 'iri'}` (a node); `literalFor` becomes
`recordValueFor`, which takes `{id}` (an absolute IRI, no blank label) for a node field and
refuses a string there (and `{id}` on a literal field). The SPARQL writes `<iri>` for it. The shape
gets `@objectProperty({path: prov.wasAttributedTo, maxCount: 1, nodeKind: shacl.IRI}) get
attributedTo(): {id: string}`, so `select(g => [g.attributedTo])` reads `{id}`. `recordFields`
typing adds `attributedTo?: {id: string}` on each class. A new terms module
`ontologies/prov.ts` holds the term (no ontology data, like `sd.ts`).

## Route

Decisions 1–6 as chosen: `object`/`predicate` on `TriplesQuery`, `toNode`, `withPredicate`,
`.exists()`, the `triplesPattern` feature, wire 1.4, and `attributedTo` with node-valued record
fields.

## Plan

### Contracts

```ts
// queries/triplesQuery.ts
interface TriplesQuery {
  kind: 'triples';
  subject?: string;    // as before
  predicate?: string;  // new: the predicate IRI
  object?: string;     // new: the object node IRI (a node, never a literal)
  graphs?: string[]; limit?: number; recordClass?: string;
}
// Refused: no node (subject or object) and no graphs. A predicate alone needs graphs.
triplesQueryFeatures(query): QueryFeature[]   // ['triplesPattern'] when predicate or object is set

// queries/TriplesBuilder.ts
TriplesBuilder.toNode({id}): TriplesBuilder
TriplesBuilder.withPredicate({id}): TriplesBuilder      // static; needs .from() before it is sent
builder.withPredicate({id}): TriplesBuilder             // narrows a node or graph read
builder.exists(target?): Promise<boolean>               // the read with limit 1, true when a triple comes back

// queries/queryFeatures.ts
type QueryFeature = 'groupBy' | 'min' | 'max' | 'shapelessDelete' | 'triplesPattern';

// queries/graphRecords.ts
type GraphRecordField =
  | {path: string; datatype: string; many?: boolean}
  | {path: string; nodeKind: 'iri'; many?: boolean};
type GraphRecordValue = GraphRecordLiteral | {id: string};
graphRecordFieldValues(query): Map<string, GraphRecordValue[]>

// shapes/NamedGraph.ts
NamedGraph.attributedTo: {id: string}   // prov:wasAttributedTo, nodeKind IRI, maxCount 1
recordFields: {…, attributedTo?: {id: string}} on NamedGraph, OntologyGraph, ShapesGraph, ComponentsGraph
```

SPARQL (fixed positions are terms, the others projected variables):

```sparql
SELECT ?s ?p WHERE { GRAPH <g> { ?s ?p <o> } }                 # toNode({id: o}).from(g)
SELECT ?s ?o WHERE { GRAPH <g> { ?s <p> ?o } } LIMIT 1         # withPredicate({id: p}).from(g).exists()
SELECT ?s ?o ?g_s0 FROM NAMED <g1> FROM NAMED <g2>
  WHERE { GRAPH ?g_s0 { ?s <p> ?o } }                         # withPredicate(p).from([g1, g2])
```

A record write: `<g> prov:wasAttributedTo <https://…/system>` in the registry, in the same update
as the content.

### Expected file changes

- `src/queries/triplesQuery.ts`: fields, checks, the rule, `triplesQueryFeatures`.
- `src/queries/TriplesBuilder.ts`: `toNode`, `withPredicate` (static and instance), `exists`.
- `src/queries/queryFeatures.ts`: `triplesPattern`.
- `src/queries/queryDispatch.ts`: `resolveTriples` checks the features (via a shared
  `assertFeaturesSupported` behind `assertQuerySupported`).
- `src/queries/wireVersion.ts`: 1.4.
- `src/sparql/triplesToSparql.ts`: fixed positions, projection, answer mapping.
- `src/sparql/SparqlDataset.ts`: only the doc comment (it forwards the checked query already).
- `src/utils/fanOutNotice.ts`: the notice names node reads, not only subject reads.
- `src/queries/graphRecords.ts`, `src/sparql/graphQueryToSparql.ts`: node-valued fields.
- `src/ontologies/prov.ts` (new), `src/shapes/NamedGraph.ts`: `attributedTo`.
- `src/index.ts`: nothing new beyond existing exports (the builder is exported already).
- Tests: `src/tests/triples-read.test.ts`, `src/tests/triples-read-fuseki.test.ts`,
  `src/tests/graph-query.test.ts`, `src/tests/graph-query-fuseki.test.ts`,
  `src/tests/shapeless-delete.test.ts` (the version assertion).
- Docs: README (triples reads), `documentation/dsl-json.md` (triples reads on the wire, 1.4),
  `docs/architecture/ontologies.md` (record fields), `IDataset.triplesQuery` doc line.
- Changeset (minor).

### Pitfalls

- `LinkedStorage` and `IDataset` are `core-tx`'s area: only the doc line in `IDataset`, no change
  in `LinkedStorage` (its per-dataset `resolveTriples` already gets the feature check).
- The answer mapping took the subject from the query or from `?s`; it must do the same for the
  predicate and the object, and never read a binding for a fixed position.
- `.exists()` must not change the builder's own limit for a later `exec()` (builders are
  immutable already).
- A node field must never accept a blank label or a relative IRI (`assertSafeIri` guards the
  SPARQL text, the field check gives the clear error first).
- Core's own shapes data includes `NamedGraph`'s property shapes: a new property changes the
  generated `shapes.ttl` and any test that pins it.
