---
summary: >
  Under graph routing a link followed through a complex `sh:path` is read in one graph. Routed
  reads read `?a ^<p> ?b` in `?a`'s graph, while the stored `?b <p> ?a` is in `?b`'s; a sequence's
  middle nodes have no graph of their own anywhere. Writes now handle `^<p>` and refuse other paths
  into another graph (report 055). Also left open: referrers without a value shape and an
  update-where's shared nested owned node.
packages: [core]
---

# 073 — Routed paths across graphs

Source: core report 055 (writes across graphs), its review.

## Problem

- **Reads.** `routedReadScope` (`irToAlgebra.ts`) gives a variable bound through a property the
  read set of the property's value shape, and `graphScope.ts` groups triples by subject.
  - An inverse path `?a0 ^<author> ?a1` (a person's articles) is grouped with `?a0` and read in the
    person's graphs. The stored triple `?a1 <author> ?a0` is in the article's graph, so the
    traversal matches nothing.
  - Writes now rewrite such a triple the stored way round (report 055); reads do not yet.
- **Sequences and other complex paths.** In `^<author>/<reviewer>`, the middle node (the article)
  has no variable and so no graph. Reads read the whole path in the subject's graphs.
  - Writes refuse such a path into a node in another graph (`GraphQueryError('unsupported-query-kind')`).
  - Writes still read it in the subject's graph when its target is there, though the middle node
    may not be.
- **Referrers without a value shape.** A delete by id removes the links held in the read sets of
  shapes whose property has the deleted shape (or a super- or sub-shape) as value shape. An object
  property without a value shape can link to anything, and its links in other graphs stay.
- **An update-where with a nested owned create** mints one IRI for every matched owner (as without
  routing). When the owners may live in several graphs, that one node is written into each of them.
  The same update linking an existing node is refused (report 055).

## First questions

- **Reads:** rewrite a pure inverse step the stored way round, as writes do. Or split complex paths
  into one variable per step, so each middle node gets the value shape of its step?
- **Sequences:** refuse a complex path across routed shapes on reads too, or split it into steps
  (above)?
- **Referrers without a value shape:** include the read sets of shapes that declare an object
  property without a value shape? That is every graph once any such property exists.
- **Nested owned create:** refuse an update-where with a nested owned create when the owners may
  live in several graphs, or mint one node per owner?
