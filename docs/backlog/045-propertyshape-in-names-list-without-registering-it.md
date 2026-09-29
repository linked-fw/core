---
summary: >
  `PropertyShape.in` (sh:in) names its value shape by string — `['@_linked/core', 'List']` — so
  loading the SHACL metamodel does not register `List`. Only the core entry, `syncShapes`,
  `PathNode` and `serializePathToNodeData` load it, and core's `sideEffects` lets a bundler drop
  it even then. Any query or create that touches `in` throws "Shape class not found" wherever
  `List` was not loaded. Create Now's production client bundle is one such place today.
packages: [core]
---

# 045 — `PropertyShape.in` names `List` without registering it

## The declaration

`src/utils/Package.ts:775-781`:

```ts
// PropertyShape.in → an rdf:List (owned)
createPropertyShape(
  {path: shacl.in, shape: ['@_linked/core', 'List'], maxCount: 1, contains: true},
  'in',
  shacl.IRI,
  PropertyShape,
);
```

A by-name reference resolves to the IRI `https://linked.cm/shape/core/List` (`connectValueShape`
in `src/shapes/SHACL.ts:342-345`) and imports nothing. `List` gets registered only when
`src/shapes/List.ts` is evaluated. On `origin/main` the only modules that import it are:

- `src/index.ts:7`: `export {rdfList} from './shapes/List.js'`
- `src/shapes/syncShapes.ts:16`, `src/shapes/PathNode.ts:11`, `src/shapes/serializePathToNodeData.ts:9`

The string reference exists because of an import cycle. `Package.ts` cannot import `List`:

```
utils/Package.ts  ──(would import)──▶  shapes/List.ts
shapes/List.ts:6   import {linkedShape} from '../package.js';
package.ts:1       import {corePackage} from './utils/Package.js';   ◀── cycle
```

`List.ts` applies `@linkedShape` when the module is evaluated. If `Package.ts` were the module
mid-evaluation, `corePackage` would still be in its TDZ.

## Evidence

**1. Registration in Node, unbundled.** Each case below ran in a fresh `node` process against
the installed 2.22.9 `lib/esm`:

| Imported | `getShapeClass(.../core/List)` | Result |
|---|---|---|
| `shapes/SHACL.js` only | `undefined` | PropertyShape itself is unregistered, because its metamodel lives in `Package.ts` |
| `package.js` + `shapes/SHACL.js` | `undefined` | `PropertyShape.select(p => p.in)`, `select(['in'])` and `select(p => p.in.first)` all throw `Shape class not found for https://linked.cm/shape/core/List` |
| same, `create({in: …})` | `undefined` | `Cannot validate the value of 'in': its shape 'https://linked.cm/shape/core/List' is not registered.` |
| same, catalog-style `NodeShape.select(ns => [ns.properties.select(ps => [ps.path, ps.in])])` | `undefined` | throws the same error. Without `ps.in` it succeeds |
| `index.js` (the entry) | `List` | all of the above succeed |
| `package.js`, then `shapes/List.js` imported *after* the failure | `List` | the query now succeeds, because the lookup happens when the query is built |

`select(['name'])` and `selectAll()` succeed either way. Only a query or create that touches
`in` fails.

**2. The entry does not save you once a bundler is involved.** `package.json` `sideEffects`
covers `**/ontologies/*` and `**/utils/Package.*`, but not `shapes/*.js`. The test was a
Vite 7 production build (lib mode, not minified) of an entry that imports what a typical app
imports: `import {validate} from '@_linked/core'` plus the deep imports `utils/Package` and
`shapes/SHACL`. The result:

```
validate: function | getShapeClass(List): undefined
catalog-style select with ps.in THREW: Shape class not found for https://linked.cm/shape/core/List
```

The bundle contains no `List` class. **The control is the important part.** Adding an explicit
bare `import '@_linked/core/shapes/List'` gives the identical result. `List.js` is declared
side-effect-free, so a bare import is dropped too. `List` survives only when a kept module uses
the binding.

## Why it matters

- **Precedent.** Create Now's production server showed "No organizations found". schema's
  `Thing.image → ImageObject` was a by-name reference, nothing in the server bundle loaded
  `ImageObject`, and the query threw `Shape class not found`. A blanket `catch` turned that into
  an empty list. That was fixed per package in schema#39, sioc#29 and auth#51. This item is the
  remaining case in core.
- **Tooling.** The cli build step "Checking shape references", which is being written now, flags
  every by-name `shape: [pkg, name]` whose module does not register the named shape. This
  declaration will be flagged.
- **Create Now is affected today**, in the production client. See below.

## Create Now impact (measured 2026-09-29)

- **Who reads `in`.** CN's `src/utils/shapeCatalogQuery.ts` `fetchShapeCatalog()` selects `ps.in`
  inside `NodeShape.select(ns => [ns.properties.select(ps => [...])])`. It deep-imports
  `NodeShape` from `@_linked/core/shapes/SHACL`. The client calls it:
  `src/data/CnDataManagerHost.tsx` → `loadShapeCatalog` → `fetchShapeCatalog()`, which has no
  store and is forwarded to the backend.
- **Who loads the entry.** In CN's own source, the only runtime imports of the `@_linked/core`
  entry are `validate` (in `instanceReadiness.ts`, a document-studio file) and `syncShape` (in
  `ProjectProvider.ts`, on the server). Everything else, 63 files, deep-imports `shapes/SHACL`.
- **Production server: covered.** The release backend (`lib/`) keeps `@_linked/*` external, and
  `lib/backend/shapes/ProjectProvider.js:12` has `import { syncShape } from "@_linked/core"`.
  Node evaluates the whole entry, so `List` is registered.
- **Production client: not covered.** CN's client bundle is `public/bundles/assets`, 86 chunks,
  built 16:03, before that day's dependency bump.
  - The declaration is present: `linked-c7ca9e3b.js` contains
    `ue({path:v.in,shape:["@_linked/core","List"],maxCount:1,contains:!0},"in",…)`.
  - The query is present: `ProjectDataRouting-78ea8ad9.js` contains the catalog query
    `…a.description,a.in,a.pattern…`.
  - The `List` class is not: no chunk has an `objectProperty` on `rdf.rest`/`rdf.first`. The only
    `dependent:!0` shape is PropertyShape.
  - Consequence: the client's catalog query should throw
    `[fetchShapeCatalog] shape catalog query failed: Shape class not found for …/core/List`.
    The Vite repro above shows the same mechanism against current 2.22.9. This has not yet
    been confirmed in a browser.
- **Dev.** Modules are served unbundled, so `List` is registered once any module that imports
  the entry has been evaluated. Whether that has happened before the catalog loads depends on
  the route. This was not measured.

## Proposed fix

Register `List` from `Package.ts`, **by value**, the same way `NodeShape` and `PropertyShape`
already are (`Package.ts:578-591`). This is the `.class.ts` split used in schema#39:

1. `src/shapes/List.class.ts` holds the undecorated-for-package `List` class: `first`/`rest` via
   `linkedProperty`/`objectProperty`, which come from `SHACL.ts` and do not import `package.js`.
   It must not import `package.js`.
2. `Package.ts` imports it and registers it after `corePackage` exists:
   `corePackage.linkedShape({name: 'List', dependent: true})(List)`. The explicit `name` keeps
   the IRI stable when a minifier renames the class. Then change `in` to `shape: List`. The
   binding is now used, so no bundler can drop it, and `Package.ts` is already in `sideEffects`.
3. `src/shapes/List.ts` stays the public module. It re-exports `List` and keeps `rdfList`, and it
   imports `../package.js` so that importing it alone still registers the class.

Alternatives considered:

- **Add `**/shapes/List.js` to `sideEffects`.** This keeps the entry's re-export alive, but only
  for consumers who load the entry. It does nothing for deep importers, and the string reference
  stays for the cli check to flag.
- **Import `List` for side effects only in `Package.ts`.** This is the cycle above. Even without
  the cycle, the control shows a bundler drops a bare import of a side-effect-free module.
- **Make the lookup lazy, resolving the by-name shape by dynamic import on a miss.** This is
  a general answer for by-name references, but it is much larger and changes lookups from
  synchronous to asynchronous.

## Open questions

- Should `List` first get its own entry in `sideEffects` as a stopgap patch release, before the
  split lands?
- Are there other by-name `shape: [pkg, name]` references in core? The scan found only this one.
  The cli check will confirm.
- CN: confirm the symptom in a browser against a `NODE_ENV=production` build (the shape catalog
  or data table fails to load). Also decide whether CN should register `List` in
  `src/shapes/register.ts` until core ships the fix, like the stopgap used for `ImageObject` in
  b6271647. Copying that stopgap exactly will not work. b6271647 used a bare import, and the
  control above shows core's `List.js` is dropped from a bare import. The stopgap must use the
  binding in a way the bundler keeps.
