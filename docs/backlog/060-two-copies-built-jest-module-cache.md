---
summary: >
  `src/tests/two-copies-built.test.ts` fails to run on Node 22.23 with jest 30: every worker
  crashes with "Module cache already has entry …/lib/esm/shapes/SHACL.js. This is a bug in Jest",
  so its 39 tests never run. Seen on main and on the store-inference branch alike.
packages: [core]
---

# 060 — two-copies-built does not run (jest module cache)

Source: CN plan 070, step K1 (report 042), which found it while recording its baseline.

## Problem

`two-copies-built.test.ts` (report 039) loads the built `lib/esm` twice in one process. On the
current toolchain (Node v22.23.3, jest 30, `--experimental-vm-modules`) the suite fails before any
test runs:

```
Error: Module cache already has entry /…/_linked-core/lib/esm/shapes/SHACL.js. This is a bug in Jest, please report it!
    at invariant (…/jest-util/build/invariant.js:16:11)
    at Runtime.loadEsmModule (…/jest-runtime/build/index.js:542:35)
```

Reproduced in the main checkout at `main` (4afe035), so it predates the store-inference work.
`npm test` therefore exits non-zero on every branch while it stands.

## First questions

- Which change brought it: the Node minor, a jest-runtime patch, or an import added to the built
  graph that is now reached twice concurrently (two dynamic imports of the same module racing)?
- Can the suite load the second copy from a separate directory (a copy of `lib/esm`) instead of
  a cache-busting query, so jest sees two distinct module paths?
