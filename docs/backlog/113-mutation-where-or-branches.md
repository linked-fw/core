---
summary: >
  A delete or update where with `||` joins every property and traversal triple as required, so a
  subject without a property only one branch reads is never matched (silent: fewer rows changed).
packages: [core]
---

# 113 — `||` in a mutation's where

Found by report 122 (plan 006 step S9), older. `deleteWhereToAlgebra` (and `updateWhereToAlgebra`,
`buildUpdateWhere`) join the where's traversals and every property triple into the required pattern:

```
DeleteBuilder.from(Person).where((p) => p.name.equals('x').or(p.bestFriend.hobby.equals('y')))
→ ?a0 <bestFriend> ?a1 . ?a0 <name> ?a0_name . ?a1 <hobby> ?a1_hobby .
  FILTER(?a0_name = "x" || ?a1_hobby = "y")
```

A person named x without a best friend (or without a hobby on the best friend) is not deleted. A
select's where keeps such triples OPTIONAL (`collectRequiredBindingKeys`, and since report 122 the
traversals too, `collectRequiredAliases`); quantifiers inside a mutation's where already go through
the same EXISTS conversion as a select's. Fix: the same required/optional split in the mutation where
builders (required triples joined, the others OPTIONAL subtrees per traversal), with goldens in
`sparql-mutation-golden.test.ts` and an oxigraph or `[fuseki]` check that the right subjects change.
`isNotDefined()` in a mutation's where has the same cause (`!BOUND` on a required triple never holds).
