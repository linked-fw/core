---
'@_linked/core': minor
---

Every core shape is now registered by whatever loads it, including under a bundler.

- `PropertyShape.in` (sh:in) refers to `List` by value instead of by name, and `List` is
  registered from `utils/Package.ts` next to `NodeShape` and `PropertyShape`. Loading the SHACL
  metamodel (`package.js` + `shapes/SHACL.js`) is now enough to query or create `in`; before,
  that threw `Shape class not found for https://linked.cm/shape/core/List` unless something
  else had loaded `shapes/List`.
- New `@_linked/core/shapes/index`: a side-effect-only module that loads every shape core
  defines. The package entry imports it.
- `sideEffects` now includes `shapes/*` and the package entry. Before, a bundler dropped a bare
  `import '@_linked/core/shapes/List'`, and `import {validate} from '@_linked/core'` registered
  no core shape at all. A consumer of the entry now bundles the SHACL metamodel with it
  (measured: +40 kB unminified in a Vite build that imports only `validate`).
- `PathNode`, `NodeShape` and `PropertyShape` have explicit shape names. Bundled, `PathNode`
  collided with the ontology term `coreOntology.PathNode` and was renamed `PathNode2`, which
  registered it under the wrong IRI. Their IRIs are unchanged.
