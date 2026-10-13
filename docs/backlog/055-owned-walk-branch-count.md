---
summary: >
  The owned-subtree walk emits one UNION branch per path through the owned shape graph, so a wide
  owned DAG (or several recursive sub-shape edges) grows the delete exponentially. Lowering warns
  above 64 branches; reduce the count with shared-prefix or per-level strategies.
packages: [core]
---

# 055 — Owned-walk branch count

Source: plan 003 (per-property ownership), iteration 1, gap 4. Contract:
[owned-values](../architecture/owned-values.md).

## Today

- `ownedWalk` (`src/sparql/irToAlgebra.ts`) emits one target per path from the root shape; each
  target is one UNION branch (plus one blank-cascade branch when its shape has blank-capable
  properties). Paths repeat their prefix triples.
- Measured: the core metamodel and `@_linked/schema` (41 shapes) stay at ≤ 8 branches per delete
  (`NodeShape` 8, `Thing` / `CreativeWork` 6). A synthetic DAG of width 3 and depth 4 gives 120;
  a shape with two recursive sub-shape edges gives 32 with `MAX_OWNED_RECURSION` K = 4 (doubling per step of K).
- `OWNED_BRANCH_WARNING` (64) logs once per root shape. There is no cap.

## Options

- **Per-target-shape merge:** one branch per (target shape, typing) with the incoming hop
  sequences merged into one property-path alternation when no hop on them is typed.
- **Per-level evaluation:** delete level by level in one request (`DELETE … WHERE` per level), or
  bind the owned set once with a sub-select and delete from it.
- **Shared prefixes:** nest the branches of one prefix in a group (`{ prefix { A } UNION { B } }`).

## Open questions

- Which option keeps Fuseki's evaluation linear for bulk deletes (`deleteAll` of 20k owners)?
- Does any real model exceed the warning threshold?
