---
summary: >
  A shape without `@linkedShape({name})` takes its IRI from `constructor.name`. The cli's Vite
  config keeps that name stable; other bundlers (webpack, Metro, a minifying esbuild or Terser
  build) can still rename the class, and nothing injects a `name` at build time.
packages: [core, cli]
---

# 032 — Stable shape URIs outside the cli's bundler

## What is already done

- **Explicit names.** `@linkedShape({name: 'Person'})` (`ShapeConfig.name`, `utils/Package.ts`)
  sets the name the IRI is built from; `constructor.name` is only the fallback. A fallback name
  ending in a digit (`Person2`, the mark of a renamed duplicate) warns once.
- **The cli's Vite build.** `optimizeDeps.exclude` keeps one copy of core, `keepNames` reaches the
  minifier, and the `pin-compiled-class-names` plugin pins the runtime name of every tsc-compiled
  decorated class before Vite's `vite:define` pass can rename it.
- **A build warning.** `linked build` (`checkShapeNames`) warns about every compiled shape that has
  no explicit `name` and whose module Vite would re-print.

## The remaining gap

1. **Bundlers other than the cli's Vite config.** A host that bundles with webpack, Metro, or an
   esbuild/Terser build that minifies class names gets none of the guards above. A shape without
   an explicit `name` then registers under its renamed class (`a`, `Person2`), and the client and
   the server disagree on its IRI (`Server.call` routes on it). The React Native template's Metro
   build is one such host.
2. **No injected names.** Nothing stamps `name` onto `@linkedShape` at compile time, so a shape is
   safe everywhere only if its author wrote the `name`. A transform in `linked build` that adds
   `name: '<ClassName>'` to every `@linkedShape` call that lacks one (before any bundler sees the
   code) would make the published `lib/` safe in every bundler.

## First questions

- Inject in `linked build` (one place, every consumer benefits) or in each bundler's plugin?
- Should a missing `name` become an error for published packages once injection exists?
