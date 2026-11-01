---
'@_linked/core': minor
---

`orderBy` sorts by a computed expression (`orderBy((p) => p.hobby.strlen())`), missing values last; before, the key was dropped without a word. An expression holding an aggregate is refused, as an aggregate is, and a callback that returns anything that is neither a path nor an expression is refused instead of ignored. A sort path's inline filter is honoured (`orderBy((p) => p.friends.where((f) => f.name.equals('Anna')).hobby)` sorts by the hobbies of the friends named Anna; the others are kept, last); before, it was dropped. A sort key no longer shares the traversal of a filtered projection, so `select((p) => p.friends.where(…).name).orderBy((p) => p.friends.hobby)` sorts by every friend's hobby.

Fixed: a paged select (or one with a where-aggregate) sorting by a key read through a multi-valued traversal (`p.friends.hobby`) sorted an instance as missing when one of its friends had no hobby (Jena answers `MIN` over such a group as unbound). That key is now computed over the rows that bind it.

`p.friends.nickNames` (a multi-valued literal straight under a multi-valued traversal) no longer throws. A quantifier takes another quantifier as its condition: `p.friends.some((f) => f.$type().equals({id: C}))`, `p.friends.some((f) => f.friends.some(…))`, as an EXISTS inside the EXISTS; DSL-JSON `{"friends.some": {"friends.some": …}}` now decodes. `LinkedStorage` checks every dataset a triples read goes to before it asks the first, so a dataset that cannot answer it (without `triplesPattern`) fails the read wherever it is in the order.

Reserved names: `$`-prefixed names and `and`/`or`/`not` throw at registration; the other reserved names warn. Registering a property whose label starts with `$` throws (any `$` name, not only `$type`/`$graph`). DSL-JSON wire version 1.7: `sortBy` entries `{value, direction}` and `{path: {direction, where, whereIndex}}`; sort directions are read in any case.
