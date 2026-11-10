---
summary: >
  Expansion and compaction take an explicit prefix map (Prefix.toFull(value, map), …), but the
  query DSL expands with the app's map in use. Let a query build carry another app's map, as a
  query carries its dataset, for a host acting for another app.
packages: [core]
---

# 120 — An explicit prefix map in query builds

Source: report 119. Since report 119 an app loads its one prefix map with `Prefix.load`, an
unknown prefix throws, and the low-level calls (`Prefix.toFull`, `toPrefixed`, `getFullURI`,
`resolveUriOrThrow`, `resolveNodeId`, `pathRefIri`, `expandPrefixedName`) take an optional
explicit map for code acting for another app.

The query DSL does not: `.for('ex:a')`, `update().for`, `delete` ids and string path steps in
shapes expand with the map in use at build or serialisation time, and the `PREFIX` block of the
SPARQL written is built from it too. A host that queries for another app (its dataset, its shapes)
with prefixed names in the DSL needs that app's map there.

1. Decide where the map rides: on the builder (`.prefixes(map)`), in the execution options next to
   the dataset, or in a scoped context like the shape catalog (`withShapeCatalog`).
2. Thread it to `resolveUriOrThrow`/`resolveNodeId` in the builders, to `pathRefIri` in
   `pathExprToSparql`, and to `formatUri`/`collectPrefixes` (compaction).
3. Only when a host needs it: a host that uses accessors (`{id}` terms) and full IRIs for the other
   app needs none of this.
