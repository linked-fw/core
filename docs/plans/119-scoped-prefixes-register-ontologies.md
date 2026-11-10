---
summary: Scoped prefixes. registerOntologies replaces linkedOntology and registers no prefix; an app loads its prefix map with Prefix.load; an unknown prefix throws; core's ontology modules hold literal terms and one index registers them.
packages: [core]
status: Implementation
---

# 119 — Scoped prefixes, `registerOntologies`, unknown prefix throws

## Goal

Prefixes are an app's choice, not a package's. No ontology registers a prefix; an app loads its
one prefix map into core at start, and every prefixed name is expanded against that map (or an
explicit map a caller passes when it acts for another app). An unknown prefix is an error, never a
silent `<p:x>` IRI. Ontologies register with one call per package, `registerOntologies`, from a
generated `ontologies/index.ts` whose terms modules hold literal `{id}` terms.

Coordinated major: no compatibility layer for `linkedOntology`, `*.register.ts` modules or
`Prefix.toFullIfPossible`.

## Contracts (as implemented)

### `registerOntologies` (package-bound, like `linkedShape`)

```ts
// src/ontologies/index.ts of a package
import * as core from './linked-core.js';
import {registerOntologies} from '../package.js';

registerOntologies(
  [
    {
      name: 'core',                              // name within the package (K1 pattern)
      namespace: 'https://linked.cm/ont/core/',  // full namespace IRI
      terms: core,                               // the terms module (import * as …)
      data: ['../data/core.ttl'],                // optional; Turtle files relative to moduleUrl
      suggestedPrefix: 'core',                   // optional; the vann preferred prefix
    },
  ],
  import.meta.url,                               // what `data` paths are relative to
);
```

- Type `OntologyDeclaration = {name: string; namespace: string; terms: Record<string, unknown>;
  data?: string[]; suggestedPrefix?: string}`, exported from `@_linked/core/utils/Package`.
- `moduleUrl` is required. Data is read lazily (`loadOntologyFiles(moduleUrl, data)`) by the
  ontology sync / shape check, server only; a client bundle gets the stub as before.
- Throws on: a name that is not `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`; an empty namespace; two
  declarations with one name in a call; a `suggestedPrefix` that is not a SPARQL `PN_PREFIX`.
- Registers no prefix. Registration is keyed by package + name (idempotent).
- `OntologyRegistration` = `{packageName, name, namespace, suggestedPrefix?, terms, files, load?}`
  (`ns` and `_prefix`/`_ns`/`_load`/`_data` are gone).
- `suggestedPrefixes(): SuggestedPrefix[]`, `SuggestedPrefix = {packageName, name, namespace,
  prefix}`, one per registration with a suggested prefix, in registration order. From
  `@_linked/core` and `@_linked/core/utils/Package`.

### The app's prefix map (`Prefix`)

- `type PrefixMap = Readonly<Record<string, string>>` (prefix → namespace, as `linked.app.json`
  `prefixes`).
- `Prefix.load(map: PrefixMap): void` replaces the map in use with `map` (the cli calls it at
  server start and in the browser bundle). Throws on a prefix that is not a `PN_PREFIX` or an empty
  namespace. When two prefixes share a namespace, compaction uses the later one (as `add`).
- `Prefix.add(prefix, namespace)`, `Prefix.delete`, `Prefix.clear` stay (low level; tests).
- `Prefix.toMap(): Record<string, string>`: a copy of the map in use (for writers that must emit
  a prefix section, and for passing it on).
- Expansion (K11): `Prefix.toFull(value: string, map?: PrefixMap): string`. A string with an IRI
  scheme (`http:`, `https:`, `urn:`, `mailto:`, `did:`, `file:`, `data:`, case-insensitive) or
  containing `://` is a full IRI and returned as is; `p:local` with `p` in the map expands;
  anything else throws `UnknownPrefixError` (`.prefix`, `.value`), whose message names the
  prefix and the value. `Prefix.isFullIri(value)` answers the first rule.
- Compaction: `Prefix.toPrefixed(iri, map?)`, `Prefix.toPrefixedIfPossible(iri, map?)`,
  `Prefix.findMatch(iri, map?)`, `Prefix.getFullURI(prefix, map?)`, `Prefix.getPrefix(iri, map?)`
  take an optional explicit map; without one they use the map in use.
- Removed: `Prefix.toFullIfPossible` (the silent expansion), `resolvePrefixedUri` (unused, silent).
  `resolveUriOrThrow(value, map?)` delegates to `Prefix.toFull`.

### Expansion paths fixed (K11)

- `paths/propertyPathSafety.ts`: `expandRegisteredPrefixedName` (undefined on unknown) →
  `expandPrefixedName(value, map?)` (throws); `pathRefIri(ref, map?)` expands a prefixed-name
  string step strictly.
- `paths/pathExprToSparql.ts`: the warn-once fallback (`warnOnUnregisteredPrefix`,
  `BARE_IRI_SCHEMES`) is gone: an unknown prefix in a string step throws. The canonical key
  (`absoluteIri`) expands a string step strictly; an `{id}` whose value is a prefixed name with a
  prefix in the map is expanded too (catalog spelling), otherwise an `{id}` is an IRI.
- `.for('p:x')` / `.forAll`, `AskBuilder`, `UpdateBuilder.for`, `DeleteBuilder` string ids:
  through `resolveUriOrThrow` (now accepting `urn:` etc.).
- Others found during the inventory (phase 1) are listed in Implementation notes.

### Writers of self-contained output

`collectPrefixes` + `formatUri` (SPARQL `PREFIX` block from the map in use) and
`shapesToTurtle` (its own fixed table) keep writing their prefix sections; unchanged.

### Core's own ontology modules (K9)

- `src/ontologies/linked-core.ts`: terms as `{id: '<full IRI>'}` literals, exported one by one
  and as `coreOntology`; no `ns`, no `Prefix.add`, no data exports. `linked-core.register.ts`
  goes. `src/ontologies/index.ts` registers `core` with `registerOntologies`. The package entry
  imports `./ontologies/index.js`.
- `rdf.ts`, `rdfs.ts`, `owl.ts`, `xsd.ts`, `shacl.ts`, `sd.ts`, `prov.ts`: core's internal
  vocabulary constants. They stop calling `Prefix.add` and are not registered (core does not own
  those namespaces; their packages do). Their `ns` helpers become literal terms where they are
  only used for the listed terms.
- `registerInstalledOntologies` imports `<pkg>/ontologies/index` (source `index.ts`, built
  `index.js`) instead of every `*.register` module.

### Tests

`src/tests/setup-prefixes.ts` (jest `setupFiles`) loads the prefixes core's tests assume (those
core's modules registered before: rdf, rdfs, owl, xsd, shacl, sd, prov, core, linked_core). Tests
that need more declare them themselves.

## Phases

### Phase 1 — Inventory every reader of registered prefixes

Tasks: list every reader of `Prefix` and of the registry (`ns`, `_prefix`, terms), in core and in
the consumers (other framework packages, the host app), before removing anything.
Validation: the inventory is in Implementation notes below.

### Phase 2 — `Prefix`: load, explicit maps, strict expansion (K8, K11)

Tasks: `PrefixMap`, `Prefix.load`, `Prefix.toMap`, `Prefix.isFullIri`, map argument on
expansion/compaction, `UnknownPrefixError`, remove `toFullIfPossible`/`resolvePrefixedUri`,
`resolveUriOrThrow` via `toFull`; path expansion strict (`propertyPathSafety`, `pathExprToSparql`);
the other silent paths found in phase 1. Tests: `prefix-resolution`, `property-path-*`,
`sparql-prefixed-names`, new `prefix-scoped.test.ts` (load, explicit map, unknown throws, schemes).
Validation: `npx tsc -p tsconfig-tests.json` clean; those suites pass.

### Phase 3 — `registerOntologies` replaces `linkedOntology` (K8, K9)

Tasks: `OntologyDeclaration`, `registerOntologies(list, moduleUrl)` on the package object and
`package.ts`, registration without `ns`, `suggestedPrefixes()`; remove `linkedOntology`; update
`checkShapeHierarchy`, `syncOntologies`, `registryData`, `registerInstalled` (index module);
fixtures and tests that used `linkedOntology` / `*.register`.
Validation: typecheck clean; ontology-registry, ontology-sync, shape-check, registerInstalled,
class-hierarchy suites pass.

### Phase 4 — Core's ontology modules in K9 form; tests declare their prefixes

Tasks: rewrite `linked-core.ts` with literal terms, add `ontologies/index.ts`, delete
`linked-core.register.ts`, entry imports the index; drop `Prefix.add` from rdf/rdfs/owl/xsd/shacl/sd/prov;
jest `setupFiles` with the test prefix map; fix tests that relied on implicit registration.
Validation: `npx linked build` ok; `npm test` all pass (2883 baseline + new).

### Phase 5 — Docs, consumer check, report

Tasks: README (prefix map, `Prefix.load`, `registerOntologies`, K11), JSDoc; master plan K8/K9
rows with the exact signatures; CN `npm run typecheck:gate` in the app worktree for the consumer
breakage list; changeset (major); report; delete this plan.
Validation: README matches the code; typecheck output quoted in the report.

Dependency: 1 → 2 → 3 → 4 → 5 (2 and 3 touch different files but phase 4's test run needs both).

## Implementation notes

### Phase 1 — inventory (done)

Readers of the prefix map in core (`src/`, tests excluded):

| Reader | Use | Change |
|---|---|---|
| `utils/NodeReference.ts` `resolvePrefixedUri` | silent expand; unused | removed |
| `utils/NodeReference.ts` `resolveUriOrThrow` | `.for`/`.forAll` (QueryBuilder), AskBuilder; `urn:x` threw "Unknown prefix urn" | via `Prefix.toFull` (schemes pass) |
| `paths/propertyPathSafety.ts` `expandRegisteredPrefixedName`/`pathRefIri` | string path step: unknown prefix → IRI `<p:x>` (silent) | strict |
| `paths/pathExprToSparql.ts` `refToSparql` + `warnOnUnregisteredPrefix` | warn once, then `<p:x>` | throws |
| `paths/pathExprToSparql.ts` `absoluteIri` | canonical key, `toFullIfPossible` (silent) | strict for strings |
| `sparql/sparqlUtils.ts` `formatUri`, `collectPrefixes` | compaction + PREFIX block (self-contained) | unchanged |
| `shapes/shapesToTurtle.ts` | own fixed table; `isValidLocalName` only | unchanged |
| `utils/Package.ts` `linkedOntology` | `Prefix.add(name)`, `_prefix` | replaced by `registerOntologies` |
| `ontologies/*.ts` | `Prefix.add` rdf, rdfs, owl, xsd, shacl, sd, prov, core, linked_core | removed |

Readers of the registry: `shapes/checkShapeHierarchy.ts` (`ns('')`, `terms`),
`ontology/syncOntologies.ts` (`ns('')`), `ontology/registryData.ts` (`load`, `files`, `name`),
`ontology/registerInstalled.ts` (imports `*.register` modules). String ids not expanded at all
(IRIs by contract): `UpdateBuilder.for`, `DeleteBuilder` ids, `toNodeReference` — unchanged.

Consumers (master tree, `grep` of the `Prefix` API and `linkedOntology(`): every ontology package
calls `linkedOntology` (auth, cli templates/generator, dcat, dcmi ×3, fuseki, npm, org, owl,
rdfs ×2, s3, schema, sentry, server ×7, server-utils, sioc, translation, xsd, plus the host app's
`packages/access`, `packages/documents` and 9 in its `src/`). Prefix readers outside core:
fuseki (`getFullURI`, `toFull` ×2, `toPrefixed`), server (`toFull` ×2, `toPrefixed`),
translation (`getFullURI`, `toPrefixed`), owl (`getPrefix`), rdfs (`findMatch`), shape-ui
(`toPrefixedIfPossible`), host app `src/` (`add` ×7, `delete` ×2, `toFullIfPossible` ×2,
`toPrefixedIfPossible`). Registry readers outside core: fuseki `fuseki.register.test.ts` and
server `ontology-prefix.test.ts` (`_prefix`), cli `ontologyModules.ts` (`_prefix` in a list of
module exports). These are F7's / F6's to convert.

### Phase 2 — `Prefix` (done)

`Prefix.load`, `toMap`, `isFullIri`, explicit `map` on `toFull`/`toPrefixed`/`toPrefixedIfPossible`/
`findMatch`/`getFullURI`/`getPrefix`, `UnknownPrefixError` (branded); `toFullIfPossible` and
`resolvePrefixedUri` removed; `resolveUriOrThrow(value, map?)`; `expandPrefixedName` replaces
`expandRegisteredPrefixedName`; the warn-once fallback in `pathExprToSparql` is gone. Tests: new
`prefix-scoped.test.ts` (12), `prefix-resolution`, `gap1-fixes`, `property-path-sparql`,
`security-path-injection` updated to the throw. Validation: typecheck clean; full jest run 2886
passed, the 3 failures were the old silent-IRI expectations, now changed (199 pass in those suites).

## Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
