---
summary: >
  Three lows from the review of the ontology sync and the shape check, not fixed: a registered
  package that stops passing `loadData` keeps its synced triples; `hierarchy.ts`'s literal
  `import('n3')` reaches browser bundles through `checkShapeHierarchy`; `@types/n3` lags `n3`.
packages: [core]
---

# 062 — Ontology sync and shape check: review lows

Source: CN plan 070, independent review of `store-inference` (reports 042-047). The fourth low
(`registerInstalled` passed a native path to `importModule`) is fixed: report 081.

## 1. A registered package that stops passing `loadData` is never pruned

`readPackageOntologies` (`src/ontology/registryData.ts`) leaves out a package whose registrations
have no `load`, and `syncOntologies` prunes only packages that are no longer registered
(`orphanScope: 'all'`). A package that still registers its ontology but drops `loadData` keeps its
sync node and its triples in every dataset: neither a changed hash nor an orphan.

First questions: treat a registered package without data as listing nothing (diff its stored
lines against an empty set), or as an orphan under `orphanScope: 'all'` only? A test either way.

## 2. `import('n3')` reaches browser bundles through `checkShapeHierarchy`

`src/ontology/hierarchy.ts:48` imports `n3` with a literal specifier, so bundlers follow it.
`checkShapeHierarchy` imports `subClassClosure` from `hierarchy.js` statically, so a browser
bundle that pulls in the shape check also bundles `n3`.

The `n3` import is already dynamic, so the effect is an emitted (lazy) `n3` chunk, not parser code
in the entry chunk. Moving `subClassClosure` alone does not remove the edge: `checkShapeHierarchy`
also reaches `hierarchy.js` through two dynamic imports (`loadOntologyHierarchy`,
`definedTermsFromTurtle`).

First questions: is a lazy chunk a problem at all (measure a Vite browser build that imports the
shape check)? If so: move `subClassClosure` (pure) into `classHierarchy.ts` and hide the `n3`
specifier (`/* @vite-ignore */` with a variable), or keep the shape check out of browser entry
points.

## 4. `@types/n3` lags `n3`

`package.json` pins `n3` `^2.13.12` against `@types/n3` `^1.26.4`; `hierarchy.ts` declares its own
`N3Module` type and casts the import, so the types are not used there. Drop `@types/n3`, or
update it when a 2.x typing is published.
