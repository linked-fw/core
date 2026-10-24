---
summary: >
  `IDataset.graphQuery`, `updateQuery`, `createQuery` and `deleteQuery` became required (report
  048). The test double typed `IDataset` in `@_linked/shape-ui` (`src/catalog.test.ts`) lacks some
  of them and fails its typecheck when that repository takes the new core. React's part is done
  (report 054).
packages: [core, shape-ui]
---

# 063 — The shape-ui test double needs the required dataset methods

Source: CN plan 071, core report 048 (the `IDataset` method changes).

## Problem

`@_linked/shape-ui`'s `src/catalog.test.ts` (`const dataset: IDataset = {…}`) implements `IDataset`
only in a test. It compiles against the published core it pins and breaks at typecheck once its
`@_linked/core` range reaches the release with report 048. Nothing breaks at runtime.

`@_linked/react`'s `ScriptedDataset` had the same gap; it was fixed with report 054.

## Fix

Add the missing methods to the double: mutation methods that reject, and
`graphQuery: async (q) => { throw unsupportedGraphQuery(q); }` (core's
`src/test-helpers/test-utils.ts` has `unusedDatasetMethods` as a model). Do it in the Renovate PR
that takes the new core, or before it. Delete this backlog item once it has merged.
