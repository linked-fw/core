---
summary: >
  Three select edges found while making sorts keep instances (report 101): an orderBy on a
  computed expression is silently dropped, a filter on a sort path is ignored, and a leaf
  straight under a multi-valued traversal (`p.friends.nickNames`) throws in the proxy.
packages: [core]
---

# 092 — Sort and leaf path edges

Source: report 101 (review).

1. `Person.select((p) => p.name).orderBy((p) => p.hobby.strlen())` lowers to no ORDER BY (and
   no hobby triple), paged or not. It should sort by the expression, or be refused the way
   `orderBy((p) => p.friends.size())` is.
2. `orderBy((p) => p.friends.where((f) => f.name.equals('Carl')).hobby)` sorts by any friend's
   hobby: the inline filter of a sort path is dropped. A sort path that shares its alias with
   a filtered projection sorts by the filtered friends only.
3. `Person.select((p) => p.friends.nickNames)` throws `result.concat is not a function`
   (`QueryShapeSet.callPropertyShapeAccessor`, `SelectQuery.ts`); `p.friends.select((f) =>
   f.nickNames)` works.
