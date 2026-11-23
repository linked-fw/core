---
summary: >
  What reports 115 and 118 left of outer references: an inline filter or a quantifier that reads
  the outer subject has no DSL-JSON form; a node more than one hop above the filtered relation is
  refused; routed complex-path outer reads.
packages: [core]
---

# 111 — Outer references: wire form, deeper hops, routed reads

Source: report 115 (backlog 108, plan 006 step S1). Report 115 resolves a path an inline filter
reads from the outer subject (`p.bestFriend.friends.where((f) => f.name.equals(p.name))`) to the
outer alias; report 118 (plan 006 step S2) does the same for a quantifier
(`p.friends.some((f) => f.name.equals(p.name))`), in a top-level where and inside an inline filter,
and for a nested quantifier reading an enclosing member (items 1 and 2 of this item, done). These
edges remain (numbers kept, as reports cite them):

3. **DSL-JSON form.** `toJSON()` refuses an inline filter or a quantifier that reads the outer
   subject, or a nested quantifier that reads an enclosing member (its paths are written relative
   to the member; report 118 made a top-level quantifier reading the outer subject, which used to
   serialize as a self-comparison, refuse too). So a live query (`live/keys.ts` keys by `toJSON()`) and a
   `RemoteDataset` cannot carry one. Needs a wire syntax for "the subject's path" inside a filter
   (e.g. a `{"@outer": "name"}` value) and a wire version bump: a design choice.
4. **A node more than one hop above the filtered relation**
   (`p.bestFriend.bestFriend.friends.where((f) => f.name.equals(p.name))`) is refused: the nested
   OPTIONAL holding the filtered block only binds its parent and the node the parent's hop leaves
   from. Answering it needs another layout (e.g. the hops from the read node down to the block in
   one OPTIONAL group), which changes what "the hops above a filter stay optional" means.
5. **Routed reads:** `routedPathsTheStoredWay` collects links from the IR's property reads through
   the registry; an outer read's own variable (`?a0_name_2`: an inline filter's, `irToAlgebra`
   step 3a, or a quantifier's inside its `EXISTS`, `bindOuterReadsInExists`) is registered under a
   key of its own,
   so a complex-path outer read (`sh:path` sequence or inverse) across graphs is not rewritten the
   stored way. Literal reads (the common case) are unaffected.
