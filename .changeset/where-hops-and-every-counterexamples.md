---
'@_linked/core': patch
---

Follow-up fixes to the inline-filter / quantifier / mutation-where changes:

- A relation on the way to a property under `isNotDefined()` or `defaultTo()` must exist again: `Person.select().where((p) => p.bestFriend.name.isNotDefined())` (and its count, `deleteWhere`, `update(…).where`, and the same inside a quantifier) matches a person whose best friend has no name, not every person without a best friend. Only an `or` branch the other branches do not need makes a relation optional.
- **Behaviour change for `every`:** a member that lacks a relation the condition reads is a counterexample. `p.friends.every((f) => f.bestFriend.name.equals('Erik'))` is now false for a person with a friend who has no best friend (it used to pass), unless the condition holds through another `or` branch. A member missing only the last property still does not count against it; `some` and `none` are unchanged.
- A sub-select of a filtered relation whose field is computed (`p.friends.where(F).select((f) => ({x: f.name.concat('!')}))`) applies the filter; it was dropped.
