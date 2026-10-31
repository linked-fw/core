---
date: 2026-10-31
summary: >
  The shapeless delete (`Shape.delete(ids)`, report 099) now deletes in every data graph of the
  dataset: the default graph and every named graph, routed or not, with or without routing. It
  never touches the graph registry or a graph the registry records as a shapes or ontology graph.
  `_inGraphs()` and `_includingDefaultGraph()` are gone, and `LinkedStorage` never fans it out.
  Minor (the same unreleased changeset as 099).
packages: [core]
---

# 100 — The shapeless delete deletes in every data graph

## PR

### Summary

Report 099 scoped the shapeless delete to the graphs a dataset routes, with two server-side
narrowings. The owner changed the design: a shared dataset is shared on purpose, its graphs are
only places, and rights are per shape across the whole dataset. A receiver that runs a shapeless
delete for a client now decides who may send it with a dataset-wide rule (Create Now: report 377).
So the delete is dataset-wide:

- With no graph named, it deletes every triple of each id, and every link to one, in the default
  graph and in every named graph. It never does this by way of `graphs.union`. A dataset without
  routing deletes the same way: the `graph-not-routed` refusal is gone.
- **Structure stays.** The named-graph side skips `graphs.registry` and every graph the registry
  records as `core:ShapesGraph` or `core:OntologyGraph`, which only graph queries write. This came
  out of the review: without it, one class IRI removed its definition and every type link to it.
- `_inGraphs()`, `_includingDefaultGraph()` and the IR's `graphs` and `includeDefaultGraph` are
  removed. Nothing narrows it any more.
- **No fan-out.** Without a target, `LinkedStorage` sends it to the one dataset it knows, and
  refuses it when it knows several (name the dataset: `.exec(dataset)`). The fan-out notice's
  `delete` kind is gone.

### The SPARQL

```sparql
DELETE {
  ?x_del ?pd_del ?od_del . ?sd_del ?p2d_del ?x_del .
  GRAPH ?g_del { ?x_del ?p_del ?o_del . ?s_del ?p2_del ?x_del . }
}
WHERE {
  VALUES ?x_del { <a> <b> }
  { ?x_del ?pd_del ?od_del . } UNION { ?sd_del ?p2d_del ?x_del . }
  UNION {
    GRAPH ?g_del { { ?x_del ?p_del ?o_del . } UNION { ?s_del ?p2_del ?x_del . } }
    FILTER(?g_del NOT IN (<registry>))
    FILTER(NOT EXISTS { VALUES ?structure_del { core:ShapesGraph core:OntologyGraph }
                        GRAPH <registry> { ?g_del rdf:type ?structure_del . } })
  }
}
```

The default-graph side and the named-graph side bind their own variables, so a solution of one
leaves the other's template unbound, and SPARQL skips an unbound template triple.
`_keepingIncoming()` drops both incoming sides.

### Changes

- `src/sparql/irToAlgebra.ts`: `deleteShapelessToAlgebra` builds the update above
  (`dataGraphsOnly`).
- `src/sparql/SparqlDataset.ts`: `deleteShapeless` compiles and runs it; no routing or scope check.
- `src/queries/DeleteBuilder.ts`, `IntermediateRepresentation.ts`, `mutationLowerSpec.ts`,
  `lower.ts`: the narrowings are gone.
- `src/utils/LinkedStorage.ts`: `deleteInTheOnlyDataset` replaces the fan-out.
- `src/utils/fanOutNotice.ts`: no `delete` kind.
- Docs: README "Shapeless delete", `documentation/dsl-json.md`,
  `documentation/intermediate-representation.md`. Changeset `shapeless-delete.md` (minor, still
  unreleased) describes the delete as shipped.

### Verification

`npm test` (jest, then `tsc -p tsconfig-tests.json`; no Fuseki variables, so the live suites skip):

```
Test Suites: 19 skipped, 148 passed, 148 of 167 total
Tests:       573 skipped, 2691 passed, 3264 total
```

The shapeless suites against a Fuseki of their own (`FUSEKI_BASE_URL=http://localhost:3973`):

```
[fuseki] live tests: 4 total — 4 passed, 0 failed, 0 skipped
Tests:       21 passed, 21 total
```

The live suite covers:
- the subject and the links to it gone from the default graph, two routed graphs and an unrouted
  graph;
- the same on a store without routing;
- `_keepingIncoming()` keeps the links in all four;
- the registry and a graph recorded as a shapes graph keep their triples.

`npx linked build`: `✔ Build successful`.

### Deviations

- "Every graph" became every **data** graph: the registry and the shapes and ontology graphs stay
  (review finding 1). Those graphs are structure, which a graph query writes under `structure`.
- `LinkedStorage` refuses a target-less shapeless delete with several datasets instead of fanning
  it out (review finding 4): a delete in every graph of every dataset had no single receiver to
  decide its rights.

### Follow-ups

- Blank nodes that a deleted subject points at are left in place (report 099). Home: this report.

## Details

The independent review covered this diff and Create Now's together (CN report 377). Its core
findings were the structure graphs (high) and the fan-out (medium), both fixed here.
