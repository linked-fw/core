---
"@_linked/core": patch
---

Graph-registry records: a record field given an empty list (for example `OntologyGraph.create({..., sources: []})`, or `.update(g).set({sources: []})`) is now left out of the generated SPARQL instead of producing `<p> ;`, which every SPARQL endpoint refused as a parse error. On an update the field's old values are still deleted, so setting a list field to `[]` clears it.
