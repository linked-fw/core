---
summary: >
  Option 2 of the global graph targets: the boot syncs write where routing pins the shapes, not
  always into the default dataset. Shapes go to the dataset NodeShape/PropertyShape are pinned to,
  ontologies to where the class and property shapes are pinned; a split pin is refused; warn when
  the ontology store does not hold the instances (inference needs the hierarchy there).
packages: [core, server]
---

# 076 — The ontology and shape syncs follow routing

## Today

The graph targets are one global setting (report 075). `@_linked/server`'s boot syncs
(`syncOntologies`, `syncShapeGraphs`) write into the default dataset only. When routing pins the
shape shapes or the ontology term shapes to another dataset, the server logs a warning at boot and
writes into the default dataset anyway, so reads of those shapes on their pinned store miss what
the sync wrote.

## The change

- **Shapes** go to the dataset `NodeShape` and `PropertyShape` are pinned to
  (`LinkedStorage.getStoreForShapeClass`), the default dataset when they are not pinned.
- **Ontologies** go to where the class and property shapes are pinned: the term shapes core and
  `@_linked/rdfs` / `@_linked/owl` register (`rdfs:Class`, `owl:Class`, `rdf:Property`,
  `owl:ObjectProperty`, `owl:DatatypeProperty`, …).
- **A split pin is refused**, before anything is written: node shapes and property shapes on
  different datasets, or classes and properties on different datasets. The error names the shapes
  and their datasets.
- **Inference caveat.** Class inference needs the hierarchy in the store that holds the instances
  (see "Store requirements" in the README). When the ontology dataset is not one that holds
  instance data (other shapes are pinned elsewhere, or the default dataset holds them), warn once,
  naming both datasets: class-scoped reads on the instance store miss subclass instances.

## Open questions

- Where the decision lives: core (a `syncTargetsFromRouting()` the server calls) or the server's
  boot phases. Core knows the shapes; the server owns the boot.
- Whether "holds instances" is a routing fact (some data shape is pinned there) or a store check
  (the probe on that dataset).
