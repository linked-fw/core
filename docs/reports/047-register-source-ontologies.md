---
summary: >
  `registerInstalledOntologies(packageDirs, {importModule})`: a package directory without built
  register modules but with `src/ontologies/*.register.ts` (a workspace package in dev, never
  built) registers through `importModule`, which the server sets to Vite's `ssrLoadModule`.
  Without it such a directory is skipped, as before. CN plan 070, §Installed packages' ontologies.
packages: [core]
---

# 047 — Source packages register their ontologies through a loader

## Why

`registerInstalledOntologies` (report 045) imports only `<dir>/lib/esm/ontologies/*.register.js`.
A Create Now clone's ontology package (`packages/<slug>-ont`) is a workspace package nothing
builds in dev and nothing imports, so it never registered and the app's ontology sync could not
write the hierarchy the ontology builder had just written into it (CN report 109, §Blocked).

## What

`src/ontology/registerInstalled.ts`:

```ts
export type RegisterInstalledOptions = {importModule?: (file: string) => Promise<unknown>};
export function registerInstalledOntologies(
  packageDirs: string[],
  options?: RegisterInstalledOptions,
): Promise<string[]>;
```

- A directory with built register modules is imported as before (Node's `import()`); the option
  is not used for it.
- A directory without them but with `src/ontologies/*.register.ts` is imported through
  `options.importModule`, called with each file's absolute path, by file name. Without the option
  it is skipped silently, as before.
- A loader that throws is warned about like a throwing register module: one warning naming the
  file, the package left out of the result.

Tests (`ontology-register-installed.test.ts`, +3): the source package is skipped without
`importModule`; with it, only the source package goes through the loader (the built one does
not), its prefix registers and `readPackageOntologies` reads its `Owl ⊑ Bird` from
`src/data/birds.ttl`; a loader that throws is warned about. Fixture
`src/tests/fixtures/installed/source-only/` (no `lib/`). Docs: `docs/architecture/ontologies.md`
§Installed packages register explicitly.

## Verification

Quick gate (the four ontology suites, then typecheck), own Fuseki (`linked-fuseki:dev`, compose
project `v3-core-test`, port 3189):

```
Test Suites: 4 passed, 4 total
Tests:       30 passed, 30 total
… jest …  23.16s user 2.83s system 160% cpu 16.235 total
```

Full gate, rebased on `store-inference` 8e3693c:

```
node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build
✔ Build successful            12.05s user 1.31s system 205% cpu 6.517 total

npm test
FAIL src/tests/two-copies-built.test.ts
[fuseki] live tests: 317 total — 317 passed, 0 failed, 0 skipped
Test Suites: 1 failed, 4 skipped, 122 passed, 123 of 127 total
Tests:       120 skipped, 2457 passed, 2577 total
npm test  124.58s user 28.05s system 349% cpu 43.688 total

npm run typecheck            6.84s user 0.28s system 231% cpu 3.069 total   (clean)
npm run check:dts            3.61s user 0.16s system 241% cpu 1.562 total   (clean)
```

`two-copies-built` fails as on `main` ([backlog 060](../backlog/060-two-copies-built-jest-module-cache.md)).

The end-to-end proof (a dev app with a source-only ontology package logging
`ontology sync: written … v3check-ont`) is in server report 012.
