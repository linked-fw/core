---
summary: >
  Ownership of `contains` values is decided two ways today. Replace, set-remove and the linked-id
  class check use the registry-wide predicate rule (any shape declaring the predicate `contains`
  makes every property on it owning), while subject deletes (by id and bulk) use the deleted
  shape's own `contains` properties. Open design question: decide ownership per property
  everywhere (including the cascade and `collectContainment`), or keep the predicate rule.
packages: [core]
---

# 053 — Per-property versus per-predicate ownership

Source: [report 032](../reports/032-owned-replace-noop-and-single-owner-shacl.md) (iteration 1
open follow-up, review L7). Contract: [owned-values](../architecture/owned-values.md).

## Today

- **Per predicate** (`collectContainment().containsPreds`): replace and set-remove delete the old
  value; the class check refuses a wrongly typed link. A plain property of shape B on
  `schema:image` owns its values because `@_linked/schema` declares `Thing.image` as `contains`.
- **Per shape**: a subject delete removes the immediately-owned children of the deleted shape's
  own and inherited `contains` properties only. So B's plain property deletes its old value on
  replace, but not when B's subject is deleted.
- The cascade path `(c1|c2|…)*` follows every `contains` predicate in the registry.

The asymmetry is in the safe direction (deletes do less), and it is documented in the README.

## Options

- (a) **Per property everywhere.** `contains` means "this accessor owns its value". A plain
  property on a shared predicate never deletes or class-checks. Con: the cascade can no longer be
  a single predicate alternation; a node owned via A's `schema:image` and referenced via B's plain
  `schema:image` is indistinguishable in the data.
- (b) **Per predicate everywhere.** Subject deletes also delete children through plain properties
  on `contains` predicates. Con: deletes more, and through shapes that never declared ownership.
- (c) Keep today's split, documented.

## Open questions

- Which rule should the single-owner SHACL constraint follow? Today it is per accessor but counts
  every subject using the predicate, which matches the predicate rule.
- Applications that strip `contains` from user-authored shapes rely on the predicate rule to
  keep library-declared ownership in force; would (a) need an explicit opt-in there?
