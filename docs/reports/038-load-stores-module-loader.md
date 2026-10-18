---
summary: >
  `loadStores` imports each store through a host-supplied loader,
  `globalThis[Symbol.for('@_linked/core:importModule')]`, when it is a function, and through the
  native `import()` otherwise. `linked start` (dev) sets it so a store named in a datasets file
  comes from the same copy of its package as the app's own import of it under Vite's SSR runner.
  Minor.
packages: [core]
---

# 038 — `loadStores` imports through a host loader

Source: [cli backlog 014](https://github.com/linked-fw/cli/blob/main/docs/backlog/014-dev-loads-a-second-copy-of-datasets-file-stores.md)
(the measurements) and [cli backlog 015](https://github.com/linked-fw/cli/blob/main/docs/backlog/015-one-copy-of-each-framework-package.md)
(the bug class). Plan: Create Now plan 068, phase 4. The CLI half (`linked start` installs the
loader) is a separate change in linked-fw/cli.

## Problem

Under `linked start` the app's storage file runs in Vite's SSR module runner, but `loadStores`
imported each `store` specifier with Node's native `import()`. When the runner bundles the store's
package, that makes two copies of it: the app's `instanceof RemoteDataset` and
`instanceof RemoteDatasetUnreachableError` checks fail against the store `loadStores` built, and
module state exists twice. The app template matches errors by name as a workaround.

## Outcome

- `loadStores` imports through `importModule(specifier)`, which calls the hook on
  `globalThis[Symbol.for('@_linked/core:importModule')]` when it is a function and the native
  `import(specifier)` otherwise.
- Without the hook (a built app, `linked serve`, scripts, any non-CLI host) behaviour is unchanged.
- The rest of `loadStores` is unchanged: export picked by the specifier's last path segment, then
  `default`; `new StoreClass(entry.config)`; the same error for a missing class.

## Contract

```ts
(globalThis as Record<symbol, unknown>)[Symbol.for('@_linked/core:importModule')] =
  (specifier: string) => Promise<unknown>; // resolves to the module namespace
```

- The specifier is passed unchanged, once per datasets entry, in entry order.
- The hook is read on every `importModule` call, not at module load, because `linked start` sets
  it after core may already be evaluated.
- A rejection from the hook rejects `loadStores`.
- Fallback when the value is unset or not a function: native `import(specifier)`.

## Decisions

1. **A `globalThis` symbol, not an option on `loadStores`.** The storage file calls
   `loadStores(config)`; the host that knows the right loader is the CLI, not the app. A
   registered `Symbol.for` key is shared across copies of core.
2. **Core does not choose between Vite and Node.** The hook owns that (the CLI sends a bundled
   package through `ssrLoadModule` and an external one through Node at the file Vite's SSR
   resolver returns; backlog 014 measured that sending every store through `ssrLoadModule` makes
   `instanceof FusekiStore` false).

## Files

- `src/utils/loadStores.ts`: `IMPORT_MODULE`, `importModule`, the call in the loop, JSDoc.
- `src/tests/load-stores-loader.test.ts`, `src/tests/fixtures/load-stores-fixture-store.mjs`.
- `README.md`: a "Host loader" paragraph under `loadStores`.
- `.changeset/load-stores-host-loader.md` (minor).

## Tests

`src/tests/load-stores-loader.test.ts` (6 tests): the hook is called once per entry with the
specifier unchanged and the named export, else `default`, is constructed with `entry.config`; the
named export wins over `default`; the missing-class error is kept; a rejecting hook rejects
`loadStores`; the hook is read per call; with the hook unset a fixture module loads through the
native `import()`. The hook is deleted after each test.

```
NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/load-stores-loader.test.ts
Tests:       6 passed, 6 total

npm test
[fuseki] live tests: 303 total — 303 passed, 0 failed, 0 skipped
Test Suites: 4 skipped, 102 passed, 102 of 106 total
Tests:       120 skipped, 2269 passed, 2389 total
```

The built `lib/esm/utils/loadStores.js` contains `Symbol.for('@_linked/core:importModule')` and
`const mod = yield importModule(entry.store);`.

## Follow-ups

- The CLI sets the hook in `linked start` (linked-fw/cli, plan 068 phase 4).
- The app template returns to `instanceof` once both halves are on npm (plan 068 phase 4).
