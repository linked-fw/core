---
summary: >
  What report 115 left of outer references: a quantifier that reads the outer subject compares the
  member with itself (top-level where) or is refused (inside an inline filter); an inline filter
  that reads the outer subject has no DSL-JSON form; a node more than one hop above the filtered
  relation is refused.
packages: [core]
---

# 111 — Outer references: quantifiers, wire form, deeper hops

Source: report 115 (backlog 108, plan 006 step S1). Report 115 resolves a path an inline filter
reads from the outer subject (`p.bestFriend.friends.where((f) => f.name.equals(p.name))`) to the
outer alias. These edges remain:

1. **A quantifier reading the outer subject, in a top-level where.**
   `Person.select().where((p) => p.friends.some((f) => f.name.equals(p.name)))` lowers to
   `FILTER(EXISTS { ?a0 :hasFriend ?a1 . ?a1 :name ?a1_name . FILTER(?a1_name = ?a1_name) })`:
   `p.name` resolves against the quantifier's member, a silent self-comparison (older than 115).
   The trace scopes of report 115 (`src/queries/traceScopes.ts`) open a scope for a quantifier
   only inside an inline filter, so this is unchanged. Inside an EXISTS the outer alias is in
   scope (EXISTS substitutes the outer bindings), so resolving to it is likely all it needs:
   open the scope for every quantifier and pass an outer resolver to `lowerExistsCondition`.
2. **A quantifier inside an inline filter** reading the filter's member or the outer subject
   (`p.friends.where((f) => f.friends.some((g) => g.name.equals(f.name)))`) is refused by 115.
   Same fix as 1, with the filter's member as one more resolvable scope.
3. **DSL-JSON form.** `toJSON()` refuses an inline filter that reads the outer subject (its paths
   are written relative to the member). So a live query (`live/keys.ts` keys by `toJSON()`) and a
   `RemoteDataset` cannot carry one. Needs a wire syntax for "the subject's path" inside a filter
   (e.g. a `{"@outer": "name"}` value) and a wire version bump: a design choice.
4. **A node more than one hop above the filtered relation**
   (`p.bestFriend.bestFriend.friends.where((f) => f.name.equals(p.name))`) is refused: the nested
   OPTIONAL holding the filtered block only binds its parent and the node the parent's hop leaves
   from. Answering it needs another layout (e.g. the hops from the read node down to the block in
   one OPTIONAL group), which changes what "the hops above a filter stay optional" means.
5. **Routed reads:** `routedPathsTheStoredWay` collects links from the IR's property reads through
   the registry; an outer read's own variable (`?a0_name_2`) is registered under a key of its own,
   so a complex-path outer read (`sh:path` sequence or inverse) across graphs is not rewritten the
   stored way. Literal reads (the common case) are unaffected.
