---
summary: >
  Edges left by report 107's review: an inline filter that reads the outer subject compares the
  member with itself; a filtered `size()` ignores its filter and keeps the hops above it required.
packages: [core]
---

# 108 — Inline filter outer references and filtered size

Source: report 107 (review R5, R6). Both are older than report 107.

1. **Outer references in an inline filter.** `p.bestFriend.friends.where((f) => f.name.equals(p.name))`
   lowers to `FILTER(?a2_name = ?a2_name)`: `p.name` resolves against the filter's own root, so the
   condition is true whenever the friend has a name. Resolve outer references to the outer alias
   (the block now sits in a nested LeftJoin whose left side holds only the hop above it, so test
   the scope there), or refuse them.
2. **Filtered `size()`.** `select((p) => p.bestFriend.friends.where(…).size())` counts every friend
   (`COUNT(DISTINCT ?a1_friends)`) and keeps `bestFriend` required, against report 107's rule that a
   projection keeps every instance. Lower the filter into the count, or refuse it.
