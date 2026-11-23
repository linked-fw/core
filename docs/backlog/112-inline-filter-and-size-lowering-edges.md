---
summary: >
  Older lowering edges found while fixing backlog 108: a filtered and an unfiltered path over the
  same relation share one (filtered) traversal; a traversal inside an inline filter is emitted as
  a required top-level triple; size() in a nested select counts across all members; a filtered
  size() cannot be compared (refused).
packages: [core]
---

# 112 — Inline filter and size() lowering edges

Source: report 115 (plan 006 step S1). Each is older than report 115 and gives a silent wrong
answer unless noted.

1. **Shared filtered traversal.** `Person.select((p) => [p.friends.name, p.friends.where((f) =>
   f.name.equals('Moa')).name])` lowers both paths onto one traversal `?a1` carrying the filter, so
   the unfiltered `friends.name` is filtered too. The same with a filtered `size()` beside the
   relation's projection. A sort key already gets a traversal of its own when the filters differ
   (`lowerSortKey` in `IRLower.ts`); projection seeds use `getOrCreateTraversal` for every step.
2. **A traversal inside an inline filter.** `p.friends.where((f) => f.bestFriend.name.equals('x'))`
   emits `?a1 :bestFriend ?a2` as a required triple of the top-level pattern while `?a1` is bound
   only inside the filtered OPTIONAL block (`lowerWhere` resolves the filter's traversals through
   the select's resolver, `irToAlgebra` treats them as ordinary required traversals). It belongs
   inside the filtered block, OPTIONAL, like the filter's property triples.
3. **size() in a nested select.** `p.friends.select((f) => ({n: f.friends.size()}))` groups by
   `?a0` only (`countLabel` golden), so `n` counts the friends of all of a person's friends, not
   per friend. Grouping by the sub-select's alias (`?a1`) is the per-member count.
4. **A filtered size compared** (`where((p) => p.friends.where(…).size().equals(1))`) is refused
   since report 115 (it counted every member before). Answering it needs the filtered block inside
   the HAVING's pattern, or a sub-SELECT count per subject (related: backlog 042).
