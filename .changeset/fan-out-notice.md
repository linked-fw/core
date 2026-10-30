---
'@_linked/core': patch
---

`LinkedStorage` logs a notice, once per call site, when a shapeless read that names no dataset is
sent to more than one dataset: a subject read (`TriplesBuilder.forNode({id})` without `.from()`)
or a shapeless ask (`Shape.exists(iri)`, `AskBuilder.forNode(iri)`). The notice gives the number
of datasets and the fix: pass a dataset (`Shape.exists(iri, dataset)`, `.exec(dataset)`) or, for a
subject read, name graphs with `.from(graph)`. Nothing is logged with one dataset or an explicit
dataset.
