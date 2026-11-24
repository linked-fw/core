---
"@_linked/core": minor
---

`linkedOntology(terms, ns, name, loadData?, dataFiles?)`: the third argument is the ontology's name within its package (unique in the package, need not equal the module's file name), not a prefix. `OntologyRegistration.prefix` is now `.name`, and the registry is keyed by package and name. A registration an older copy of core wrote (a `prefix`, no `name`) is skipped with one warning. `linkedOntology` still registers the name as a prefix with `Prefix`.
