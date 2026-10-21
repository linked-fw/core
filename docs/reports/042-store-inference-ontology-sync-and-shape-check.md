---
summary: >
  Ontology data as Turtle (loader, registry, hierarchy reader), the ontology sync with the built-in
  OntologySync shape, the shape check (`checkShapeHierarchy`, five kinds, `mirrors`,
  `sharedTargetClass`), tighten-only warnings with inheritance of omitted constraints, and the rest
  of the SHACL Core terms plus PropertyGroup in the metamodel. Step K1 of CN plan 070, phases 1-4;
  the store phase (core's tests on the inferring image) follows once the image lands.
packages: [core]
---

# 042 — Store inference: ontology sync and the shape check

Source: CN plan 070 (`create-now/docs/plans/070-store-inference-and-ontology-data.md`), step K1;
sub-plan [003](../plans/003-store-inference.md). Design: the master's §Decisions 1, 10-16, 19.
Phases 1-4 of 5 are done; phase 5 (the store phase) waits for the image (step F1) and is recorded
here when it lands.

## What was built

**Ontology data plumbing** (`src/ontology/`, server-only subpaths, none re-exported from the
index):

- `ontology/loadOntologyFiles` — `loadOntologyFiles(moduleUrl, files)` reads Turtle relative to
  the ontology module; `node:fs/promises` is imported through a variable specifier, so the module
  is safe in a browser bundle.
- `ontology/hierarchy` — `RDFS_SUBCLASSOF`, `hierarchyFromTurtle(texts, sources?)`,
  `subClassClosure`, `definedTermsFromTurtle`. `n3` (new dependency, `^2.13.12`) is imported
  inside the parse functions only.
- `ontology/registryData` (internal) — groups the registry by package and reads it; a JSON
  `loadData` is skipped with one warning per package, a rejected load or parse error skips the
  package naming package and file.
- `utils/Package` — `linkedOntology` records `{packageName, prefix, ns, load, files, terms}` in
  shared state keyed by package and prefix (`getRegisteredOntologies()`); `linkedPackage(name,
  {mirrors})` (`getPackageMirrors()`); `autoLoadOntologyData` a documented no-op; the stale
  `lincd-jsonld` JSDoc rewritten to the Turtle pattern.

**Ontology sync** — `ontology/syncOntologies` (`syncOntologies(ds?, {force, packages,
orphanScope})` → `{written, skipped, pruned}`), the built-in `OntologySync` shape
(`core:packageName`, `core:ontologyHash`, `core:ontologyTriples`) and the internal `ClassAxioms`
write shape (no targetClass: an update by id never types the class). Hash
`sha256Hex('linked-ontology-sync/1\n' + lines)`, lines sorted, joined with `\n`. One update per
changed subject class, at most eight in flight, the sync node last.

**Shape check** — `shapes/checkShapeHierarchy` with `extends-without-subclass`,
`subclass-without-extends` (error in scope, warning outside; meta classes excluded; reported once
at the lowest shape responsible), `borrowed-target-class`, `mirror-undefined-term`,
`override-not-tightened`. Sorted by kind, shape, IRI. A caller passing `hierarchy` (and with no
mirror package registered) never loads `n3` (tested with a mocked `n3`).
`@linkedShape({sharedTargetClass: true})` → `NodeShapeData.sharedTargetClass` →
`core:sharedTargetClass` in shape sync; `PathList` and the `UP` fixture declare it.

**Tighten-only** (`shapes/tightenOnly.ts`, shared by the decorator path, data-only registration
and the check). The three original cases still throw. New warnings, once per shape, property and
case: datatype changed, a value shape that is not the base's or a sub-shape of it (compared when
it registers, for a `[package, name]` reference not registered yet), `contains: false`, a changed
path, and a new label whose path an inherited property already declares. A differing `sh:class`
is the shape check's. An override inherits the datatype, class, value shape and `contains` it does
not restate. Shapes known only as data warn for all seven cases at `registerRuntimeShape`.

**SHACL metamodel** — NodeShape: `name`, `targetSubjectsOf`, `deactivated`, `message`, `severity`,
`andShapes`, `xoneShapes`, `notShape`, `sharedTargetClass`; PropertyShape: `flags`, `languageIn`
(owned list), `uniqueLang`, `qualifiedMinCount`, `deactivated`, `message`, `severity`,
`properties` (owned nested property shapes); the built-in `PropertyGroup` (`description`,
`order`); `PropertyShape.group` names a `PropertyGroup` (an IRI; `PropertyShapeData.group` is a
`NodeReferenceValue`, the decorator accepts an IRI string or `{id}`). Shape sync writes every new
field when set; `sh:and`/`sh:xone` as blank `rdf:List`s of shape IRIs. Core's built-ins are eight:
`Shape`, `NodeShape`, `PropertyShape`, `List`, `PathNode`, `PathList`, `PropertyGroup`,
`OntologySync`.

Docs: `docs/architecture/ontologies.md` (Turtle data, loader, registry, reader, sync, mirror
packages), `owned-values.md` (`sharedTargetClass` profiles, the `contains` override rule, branch
counts), `runtime-instances.md` (built-in list).

## Effect on what shape sync writes

- No `SHAPE_HASH_VERSION` bump; the golden fixture's output and digest are unchanged
  (`shape-sync-output-equivalence` green).
- The built-ins `NodeShape`, `PropertyShape` and `PathList` change (new property shapes,
  `core:sharedTargetClass`) and `PropertyGroup`, `OntologySync` are new, so the next shape sync of
  every dataset rewrites three shapes and writes two.
- **Overrides whose generated SHACL changes** (omitted constraints now inherited), measured by
  importing the localized `xsd, rdfs, owl, dcmi, schema, sioc, org, dcat, auth` (package entry,
  `shapes/index`, every `*.register.js`; 64 shapes) and listing every override whose base has a
  datatype, class, value shape or `contains` the override lacks:

  ```
  @_linked/schema Event.image: contains
  ```

  That is the master's decision 18 item ("`Event.image` gets `contains`"), now inherited
  automatically. No package override triggers a new tighten-only warning.

## The shape check over the localized packages

Same import set, `checkShapeHierarchy()` with the hierarchy from registered data (no package ships
Turtle yet, so every `loadData` is skipped with the JSON warning and the hierarchy is empty):

```
{"extends-without-subclass/error":35,"borrowed-target-class/error":5}
```

The 35 `extends-without-subclass` errors are every `extends` between two classes: they clear when
N1, N2 and P1 ship Turtle. The five `borrowed-target-class` findings are decision 18's items:
`ArtBlock`/`VisualArtwork` (both `schema:VisualArtwork`), `CreativeWork`/`DataFeedItem` (both
`schema:CreativeWork`), `PostalAddress` (inherits `schema:Thing`).

## Deviations and decisions within the contracts

- The registry entry also carries `terms` (the module's exports), which the mirror check reads.
- `NodeShapeData.generated` (the `core:generated` flag a stored generated shape carries) so the
  check can skip such shapes.
- `ClassAxioms` lives in `src/shapes/` and is loaded by `shapes/index`: the build's
  `shapes/index` check requires every declared shape there. Its `subClassOf` names `Shape` as value
  shape (an update with `{id}` values needs one), the metamodel's convention for IRI values.
- An omitted `contains` is inherited, so only an explicit `contains: false` warns on a decorator
  override.
- The check computes the roots of a class without shapes that declare `sharedTargetClass`, so a
  shared shape never hides a real root.
- Orphans pruned in the same run (`orphanScope: 'all'`) do not keep each other's triples.
- The owned walk follows the new `contains` edges (nested property shapes recurse, `languageIn`
  lists): pinned branch counts NodeShape 8 → 9, PropertyShape 4 → 7
  (`owned-walk-recursion.test.ts`); two delete-SPARQL assertions in `blank-nested-nodes` and
  `shacl-cascade` follow the nested `sh:property*` step.

## Verification

Baseline on the step's branch before phase 1 (`store-inference` at 9c14fbd, lib built), `npm test`:

```
[fuseki] live tests: 304 total — 304 passed, 0 failed, 0 skipped
Test Suites: 1 failed, 4 skipped, 107 passed, 108 of 112 total
Tests:       120 skipped, 2340 passed, 2460 total
npm test  85.00s user 13.74s system 421% cpu 23.444 total
```

The one failing suite, `two-copies-built.test.ts`, fails the same way in the main checkout at
`main` (4afe035): `Error: Module cache already has entry …/lib/esm/shapes/SHACL.js. This is a bug
in Jest` — recorded as [backlog 060](../backlog/060-two-copies-built-jest-module-cache.md).

Quick gates (phase test files plus `shape-catalog`, `shacl-syncshapes`,
`shape-sync-output-equivalence`, then `npm run typecheck`):

| Phase | Result | Time |
|---|---|---|
| 1 | `Tests: 70 passed, 70 total` (after a rebuild for the loader's emitted-module test); typecheck clean | 11.2 s |
| 2 | `Test Suites: 7 passed, 7 total`, `Tests: 97 passed, 97 total` (with `owned-walk-recursion`); typecheck clean | 11.6 s |
| 3 | full jest: `Tests: 120 skipped, 2393 passed, 2513 total` (only `two-copies-built` failing); typecheck clean | 17.2 s |
| 4 | full jest: `Tests: 120 skipped, 2404 passed, 2524 total` (only `two-copies-built` failing); typecheck clean | 26.2 s |

Full gate before landing (Fuseki: the existing test store on 3939; the image comes with phase 5):

```
node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build
✔ Build successful            (5.9 s)

npm test
[fuseki] live tests: 304 total — 304 passed, 0 failed, 0 skipped
Test Suites: 1 failed, 4 skipped, 115 passed, 116 of 120 total   (two-copies-built, backlog 060)
Tests:       120 skipped, 2404 passed, 2524 total
Time:        18.166 s

npm run typecheck             clean (3.4 s)

REQUIRE_FUSEKI=1 npm run test:fuseki
[fuseki] live tests: 304 total — 304 passed, 0 failed, 0 skipped
Tests:       2259 skipped, 304 passed, 2563 total
Time:        11.048 s

npm run check:dts             clean (1.9 s)

grep -rln "n3'" lib/esm --include='*.js'            → lib/esm/ontology/hierarchy.js
grep -n "^import.*n3" lib/esm/ontology/hierarchy.js  → nothing
grep -rn "ontology/" lib/esm/index.js               → nothing
```

The owned-walk, owned-link-check and single-owner suites are unchanged and green (on the current,
non-inferring store until phase 5).

## Follow-ups

- Phase 5 (store phase): compose on `linked-fuseki:dev`/`ghcr.io/linked-fw/fuseki`, `tdb2`
  datasets, the inference probe, reap and teardown, `ontology-sync-fuseki.test.ts` and the
  schema.org measurement — this step, resumed after F1 lands (sub-plan 003, K1 phase 5).
- `two-copies-built` not running: [backlog 060](../backlog/060-two-copies-built-jest-module-cache.md).
- Tighten-only errors, `autoLoadOntologyData` removal: K3.
