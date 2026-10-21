---
summary: >
  Core's sub-plan for CN plan 070 (the store infers; ontology data in every app dataset): K1
  (Turtle ontology data, the hierarchy reader, the ontology registry and sync with the built-in
  OntologySync shape, the shape check with `mirrors` and `sharedTargetClass`, tighten-only
  warnings, the SHACL metamodel's missing standard terms and PropertyGroup, the test store on the
  inferring image), then K2 (validate by class) and K3 (the no-inference workarounds go, major).
status: Plan
packages: [core]
---

# 003 — Store inference: ontology sync and the shape check

Sub-plan of CN plan 070,
`create-now/docs/plans/070-store-inference-and-ontology-data.md` (the **master plan**; locally
`~/web/wt/070/docs/plans/070-store-inference-and-ontology-data.md`). Its §Decisions are the
design; this document does not redesign them. Read the master's §Decisions, §How to use, §Rules
and this sub-plan; the contracts core provides or consumes are repeated below verbatim.

Integration branch: `store-inference` (this repository's worktree
`~/web/wt/070/packages-local/_linked-core`). A step works in
`~/web/wt/070-<step>/packages-local/_linked-core` on `store-inference--<step>` and lands with
`git -C ~/web/wt/070/packages-local/_linked-core merge --ff-only store-inference--<step>`, then
a rebuild there with the integration CLI
(`node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build`, master §Rules). No PR per step; one release PR at the end (master step R).

Records: K1 → report 042, K2 → report 043, K3 → report 044 (`docs/reports/`).

## Contracts

Repeated verbatim from the master plan §Contracts as of this writing. The master is the
authority; a step that changes a contract updates both copies in its landing. Contracts core
neither provides nor consumes (`@_linked/fuseki`, control route, bulk access, CLI build check,
graph rule) are in the master only.

### The image (provider F1; consumers C1, W1, W2, T1, K1's test store, L1's e2e)

- `ghcr.io/linked-fw/fuseki:<jena>-<n>` (first: `6.2.0-1`), `FROM secoresearch/fuseki:6.2.0`;
  until the release, built locally from `linked-fw/fuseki`'s `server/Dockerfile` (compose
  `build:` pointing at `~/web/wt/070/packages-local/_linked-fuseki/server`, tag
  `linked-fuseki:dev`). Same env as the base image (`ADMIN_PASSWORD`, `ENABLE_DATA_WRITE`,
  `ENABLE_UPDATE`, `ENABLE_SHACL`, `QUERY_TIMEOUT`), `FUSEKI_BASE=/fuseki-base`, uid 9008.
- Dataset type `lf:DatasetRDFSLive` (`PREFIX lf: <https://linked.cm/ont/fuseki#>`), declared in an
  assembler as:
  ```turtle
  :ds a lf:DatasetRDFSLive ; ja:dataset :tdb .
  :tdb a tdb2:DatasetTDB2 ; tdb2:location "/fuseki-base/databases/<name>" .
  ```
  It infers over every graph; its hierarchy is the closure of the stored `rdfs:subClassOf`
  triples in the default graph. A commit that adds or removes one marks the hierarchy stale and
  bumps a generation counter; the first transaction to begin afterwards rebuilds it once (other
  starting readers wait), and each transaction keeps the hierarchy it began with. A burst of sync
  commits costs one rebuild; a writer sees its own `subClassOf` change from its next transaction.
- The image keeps the base image's `ds` dataset and its `shacl` endpoint under
  `ENABLE_SHACL=true`, as `lf:DatasetRDFSLive` over TDB2 at `/fuseki-base/databases/ds` (the base
  image's `ds` is TDB1 with a union default graph; its Lucene index and `ENABLE_*` handling are
  kept). Core's SHACL tests validate through it.
- The module rewrites `$FUSEKI_BASE/templates/config-tdb2` at start when it is missing or
  different, with a warning (Fuseki copies its stock template only when the file is missing, so a
  persisted volume would otherwise create plain datasets silently).
- `templates/config-tdb2` (baked in) declares the service with the endpoints CN uses today
  (`""`/`sparql`/`query`, `""`/`update`, `""`/`data` GSP read-write, `upload`, `get`) over
  `lf:DatasetRDFSLive`, plus `stored` and `shacl` (store validation, decision 23). A form-created dataset (`POST $/datasets`,
  `dbName`, `dbType=tdb2`) gets it. **Only `dbType=tdb2` datasets infer**; `mem` (`config-mem`)
  stays plain.
- `/<ds>/stored`: one module operation (`lf:stored`) over the stored triples only (every graph),
  run by TDB2's own query engine: a SPARQL query or a GSP read, chosen from the request; writes
  answer 405.
- **Backups and copies stream `GET /<ds>/stored` as N-Quads.** `POST $/backup` and `GET /<ds>`
  dump the service's dataset, inferred triples included, so they are never used for these
  datasets.
- `DELETE $/datasets/<ds>` removes the TDB2 files too (a module filter finishes what Fuseki skips
  for a wrapped dataset); a re-created name starts empty.
- `arq:httpServiceAllowed=false` set by the module for every dataset.
- *pending F1:* whether `text:TextDataset` (pg-test) works over `lf:DatasetRDFSLive`.

### Ontology data files and loader (provider K1 + L1; consumers N1, N2, P1, C2, C3, T1, every package)

- A package's ontology data is Turtle, `src/data/<file>.ttl`, the whole vocabulary (labels,
  comments and the rest stay in the file; the sync keeps only the hierarchy). One file per former
  JSON file, same base name.
  ```ts
  // @_linked/core/ontology/loadOntologyFiles  (server only; imports node:fs/promises dynamically)
  export function loadOntologyFiles(moduleUrl: string, files: string[]): Promise<string[]>;
  // a package's src/ontologies/schema.ts
  export const loadData = () => loadOntologyFiles(import.meta.url, ['../data/schema.ttl', '../data/schema-added.ttl']);
  // src/ontologies/schema.register.ts
  linkedOntology(terms, ns, 'schema', loadData, ['../data/schema.ttl', '../data/schema-added.ttl']);
  ```
  A package without data passes no `loadData`. A `loadData` that resolves to anything but strings
  (an unconverted JSON package) is skipped with one warning naming the package.
- `npx linked build` copies `src/**/*.ttl` into `lib/esm/`, keeping `src`'s layout. A release
  app build keeps every `@_linked/*` package external (it fails if one is compiled in), so their
  data is read from the installed package; `build-app` copies the app's own `src/**/*.ttl` into
  `lib/` the way it copies CSS. L1 verifies (its checks M1-M5, incl. `import.meta.url` under dev
  SSR).

### Hierarchy reader (provider K1; consumers K1's sync, the shape check)

```ts
// @_linked/core/ontology/hierarchy   (server only; depends on `n3`)
export const RDFS_SUBCLASSOF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
export interface HierarchyTriple { s: string; o: string }     // s rdfs:subClassOf o, IRIs only
export function hierarchyFromTurtle(texts: string[]): Promise<HierarchyTriple[]>;  // deduped, sorted
export function subClassClosure(triples: HierarchyTriple[]): Map<string, Set<string>>; // class → all superclasses
export function definedTermsFromTurtle(texts: string[]): Promise<Set<string>>;     // every IRI subject in the data (mirror check)
// hierarchyFromTurtle(texts, sources?: string[]) — sources name the files for parse errors
```
Streams with N3.js; keeps `rdfs:subClassOf` between IRIs; drops everything else. A parse error
names the package and file and fails that package only. The registry entry carries the package's
data `files`.

### Ontology sync (provider K1; consumers V1, C2, C3)

- Registry: every `linkedOntology(...)` registers `{packageName, prefix, ns, load}`;
  `getRegisteredOntologies()`; the sync groups by package (dcmi registers three, rdfs two).
- `syncOntologies(ds?: IDataset, options?: {force?: boolean; packages?: string[]; orphanScope?: 'none' | 'all'}):
  Promise<{written: string[]; skipped: string[]; pruned: string[]}>`.
- Per package a sync node `https://linked.cm/ont/core/ontologySync/<encodeURIComponent(packageName)>`
  of the built-in shape `OntologySync` (`rdf:type core:OntologySync`): `core:packageName`,
  `core:ontologyHash`, `core:ontologyTriples` (the kept triples as sorted N-Triples lines).
  `OntologySync` and `PropertyGroup` join `BUILT_IN_NAMES` (`src/utils/ShapeCatalog.ts:49-54`; 8
  built-ins; core's test and CN's `projectShapeCatalogs.test.ts:148-153` assert the count, and
  K1's landing updates CN's test). `PropertyShape.group` becomes a `PropertyGroup` IRI (a literal
  today, `Package.ts:882`; no shape sets it).
- Hash `sha256Hex('linked-ontology-sync/1\n' + ontologyTriples)`.
- Algorithm: read every sync node's hash; per changed package (or `force`), one Linked Queries
  update per subject class whose superclass set changed (`subClassOf: {add, remove}`; a Linked
  Queries update has one subject), through a core-internal shape with no targetClass, removing
  only triples no other package lists, then the sync node's upsert last; the store's view
  rebuilds once on the next read. The N-Triples lines are joined with `\n`, no trailing newline;
  unchanged → no write (an unforked branch stays unforked). Orphans pruned only under
  `orphanScope: 'all'`. All through Linked Queries, default graph.
- Runs before shape sync, at boot and in the control route.

### Shape check (provider K1; consumers V1, L2, C3, every package)

```ts
// @_linked/core/shapes/checkShapeHierarchy
export type ShapeCheckKind =
  | 'extends-without-subclass'   // decision 13, direction II
  | 'subclass-without-extends'   // decision 13, direction I (in scope; out of scope → severity 'warning')
  | 'borrowed-target-class'      // decision 15
  | 'mirror-undefined-term'      // decision 16
  | 'override-not-tightened';    // decision 14: a narrower class/value shape (needs the hierarchy) and every data-only shape
export interface ShapeCheckFinding { kind: ShapeCheckKind; severity: 'error' | 'warning'; shape?: string; iri?: string; message: string }
export function checkShapeHierarchy(options?: {
  hierarchy?: HierarchyTriple[];
  dependencies?: Record<string, string[]>;   // package → its dependencies, from package.json (L2, V1);
}): Promise<ShapeCheckFinding[]>;            // without it, direction I's scope is the shape's own package
```
Reads registered shapes, registered ontologies (parsed through the reader unless `hierarchy` is
given) and `linkedPackage(..., {mirrors})`. `@linkedShape({sharedTargetClass: true})` exempts a
shape from `borrowed-target-class`; shape sync stores it as `core:sharedTargetClass` so data-only
shapes keep it. Boot and sync log findings; `npx linked build` fails on any
`error` (L2); CN's builder refuses or offers the fix (C3).

### Tighten-only (provider K1 warns, K3 refuses; consumers every package, C3)

The override check of decision 14. At `registerPropertyShape` K1 reports the new cases
(datatype, class/value shape, `contains`, path) as warnings; a narrower `sh:class` needs the
hierarchy, so it is the shape check's `override-not-tightened`, which also carries every case for
data-only shapes (they register at runtime from store data and never throw). An override that
leaves out `datatype`, `class`, value shape or `contains` inherits it, as `minCount`, `maxCount`
and `nodeKind` already do (`SHACL.ts:403-412`); report 042 lists the overrides whose generated
SHACL changes. K3 makes the decorator cases errors; data-only shapes stay findings.

### Validate by class (provider K2; consumers apps, CN)

```ts
// @_linked/core/shapes/validation
export function validateByClass(data: unknown, options?: ValidateOptions & {types?: string[]}): ValidationReport;
```
Validates against every registered shape whose targetClass is one of the node's types (from
`types`, else the data's `rdf:type`/`type` values) or a superclass of one (in-memory closure).
Without known types it validates nothing and says so in the report.

### Contract clarifications this sub-plan proposed (adopted in the master plan)

These came out of reading the code. All eleven are **adopted in the master plan** (its
§Contracts, copied above); the reasoning is kept here.

1. **The sync cannot write a package's diff in one Linked Queries update.** An IR `update` has one
   subject (`IntermediateRepresentation.ts:303`, `irToAlgebra.ts:2348`); a package's diff spans
   many subject classes (schema: ~800). Proposed text: *"per changed package, one `update` per
   subject class whose superclass set changed (`subClassOf: {add, remove}`), bounded concurrency
   (8), then the sync node's upsert last, so an interrupted sync leaves the old hash and the next
   sync redoes the package."* Cost: one store commit per changed subject (the master's lazy
   rebuild makes a burst of them one view rebuild); measured in report 042 against F1's rebuild time. If that is too slow, the follow-up
   is a multi-subject mutation in core (backlog item), not raw SPARQL.
2. **The direction-I scope needs package dependencies, which core does not know.** Proposed
   signature: `checkShapeHierarchy(options?: {hierarchy?: HierarchyTriple[]; dependencies?:
   Record<string, string[]>})` — package name → the names of its direct `dependencies` and
   `peerDependencies`; core takes the transitive closure. Without the map only sA's own package is
   in scope. L2 and V1 read it from `package.json` files.
3. **`mirror-undefined-term` needs the terms a package's data defines**, which the hierarchy
   reader drops. Proposed addition to §Hierarchy reader: `definedTermsFromTurtle(texts: string[]):
   Promise<Set<string>>` (every IRI subject in the data). `options.hierarchy` replaces only the
   hierarchy; the mirror check always reads the mirror packages' data.
4. **Parse errors cannot name the file from `texts` alone.** Proposed: the registry entry is
   `{packageName, prefix, ns, load, files}` (`files` = the `dataSource` list) and
   `hierarchyFromTurtle(texts: string[], sources?: string[])`; the caller catches per package.
5. **`sharedTargetClass` must survive the round trip** for data-only shapes (CN's builder, C3):
   `NodeShapeData.sharedTargetClass?: boolean`, persisted as `core:sharedTargetClass`
   (`xsd:boolean`) on the NodeShape, carried by the wire form automatically
   (`nodeShapeWire.ts:43-46`).
6. **A narrower `sh:class` cannot be decided at `registerPropertyShape`**: it needs the hierarchy,
   which is server-only and async. Proposed: `registerPropertyShape` warns on a differing `class`
   only when the two IRIs differ and the hierarchy is unknown *at check time*, i.e. it defers
   them; `checkShapeHierarchy` re-checks every override's `class` against the closure and reports
   a fifth kind, `'override-not-tightened'` (severity `warning` in K1, `error` from K3). The same
   kind carries every tighten-only case of data-only shapes, so the shape check sees them too.
7. **Data-only shapes get warnings for all seven cases, the existing three included**, in K1:
   `registerRuntimeShape` runs on data read from a store at runtime (CN's catalogs), and throwing
   there stops a running app (decision 13's rule: a running app is never stopped by data). K3
   decides whether a data-only override is refused (not registered) or still warned.
8. **The image's SHACL dataset.** K1's SHACL test validates through the base image's `ds`
   (`fuseki-test-store.ts:290-298`). Proposed addition to §The image: *"the image keeps the base
   image's `ds` dataset and its `shacl` endpoint under `ENABLE_SHACL=true`, as
   `lf:DatasetRDFSLive`"*.
9. **`dbType=mem` datasets do not infer** (the master's coordinator confirmed: only the
   `config-tdb2` template infers; `config-mem` stays plain). Core's test store creates `mem`
   datasets today (`fuseki-test-store.ts:168-182`, body at `:175`). K1 switches it to
   `dbType=tdb2` and adds the cleanup described under K1 §Architecture (Test store).
10. **Hash input format:** `ontologyTriples` is the sorted N-Triples lines (`<s> <p> <o> .`) joined
    with `\n`, no trailing newline; the empty package hashes the empty string.
11. **PropertyShape `group` becomes an IRI** (`sh:group` → a `PropertyGroup` node, as SHACL
    defines it) with value shape `PropertyGroup`; today it is a literal
    (`Package.ts:882`, `nodeShapeData.ts:29`). No shape in the framework or CN sets `group`
    (searched), so nothing stored changes.

---

## K1 — ontology data, sync and the shape check

### Depends on

- Nothing for phases 1–4 (pure code, unit tests with the in-memory capture store).
- **Phase 5 (the store phase) waits for F1's landing** on `linked-fw/fuseki`'s
  `store-inference`: the image built locally as `linked-fuseki:dev` from
  `~/web/wt/070/packages-local/_linked-fuseki/server`
  (`docker build -t linked-fuseki:dev ~/web/wt/070/packages-local/_linked-fuseki/server`), and
  the master's settled *pending F1* items (the one stored endpoint, `DELETE $/datasets` removing
  TDB2 files, the `ds` SHACL dataset).

### Goal

Packages ship their ontology data as Turtle, core parses the class hierarchy from it, syncs each
package's `rdfs:subClassOf` into an app dataset by content hash, and one function checks that shape
`extends` and the class hierarchy agree. Core's own tests run on the inferring image. Nothing core
queries changes yet (the workarounds go in K3).

### Scope

1. **Dependency:** `n3` `^2.13.12` in `dependencies` (the version `@_linked/auth` already pulls
   into CN's tree), `@types/n3` `^1.26.4` in `devDependencies`.
2. **New server-only subpaths** (files under `src/ontology/`, a new folder; `src/ontologies/` stays
   the vocabularies), none re-exported from `src/index.ts`:
   - `@_linked/core/ontology/hierarchy` — `RDFS_SUBCLASSOF`, `HierarchyTriple`,
     `hierarchyFromTurtle`, `subClassClosure`, and (clarification 3) `definedTermsFromTurtle`.
     `n3` is imported **dynamically inside** the parse functions (`await import('n3')`), so the
     module has no static `n3` import; `subClassClosure` is pure.
   - `@_linked/core/ontology/loadOntologyFiles` — `loadOntologyFiles(moduleUrl, files)`: resolves
     each file with `new URL(file, moduleUrl)`, reads it with `node:fs/promises` imported
     dynamically through a variable specifier with `/* @vite-ignore */ /* webpackIgnore: true */`
     (as `loadStores.ts:24-29` keeps `import(variable)` out of bundles), and rejects naming the
     file when one is missing. Packages import it statically from browser-reachable ontology
     modules, so the module itself must be browser-safe to import.
   - `@_linked/core/ontology/syncOntologies` — `syncOntologies` (§Ontology sync).
   - `@_linked/core/shapes/checkShapeHierarchy` — `checkShapeHierarchy`, `ShapeCheckKind`,
     `ShapeCheckFinding` (§Shape check). Imports the reader's parse functions dynamically, so a
     caller passing `hierarchy` (CN's builder) never loads `n3`.
   The `./*` export (`package.json` `exports["./*"]`) already serves these paths from
   `lib/esm/<path>.js`; no `exports` change. `sideEffects` needs no entry (`ontology/` modules
   have none; `shapes/OntologySync` is covered by `**/shapes/*.js`).
3. **The ontology registry** (`Package.ts`):
   - `linkedOntology(exports, ns, prefix, loadData?, dataSource?)` records
     `{packageName, prefix, ns, load, files}` (clarification 4) in a new shared-state field
     (`packageState`, `Package.ts:41-50`) keyed by `packageName + prefix`, so two copies of core
     and Vite's double evaluation register once. `getRegisteredOntologies()` exported from
     `Package.ts`. The `ontologies` Set (`Package.ts:51`) and the `_ns/_prefix/_load/_data` keys
     on the export copy stay (other code may read them).
   - `loadData` optional; `dataSource` a string or list (already typed so, `Package.ts:190`).
   - `autoLoadOntologyData(value)` (`Package.ts:247-262`) becomes a documented no-op (JSDoc:
     ontology data is synced into the store by `syncOntologies`; removed in the next major), and
     the auto-load branch in `linkedOntology` (`Package.ts:500-510`) goes.
   - The stale JSDoc (`Package.ts:146-191`, the `lincd-jsonld` example at `:153-183`) is rewritten
     to the Turtle pattern of §Ontology data files, with the sibling `.register.ts` module.
   - `linkedPackage(packageName, options?: {baseUri?: string; mirrors?: string | string[]})`
     (`Package.ts:265-268`): `mirrors` stored per package in shared state; read by the shape
     check through `getPackageMirrors()` (internal export).
4. **`@linkedShape({sharedTargetClass: true})`**: `ShapeConfig.sharedTargetClass?: boolean`
   (`Package.ts:60-93`), copied to `nodeShape.sharedTargetClass` in `applyLinkedShape`
   (`Package.ts:384-401`); metamodel property `core:sharedTargetClass` on `NodeShape`;
   `buildNodeShapeData` writes it when true (`syncShapes.ts:84-106`). Declared by `PathList`
   (`PathList.ts:26`, it shares `rdf:List` with `List`) and the `UP extends PP` fixture
   (`owned-walk-recursion.test.ts:142-145`).
5. **The shape check** (algorithm below), its four kinds plus clarification 6's
   `'override-not-tightened'`.
6. **Tighten-only warnings** (algorithm below) at `registerPropertyShape` (`SHACL.ts:387-418`,
   `validateOverrideTightening` `:458-499`) and in `registerRuntimeShape`
   (`registerRuntimeShape.ts:43-56`).
7. **The SHACL metamodel's missing standard terms** (master §Owner answers 2): `NodeShape` gains
   `sh:name`, `sh:targetSubjectsOf`, `sh:deactivated`, `sh:message`, `sh:severity`, `sh:and`,
   `sh:not`, `sh:xone` (its description stays `rdfs:comment`); `PropertyShape` gains `sh:flags`,
   `sh:languageIn`, `sh:uniqueLang`, `sh:qualifiedMinCount`, `sh:deactivated`, `sh:message`,
   `sh:severity`, nested `sh:property`; a new built-in shape `PropertyGroup` (`sh:PropertyGroup`:
   `rdfs:label`, `rdfs:comment`, `sh:order`); `PropertyShape.group` an IRI to it
   (clarification 11).
8. **`OntologySync`** built-in shape and **`syncOntologies`**.
9. **Built-ins:** `BUILT_IN_NAMES` (`ShapeCatalog.ts:49`) gains `OntologySync` and `PropertyGroup`
   (six → eight).
10. **Test store on the image**: `src/tests/docker-compose.test.yml` and
    `src/test-helpers/fuseki-test-store.ts`; datasets through the admin form with `dbType=tdb2`;
    an inference probe in global setup.
11. **Docs:** `docs/architecture/ontologies.md` (Turtle data, the loader, the registry, the sync,
    the reader, `mirrors`), `docs/architecture/owned-values.md` (`sharedTargetClass` names the
    profile case of `:66-67`; the inherited-plain-`contains` case of `:71-72` now warns),
    README's ontology section if it shows JSON data; report 042; changeset.

Out of scope: removing `autoLoadOntologyData`, tighten-only errors, the workarounds (K3);
`validateByClass` (K2); the cli copying `.ttl` and the build check (L1, L2); converting any
package's data (N1, N2, P1); the server boot and control route (V1).

### Verify

Run in `~/web/wt/070-K1/packages-local/_linked-core` (the step's worktree).

**Build** (master §Rules): once L1 has landed and the cli is built in
`~/web/wt/070/packages-local/_linked-cli`, build with the integration CLI,
`node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build` (in the layout `npx linked`
runs the main checkout's CLI). Before L1 lands, `npx linked build` is acceptable for phases 1–4
(core ships no Turtle of its own); the full gate and the landing rebuild use the integration CLI.

```bash
node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build   # see Build below; lib/esm/ontology/*.js present
npm test                                           # jest (unit + live) + typecheck
REQUIRE_FUSEKI=1 LINKED_FUSEKI_IMAGE=linked-fuseki:dev npm run test:fuseki
npm run check:dts
# n3 stays out of the browser entry: only the reader imports it, and dynamically
grep -rln "n3'" lib/esm --include='*.js'           # expect: lib/esm/ontology/hierarchy.js only
grep -n "^import.*n3" lib/esm/ontology/hierarchy.js # expect: nothing (dynamic import only)
grep -rn "ontology/" lib/esm/index.js              # expect: nothing
# against the image: the probe dataset infers
curl -s -u admin:admin -d 'dbName=k1-probe&dbType=tdb2' http://localhost:3939/\$/datasets
```

Plus one measurement for report 042: the first `syncOntologies` of a dataset with schema.org's
hierarchy (the 952 `rdfs:subClassOf` of `schema.ttl`, written as a fixture package in a test) on
the image — wall time, requests, and the second (skipped) sync's time.

### Done when

- §Contracts' K1 items exist under their export paths with those signatures (plus the
  clarifications the master settled).
- `npm test` and `npm run test:fuseki` green on the image (`linked-fuseki:dev`), every `[fuseki]`
  test run (none skipped), counts recorded; the owned-walk, owned-link-check and single-owner
  suites unchanged and green on the inferring store.
- Report 042 written; a `minor` changeset added; `ontologies.md` and `owned-values.md` updated.
- Landed by fast-forward on `store-inference`, rebuilt there with the integration CLI, branch
  pushed.

### Files

Found in the code at `store-inference` (6adec19). Line numbers drift; search for the symbol.

| File | What changes |
|---|---|
| `package.json` | `n3` dependency, `@types/n3` devDependency. `exports["./*"]` (`:44-47`) already serves the new subpaths; `sideEffects` (`:14-28`) unchanged |
| `src/ontology/hierarchy.ts` (new) | the reader |
| `src/ontology/loadOntologyFiles.ts` (new) | the loader |
| `src/ontology/syncOntologies.ts` (new) | the sync |
| `src/shapes/OntologySync.ts` (new) | the built-in shape, `@linkedShape({name: 'OntologySync'})` from `../package.js`, like `PathNode.ts:30-32` |
| `src/shapes/PropertyGroup.class.ts` (new) | the class only, never importing `package.js` (as `List.class.ts:18-25`); registered in `Package.ts` next to `List` (`:626-629`), because `PropertyShape.group` names it as value shape (backlog 045's reason) |
| `src/shapes/checkShapeHierarchy.ts` (new) | the shape check |
| `src/utils/Package.ts` | `ShapeConfig` (`:60-93`) `sharedTargetClass`; `linkedOntology` JSDoc (`:146-191`); `autoLoadOntologyData` (`:247-262`) no-op; `linkedPackage` options (`:265-268`) `mirrors`; `applyLinkedShape` (`:329-442`, options block `:384-401`, `extends` at `:409-415`, targetClass `:438-441`); `linkedOntology` (`:474-512`, auto-load branch `:500-510`) registry; metamodel: `List` registration `:626-629`, NodeShape properties (`description` `:674-677`, `targetObjectsOf` ~`:932`, `class` `:978-983`, `orShapes` `:984-990`), `isExtending` `:701-704`, PropertyShape `name`/`description` `:783-801`, `group` `:882`, `qualifiedValueShape`/`qualifiedMaxCount` `:966-977` |
| `src/ontologies/shacl.ts` | terms missing today: `flags`, `deactivated`, `severity`, `qualifiedMinCount`, `targetSubjectsOf`, `and`, `not`, `xone`, `PropertyGroup` (present: `name` `:24`, `order` `:48`, `group` `:49`, `languageIn` `:66`, `uniqueLang` `:76`, `message` `:86`) |
| `src/ontologies/linked-core.ts` | terms `OntologySync`, `packageName`, `ontologyHash`, `ontologyTriples`, `sharedTargetClass` (next to `shapeHash` `:62`, export object `:64-80`) |
| `src/shapes/nodeShapeData.ts` | `PropertyShapeData` (`:18-61`) and `NodeShapeData` (`:66-82`) gain the new fields; `getPropertyShapes`/`getUniquePropertyShapes` (`:164-235`) used by the checks |
| `src/shapes/SHACL.ts` | `NodeShape` (`:334-336`), `PropertyShape` (`:345-347`); property config (`group` `:283`, `:604`); `RESERVED_PROPERTY_LABELS` (`:385`); `registerPropertyShape` (`:387-418`); `validateOverrideTightening` (`:458-499`); `createPropertyShape` (`:501-620`, `connectValueShape` call `:615`) |
| `src/shapes/registerRuntimeShape.ts` | the data-only override check (`:43-56`) |
| `src/shapes/syncShapes.ts` | `buildPropertyShapeData` (`:34-80`) and `buildNodeShapeData` (`:84-106`) write the new fields when set; comments naming "six built-ins" (`:24`, `:295`, `:342-345`) |
| `src/utils/ShapeCatalog.ts` | `BUILT_IN_NAMES` (`:49`), the side-effect import (`:30-31`) gains `OntologySync`; doc comments "six" (`:52`) |
| `src/utils/ShapeClass.ts` | read only: `getShapesForTargetClass` (`:720-736`), `leastSpecific` (`:677-691`), `targetClassIdWithin` (`:625-651`), `getSuperShapes` (`:506`), `isSubShapeOf` (`:575-579`); maybe an exported `getTargetClassRoots()` view of `targetClassIndex` (`:693-706`) for the check |
| `src/shapes/PathList.ts` | `@linkedShape({name: 'PathList', sharedTargetClass: true})` (`:26`) |
| `src/tests/shape-catalog.test.ts` | `toHaveLength(6)` → 8 (`:136`), `catalog.size` 7 → 9 (`:139`), the test name (`:134`) |
| `src/tests/shacl-syncshapes.test.ts`, `src/tests/shape-sync-hash.test.ts` | built-in lists (`:93-97`, `:168`, `:205`; `:62-63`) follow `builtInShapeIris()`; comments "six" |
| `src/tests/owned-walk-recursion.test.ts` | `UP` (`:142-145`) declares `sharedTargetClass` |
| `src/tests/docker-compose.test.yml` | image `${LINKED_FUSEKI_IMAGE:-ghcr.io/linked-fw/fuseki:6.2.0-1}`; env kept |
| `src/test-helpers/fuseki-test-store.ts` | `dbType=mem` → `tdb2` (`:168-182`), reap of leftover datasets; compose project `-p linked-core-test` (`:123`, `:146`); an inference probe; `SHACL_DATASET` comment (`:279-286`) |
| `src/tests/global-setup.ts`, `src/tests/global-teardown.ts` (`:5-8`) | the reap and the teardown deletes (§Architecture, Test store); run the probe; a non-inferring Fuseki on the port fails the run with a message naming the image |
| `src/tests/*` (new) | `ontology-hierarchy.test.ts`, `ontology-load-files.test.ts`, `ontology-registry.test.ts`, `ontology-sync.test.ts` (capture store), `ontology-sync-fuseki.test.ts` (`[fuseki]`), `shape-check.test.ts`, `tighten-only.test.ts`, `shacl-metamodel-terms.test.ts` |
| `docs/architecture/ontologies.md`, `docs/architecture/owned-values.md` | as Scope 11 |
| `docs/reports/042-store-inference-ontology-sync-and-shape-check.md` (new) | the record |
| `.changeset/*.md` (new) | `minor` |

### Architecture

The algorithms a step agent implements without design choices left.

**Reader.** `hierarchyFromTurtle(texts, sources?)`: parse each text with N3.js `StreamParser`
(or `Parser` with a callback, no store); keep quads whose predicate is `RDFS_SUBCLASSOF`, graph is
the default graph, subject and object are `NamedNode`s; dedupe on `s\u0000o`; sort by `s` then `o`
(code-unit order). A blank-node object (an OWL restriction) is dropped silently: decision 10
forbids blank nodes in package data, and the view (decision 3) ignores anything but
`subClassOf` between IRIs anyway. `subClassClosure`: per class, a DFS over direct superclasses
with a visited set (a cycle `A ⊑ B ⊑ A` terminates; each holds the other), excluding the class
itself unless it is on a cycle. `definedTermsFromTurtle`: every `NamedNode` subject.

**Registry and loading.** Per package (`groupBy packageName`): call each entry's `load()`;
`Array.isArray(r) && r.every(s => typeof s === 'string')` else one warning
`[linked] ontology data of <pkg> (<prefix>) is not Turtle text; skipped — convert src/data to .ttl`
per package; a rejected load or parse error warns naming package and file and skips the package.

**Sync** (`syncOntologies(ds, {force, packages, orphanScope = 'none'})`):
1. Packages = registered packages with at least one `load`, filtered by `packages` if given.
   Parse each into its kept triples → sorted N-Triples lines → `ontologyTriples`, `hash`.
2. Read every `OntologySync` node in one select (`QueryBuilder.from(OntologySync).select([...])`,
   `.exec(ds)`, as `syncShapes.ts:190-199` reads hashes): `packageName`, `ontologyHash`,
   `ontologyTriples`.
3. `listedElsewhere(P)` = the union, over every other package Q, of Q's **new** triples if Q is
   registered and readable, else Q's stored triples. Two packages changing in one run then never
   delete a triple the other still lists.
4. Per package P whose stored hash differs or is missing (or `force`): `add = new − old`,
   `remove = (old − new) − listedElsewhere(P)`; group both by subject; per subject one
   `ClassAxioms.update({subClassOf: {add, remove}}).for({id: s}).exec(ds)` (clarification 1),
   concurrency 8; then `OntologySync.upsert({packageName, ontologyHash, ontologyTriples})
   .for({id: syncNodeIri(P)}).exec(ds)`. `ClassAxioms` is a core-internal shape (not a built-in,
   not synced: `syncShapes.ts:347-351` skips core-package shapes outside `BUILT_IN_NAMES`) with
   one multi-valued IRI property `subClassOf` on `rdfs:subClassOf` and **no targetClass**, so the
   update never writes `rdf:type` (an update's plan has no type triple, `irToAlgebra.ts:2361-2365`)
   and it takes no part in the shape check or class resolution. P goes to `written`.
5. Unchanged P → `skipped`, no request at all (an unforked branch stays unforked). Unreadable or
   JSON packages → `skipped` with their warning.
6. `orphanScope: 'all'` (and no `packages` filter): every stored node whose package is not
   registered: remove its triples except `listedElsewhere`, delete the node; → `pruned`.
7. Runs outside any `withShapeCatalog` scope (`assertNoActiveCatalog`), like `syncShapes`.

Triples already in a dataset before its first sync (CN's builder wrote `subClassOf` directly) are
never deleted by the sync: `old` is empty for a package never synced.

**Shape check** (`checkShapeHierarchy({hierarchy?, dependencies?})`). Inputs: every registered
node shape (`getAllNodeShapes()`), outside a catalog; `closure = subClassClosure(hierarchy ??
union of every registered package's parsed triples)`; mirrors per package; dependencies.
Definitions: `cls(s)` = `getTargetClassId(s)` (own or inherited); `ownCls(s)` = `s.targetClass`
when s declares it, i.e. differs from what it extends (Package.ts:438-441 copies an inherited
static targetClass onto the node shape, so "own" means `cls(s) !== cls(parent)`); `pkg(s)` = the
class's `packageName`, or undefined for data-only shapes; `sup(C)` = `closure.get(C) ?? ∅`.
Skipped everywhere: core's built-ins (`builtInShapeIris()`), generated shapes (`generated`), and
`ClassAxioms`. Meta classes: `http://www.w3.org/2000/01/rdf-schema#Resource`,
`http://www.w3.org/2002/07/owl#Thing`, `http://www.w3.org/2000/01/rdf-schema#Class`,
`http://www.w3.org/1999/02/22-rdf-syntax-ns#Property`.

1. **`extends-without-subclass`, `error`** — for each s with `s.extends = {id: d}`, both classes
   known, `C = cls(s)`, `D = cls(d)`: finding unless `C === D` or `sup(C).has(D)`. Message names
   both shapes, both classes and the package whose data should state `C ⊑ D` (the package owning
   C's namespace, if registered).
2. **`subclass-without-extends`** — for each s with an own class A, for each B in `sup(A)` that
   is not a meta class: `roots = getShapesForTargetClass(B)` minus shapes declaring
   `sharedTargetClass`; none → nothing. Satisfied when s is a sub-shape of a root
   (`isSubShapeOf`). Not reported at s when s extends (transitively) a shape t ≠ s whose class T
   has `sup(T).has(B)` or `T === B`: that finding belongs to t, so one missing link is reported
   once, at the lowest shape responsible. Otherwise severity **`error`** when `roots.length ===
   1`, `pkg(roots[0])` is defined and is `pkg(s)` or in the transitive closure of
   `dependencies[pkg(s)]`; else **`warning`** (several roots, a root in a package s's package
   cannot see, a data-only shape). Message names s, A, B, the root and the fix ("make s extend
   <root>").
3. **`borrowed-target-class`, `error`** — group the registered shapes by `cls(s)`, dropping those
   declaring `sharedTargetClass`. In each group with more than one shape: every shape that is not
   a root of the group (`leastSpecific`, i.e. a sub-shape that borrowed its parent's class), and,
   when the group has several roots, every root. A mangled duplicate (`Person` and `Person2`, the
   case the warning at `ShapeClass.ts:762-780` catches at registration) lands here too.
   `List`/`PathList` (`rdf:List`) and `PP`/`UP` are clean once `PathList` and `UP` declare
   `sharedTargetClass`.
4. **`mirror-undefined-term`, `error`** — for each package M with `mirrors` (each a namespace
   string): `defined = definedTermsFromTurtle(M's data)`. Candidate IRIs: every exported term of
   M's ontologies (the `{id}` values of each registry entry's export object), and from every
   registered shape (any package) its `targetClass`, each property's predicate IRIs (every IRI in
   the path expression, complex paths included), `datatype`, `class`. A candidate that starts
   with a mirrored namespace, is not the namespace itself, and is not in `defined` → finding with
   `iri`, and `shape` when it came from a shape.
5. **`override-not-tightened`** (clarification 6), severity `warning` in K1 — for each property
   override (a shape's own property shape whose label an ancestor also declares), the class
   comparison against `closure` (narrower = equal or `sup(override).has(base)`), and every case of
   the tighten-only list below for data-only shapes.

Findings sorted by kind, then shape, then iri; deterministic so L2's output and tests are stable.

**Tighten-only** (decision 14), `base` = the nearest ancestor's same-label property shape,
`override` = the shape's own. The three existing checks keep throwing for class-backed shapes. The
new ones warn once per `shape.id + label` with `[linked] Override <shape>.<label> widens the
inherited property: <reason>. This becomes an error in the next major.`:
- **datatype**: both set and differ.
- **valueShape**: both set, differ, and the override's is not a sub-shape of the base's
  (`isSubShapeOf`). When the override's value shape is not set up yet (`connectValueShape`
  defers through `onShapeSetup`, `SHACL.ts:359-372`), the comparison runs in that callback.
- **class**: equal passes; different is deferred to the shape check (clarification 6).
- **contains**: `base.contains && !override.contains`.
- **path**: the override's path differs from the base's (compare the canonical path keys the
  property-path module already builds); and a property with a **new** label whose path equals an
  inherited property's path under another label.
Omitted `datatype`, `class`, `valueShape` and `contains` on an override are **not** a warning:
they are inherited from the base like `minCount`/`maxCount`/`nodeKind` (`SHACL.ts:403-412`),
because an override that restates only its cardinality must not widen the rest. This changes the
SHACL written for such overrides (they gain the inherited constraint); their shape hashes change
through the data, so `SHAPE_HASH_VERSION` stays.

For data-only shapes, `registerRuntimeShape` runs the same comparison (all seven) as warnings
against `getSuperShapes(data)` when the parent is registered (`registerRuntimeShapes` sorts
parents first, `registerRuntimeShape.ts:64-90`).

**Metamodel additions.** New property shapes in `Package.ts` after the existing ones:
NodeShape `name` (`sh:name`, literal, max 1), `targetSubjectsOf` (IRI, multi), `deactivated`
(`xsd:boolean`, max 1), `message` (literal, multi: one per language), `severity` (IRI, max 1),
`andShapes` / `xoneShapes` (`sh:and` / `sh:xone`, `BlankNodeOrIRI`, max 1, no value shape, like
`orShapes` `:984-990`), `notShape` (`sh:not`, value shape `NodeShape`, max 1). The labels avoid
the reserved `and`, `or`, `not` (`SHACL.ts:385`). PropertyShape `flags` (literal, max 1),
`languageIn` (value shape `List`, max 1, `contains`, as `in`), `uniqueLang` (boolean, max 1),
`qualifiedMinCount` (`xsd:integer`, max 1), `deactivated`, `message`, `severity` as on
NodeShape, `properties` (`sh:property`, value shape `PropertyShape`, `contains`, as NodeShape's
`:663-670`). `PropertyGroup` (`sh:PropertyGroup`): `label` (inherited from `Shape`), `description`
(`rdfs:comment`, max 1), `order` (`sh:order`, `xsd:decimal`, max 1). `PropertyShape.group`
becomes `{path: sh:group, shape: PropertyGroup, maxCount: 1}`, IRI. The matching
`NodeShapeData`/`PropertyShapeData` fields are added and `buildNodeShapeData` /
`buildPropertyShapeData` write them when set, so a data-only shape carrying them round-trips.

**Effect on shape sync output and hashes.** No `SHAPE_HASH_VERSION` bump and no ledger entry:
the version is for serialization changes the create data does not show (`syncShapes.ts:108-122`),
and every change here shows in the data. The golden fixture
(`shape-sync-output-equivalence.test.ts`, `sync-fixture/Fixture`) sets none of the new fields
and no `group`, so its digest (`:214`) is unchanged — the test proves it. What does change: the
built-ins `NodeShape` and `PropertyShape` gain property shapes, `PathList` gains
`core:sharedTargetClass`, and `OntologySync`/`PropertyGroup` are new, so the next sync of every
dataset rewrites those four shapes once and writes the two new ones (their hashes differ through
the data). Overrides that now inherit an omitted constraint are rewritten the same way.

**Test store.** `createTestDataset` posts `dbName=<name>&dbType=tdb2`. Cleanup, because TDB2
datasets persist (unlike `mem`) and no live suite deletes its dataset today (13 suites call
`createTestDataset`, none `deleteTestDataset`):
- global setup, after the probe, lists `GET $/datasets` and deletes every `nashville-test-*` and
  `k1-probe` dataset left by a killed run (the reap);
- global teardown (`global-teardown.ts:5-8`) deletes every `nashville-test-*` dataset before
  `stopFuseki`, even when tests failed;
- `deleteTestDataset` tolerates 404 as today.
`DELETE $/datasets/<ds>` also removes the TDB2 files of an `lf:DatasetRDFSLive` dataset (master
§The image), so a re-created dataset of the same name starts empty; the probe and the suites
still `clearAllData()` after create, as they do now.

**Constraining docs:** master §Decisions 1, 10–16, 19; core's `docs/architecture/ontologies.md`
(registration in a sibling module, terms as properties), `owned-values.md` (sub-shapes, profiles,
`blockedGuard`), `runtime-instances.md` (shared state across copies, catalogs).

### Pitfalls

- **A stale stock Fuseki on 3939 passes silently.** `ensureFuseki` returns as soon as something
  answers on the port (`fuseki-test-store.ts:105`), so a leftover `secoresearch/fuseki` container
  runs the live suites without inference. The global-setup probe (create `k1-probe` with
  `dbType=tdb2`, insert `A ⊑ B` and `x a A`, `ASK { x a B }`, drop it) must fail the run.
- **`dbType=mem` does not infer** (clarification 9). TDB2 datasets persist in the container;
  the reap and teardown under §Architecture (Test store) delete them (files included, master §The image).
- **Build with the integration CLI** after L1 lands (master §Rules); `npx linked` in the layout is
  the main checkout's CLI.
- **Compose must not name a local path for CI.** The committed file uses
  `${LINKED_FUSEKI_IMAGE:-ghcr.io/linked-fw/fuseki:6.2.0-1}`; locally
  `LINKED_FUSEKI_IMAGE=linked-fuseki:dev`. CI at the release PR (R) needs the image published
  first: the fuseki repository releases before core.
- **Own compose project** (`-p linked-core-test`), never 3030; the owner's Fuseki is
  `create_now-fuseki-1` on 3030.
- **`n3` must not reach a browser bundle.** No static import of `n3`, `node:fs` or `node:url` in
  any module a browser can import: `loadOntologyFiles.ts` is imported by every package's
  ontology module. Use a variable specifier with `@vite-ignore`/`webpackIgnore`, as
  `loadStores.ts` does.
- **Two copies of core** (`runtime-instances.md`): the registry lives in `sharedState`; an older
  copy's `linkedOntology` registers without `packageName`/`files` — skip such entries with one
  warning rather than crashing.
- **Vite SSR evaluates `package.ts` twice** (`Package.ts:286-291`): registration must be
  idempotent per `packageName + prefix`.
- **Write the sync node last.** A sync interrupted after some subject updates and before the node
  leaves the old hash; the next run recomputes `old` from the stored node and finishes. Writing
  the node first would mark a half-written package as synced.
- **`OntologySync` read before it exists**: a fresh dataset has no nodes; the select returns `[]`
  (not `null`) handling as `syncShapes.ts:193-195`.
- **`and`/`not`/`or` are reserved labels** (`SHACL.ts:385`): use `andShapes`, `notShape`,
  `xoneShapes`.
- **`PropertyGroup` must be registered before `PropertyShape.group` names it**, and registering
  it from a module that imports `package.js` creates a cycle: class in `PropertyGroup.class.ts`,
  registered in `Package.ts`, as `List`.
- **Every built-in is synced into every dataset** (`syncShapes.ts:342-351`): `OntologySync` and
  `PropertyGroup` appear as NodeShapes in app datasets; CN's `deriveShapesOfInterest` filters by
  `builtInShapeIris()`, so they stay hidden there.
- **Cross-repository breakage:** CN's
  `src/backend/shapes/projectShapeCatalogs.test.ts:148-153` asserts six built-ins; it fails in the
  `~/web/wt/070` CN worktree the moment K1 lands (Vite resolves core to the nested checkout). K1's
  landing updates CN's test (assert `builtInShapeIris().length` against the list, or 8) and the
  comment at `src/backend/shapes/shapesOfInterest.ts:27-29` (master §Ontology sync).
- **Tighten-only inheritance of omitted fields** changes generated SHACL for existing overrides
  across packages; K1 lists every affected shape in report 042 (run the check over the localized
  schema/org/dcat packages), so N1/N2/P1 see them.
- **Inherited targetClass looks "own"** on class-backed shapes (`Package.ts:438-441`); compare
  with the parent's class, never test `nodeShape.targetClass` presence.

### Tests

Quick gate after each phase (1–2 min):

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs \
  src/tests/<the phase's test files> src/tests/shape-catalog.test.ts \
  src/tests/shacl-syncshapes.test.ts src/tests/shape-sync-output-equivalence.test.ts
npm run typecheck
```

Full gate before landing (record counts and timings in report 042; baseline at 2.36.1: 2322 tests
per report 041 — record the exact baseline on the step's branch before phase 1):

```bash
node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build
npm test                                                                  # all suites + typecheck
REQUIRE_FUSEKI=1 LINKED_FUSEKI_IMAGE=linked-fuseki:dev npm run test:fuseki # every [fuseki] test, none skipped
npm run check:dts
```

New tests (each phase's):
- reader: two files, duplicates, a blank-node superclass dropped, a literal object dropped, a
  named graph ignored, sort order, a parse error naming the source, the closure with a cycle.
- loader: relative paths from a module URL, a missing file named, no static `node:` import in the
  emitted module (read `lib/esm/ontology/loadOntologyFiles.js`).
- registry: grouping (one package, three prefixes), JSON-returning `loadData` warned once and
  skipped, idempotent re-registration, `autoLoadOntologyData(true)` loads nothing.
- sync (capture store, `query-capture-store.ts`): first sync writes per-subject updates then the
  node; unchanged → zero requests; a changed package deletes only `old − new − listedElsewhere`;
  two packages sharing a triple; `force`; `packages`; `orphanScope: 'all'`; the hash vector
  (`sha256Hex('linked-ontology-sync/1\n' + lines)` for a two-triple fixture, value pinned).
- sync `[fuseki]`: on the image, a subclass instance is returned by a superclass select after the
  sync; a resync after removing the axiom makes it disappear; the measurement above.
- shape check: one fixture per kind and severity, each direction-I scope rule (several roots, a
  root outside the dependencies, a meta class, data-only), the "reported once at the lowest
  shape" rule, `sharedTargetClass` exemption, a mirror package with an invented term, a passed
  `hierarchy` not loading `n3`.
- tighten-only: each new case warns once; the existing three still throw; deferred value shape;
  omitted fields inherited; data-only shapes warn for all seven.
- metamodel: each new term round-trips through `syncShapes` and `registerRuntimeShape`
  (`toWire`/`fromWire`), `PropertyGroup` as `group`'s value, the golden digest unchanged.
- unchanged and green on the image: `owned-walk-recursion`, `owned-link-check`,
  `shacl-cascade`, `sparql-fuseki*`, `property-path-fuseki`.

### Size and phases

Large. **5 phases** (the master estimated 4; the metamodel additions from §Owner answers 2 are
one more):

1. **Ontology data plumbing** — `n3`, the reader, the loader, the registry, `mirrors`,
   `autoLoadOntologyData` no-op, JSDoc, `ontologies.md`. Unit tests.
2. **Shape check and tighten-only** — `sharedTargetClass` (config, data, metamodel term,
   `PathList`, `UP`), `checkShapeHierarchy` with the five kinds, the new override warnings and
   omitted-field inheritance, data-only checks, `owned-values.md`.
3. **SHACL metamodel terms** — the NodeShape/PropertyShape terms, `PropertyGroup`, `group` as IRI,
   data fields and sync writes; the golden unchanged.
4. **Ontology sync** — `OntologySync`, `ClassAxioms`, `syncOntologies`, `BUILT_IN_NAMES` six →
   eight and its tests; capture-store tests.
5. **Store phase** (after F1 lands) — compose on the image, `tdb2` datasets, the probe, the live
   sync tests and measurement, the full gate on the image, report 042, the changeset (`minor`:
   "ontology data as Turtle, ontology sync, the shape check, tighten-only warnings, SHACL
   metamodel terms").

---

## K2 — validate by class

Detail written when its wave starts. Master: [§Validate by class](#validate-by-class-provider-k2-consumers-apps-cn);
tests with a subclass node validated against the superclass shape; report 043. Size: small.

## K3 — the workarounds go (major, sensitive)

Detail written when its wave starts. Master §K3: the owned-link check, the single-owner
constraint and the cycle walk rely on inference; tighten-only warnings (and
`override-not-tightened`) become errors; `autoLoadOntologyData` removed; report 044; changeset
**major**.

## Progress

- [ ] K1 — ontology data, sync and the shape check (report 042)
- [ ] K2 — validate by class (report 043)
- [ ] K3 — the workarounds go (report 044)
