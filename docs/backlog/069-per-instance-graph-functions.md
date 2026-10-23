---
summary: >
  A route that picks a graph per instance (a function of the node being written, e.g. one graph per
  customer), next to the per-shape routes `'own'` and `dataGraph()`. Open: the function may be
  async and query; whether the registry records each instance graph; how reads enumerate them; the
  cost on the write path.
packages: [core]
---

# 069 — Per-instance graph functions

Source: CN plan 071 §Open questions 5 (1c-i, owner, 2026-10-23), core report 053 (routing forms).

## Problem

A graph route maps a **shape** to one graph: `{graph: 'own'}` (`{DATA_ROOT}/graph/{package
slug}/{shape name}`), `{graph: dataGraph('slug')}` or a graph IRI. Some apps want the graph to
depend on the **instance**: one graph per customer, per tenant or per project, so a whole slice of
data can be copied, exported, secured or dropped as one graph. That needs a route that is a
function, e.g. `{graph: (node) => dataGraph(`customers/${node.customer.slug}`)}`.

## Open questions (from the plan)

- **Async, may query.** The function may need data the write does not carry (the customer's slug
  when only its id is linked), so it may be async and run queries. Where does it run (the store, on
  the server only), and what may it read (its own dataset, the graph it is choosing)?
- **The registry.** Does every instance graph get a registry record (a `NamedGraph` per customer,
  created on the first write into it), so `graphs.union`, the hierarchy and CN's graph overview see
  them? Who removes a record when its graph empties?
- **Reads.** A shape's read set is static today (its graph, its sub-shapes', its owners'). With
  instance graphs, a select of the shape must enumerate them: from the registry (by a record kind or
  a graph IRI prefix), as `FROM NAMED`/`VALUES` over a set that grows with the data, or through the
  union graph with a type check. What does a page or a count cost over thousands of graphs
  (decision 9's fixture measured 10 of 100)?
- **Writes.** A create must call the function before the `INSERT` (one more round trip when it
  queries); an update or delete of an existing subject already finds its graph inside the update
  (`graphIn`, report 051), but its candidate set is the enumeration above. What is the cost on the
  write path, and is a cache (per instance, invalidated how) acceptable?
- **Moves.** When the value the function reads changes (an order moves to another customer), does
  the node move graphs?

## First step

A short ideation against one concrete app need (per-customer graphs in a CN app), measuring reads
over a realistic number of instance graphs before choosing the API.
