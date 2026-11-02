---
summary: >
  `@_linked/core/ontology/registerInstalled` (server only): `registerInstalledOntologies(packageDirs)`
  imports each package directory's `lib/esm/ontologies/*.register.js` and returns the packages it
  registered, so the ontology sync and the shape check see the data of a package an app only
  deep-imports shape files from. CN plan 070, §Installed packages' ontologies.
packages: [core]
---

# 045 — Installed packages register their ontologies explicitly

## Why

A package registers its ontology data (`linkedOntology`) from `ontologies/<prefix>.register.js`,
which its index and `shapes/index` import. An app that deep-imports one shape file
(`@_linked/schema/shapes/Person`, as the app template and org do) never evaluates the register
module, so its boot synced none of schema's hierarchy and the shape check reported
`extends-without-subclass` for `Person`. Registration of installed packages is therefore explicit,
done by whoever syncs or checks (the server's boot and control route, the cli's build check).

## What

`src/ontology/registerInstalled.ts`, subpath `@_linked/core/ontology/registerInstalled` (not in
the index):

```ts
export function registerInstalledOntologies(packageDirs: string[]): Promise<string[]>;
```

- Imports `<dir>/lib/esm/ontologies/*.register.js` (the cli's build layout) of each directory, in
  the order given, by file name within a package, through a native `import()` of the file URL.
- Returns the `package.json` `name` (else the directory name) of each package whose register
  modules were imported.
- A directory that does not exist or has no register modules is skipped silently; one given twice,
  also through a symlink (compared by real path), is imported once.
- A register module that throws is reported in one `console.warn` naming the file; its package is
  left out of the result and the other directories still register.
- `node:fs/promises`, `node:path` and `node:url` are imported through variable specifiers, like
  `loadOntologyFiles`, so the emitted module has no static `node:` import.

Registration is keyed by package and prefix, so a package the app already imported registers again
without effect.

Tests: `src/tests/ontology-register-installed.test.ts` with fixture package roots in
`src/tests/fixtures/installed/` (their `lib/` is committed: `.gitignore` re-includes
`src/tests/fixtures/installed/*/lib/`): a package with a register module, one without, one whose
register module throws, and a deep-imported shape file whose package registers nothing until
`registerInstalledOntologies` runs, after which `readPackageOntologies` reads its
`Cat ⊑ Pet`. Docs: `docs/architecture/ontologies.md` §Installed packages register explicitly.

## Verification

Quick gate (the new suite plus ontology-registry, ontology-load-files, ontology-sync; then
typecheck):

```
Test Suites: 4 passed, 4 total
Tests:       27 passed, 27 total
… jest …  18.03s user 4.15s system 118% cpu 18.742 total
npm run typecheck  7.30s user 0.37s system 204% cpu 3.752 total   (clean)
```

Full gate (Fuseki: an own `linked-fuseki:dev` container, compose project `v2-core-test`, port
3183):

```
node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build
✔ Build successful            12.63s user 1.46s system 186% cpu 7.572 total

npm test
FAIL src/tests/two-copies-built.test.ts
[fuseki] live tests: 306 total — 306 passed, 0 failed, 0 skipped
Test Suites: 1 failed, 4 skipped, 120 passed, 121 of 125 total
Tests:       120 skipped, 2431 passed, 2551 total
npm test  140.90s user 70.25s system 166% cpu 2:07.03 total

npm run check:dts            4.31s user 0.30s system 86% cpu 5.338 total   (clean)
```

`two-copies-built` fails as on `main` ([backlog 060](../reports/092-two-copies-built-jest-module-cache.md)).

The end-to-end proof (the app template's boot syncing `@_linked/schema` and no
`extends-without-subclass` for `Person`) is in server report 011, which wires the call into the
boot and the control route.

## Notes for consumers

- Pass package roots (the directory holding `package.json`), not `lib/esm`.
- The import is Node's. Under Vite's SSR runner (`linked start`), a package the runner bundles is
  then evaluated a second time by Node; the registry entry it writes replaces the runner's (same
  package and prefix, same data files), and the cli's dual-copy guard may warn about it.
