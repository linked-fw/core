---
"@_linked/core": patch
---

A nested create without `__id` now returns the id it was written under. `Shape.create({…, author: {name: 'Ann'}})` used to return `author: {id: ''}`; the store now mints the nested ids before it compiles the write, so the result (of `create`, `update` and `upsert`) carries the same IRI the node was stored under, and a `select().for({id})` finds it. A nested value written as a blank node (a blank-capable `sh:nodeKind`) still has no id. The minting step is exported as `mintNestedIds(ir, options)` from `@_linked/core/sparql` for stores that compile mutation IR themselves.

Under graph routing, a nested create two or more levels deep whose innermost node belongs in the mutation's own graph, the default graph or a named one (an article in the default graph, its author routed to another graph, her photo back in the default graph) no longer fails with `Invalid IRI for SPARQL output: null`: that node is written into the mutation's graph, in create, update, upsert and update-where.
