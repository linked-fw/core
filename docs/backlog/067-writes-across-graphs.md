---
summary: >
  A routed mutation runs in one graph (`WITH <g>`): a delete by id leaves incoming references held
  in other graphs, and an `update_where`/`delete_where` filter or a computed update that traverses
  into a linked node in another graph does not see that node. Decide whether these need a
  cross-graph form (and how a triple delete names every graph that holds it).
packages: [core]
---

# 067 — Writes across graphs

Source: CN plan 071 §Graph routing, core report 051 (graph routing).

## Problem

Routed writes put the subject's graph on the plan (`INSERT DATA { GRAPH <g> … }`, `WITH <g>`
before `DELETE`/`INSERT`), so the template and the `WHERE` both run in that graph. That is what
keeps an owned delete inside its graph, and it matches the plan's pitfall "never delete across
graphs". Three consequences are not covered yet:

- `Person.delete({id})` removes `?s ?p <person>` only in the person's graph: an `Article` in an
  articles graph that names the person as its author keeps the dangling reference.
- `Article.update(…).where((a) => a.author.name.equals('x'))` (and `deleteWhere`) reads the
  author's name in the article's graph, where it is not: nothing matches.
- A computed update (`p.bestFriend.name.ucase()`) reads the linked node's value in the subject's
  graph.

- `UpdateBuilder.from(Album).set({cover: {id: X}}).forAll()` (an `update_where` linking an owned
  node) is not checked for X living in another graph than the matched owners (the by-id and create
  paths refuse that); a later cascade of such an owner would miss X.
- An upsert whose shape reads several graphs wraps its WHERE in `OPTIONAL { GRAPH ?g { … } }`: a
  computed value through a required traversal that does not match no longer stops the constant
  inserts (`a <Class>`, literal sets).

Before routing all of these ran in the default graph, where everything was.

## Open questions

- Should a delete by id clean incoming references in every graph of the dataset's routing (one
  `DELETE` with a `GRAPH ?g` template over the routed set), or is a dangling reference acceptable
  (reads of the referring shape show an id with no data)?
- Should the `WHERE` of `update_where`/`delete_where` and of computed updates be scoped like a
  read (per subject group, `GRAPH ?g` / `VALUES`), with only the template in the subject's graph?
