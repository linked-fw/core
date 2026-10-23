---
summary: >
  `isolateLinkedTypeChecks` (report 049) moves a linked subject's inferred type check into a
  second `GRAPH ?g` block, but the select generator never type-checks a traversal's target, so
  the flag changes no query the DSL builds today. Whoever adds linked type checks (graph routing
  by sub-shape, if it needs them) gets the split for free and should add a DSL-level
  identical-rows test.
packages: [core]
---

# 065 — Linked type checks in graph reads

Source: CN plan 071 decision 9, core report 049 (reads from graphs).

## Problem

Decision 9 measured a join of a work to its author with `?author a schema:Person` in the author's
block, and made the second block (`GRAPH ?gAuthor { ?author a schema:Person }` after the block
reading `?author schema:name`) a store option, `isolateLinkedTypeChecks`. Core's select generator
(`selectToAlgebra`) writes `rdf:type` only for the root subject and for `MINUS` shape exclusions
on the root; a traversal (`p.bestFriend.name`) adds `?a0 bestFriend ?a1` and the properties of
`?a1`, never `?a1 a C`. So with today's generator the option is inert: `graphScope.ts` splits any
linked subject block holding a type triple and a stored triple, and no generated block holds one.
Report 049's tests add a type triple to a generated algebra to exercise it (unit golden and
`[fuseki]` identical rows); the DSL-level identical-rows test compares identical text.

## Open questions

- Does graph routing (K4: per-shape graph sets, sub-shapes routed to other graphs) need a type
  check on a linked subject to pick the right graph set, or does the property's value shape
  decide it without one? If it adds one, add a DSL query to `read-graphs-fuseki.test.ts` whose
  two forms differ in text.
- Should a traversal to a property whose value shape is narrower than what the data holds filter
  by type at all (a semantic change to every select), independent of graphs?
