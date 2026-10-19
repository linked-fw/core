---
summary: >
  Query building is still ~17% (select) / ~20% (create) slower than 2.36.1 after the per-prototype
  memo in `isLinkedInstance`. The remaining cost is in the miss path (static brand read,
  getPrototypeOf, lookup), not the prototype walk. Find a cheaper miss path or keep inline
  `instanceof` at hot internal sites.
packages: [core]
---

# 058 — `isLinkedInstance` miss path still slows query building

Measurements and what was ruled out: report 039, "Known limits" (query-building cost table).

Before the memo, 2.36.2 was +50% on select and +30% on create (medians, ms per 1000). With the
memo, 2.36.3 is +17% and +20%. A select makes 19 `isLinkedInstance` calls and a create 66, mostly
misses on `PendingQueryContext`, `ExpressionNode` and `FieldSet` (in `lower.ts`, `IRLower.ts`,
`DslJsonExpression.ts`, `ExpressionNode.ts`, `FieldSet.ts`). Timing was back at 2.36.1 when the
static brand was absent, so each miss returned at the `hasOwnProperty` check on the class.

Directions to try, measured with `src/tests/query-compile-timing.test.ts` in alternating runs:

- Keep `x instanceof C` inline at each hot site (monomorphic) and call a brand-only check only
  when it fails and `x` is an object whose prototype is not `Object.prototype` / `Array.prototype`.
- Per-class checkers made once (`const isPending = linkedInstanceCheck(PendingQueryContext)`) that
  hold the brand symbol in a closure, so no per-call static read.
- Check whether a second copy is present at all (the shape registry already counts copies) and
  skip the brand path while there is one copy.
