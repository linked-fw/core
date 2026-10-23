---
summary: Design the storage configuration layer — mapping shapes to named graphs, graphs to datasets, datasets to graph databases, and inference rules.
packages: [core, sparql]
---

# Storage Config and Graph Management

## Status: placeholder

The graph part is being designed and built through CN plan 071 and core sub-plan
[004](../plans/004-named-graphs.md): the portable names (`graphs.default`, `graphs.union`,
`graphs.allOntologies`, `graphs.allShapes`, `graphs.registry` in
`@_linked/core/ontologies/graphs`) and the graph registry landed with report 048; per-app storage
rules that route shapes to graphs come later in that plan.

This ideation doc is a placeholder for future design work. The storage config layer will determine how shapes, named graphs, datasets, and graph databases relate to each other.

## Prerequisite work completed

The dispatch registry refactoring (plan 001) broke the circular dependency `Shape → QueryParser → LinkedStorage → Shape` and established a clean architectural boundary:

```
Shape ──────────→ queryDispatch.ts ←──────── LinkedStorage
  (calls dispatch)      (leaf)        (registers as dispatch)

LinkedStorage ──→ ShapeClass.ts  (string-based shape lookups)
```

Key changes relevant to storage config:

- **LinkedStorage no longer imports Shape**. Store routing uses `Function` prototype-chain walking + `ShapeClass.getShapeClass()` for string-based shape resolution. This means routing metadata (targetGraph, targetDataset) can be added to `ShapeClass` or to `NodeShape`/`PropertyShape` objects without touching Shape or the dispatch boundary.
- **QueryParser removed**. All query dispatch goes through `queryDispatch.ts`, a single interception point where routing decisions can be made.
- **`shapeToStore` map accepts `Function` keys**. Currently maps shape classes to `IQuadStore` instances. This map (or a parallel one) can be extended to include graph/dataset metadata per shape.

## Key questions to explore

1. **Shape → Graph mapping**: How does the config declare which shapes live in which named graphs? The `ShapeClass` registry already maps shape IDs to classes — could extend with graph URIs.
2. **Graph → Dataset mapping**: How do named graphs compose into datasets?
3. **Dataset → Store mapping**: How does a dataset map to a physical graph database (Fuseki endpoint, Virtuoso, etc.)? `LinkedStorage.shapeToStore` already does shape→store; this would add dataset as an intermediate level.
4. **Inference rules**: Which engines support inference and how does the config express that?
5. **GRAPH clause generation**: Given the storage config, how do the SPARQL conversion utilities decide when and how to emit `GRAPH <uri> { ... }` blocks?
6. **Cross-graph queries**: Queries that span multiple named graphs — how does the config support this?
7. **Default graph behavior**: Different engines treat the default graph differently (union of all named graphs vs empty vs explicit). How does the config handle this?

## Where routing logic would live

The dispatch registry provides a natural interception point. Two viable approaches:

- **Option A: Routing in LinkedStorage** — `LinkedStorage.selectQuery()` already resolves the store via `resolveStoreForQueryShape()`. Extend this to also resolve graph/dataset metadata and pass it through to the store. The dispatch boundary doesn't change.
- **Option B: Routing in dispatch** — Replace the simple dispatch with a routing-aware dispatch that resolves graph/dataset/store before calling the store. This would let different dispatch implementations handle routing differently (e.g. a SPARQL dispatch vs an in-memory dispatch).

## Relationship to SPARQL conversion (001)

The SPARQL conversion utilities (Decision 4 in plan 001) currently take an optional `defaultGraph` in `SparqlOptions`. Once this storage config is designed, that option will be driven by the config rather than manually passed by each store. For now, SPARQL conversion generates no GRAPH wrapping by default.

## Portable default-graph and union-graph IRIs

Once core addresses graphs, a query must be able to say "the stored default graph" and "the
union of the named graphs". Stores spell these differently (Jena: `urn:x-arq:DefaultGraph`,
`urn:x-arq:UnionGraph`; other engines have their own names or none), so core should not emit a
store's spelling. Proposal: core defines its own IRIs in its namespace, for example
`core:graph/default` and `core:graph/union` (`https://linked.cm/ont/core/graph/default`, `…/union`),
uses them in the IR and algebra (`GRAPH`, `FROM`, `FROM NAMED`, `.from()` / `.into()` of backlog
005), and each store implementation replaces them in the SPARQL it sends (the Fuseki store maps
them to the `urn:x-arq:` names). A store that cannot express one refuses the query rather than
guessing. Writes to either IRI are refused: they are read-only views.

### What Jena/Fuseki does (measured on Fuseki 6.2.0, TDB2, October 2026)

Dataset: stored default graph `{:a :p 1}`, named graphs `:g1 {:b :p 2}`, `:g2 {:c :p 3}`.

| Query | `unionDefaultGraph` off | `tdb2:unionDefaultGraph true` |
|---|---|---|
| `{ ?s :p ?o }` (no `GRAPH`) | `:a` (stored default only) | `:b :c` (union of named graphs; stored default hidden) |
| `GRAPH ?g { … }` | `:g1 :b`, `:g2 :c` (never the default graph) | unchanged |
| `GRAPH <urn:x-arq:DefaultGraph> { … }` | `:a` | `:a` (the only way back to the stored default) |
| `GRAPH <urn:x-arq:UnionGraph> { … }` | `:b :c` (named graphs only) | `:b :c` |
| `FROM :g1 FROM :g2` / `default-graph-uri` | `:b :c` | unchanged (the flag is skipped for dynamic datasets) |

- **The flag changes reads only, including the WHERE of an update.** `INSERT DATA { :d :p 4 }`
  still lands in the stored default graph, which the flag hides, so the write vanishes from every
  later query without `GRAPH`. `DELETE WHERE { :b :p 2 }` matches through the union and deletes
  from the stored default graph: 200, nothing deleted.
- **The flag is read only by TDB2's own query engine** (`QueryEngineTDB`, context symbol
  `TDB2.symUnionDefaultGraph`). A wrapping dataset, such as Jena's query-time RDFS view
  (`DatasetGraphRDFS`), runs on the generic engine, and the flag has no effect there in any form
  tried (on the TDB2 dataset, on the endpoint, on the RDFS dataset). Through such a wrapper
  `GRAPH <urn:x-arq:UnionGraph>`, `FROM <urn:x-arq:UnionGraph>` and `GRAPH ?g` all work, with
  inference. CN serves every dataset through that view (CN plan 070), so the flag is not an option
  there: queries address graphs explicitly.
- **`urn:x-arq:UnionGraph` is not protected as a write target.** `INSERT DATA { GRAPH
  <urn:x-arq:UnionGraph> { … } }` succeeds and creates a real named graph with that name. Another
  reason core speaks its own IRIs and the store refuses writes to them.
- **The same triple in two graphs** is returned once by a union read; a triple-level delete must
  name every graph that holds it, or it reappears.
- **Cost:** about 950k triples over 100 named graphs read through the inferred union graph cost
  5-25% more than the same data in the default graph; `GRAPH ?g` with inference about 2x.

For CN today: the flag stays off and core keeps reading and writing the default graph only.

## Prior art

The OLD implementation used `SPARQLStore.setDefaultGraph(graphIRI)` — a single global graph for all queries. The new design should support per-shape and per-query graph resolution.
