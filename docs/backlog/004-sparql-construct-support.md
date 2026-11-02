---
summary: Add SPARQL CONSTRUCT query support to the conversion layer.
origin: Review of 001-sparql-conversion-layer (Gap C)
---

# Idea: SPARQL CONSTRUCT Support

The current SPARQL conversion layer supports SELECT, INSERT DATA, DELETE/INSERT, and DELETE WHERE operations. CONSTRUCT queries are not yet supported.

## Covered elsewhere

[Report 093](../reports/093-triples-reads.md) added two shapeless reads that answer triples
(`NamedGraph.readContent(graph)`, `TriplesBuilder.forNode({id}).from(graphs)`, through
`IDataset.triplesQuery`, compiled to a SELECT): extracting one whole graph or one subject's
triples no longer needs CONSTRUCT. What stays here is CONSTRUCT proper: subgraphs chosen by a
pattern, and transforms between schemas.

## Motivation

CONSTRUCT queries return RDF graphs rather than tabular results. Useful for:
- Extracting subgraphs from a store
- Transforming data between schemas
- Federated query result merging

## Scope

- Add `SparqlConstructPlan` to `SparqlAlgebra.ts`
- Add `constructToAlgebra()` to `irToAlgebra.ts`
- Add `constructPlanToSparql()` to `algebraToString.ts`
- Add result mapping for CONSTRUCT (returns triples, not bindings)
- Tests and golden tests

## Open questions

- Does the current IR have a construct-like operation, or would a new IR node be needed?
- What DSL syntax would trigger a CONSTRUCT vs SELECT?
