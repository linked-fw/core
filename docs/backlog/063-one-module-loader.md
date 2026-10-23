---
summary: >
  Framework code loads package modules through one loader, so a package Vite bundles is never
  loaded a second time by Node. Make core's loader public and documented, route
  registerInstalledOntologies (and every future module discovery) through it, forbid bare dynamic
  import() of package code, and test every install setup (all npm, all localized, mixed).
packages: [core, cli, server]
---

# 063 — One module loader for package code

Source: Peace Game's framework upgrade (the-game plan 006, Oct 2026).

## Why

Since apps run on Vite, the same mistake keeps coming back in a new place: framework code loads a
package's module with Node's `import()` while Vite's SSR runner bundles its own copy of that
package. Each case got its own fix — stores (cli reports 014–017), unbuilt workspace packages
(core 047, server 012) — and server 3.7.0 added a new one: its boot ontology registration calls
`registerInstalledOntologies`, which imports built `lib/esm/ontologies/*.register.js` natively.

In an app that installs core from npm (Node loads core, so its `import()` is Node's) this loads
`@_linked/server` a second time and prints 7 `[linked] TWO COPIES` warnings in Peace Game; it
also registers a workspace package's possibly stale `lib/` instead of its `src/`. CN does not
show it: every package is localized there, Vite bundles core, and Vite rewrites core's dynamic
imports. The work was measured only in that setup.

For ontology modules the second copy is cosmetic (they hold no classes). For anything holding
shapes — for example a future sync of installed packages' shapes, like the ontology sync — it is a
real split: a second shape registry and failing `instanceof`.

## What to do

1. **One public loader in core**, e.g. `importPackageModule(fileOrSpecifier)`, backed by the loader
   `linked start` already installs at `Symbol.for('@_linked/core:importModule')`. With no loader
   installed (production builds, plain Node, tests) it is native `import()`, as today.
   - The cli's loader takes file paths as well as specifiers: it maps a file to its package
     (the dual-copy guard's matcher), sends a package Vite bundles through `ssrLoadModule`, and
     maps a source package's `lib/esm/<path>.js` to `src/<path>.ts`.
   - `registerInstalledOntologies` uses it for built files too; `loadStores` and server's
     `nativeImport` move onto it.
2. **Document it** in `docs/architecture/` (a short "Loading package modules" page, linked from
   `ontologies.md` and `runtime-instances.md`): why the loader exists, when to use it (any
   framework code that discovers and imports modules of installed or workspace packages: stores,
   ontologies, shapes, providers), and that bare `import()` of package code is not allowed.
3. **Enforce it:** a unit test or lint rule in core, server and cli that fails on a new bare dynamic
   `import()` of package code outside the loader.
4. **Test every install setup:** the cli's template-app e2e runs the app with all packages from npm,
   all localized, and mixed (core from npm, one package localized); in each it boots, runs the
   ontology and shape sync and fails on any `TWO COPIES` line.
5. **Measure releases in an app that installs from npm** (the template app or Peace Game), not only
   in CN's localized setup.

Separately, `@_linked/translation` ships `src/` in its package (`"files": ["lib","src"]`), so the
cli treats the installed package as a source workspace and Vite compiles it from source next to
Node's `lib/`. It should ship `lib/` only, with its `development` export condition pointing at
`lib/` or removed (Peace Game plan 006 does this).

## Open questions

- Name and module of the public loader (`@_linked/core/utils/importPackageModule`?).
- Lint rule (eslint `no-restricted-syntax` on `ImportExpression`) or a source-scanning unit test?
- Does the source mapping need a package-declared map for packages whose `src/` does not mirror
  `lib/esm/`?
