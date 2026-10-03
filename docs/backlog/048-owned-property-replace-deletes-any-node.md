---
summary: >
  Replacing the value of a `contains` (owned) property deletes the previous value node and its owned
  subtree (`buildOwnedSelfDelete` / `buildOwnedCascade` in `sparql/irToAlgebra`). Core does not check
  that the previous value is actually owned by the subject, or that it has the property's value
  shape — so when an app links an existing node id into an owned property, the next replace or a
  cascade delete removes that node's triples, wherever else it is used. Proposal: only delete a
  replaced or cascaded node that core can show is owned by the subject.
packages: [core]
status: Open — apps guard their own call sites today; core should make this safe by default
---

# 048 — Replacing an owned property deletes whatever node it pointed to

## Behaviour today

A property declared `contains` (e.g. `schema:image` on `Thing`) means "the value node belongs to the
subject". Core acts on that in two places:

- **Replace.** `processUpdateFields` treats an update of a `contains` property as replace-and-own:
  it emits `buildOwnedSelfDelete` for the old value, deleting every triple of that node, plus
  `buildOwnedCascade` for its owned subtree.
- **Delete.** Deleting the subject cascades through its `contains` edges.

Neither step checks the old value. Whether a predicate is `contains` is decided by predicate across
the whole shape registry, and the value node is deleted without checking that it

1. has the property's value shape (or any type at all), or
2. is referenced only by this subject through this predicate.

So if a value was linked by id (`{image: {id: existingNodeId}}`) rather than created as a new nested
node, the next replace — or deleting the subject — deletes `existingNodeId`'s triples, even if that
node is used elsewhere or is a different kind of node entirely. A second effect: re-sending the
*current* `{id}` unchanged is treated as a replace and deletes that same node's own triples.

## Where it showed up

Create Now hit both effects (project images linked by id; a settings form re-sending the current
image id on every save) and now guards its own call sites: values for owned properties are minted
server-side, and client-supplied `{id}` values for `contains` predicates are refused or dropped.
That fixes one app; every other app that links ids into owned properties can lose data the same way.

## Proposal

Make the owned delete conditional in the generated algebra, so it only removes a node core can show
the subject owns:

- delete the old value only if it is typed with the property's value shape (or a subclass), and
- only if no other subject references it (`FILTER NOT EXISTS { ?other ?p ?old . FILTER(?other != ?subject) }`),
- and treat "new value equals current value" as a no-op rather than a replace.

Alternatively (or additionally) refuse, at the DSL level, linking an existing `{id}` into a
`contains` property — owned values are created, not linked — with an explicit opt-in for the cases
that genuinely transfer ownership.

## Open questions

- Is "linked by id into an owned property" ever intended (ownership transfer)? If yes, it needs an
  explicit form rather than being the default.
- Cost of the extra `NOT EXISTS` per replaced value on large updates.
- The same rule for cascades during subject delete, including nested owned subtrees.

## Tests to add

- Replace of an owned property whose old value is referenced elsewhere keeps that node.
- Replace whose old value has a different type keeps that node.
- Re-sending the current value is a no-op (no delete emitted).
- Subject delete does not cascade into a node another subject references.
