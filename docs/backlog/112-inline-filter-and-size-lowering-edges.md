---
summary: >
  What stays open of the inline-filter and size() lowering edges after report 122: comparing a
  filtered size (refused), answering an inline filter on a path read as a value (refused, needs a
  wire form), and a where that narrows a projected or counted relation it shares (a design
  question).
packages: [core]
---

# 112 — Inline filter and size() lowering edges (what stays open)

Source: reports 115, 118; items 1, 2, 5 and 6 fixed or refused by report 122 (plan 006 step S9).
Item 3 (`size()` in a nested select, per member) moved to plan 006 step S8 (decision 21, the lone
sub-select aggregate) and is answered by report 121. Numbers kept: reports cite 112.N.

4. **A filtered size compared** (`where((p) => p.friends.where(…).size().equals(1))`) is refused
   since report 115 (it counted every member before). Answering it needs the filtered block inside
   the HAVING's pattern, or a sub-SELECT count per subject (related: backlog 042). Report 122's
   fixes do not give it: the HAVING still counts over the where's own traversal.

6. **An inline filter on a path read as a value is refused** (report 122):
   `p.friends.where(F).hobby.equals('y')` in a where, inside a quantifier's callback, in a computed
   field or sort expression, under `min()`/`max()`, and a filter on a hop above a quantified relation
   (`p.friends.where(F).friends.some(…)`). Each dropped the filter before. A quantifier on the
   filtered relation itself (`p.friends.where(F).some(P)`) is answered (`F and P`). Answering the
   refused forms needs (a) the semantics under `not`/`or`: the filter restricts which members bind
   the traversal (a filtered traversal of its own, as a projection's), not an `EXISTS` per
   comparison; and (b) a DSL-JSON form for a filtered step inside an expression path (expression
   refs carry property ids only). Suggested start: lower the where's filtered step through
   `getOrCreateFilteredTraversal` and emit the block as a required (or, under `||`, OPTIONAL)
   filtered group.

7. **A where narrows a relation the projection or a count also reads.** A where and a projection
   share an unfiltered traversal (`select((p) => p.friends.name).where((p) => p.friends.hobby.equals('Golf'))`
   lists only the golf-playing friends), and so does a plain count:
   `select((p) => ({n: p.friends.size()})).where((p) => p.friends.name.equals('Anna'))` gives bob
   `n: 1` although he has three friends (oxigraph, report 122). Long-standing for paths and
   possibly intended ("the where filters the rows"); for a count it reads as a wrong answer. A
   paginated sub-select and a filtered path already have traversals of their own (reports 115,
   122). Decide whether a where shares traversals with fields at all; if not, give the where its
   own (`LoweringContext.conditionResolver` is the place) and update the goldens that encode the
   sharing.
