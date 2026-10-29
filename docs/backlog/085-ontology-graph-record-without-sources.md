---
summary: >
  An ontology registration with data but no data file names (`linkedOntology(terms, ns, prefix,
  load)` without `dataSource`) makes the ontology sync write a record with `sources: []`, which
  becomes invalid SPARQL (`dcterms:source ;`) and fails the package's graph.
packages: [core]
---

# 085 — Ontology graph record without sources

Source: core report 084 (found while writing `sync-routed-fuseki.test.ts`).

## Problem

`packageSources(name)` is the list of a package's registered data files. A registration with a
`load` function but no `dataSource` has `files: []`, so `OntologyGraph.create({…, sources: []})`
serializes the empty list as `<http://purl.org/dc/terms/source>  ;` and Fuseki answers 400. The
package's ontology graph is never written; the routed sync reports the dataset as failed. Packages
built by `linked build` always name their files, so only hand-written registrations hit it.

## First questions

- Should a create or update with an empty list leave the property out (the fix in core's
  mutation serialization, for every shape), or should the ontology sync leave `sources` out when
  it is empty?
- Should `linkedOntology` refuse `load` without `dataSource`?
