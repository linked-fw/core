---
'@_linked/core': patch
---

Fixes silent wrong answers in select lowering:

- A where (or sort key) on a relation that a paginated sub-select reads
  (`select((p) => p.friends.select(…).limit(1)).where((p) => p.friends.hobby.equals('Chess'))`) now
  reads a traversal of its own; its triple used to bind the page's variable outside the page, so the
  page showed the wrong members.
- A path an inline filter reads below its member (`p.friends.where((f) => f.bestFriend.name.equals('Erik'))`)
  stays inside the filter's OPTIONAL block; it was a required triple of the whole query that ranged
  over every node (every person got the same friends).
- Inside a quantifier, a property or traversal only one `or` branch reads is OPTIONAL
  (`p.friends.some((f) => f.name.equals('x').or(f.hobby.equals('Chess')))` matches a chess player
  without a name), and `isNotDefined()` inside a quantifier finds the members without the property.
  A top-level where keeps a traversal only one branch reads OPTIONAL too
  (`p.name.equals('Bob').or(p.bestFriend.hobby.equals('Golf'))` keeps Bob without a best friend).
- A quantifier on a filtered relation (`p.friends.where(F).some(P)`, `every`, `none`) tests the filter;
  it was dropped. An inline filter on a path read as a value (`p.friends.where(F).hobby.equals('y')`,
  inside a quantifier, a computed field or sort key, under `min()`/`max()`, or on a hop above a
  quantified relation) is refused with an error that suggests the quantifier form; the filter used to
  be dropped.
- A computed field through a relation (`{e: p.bestFriend.name.concat('!')}`) is `null` for an
  instance without the relation; the instance used to be dropped.
