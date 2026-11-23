---
summary: >
  Three leftovers seen while making object-form rows follow their keys (report 121): an array-form
  count through a hop lands on the root row while its type nests it, a Fuseki aggregation test
  asserts two rows where OPTIONAL gives every person, and computed fields are typed `boolean`.
packages: [core]
---

# 114 — Array-form count through a hop; Fuseki count test; computed field types

Source: report 121 (plan 006 (report 125) step S8). Neither changed there: S8's contract leaves the array form
as it is, and the tests are not S8's.

1. **An array-form `size()` through a hop sits on the root row, typed nested.**
   `Person.select((p) => p.bestFriend.friends.size())` answers `{id, friends: 0}` (the count is per
   root, and the best friend's traversal is not projected, since a GROUP BY on it would split the
   count), while its type is `{bestFriend: {friends: number}}`. The object form
   (`{c: p.bestFriend.friends.size()}` → `c: number`) is right. Open question: change the row
   (project the hop and nest the count) or the type (the count on the row, as the object form).

2. **`sparql-fuseki.test.ts` "countNestedFriends" asserts `rows.length` 2.** The SPARQL is
   `OPTIONAL { ?a0 hasFriend ?a1 . OPTIONAL { ?a1 hasFriend ?a1_friends } } GROUP BY ?a0`, which
   gives one row per person (4) on oxigraph, on the integration branch before report 121 too
   (`countLabel` asserted the same and was rewritten by report 121). Check on the CI Fuseki whether
   the suite runs and what it answers; fix the assertion (4 rows, counts 2/0/0/0).

3. **A computed field is typed `boolean` whatever it computes.** `{e: p.bestFriend.name.concat('!')}`
   answers a string, typed `boolean`: `QueryResponseToResultType` maps every `ExpressionNode` that
   is not an aggregate to `boolean`, and the expression methods (`concat`, `ucase`, `plus`,
   `strlen`, …) all return a plain `ExpressionNode`. Fix: give `ExpressionNode` a result type
   parameter (`ExpressionNode<string>`) set by each method in `ExpressionMethods.ts`, and read it in
   `QueryResponseToResultType` / `KeyedFieldResult`. Pre-existing (review of report 121).
