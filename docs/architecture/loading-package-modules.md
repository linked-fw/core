---
summary: Framework code that discovers and imports modules of installed or workspace packages loads them by specifier through the host's module loader (importPackageModule), never a bare import(), so a package Vite bundles in dev is not loaded a second time by Node. Why the loader exists, who installs it, how stores and ontology register modules use it, and what happens without one.
---

# Loading package modules

```ts
import {importPackageModule} from '@_linked/core/utils/importPackageModule'; // server only

await importPackageModule('@_linked/fuseki/shapes/FusekiStore'); // through the host loader
await importPackageModule('/app/node_modules/@acme/pets/lib/esm/x.js'); // always Node's import()
```

## Why there is a loader

In dev, `linked start` runs the app in Vite's SSR module runner, and the runner bundles some
packages itself (the app's workspace packages, localized ones, and whatever it does not
externalize). A native `import()` made by framework code that Node loaded, such as core installed
from npm, does not go through that runner: Node loads the package again from `node_modules`.
The app then holds two copies of it. For a package holding shapes or stores that is a real
split: a second shape registry, `instanceof` checks that fail, a store the app's code does not
recognise. The cli's dual-copy guard reports it as `[linked] TWO COPIES`.

So the host installs one loader, and framework code loads package modules through it.

## Who installs it

`linked start` sets a `ModuleLoader` (`(specifier: string) => Promise<unknown>`) on `globalThis`
under `MODULE_LOADER_KEY`, `Symbol.for('@_linked/core:importModule')` (cli reports 014–017). The
loader loads a package specifier the way the app's own import of it is loaded: a package Vite bundles goes
through its SSR runner, anything else through Node at the file Vite resolves. Core reads the key
on every call, so the host may install the loader after core was evaluated.

Nothing else needs to install it. A host that evaluates the app through another loader may set
its own under the same key; it is only ever handed package specifiers.

## How framework code uses it

`importPackageModule(target)` is the one way framework code loads a package module it discovered
at runtime. A package specifier goes through the installed loader when there is one, else Node's
`import()`. An absolute file path (or `file:` URL) is always Node's `import()`, loader or not: a
path skips the package resolution that keeps one copy per package, so framework code imports by
specifier wherever the package exports the module, and uses a path only where no loader can be
involved. `installedModuleLoader()` returns the installed loader (or undefined) for code that
loads differently with one.

- **Stores** (`loadStores`): each `store` specifier of a datasets file goes through
  `importPackageModule` unchanged.
- **Ontology register modules** (`registerInstalledOntologies`): with a loader installed, each
  register module of a package that the app resolves to the given directory is imported through
  it by specifier, `<name>/ontologies/<prefix>.register`, so it is the module the app's own import
  of it gets (Vite's `lib` or a workspace's `src`, never a file path next to it). A directory the
  app does not resolve the package to (a nested copy), and every call without a loader, imports
  the built files by path. See [Ontologies](./ontologies.md#installed-packages-register-explicitly).
- **Any future discovery** of shapes or providers follows `registerInstalledOntologies` (core
  #372) as the reference: find the files on disk, derive each module's package specifier, check
  that the app resolves the package to that directory and its `exports` allow the subpath, and
  load the specifier with `importPackageModule`.

**A bare dynamic `import()` of package code is not allowed** there; it works in production and in
tests, and splits the app in dev only. A bare `import()` is fine for Node's built-ins
(`node:fs/promises`), which have one copy anyway.

## Without a loader

In a production build, in plain Node and in tests no loader is installed, and
`importPackageModule` is Node's `import()`: an absolute path is imported by its `file:` URL,
anything else (a specifier, or a URL already) as given.

## Related

- [Runtime instances](./runtime-instances.md): why core must be one module instance per runtime.
- [Ontologies](./ontologies.md#installed-packages-register-explicitly): how installed packages
  register their ontologies.
