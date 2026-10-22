---
summary: >
  Four lows from the review of the ontology sync and the shape check, not fixed: a registered
  package that stops passing `loadData` keeps its synced triples; `hierarchy.ts`'s literal
  `import('n3')` reaches browser bundles through `checkShapeHierarchy`; `registerInstalled`
  passes a native path to `importModule`; `@types/n3` lags `n3`.
packages: [core]
---

# 062 — Ontology sync and shape check: review lows

Source: CN plan 070, independent review of `store-inference` (reports 042-047).

## 1. A registered package that stops passing `loadData` is never pruned

`readPackageOntologies` (`src/ontology/registryData.ts`) leaves out a package whose registrations
have no `load`, and `syncOntologies` prunes only packages that are no longer registered
(`orphanScope: 'all'`). A package that still registers its ontology but drops `loadData` keeps its
sync node and its triples in every dataset: neither a changed hash nor an orphan.

First questions: treat a registered package without data as listing nothing (diff its stored
lines against an empty set), or as an orphan under `orphanScope: 'all'` only? A test either way.

## 2. `import('n3')` reaches browser bundles through `checkShapeHierarchy`

`src/ontology/hierarchy.ts:45` imports `n3` with a literal specifier, so bundlers follow it.
`checkShapeHierarchy` imports `subClassClosure` from `hierarchy.js` statically, so a browser
bundle that pulls in the shape check also bundles `n3`.

First questions: move `subClassClosure` (pure) into a browser-safe module (`classHierarchy.ts`),
or hide the specifier (`/* @vite-ignore */` with a variable)? Measure a Vite build's chunk before
and after.

## 3. `registerInstalled` passes a native path to `importModule`

`registerInstalledOntologies` (`src/ontology/registerInstalled.ts:89-92`) hands
`path.join(ontologiesDir, file)` to `options.importModule`. On Windows that is `C:\…`, which
Vite's `ssrLoadModule` and other loaders may not resolve as a module id (the built path already
goes through `pathToFileURL`).

First questions: pass a normalized `/`-separated absolute path, or a file URL, and document which?
A test with a Windows-style path through `path.win32`.

## 4. `@types/n3` lags `n3`

`package.json` pins `n3` `^2.13.12` against `@types/n3` `^1.26.4`; `hierarchy.ts` declares its own
`N3Module` type and casts the import, so the types are not used there. Drop `@types/n3`, or
update it when a 2.x typing is published.
