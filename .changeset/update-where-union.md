---
"@_linked/core": patch
---

An update's WHERE, and a bulk delete's, no longer multiply their parts — the same fix #318 made for a delete by id. `update`, `upsert` and `updateWhere` chained the old value of every property and every owned-cleanup block as OPTIONALs, so the solutions were the product of all of them: updating two multi-valued properties gave one solution per pair of old values, and replacing a `contains` property gave the old node's own triples times every triple of its owned subtree. They are now one OPTIONAL over a UNION of those blocks, which deletes and inserts the same triples. Old values a computed field's BIND reads stay joined to it, as before. `deleteAll` and `deleteWhere` likewise join the root's triples and each blank-node subtree with a UNION instead of nested OPTIONALs.

Also fixes a data-loss bug: replacing a `contains` property that had no old value deleted the owned subtree of every other node in the graph, because the cascade block's `?old` variable was left unbound. Each cascade block now binds it through the owning edge.
