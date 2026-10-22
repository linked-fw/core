---
summary: >
  Property inference (`rdfs:subPropertyOf`) was deferred when the store started inferring classes:
  the ontology sync writes only `rdfs:subClassOf`, and the store's RDFS view builds class
  inference only. Turning on property inference first needs rules for owned predicates,
  single-valued properties, `rdf:type` and deletes, because several schema.org sub-properties
  would make core delete or return the wrong values.
packages: [core]
---

# Property inference (`rdfs:subPropertyOf`)

## Problem

Create Now's stores infer `rdf:type` through `rdfs:subClassOf` (CN plan 070): the class hierarchy
from each package's ontology data is synced into every app dataset, and the store's RDFS view
expands type patterns at query time. `rdfs:subPropertyOf` was deliberately left out. The sync
writes only `rdfs:subClassOf`, and the store's module reads only `subClassOf` to build its
hierarchy, so a `subPropertyOf` triple in a dataset (from an imported ontology, say) infers
nothing.

Turning it on would make a pattern on a super-property also match every sub-property's values.
schema.org's data alone has 151 `subPropertyOf` triples, and some of them break core today:

- **Owned predicates widen.** `schema:logo`, `schema:photo` and `schema:layoutImage` are
  ⊑ `schema:image`, which `Thing` owns (`contains`). Replacing a Thing's image runs
  `DELETE { <s> schema:image ?old . ?old ?p ?o } WHERE { <s> schema:image ?old }`
  (`buildOwnedSelfDelete`, `src/sparql/irToAlgebra.ts`), so `?old` also binds the logo and the
  photos and deletes them. Deleting a Thing cascades into its logo, which may be shared.
- **Single-valued properties return several values.** `image` (maxCount 1) would come back with
  the logo too. `schema:name ⊑ rdfs:label`: shapes with a single `rdfs:label` read every name as a
  label.
- **Deletes of inferred triples do nothing.** Updating `rdfs:label` deletes the inferred label,
  which has no stored triple; the stored `schema:name` stays, so the node ends with two labels.
- **`schema:additionalType ⊑ rdf:type`** would make any IRI-valued additionalType a class of the
  node, for selects, counts and deletes.

No feature needs property inference yet.

## Context

- Source: CN plan 070 (store inference and ontology data), its §Ideation, decision on sync scope.
- Ontology sync: `syncOntologies` (core) keeps `rdfs:subClassOf` from the parsed Turtle; the
  hierarchy reader drops every other predicate.
- The store side: the `linked-fw/fuseki-server` image (Jena's `DatasetGraphRDFS` view, rebuilt
  when a commit touches the hierarchy). Adding properties means it also reads `subPropertyOf`.
- Owned walks and type guards: `src/sparql/irToAlgebra.ts` (`ownedWalk`, `ownedEdges`,
  `buildOwnedSelfDelete`, `blockedGuard`); `docs/architecture/owned-values.md`.

## First open questions

1. Which sub-properties are safe? Candidate rule: never sync a `subPropertyOf` whose
   super-property is `rdf:type`, or a predicate any registered shape uses (owned or not).
   That makes the synced set depend on which shapes are registered; is that acceptable?
2. Should core's queries read stored triples for owned walks and deletes (through `/stored` or a
   marker), so property inference can never widen a delete?
3. Is property inference wanted per dataset (opt-in), or for every dataset?
4. What is the first feature that needs it (e.g. a generic "label" over `rdfs:label`,
   `schema:name`, `skos:prefLabel`)? Could that feature use an explicit property list instead?
