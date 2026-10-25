---
summary: >
  What is left of routed paths across graphs after report 077 (reads through `^<p>` follow the
  stored triple; other complex paths between graphs are refused on reads and writes): a complex
  path whose ends share one graph but whose middle node lives in another, inverse paths under a
  `.from()` of several graphs, referrers without a value shape, and an update-where's shared
  nested owned node.
packages: [core]
---

# 073 — Routed paths across graphs

Source: core reports 056 (writes across graphs) and 077 (routed complex-path reads).

## Problem

- **A complex path whose ends read one same graph.** Reads and writes refuse a sequence (or an
  alternative, a repetition) only when its two ends may live in different graphs. In
  `^<author>/<reviewer>` from a writer to a person in the same people graph, the middle node (the
  article, in the articles graph) has no variable and so no graph: the whole path is read in the
  people graph and matches nothing.
- **Inverse paths under `.from()` of several graphs.** The stored-way rewrite applies under graph
  routing only. `.from([g1, g2])` gives every subject its own graph variable as well, so
  `?a0 ^<author> ?a1` is read in `?a0`'s graph and misses an article stored in the other one.
- **A linked node bound only inside `EXISTS`** (`w.articles.some(…)`) reads every graph the
  routing knows (`VALUES ?g_a1 { <default> <articles> <people> }`), not its value shape's read set:
  `routedReadScope` takes its sets from the select's variable registry, which does not hold the
  `EXISTS` traversals. Correct, but wider than needed. (Whether such a link is rewritten or
  refused is already judged by its value shape's read set.)
- **Referrers without a value shape.** A delete by id removes the links held in the read sets of
  shapes whose property has the deleted shape (or a super- or sub-shape) as value shape. An object
  property without a value shape can link to anything, and its links in other graphs stay.
- **An update-where with a nested owned create** mints one IRI for every matched owner (as without
  routing). When the owners may live in several graphs, that one node is written into each of them.
  The same update linking an existing node is refused (report 056).

## First questions

- **Middle nodes:** refuse any complex path other than `^<p>` under routing when the routing has
  more than one graph, or split a path into one variable per step so each middle node gets the
  value shape of its step (when the step's property declares one)?
- **`.from()`:** apply the stored-way rewrite whenever a read's scope gives the two ends different
  graph variables, routed or not?
- **`EXISTS` sets:** feed `EXISTS` traversals into `routedReadScope` (narrower `VALUES`, changed
  routed SPARQL)?
- **Referrers without a value shape:** include the read sets of shapes that declare an object
  property without a value shape? That is every graph once any such property exists.
- **Nested owned create:** refuse an update-where with a nested owned create when the owners may
  live in several graphs, or mint one node per owner?
