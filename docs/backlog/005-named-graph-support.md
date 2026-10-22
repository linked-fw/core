# Named Graph Support

## Summary

Add DSL support for querying and mutating data within specific SPARQL named graphs. This enables multi-tenancy, access control, provenance tracking, and data partitioning scenarios where triples are organized into named graphs.

## Motivation

SPARQL named graphs allow partitioning data into separate logical containers within a single store. Currently the DSL generates queries against the default graph only. Many real-world deployments organize data by source, tenant, or access level using named graphs.

## DSL Surface

### Querying from a named graph

```ts
// Query a specific named graph
Person.select(p => p.name).from('http://example.org/graphs/hr')

// Generated SPARQL:
// SELECT ?name WHERE {
//   GRAPH <http://example.org/graphs/hr> {
//     ?s rdf:type ex:Person .
//     OPTIONAL { ?s ex:name ?name . }
//   }
// }
```

### Querying from multiple named graphs

```ts
// Query from multiple graphs (UNION of GRAPH clauses)
Person.select(p => p.name).from([
  'http://example.org/graphs/hr',
  'http://example.org/graphs/finance'
])

// Generated SPARQL:
// SELECT ?name WHERE {
//   {
//     GRAPH <http://example.org/graphs/hr> {
//       ?s rdf:type ex:Person . OPTIONAL { ?s ex:name ?name . }
//     }
//   }
//   UNION
//   {
//     GRAPH <http://example.org/graphs/finance> {
//       ?s rdf:type ex:Person . OPTIONAL { ?s ex:name ?name . }
//     }
//   }
// }
```

### Mutations into a named graph

```ts
// Create into a specific graph
Person.create({ name: 'Alice' }).into('http://example.org/graphs/hr')

// Generated SPARQL:
// INSERT DATA {
//   GRAPH <http://example.org/graphs/hr> {
//     <generated-uri> rdf:type ex:Person .
//     <generated-uri> ex:name "Alice" .
//   }
// }
```

### Delete from a named graph

```ts
Person.delete('http://example.org/alice').from('http://example.org/graphs/hr')

// Generated SPARQL targets only the specified graph
```

## Algebra mapping

Uses the existing `SparqlGraph` algebra node type already defined in `SparqlAlgebra.ts`:

```ts
type SparqlGraph = {
  type: 'graph';
  iri: string;
  inner: SparqlAlgebraNode;
};
```

The `SparqlGraph` node wraps the inner BGP/join/optional pattern and is serialized by `algebraToString.ts` (already implemented).

## Implementation considerations

- The `.from()` / `.into()` method needs to be added to the DSL query builder chain
- IR needs a new optional `graph?: string | string[]` field on query/mutation types
- `irToAlgebra.ts` wraps the algebra in `SparqlGraph` when graph is specified
- Multi-graph queries use `SparqlUnion` of `SparqlGraph` nodes
- `insertDataPlanToSparql` and `deleteInsertPlanToSparql` already support `plan.graph` field
- Store-level default graph could be configured in `SparqlOptions`

## Open questions

- Should the graph be configurable at the store level (all queries go to a default graph)?
- Should cross-graph queries be supported (e.g., join data from two different graphs)?
- How does this interact with SPARQL datasets (FROM / FROM NAMED)? Core needs portable IRIs for the default and union graphs; see backlog 025 §Portable default-graph and union-graph IRIs.
