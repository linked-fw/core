---
date: 2026-11-10
summary: >
  Prefixes are the app's. registerOntologies(ontologies, moduleUrl) replaces linkedOntology and
  registers no prefix; an app loads its map with Prefix.load; expansion takes an explicit map; an
  unknown prefix throws UnknownPrefixError; core's ontology modules hold literal terms and one
  index registers them. Major.
packages: [core]
---

# 119 — Scoped prefixes, `registerOntologies`, an unknown prefix throws

## PR

**What changed.** No ontology registers a prefix any more, core's own included. An app has one
prefix map and loads it at start; every prefixed name is expanded against it (or against a map
the caller passes), and an unknown prefix is an error instead of a silent `<p:x>` IRI.

- **`registerOntologies(ontologies, moduleUrl)`** replaces `linkedOntology` (removed). A
  package's `src/ontologies/index.ts` imports its terms modules (only `{id}` literals) and
  registers them all with one call:

  ```ts
  import * as core from './linked-core.js';
  import {registerOntologies} from '../package.js';

  registerOntologies(
    [{name: 'core', namespace: 'https://linked.cm/ont/core/', terms: core, data: ['../data/core.ttl'], suggestedPrefix: 'core'}],
    import.meta.url,
  );
  ```

  `data` is relative to `moduleUrl` and read only when the ontology sync or shape check asks.
  The call refuses an invalid or repeated name, an empty namespace and an invalid suggested
  prefix. `OntologyRegistration` has `namespace` and `suggestedPrefix` instead of `ns`;
  `suggestedPrefixes()` lists `{packageName, name, namespace, prefix}`.
  `registerInstalledOntologies` imports `<pkg>/ontologies/index` instead of `*.register` modules.
- **The app's map:** `Prefix.load(map)` replaces the map in use (`PrefixMap` =
  `Record<prefix, namespace>`), `Prefix.toMap()` returns it. Expansion and compaction take an
  optional explicit map (`Prefix.toFull(value, map)`, `toPrefixed`, `toPrefixedIfPossible`,
  `getFullURI`, `getPrefix`, `findMatch`, `resolveUriOrThrow`, `resolveNodeId`, `pathRefIri`,
  `expandPrefixedName`).
- **An unknown prefix throws** `UnknownPrefixError` (`.prefix`, `.value`): `Prefix.toFull`, query
  subjects (`.for('ex:a')`), `update().for` and `delete` string ids (never expanded before), and
  property path steps (written as `<p:x>` with a one-time warning before). A string containing
  `://` or with the scheme `http`, `https`, `urn`, `mailto`, `did`, `file` or `data` is a full IRI.
  `Prefix.toFullIfPossible` and `resolvePrefixedUri` (the silent expansions) are removed.
- **Core's own modules:** `linked-core.ts` holds literal terms and `coreOntology` (no `ns`,
  `_self`, data exports or `Prefix.add`); `ontologies/index.ts` registers it; the register module
  is gone. `rdf`, `rdfs`, `owl`, `xsd`, `shacl`, `sd`, `prov` no longer add prefixes (and are not
  registered); the deprecated `linked_core` label is gone.
- **Tests** load the prefixes they assume in a jest setup file (`src/tests/setup-prefixes.ts`);
  in-memory ontology data registers through a test helper (`registerTestOntology`).
- SPARQL core writes still declares a `PREFIX` for every prefixed name it uses, and
  `shapesToTurtle` still writes its prefix section.

README (§Registering ontologies, §Prefixes: one map per app) and the architecture docs
(ontologies, loading package modules) describe the new layout. Major changeset.

**Verification**

`npx linked build`:

```
✔ Build successful
```

`npm test` (jest, then `tsc -p tsconfig-tests.json`, exit 0):

```
Test Suites: 19 skipped, 160 passed, 160 of 179 total
Tests:       623 skipped, 2892 passed, 3515 total
```

(Baseline before the change: 2883 passed, 623 skipped.) The live Fuseki suites, on a store of
the run's own (`FUSEKI_BASE_URL=http://localhost:3947 npm run test:fuseki`, started and stopped by
the run):

```
[fuseki] live tests: 503 total — 501 passed, 0 failed, 2 skipped
Tests:       3014 skipped, 501 passed, 3515 total
```

The built package, loaded by Node (`lib/esm/index.js`):

```
[ [ '@_linked/core', 'core', 'https://linked.cm/ont/core/', [ '../data/core.ttl' ] ] ]
data chars 10252
suggested [{"packageName":"@_linked/core","name":"core","namespace":"https://linked.cm/ont/core/","prefix":"core"}]
map at start {}
UnknownPrefixError Unknown prefix "core" in "core:x": the prefix map in use has no "core". Add it to the app's prefix map (linked.app.json "prefixes"), pass the map that has it, or write the full IRI.
https://linked.cm/ont/core/x
```

A host app's typecheck against this build (other framework packages still on the previous core,
so most of its errors are two-copies type mismatches). The errors this change causes directly:

```
src/backend/ai/dataQuery.ts: TS2339: Property 'toFullIfPossible' does not exist on type 'typeof Prefix'.
src/backend/shapes/llmShapeInfo.ts: TS2339: Property 'toFullIfPossible' does not exist on type 'typeof Prefix'.
src/package.ts: TS2339: Property 'linkedOntology' does not exist on type 'LinkedPackageObject'.
```

**Deviations from the plan.** `registerOntologies` takes a second argument, `moduleUrl`
(`import.meta.url`), the base of `data` (the contract showed one argument). `registerInstalledOntologies`
moved to the index layout here (the contract removes the register modules). `update().for` and
`delete` string ids now expand prefixed names (found while inventorying; plain ids and `_:` labels
unchanged).

**Follow-ups.**

- An explicit prefix map in query builds (the DSL expands with the map in use): core
  [backlog 120](../backlog/120-explicit-prefix-map-in-query-builds.md).
- Every ontology package to the index layout (`registerOntologies`, literal terms), and the
  packages and the host app that read prefixes registered by packages: the coordinated major's
  next steps (ontology packages and the app's prefix map), outside this repo.
- Backlog 117 (`linkedOntology` registers no prefix) is closed by this report.

## Details

### Inventory (before removing anything)

Readers of the prefix map in core: `NodeReference` (`resolvePrefixedUri`, unused and silent;
`resolveUriOrThrow`, used by `.for`/`.forAll`/`AskBuilder`, which threw for `urn:` ids),
`propertyPathSafety` (`expandRegisteredPrefixedName`, `pathRefIri`: unknown prefix → IRI),
`pathExprToSparql` (warn once, then `<p:x>`; the canonical key through `toFullIfPossible`),
`sparqlUtils` (`formatUri`, `collectPrefixes`: compaction and the `PREFIX` block),
`shapesToTurtle` (own table), `Package.linkedOntology` (`Prefix.add`, `_prefix`), the vocabulary
modules (`Prefix.add` ×9). Readers of the registry: `checkShapeHierarchy` (`ns('')`, `terms`),
`syncOntologies` and `syncTargets` (`ns('')`), `registryData` (`load`, `files`, `name`),
`registerInstalled` (the `*.register` modules). String ids never expanded: `UpdateBuilder.for`,
`DeleteBuilder.from`/`forNodes` — now through `resolveNodeId`.

Outside core (for the next steps), by grep of the `Prefix` API and `linkedOntology(`:

| Where | Uses |
|---|---|
| auth, dcat, npm, org, schema, sentry, sioc, xsd, owl | `linkedOntology` ×1, `Prefix.add` ×1 (owl also `Prefix.getPrefix`) |
| dcmi | `linkedOntology` ×3, `Prefix.add` ×3 |
| rdfs | `linkedOntology` ×2, `Prefix.add` ×2, `Prefix.findMatch` |
| fuseki | `linkedOntology`, `Prefix.add`, `getFullURI`, `toFull` ×2, `toPrefixed`; test reads `_prefix` (`fuseki.register.test.ts`) |
| server | `linkedOntology` ×7, `Prefix.add`, `toFull` ×2, `toPrefixed`; test reads `_prefix` (`ontology-prefix.test.ts`) |
| server-utils | `linkedOntology`, `Prefix.add` ×3 |
| s3 | `linkedOntology` |
| translation | `linkedOntology`, `getFullURI`, `toPrefixed` |
| shape-ui | `toPrefixedIfPossible` (unchanged API) |
| cli | generator and templates write `linkedOntology` (13) and `Prefix.add` (10); `ontologyModules.ts` lists `_prefix` |
| host app | `linkedOntology` ×9 in its source and one in each of two workspace packages; `Prefix.add` ×7, `delete` ×2, `toFullIfPossible` ×2, `toPrefixedIfPossible` |

Behaviour that changes for a consumer without a compile error: any `Prefix.toFull`/`getFullURI`
of a prefix that a package used to register returns undefined or throws until the app loads a map
that has it; string path steps with such prefixes throw at query time.

### Decisions taken on the owner's behalf

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| 1 | contract K9 | K9 shows `registerOntologies([...])` with `data`, but a data path needs a base URL | `registerOntologies(ontologies, moduleUrl)`, `data: string[]` relative to `moduleUrl`, core reads with `loadOntologyFiles` | a `load` function per entry in the generated code | one argument the generator always writes; core owns reading; entries stay data |
| 2 | registry | `OntologyRegistration.ns` (a function) vs K9's `namespace` | `namespace: string` replaces `ns`; `suggestedPrefix?` added | keep `ns` too | one way; a namespace function is `createNameSpace(namespace)` (K9) |
| 3 | `Prefix.load` | merge into or replace the map in use | replace (later prefix of one namespace compacts) | merge | the app's map is the map; no package adds prefixes |
| 4 | `Prefix.load` | K10's stricter prefix rule vs SPARQL `PN_PREFIX` | core checks `PN_PREFIX`; K10's rule is the cli's | K10 rule in core | core does not own `linked.app.json`; never rejects a valid map |
| 5 ⚠ risky | K11 schemes | the old warn list also passed `tag`, `tel`, `uuid`, `geo`, `info` as IRIs in path steps | K11's seven schemes plus any `://`; others throw as unknown prefixes | keep the wider list | the contract is explicit; `geo:` is a common real prefix; loud, not silent |
| 6 | canonical path key | `{id: 'schema:name'}` (catalog spelling) | expanded when the prefix is in the map, else an IRI | throw on any unknown `{id}` prefix | an `{id}` is an IRI by type; one key per path |
| 7 | silent APIs | `toFullIfPossible`, `resolvePrefixedUri` | removed | deprecated | K11; coordinated major |
| 8 | mutation ids | `update().for('p1')`, delete ids are plain ids in tests and apps | `resolveNodeId`: expand prefixed names (unknown throws); plain ids and `_:` labels as before | `resolveUriOrThrow` (throws on plain ids) | K11 covers prefixed names; existing blank-node errors stay |
| 9 | core's shortcut vocabularies | K9 for rdf, rdfs, owl, xsd, shacl, sd, prov | drop `Prefix.add`; not registered; `ns` helpers kept | literal rewrite and registration | core does not own those namespaces; registering them would attribute them to core |
| 10 | `linked_core` | deprecated label | removed | keep | K8: deprecated labels included |
| 11 | `registerInstalledOntologies` | not named in F5; K9 deletes the register modules | imports `<pkg>/ontologies/index` | leave to a later step | core owns the loader; nothing would register otherwise |
| 12 | shared state | the `ontologies` Set in the shared container is unused | keep initialising it; `registrationsByPackage` also skips an older copy's entry without `namespace` | drop | an older copy of core in one runtime writes to it (the two-copies test caught it) |
| 13 | tests | 13 suites registered in-memory data through `linkedOntology(load)` | `registerTestOntology` over an `@internal` `setOntologyRegistration` | temp files per test | tests change data between syncs; production keeps one way |
| 14 | `linked-core.ts` | export each term, or keep `coreOntology` | literal terms, `coreOntology` exported | export each | `generated: false` keeps its exports; consumers import `coreOntology` only |
| 15 | architecture doc | "Terms are properties" contradicted the generated per-term exports | rewritten to the current layout | leave | docs describe the current state |
| 16 | phases | phases 3 and 4 share the core module (it must compile) | one commit for both | two commits with a broken middle | each commit builds and passes |

### Files

`src/utils/Prefix.ts`, `src/utils/Package.ts`, `src/utils/NodeReference.ts`, `src/package.ts`,
`src/index.ts`, `src/ontologies/{index,linked-core,rdf,rdfs,owl,xsd,shacl,sd,prov}.ts`,
`src/ontology/{registerInstalled,registryData,syncOntologies}.ts`,
`src/shapes/{checkShapeHierarchy,syncTargets}.ts`, `src/paths/{propertyPathSafety,pathExprToSparql}.ts`,
`src/queries/{UpdateBuilder,DeleteBuilder}.ts`, `src/test-helpers/register-test-ontology.ts`,
`jest.config.cjs`, `src/tests/setup-prefixes.ts`, `src/tests/prefix-scoped.test.ts` (new), the
installed-package fixtures, 20 test files; README, `docs/architecture/{ontologies,loading-package-modules}.md`.
