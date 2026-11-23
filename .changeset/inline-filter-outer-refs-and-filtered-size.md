---
'@_linked/core': patch
---

An inline filter that reads the outer subject (`p.bestFriend.friends.where((f) => f.name.equals(p.name))`) now compares with the outer node; it used to compare the member with itself. A read that cannot be answered (a path that is not a hop above the filtered relation, a node further up, a quantifier reading outside its member, an aggregate over the outer subject) is refused, and such a query has no DSL-JSON form yet (`toJSON()` refuses it). A filtered `size()` counts only the members its filter keeps (it counted every member), and a counted path's hops stay optional: an instance without them is returned with a count of 0 instead of being dropped (also for an unfiltered `p.bestFriend.friends.size()`). A filtered `size()` compared in a where is refused (it counted every member). An error while running a query that has no DSL-JSON form names the original error.
