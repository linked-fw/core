---
summary: >
  `src/tests/two-copies-built.test.ts` crashes with "Module cache already has entry …/lib/esm/shapes/SHACL.js.
  This is a bug in Jest" when it runs under Create Now's hoisted jest 29.7 (a localized core in
  `packages-local/`). Under core's own jest 30 it passes. The fix belongs in Create Now.
packages: [core]
---

# 060 — two-copies-built does not run under Create Now's jest 29.7

Source: CN plan 070, step K1 (report 042), which found it while recording its baseline.

## Problem

`two-copies-built.test.ts` (report 039) loads the built `lib/esm` twice in one process. In a
localized checkout inside Create Now (`packages-local/_linked-core`), the suite fails before any
test runs:

```
Error: Module cache already has entry /…/_linked-core/lib/esm/shapes/SHACL.js. This is a bug in Jest, please report it!
    at invariant (…/jest-util/build/invariant.js:16:11)
    at Runtime.loadEsmModule (…/jest-runtime/build/index.js:542:35)
```

## Cause

It is not jest 30. A checkout in `packages-local/` resolves `jest` from Create Now's root
`node_modules`, where npm hoists jest 29.7, and jest-runtime 29.7 has the module-cache race. Core
declares jest ^30, and in a standalone clone (core's own jest 30) the suite runs and passes, as it
does in core's CI.

## Fix

In Create Now: give the localized checkouts core's own jest (or raise CN's hoisted jest to 30), so
`npm test` in `packages-local/_linked-core` runs the jest core declares. That work is being done in
Create Now; this item closes when it lands.
