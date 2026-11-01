---
summary: >
  Edges left by report 105: a filter further down a sort path (or a projected path) makes the
  hops before it required; a quantifier on a cast relation loses its cast on the wire; a
  quantifier condition on an unresolvable member shape falls back to the outer shape; three small
  DSL-JSON decode edges.
packages: [core]
---

# 093 — Sort filter depth and quantifier wire edges

Source: report 105 (review).

1. **Filters below the first segment.** `orderBy((p) => p.bestFriend.friends.where(…).hobby)` is
   refused, because irToAlgebra makes the hops above a filtered traversal required, which would
   drop the instances without a best friend. A projection has the same required hops today
   (`select((p) => p.bestFriend.friends.where(…).name)` drops persons without a best friend).
   Nesting the filtered block inside OPTIONAL parent hops would let both keep every instance.
2. **Cast relation in a quantifier.** `p.pets.as(Dog).some((d) => d.guardDogLevel.equals(2))`
   encodes as `{"pets.some": {"guardDogLevel": 2}}`: the cast is dropped, and decoding throws
   `Property 'guardDogLevel' not found on shape 'Pet'` (older; projections write `pets.as(Dog)`).
3. **Unresolvable member shape.** A quantifier condition whose relation has no resolvable value
   shape decodes against the outer shape; a same-label property there binds silently. Throw like
   `walkPropertyPath` does instead.
4. Small decode edges: `{"and": [{"name": "B"}, {"friends.some": …}]}` crashes (`from is not
   iterable`: an exists that is not the first operand); `{"pets.none": {}}` lowers to an empty
   `FILTER()`; `x.not().not()` on a chained quantifier is not simplified (same meaning).
