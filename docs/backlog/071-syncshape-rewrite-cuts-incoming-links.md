---
summary: >
  The ordinary default-graph `syncShape`/`syncShapes` rewrite (`delete → create` per changed
  shape) deletes the incoming links to the shape it rewrites (`?s ?p <shape>`, e.g. another
  shape's `core:isExtending` or `sh:node`), the same cascade the one-time cleanup had. Delete the
  shape's own description and keep incoming links, as the cleanup now does.
packages: [core]
---

# 071 — Default-graph `syncShape` rewrite cuts incoming links

Source: CN plan 071 final review; core report 051 §Review fixes ("Observed, not changed").

## Problem

`writeShape` in `src/shapes/syncShapes.ts` rewrites a changed shape in two requests:
`DeleteBuilder.from(NodeShape, {id: iri})`, then `NodeShape.create(…).withId(iri)`. The delete
also removes every triple that points at the shape (`?s ?p <shape>`). When shape B extends or
nests shape A and only A changed (its hash differs, B's does not), the rewrite of A deletes B's
`core:isExtending <A>` or `sh:node <A>`, and the hash check skips B, so the link stays lost
until B changes or a forced sync runs. Instance data that links to the shape IRI loses those links
too.

Report 051 fix 3 solved the same cascade for the one-time default-graph shape cleanup with an
internal delete by ids that keeps incoming links (`DeleteBuilder._keepingIncoming()`,
`IRDeleteMutation.keepIncoming`). The ordinary sync path was not changed.

Shape graphs (`syncShapeGraphs`) replace a package's graph whole and are not affected; this hits
stores without graph queries, which fall back to `syncShapes`, and every caller of `syncShape`.

## First questions

- Use the cleanup's keep-incoming delete in `writeShape` too, or rewrite the shape as a patch?
- A `[fuseki]` test: sync A and B, change A only, sync again; B keeps `core:isExtending <A>`
  (fails today).
- Do stores already holding a cut link need a one-time forced sync, or is the next change enough?
