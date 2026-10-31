---
summary: >
  Three row-level effects left after subject paging (report 098): an unpaged select with a
  where-aggregate and a multi-valued projection applies its HAVING per (subject, values) group;
  ordering by a nested path makes the traversal required and drops instances without it; a
  multi-valued leaf under a single-valued traversal maps to one value.
packages: [core]
---

# 089 — Where aggregates and nested sort paths at row level

Source: report 098 (review of subject paging).

1. `Person.select((p) => [p.name, p.friends.name]).where((p) => p.friends.size().equals(2))`
   without `limit`/`offset` lowers to `GROUP BY ?a0 ?a0_name ?a1_name ?a1 HAVING(COUNT(DISTINCT
   ?a1) = 2)`: each group is one friend, so the count is 1 and nobody matches. A paged select
   applies the HAVING in the page, per subject, and is correct. The unpaged form could use the
   same sub-SELECT of subjects (without LIMIT) whenever a where-aggregate meets a multi-valued
   projection.
2. `orderBy((p) => p.friends.name)` and `orderBy((p) => p.bestFriend.name)` make the traversal a
   required join, so an instance without friends (or a best friend) is not returned at all.
   Making the order traversal OPTIONAL would sort those instances as unbound instead, like a
   direct path. That changes which instances a select returns, so it needs the owner's call.
3. Result mapping, older than paging: under a single-valued traversal a multi-valued leaf comes
   back as one value. `Person.select((p) => p.bestFriend.nickNames)` returns rows C, D, E for
   p2, and the result is `{bestFriend: {id: p2, nickNames: 'C'}}`.
