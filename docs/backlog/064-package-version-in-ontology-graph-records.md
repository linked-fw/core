---
summary: >
  The ontology sync records no `core:version` on a package's `OntologyGraph` (report 050): core
  knows no package's version (`OntologyRegistration` and `linkedPackage` carry none). Recording
  it needs the version in the registration, filled by the package's generated register module
  or by `registerInstalledOntologies` from `package.json`.
packages: [core]
---

# 064 — The package version in ontology graph records

Source: CN plan 071 §Ontology sync (`update(...).set({version}).replaceContent`), core report 050.

## Problem

The registry record of an ontology graph has an optional `version` field (`core:version`), and
master plan 071 shows the sync setting it. The sync has nothing to set it from: an ontology
registration (`linkedOntology(terms, ns, prefix, load, files)`) records the package name, prefix,
loader and files, not the version, and `linkedPackage(name, options)` takes no version either.
The sync therefore writes `package` and `sources` only; the content hash, not the version, decides
whether a graph is rewritten, so nothing depends on it today.

## First open questions

- Where does the version come from: a `version` option on `linkedPackage` (written by the
  package template from `package.json`), or `registerInstalledOntologies`, which reads each
  installed package's directory and could read its `package.json`?
- Should a version change alone (same data bytes) update the record (`update(iri).set({version})`,
  a record-only graph query, no body rewrite)?
