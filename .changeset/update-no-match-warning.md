---
"@_linked/core": minor
---

Outside production, an update by id that matched no node says so.

`update().for({id})` on an absent id (or an id with properties but no `rdf:type`) writes nothing and still resolves with the fields it was given. A `SparqlDataset` now follows such an update with one `ASK` whether the subject is typed where the update's WHERE looked (its `WITH` graph, every graph of a routed read set, or the default graph), and `console.warn`s naming the id and the shape, and pointing to `upsert()`, when it is not. The result does not change and a failing check is ignored. Skipped when `NODE_ENV` is `production` (no `ASK` is sent), for an upsert, a bulk update (`forAll`/`where`) and a shape without a `targetClass`.
