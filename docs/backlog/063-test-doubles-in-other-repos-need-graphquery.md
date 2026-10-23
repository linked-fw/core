---
summary: >
  `IDataset.graphQuery`, `updateQuery`, `createQuery` and `deleteQuery` became required (report
  048). Test doubles typed `IDataset` in `@_linked/react` (`src/tests/fixtures.ts`,
  `ScriptedDataset`) and `@_linked/shape-ui` (`src/catalog.test.ts`) lack some of them and fail
  their typecheck when those repositories take the new core.
packages: [core, react, shape-ui]
---

# 063 — Test doubles in react and shape-ui need the required dataset methods

Source: CN plan 071, core report 048 (the `IDataset` method changes).

## Problem

The production implementers (server's `RemoteDataset`, CN's `AppDataRouter` and
`ExecutionGateway`) are updated by plan 071's own steps. Two repositories outside the plan only
implement `IDataset` in tests:

- `@_linked/react`: `src/tests/fixtures.ts`, `class ScriptedDataset implements IDataset`;
- `@_linked/shape-ui`: `src/catalog.test.ts`, `const dataset: IDataset = {…}`.

They compile today against the published core and break at typecheck once Renovate raises their
`@_linked/core` range to the release with report 048. Nothing breaks at runtime.

## Fix

Add the missing methods to each double: mutation methods that reject, and
`graphQuery: async (q) => { throw unsupportedGraphQuery(q); }` (core's
`src/test-helpers/test-utils.ts` has `unusedDatasetMethods` as a model). Do it in the Renovate PR
that takes the new core, or before it.
