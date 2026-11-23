---
"@_linked/core": minor
---

Sort a select by several keys, each in its own direction, with the new `thenBy(fn, direction = 'ASC')` on the select builder:

```ts
const people = await Person.select((p) => [p.name, p.birthDate])
  .orderBy((p) => p.birthDate, 'DESC') // newest first
  .thenBy((p) => p.name)               // then by name, A–Z
  .limit(20);
```

Each `thenBy` call appends one key (a path or a computed expression, not an array) and follows the same rules as an `orderBy` key: missing values sort last, a multi-valued path sorts by its first value in that key's direction, aggregates are refused, and pages break ties by the instance IRI. `thenBy` needs a preceding `orderBy` and throws without one; `orderBy` still replaces the whole sort (its `thenBy` keys included), and its array form (`orderBy((p) => [p.a, p.b], 'DESC')`) keeps one direction for all its keys. `count()` and `exists()` drop the sort as before; a grouped select sorts its groups with its own `orderBy`.

DSL-JSON is now version 1.11: the `sortBy` array may mix directions across its entries (`[{"birthDate": "DESC"}, {"name": "ASC"}]`). The entry forms are unchanged, so envelopes from earlier 1.x versions still parse, and a builder restored with `fromJSON` can be extended with `thenBy`. See `documentation/dsl-json.md` and the README, "Sorting, limiting, one".
