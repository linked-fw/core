---
summary: >
  A mutation lowered inside a shape catalog gets its write graphs (`WITH` / `writeGraphs`) from the
  global registry's read sets, because LinkedStorage sends it to the store outside any catalog;
  the compile re-enters the catalog. A catalog-only owner's graph is then missing from the graphs
  an update or delete by id looks in. Pre-existing (identical before report 124).
packages: [core]
---

# 115 — Catalog mutations take their write graphs from the global registry

Source: the review of report 124 (graph routing cache). Probed there; the generated SPARQL is the
same with and without the routing cache, so this predates it.

## Scenario

- Global registry: `Item`, and `Owner` with no property to `Item`.
- Catalog (`ShapeCatalog.from`): the same IRIs, where `Owner` declares `item` with `contains: true`
  and value shape `Item`, so inside the catalog an `Item` may live in `Owner`'s graph.
- A store with routes `Owner → …/g/owner`, `Item → …/g/item`, set as the default dataset.
- `withShapeCatalog(cat, () => UpdateBuilder.from(ITEM).for(id).set({name: 'x'})).exec()`.

`LinkedStorage` sends the query outside any catalog (`LinkedStorage.outsideCatalog`), so
`SparqlDataset.resolveWriteGraph` reads `routing.readGraphsForShape(Item)` against the global
registry: `[…/g/item]`, one graph, so the update gets `WITH <…/g/item>`. Inside the catalog the
read set is `[…/g/item, …/g/owner]`, which would give `writeGraphs` and `VALUES ?g`. An `Item`
written into its owner's graph is not updated. A delete by id shows the mix within one query:
`WITH <…/g/item>` for the subject, while its incoming-link cleanup (compiled in the catalog)
already lists `…/g/owner`.

## First questions

- Run `resolveWriteGraph` (and `checkOwnedLinks`' graph choice) inside `catalogOf(ir)`, as the
  compile does, so both read the same catalog's read sets?
- Are there other store-side steps that read the routing outside the IR's catalog (the `.into()`
  check, the update-no-match ASK)?
