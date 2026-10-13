---
summary: >
  Two edge cases of the generated single-owner shapes that shape sync owns through
  `core:generatedShape`. (1) A store-only NodeShape that already sits at a generated IRI
  (`<shape>/<accessor>.singleOwner`) is adopted by the nested create and wiped by the next sync.
  (2) Under `orphanScope: 'ownedNamespaces'`, a generated shape that lost its owner edge (data
  written by raw SPARQL, or by unreleased pre-ownership builds) is never pruned. Both are unlikely;
  decide whether to guard or only document.
packages: [core]
---

# 052 — Generated-shape lifecycle edge cases

Source: [report 032](../reports/032-owned-replace-noop-and-single-owner-shacl.md) (follow-ups L15,
L16). Contract: [owned-values](../architecture/owned-values.md).

## 1. A store-only NodeShape at a generated IRI is adopted, then wiped

`assertNoGeneratedIriCollision` (`src/shapes/syncShapes.ts`) compares generated IRIs only with
**registered** shapes. A NodeShape that exists only in the store (written by another tool or an
application's shape editor) at `…/<Shape>/<accessor>.singleOwner` gets linked by the nested create
through `core:generatedShape`. The next sync's owned-child delete then removes all of its triples.

It needs a hand-made NodeShape at exactly that IRI, which is unlikely.

Options:
- document it (README / owned-values);
- extend the collision check with one `ASK { <iri> a sh:NodeShape FILTER NOT EXISTS { <iri> core:generated true } }`
  per generated IRI (or one batched SELECT per `syncShapes` call) and throw.

## 2. Ownerless generated shapes are not pruned under `'ownedNamespaces'`

`'ownedNamespaces'` derives a shape's namespace from its IRI up to the last `/`. For a generated
shape that is `…/<Shape>/`, not the package namespace, so an ownerless generated shape is never
in scope. With its owner edge present it goes with its owner's delete, so this only matters for:
- generated shapes written before the ownership edge existed (unreleased builds only);
- an owner removed by raw SPARQL.

Options: map `core:generated true` NodeShapes to their owner's namespace in the prune; or prune
every `core:generated` NodeShape that no `core:generatedShape` edge points at (needs a richer read
than the id-only orphan SELECT). Likely fold into [backlog 046](046-provenance-scoped-shape-pruning.md).

## Open questions

- Guard (1) with a store read, or document it only?
- Should (2) be handled by backlog 046's provenance tagging instead?
