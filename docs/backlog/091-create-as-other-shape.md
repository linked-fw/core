---
summary: >
  One write, several shapes: `SomeShape.create({...}).as(OtherShape, otherData)` writes the same
  node through more than one shape (casting in one sequence), for open shapes. Closed shapes refuse
  the other shape's properties.
packages: [core]
---

# 091 — Writing one node through several shapes (`.as`)

Source: a discussion of provenance in a host app (owner, 2026-10-31).

An RDF node can hold properties of several shapes as long as the shapes are not closed. The idea:

```ts
await Product.create({name, price})
  .as(Sourced, {source: {id: documentIri}})   // the same node, also written as a Sourced
  .exec(ds);
```

- Each part is checked as a write on its own shape, so rights stay per shape.
- A closed shape (`sh:closed`) refuses properties outside it. Whether `.as` is refused on a closed
  shape, or the other shape's properties are, is open.
- It came up for provenance, which the owner decided to handle differently (change tracking in the
  gateway, transaction history in a store such as Logos). This item is the general DSL feature.

## Open

- Name (`.as`), and whether update and upsert get it too.
- Closed shapes: refuse at build time when the shape is known closed, or at the store.
- How it lowers (one mutation with several shape parts in the IR).
