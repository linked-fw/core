---
summary: >
  Sub-plan of Create Now master plan 057 (package repos) for `linked-fw/core` and the new
  `@_linked/npm`: step CK — package kinds `core:OntologyPackage` / `core:AssetPackage` in core,
  core's `npm:` module, `core:packageName` and the default-graph `OntologySync` fallback removed,
  and a new hand-made `@_linked/npm` package (ontology + shapes after `package.json`). Lands on `dev`.
status: Done
---

# 005 — Package kinds and `@_linked/npm`

## Master plan

[CN plan 057](../../../../docs/plans/057-package-repo-creation.md) —
`/Users/rene/web/create_now/docs/plans/057-package-repo-creation.md` (rules for every step,
status table, numbers, starter prompt). Steps land on integration branch `dev`.

## Contracts

Copied verbatim from plan 057; the rest are there. A step that changes one updates it here and in
057 in the same landing.

- **K-core** (provider CK; consumers PR, CN): `https://linked.cm/ont/core/OntologyPackage` and
  `https://linked.cm/ont/core/AssetPackage`, `rdfs:subClassOf core:Package`, exported as
  `coreOntology.OntologyPackage` / `coreOntology.AssetPackage`. Core has no `npm` module and no
  `core:packageName`; it refers to npm terms by IRI only. Registry records keep `core:package` /
  `core:version`.
- **K-npm** (provider CK; consumers PR, CN): package `@_linked/npm`, namespace
  `https://linked.cm/ont/npm/`, terms: classes `npm:Package` (⊑ `schema:SoftwareSourceCode`),
  `npm:Dependency`; literals `npm:name`, `npm:version`, `npm:description`, `npm:keyword`,
  `npm:license`, `npm:private`, `npm:range`; IRIs `npm:homepage`, `npm:repository`
  (⊑ `schema:codeRepository`), `npm:bugs`; people `npm:author`, `npm:contributor`,
  `npm:maintainer` (to `schema:Person`); `npm:dependency`, `npm:devDependency`,
  `npm:peerDependency`, `npm:optionalDependency`, `npm:engine` (to `npm:Dependency` with
  `npm:name` + `npm:range`). Shapes `NpmPackage`, `NpmDependency`. Exports
  `@_linked/npm/ontologies/npm` and `@_linked/npm/shapes/*`.
- **K-kind** (provider LK; consumers RK, PC, CO, CN, server): every `package.json` carries
  `"linked": { "kind": "app" | "ontology" | "assets" | "library" }`, merged into an existing
  `linked` object (e.g. `linked.serverOnly`), never replacing it. `linkedPackage` and `linkedApp`
  are gone; no reader accepts them. One helper, `linkedKind(json)` →
  `'app'|'ontology'|'assets'|'library'|undefined`, exported by `@_linked/cli`; `@_linked/server`
  keeps a byte-identical copy. A linked package is `kind !== undefined && kind !== 'app'`.
  `ontology` packages may carry shapes for their own terms; `library` is framework code.

  (CK consumes it for `@_linked/npm`'s own `package.json`: `"linked": {"kind": "ontology"}`. Core's
  own `package.json` gets `"library"` in step RK, not here.)

As built in CK (detail under K-npm, not a change to it): `NpmPackage` extends `CreativeWork` of
`@_linked/schema` (the shape check requires it, `npm:Package ⊑ schema:SoftwareSourceCode ⊑
schema:CreativeWork`), so its inherited `name` / `description` are `schema:name` /
`schema:description` and the `npm:name` / `npm:description` accessors are `npmName` /
`npmDescription`. `NpmDependency` has `name` and `range`. The term `npm:private` is exported as
`private_` (a reserved word).

## CK — Package kinds in core; `@_linked/npm`

**Depends on:** nothing (wave 1, parallel with LK and WC). **Repos:** core (`dev`), npm (new local
repo). **Plan doc:** core `docs/plans/006-…`. **Reports:** core `docs/reports/080-…`, npm
`docs/reports/001-…`. **Test port:** 4341. **Size:** medium, 2 phases: (1) core — kinds in,
`npm:` module, `core:packageName` and the default-graph fallback out; (2) the new `@_linked/npm`
package, built and wired into CN's workspace.

**Goal.** K-core and K-npm: core names the package kinds and nothing npm-specific; npm's terms live
in their own vocabulary package on `https://linked.cm/ont/npm/`, like every other `@_linked`
vocabulary.

**Scope.**
- Core: add `OntologyPackage`, `AssetPackage` (⊑ `core:Package`) to `coreOntology` and `core.ttl`;
  delete the `npm:` module (`npm.ts`, `npm.register.ts`, `npm.ttl`) and its index import; delete
  `core:packageName` and the `OntologySync.packageName` property; delete the deprecated
  default-graph sync (`syncDefaultGraph`, the per-package `OntologySync` nodes and the removal of
  their lines). Keep the `OntologySync` class and shape: the `'default'` graph mode records its
  hash on one `OntologySync` node (`DEFAULT_GRAPH_ONTOLOGY_NODE`), and the hierarchy probe reads
  through that shape.
- A store without graph queries no longer gets a fallback: the `'package'` and shared-graph modes
  throw a clear error naming the store (the error style of the `'default'` mode's blank-node
  checks). Report it under Deviations if a test or caller relied on the fallback.
- New package `@_linked/npm` (K-npm) at `/Users/rene/web/create_now/packages-local/_linked-npm`, a
  local git repo with branch `dev` (from an initial commit on `main`), no remote.
- Changeset in core (minor: the removals are small breaking changes, master decision). The npm
  package gets a changeset for its first release (`minor`, from `0.0.0` or `0.1.0`).
- Not here: `linked.kind` in core's or any other existing `package.json` (RK); CN code that uses
  the new terms (PR).

**Verify.**
- Core: `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs` green,
  `npm test` green, `npx linked build` clean; `git grep -n 'purl.org/on/npm\|packageName' src/ontologies src/data`
  finds nothing; `git grep -n 'ontologies/npm' src` finds nothing.
- npm: `npx linked build && npm test` (shape check) green; `npx linked generate-ontology --check`
  (cli `src/cli.ts:317-348`) reports nothing stale.
- CN, after rebuilding core and npm in the main checkouts and restarting the owner's CN on :4040
  (one ontology sync):
  `SELECT (COUNT(*) AS ?n) {GRAPH ?g {?s ?p ?o FILTER(STRSTARTS(STR(?s),"http://purl.org/on/npm/"))}}`
  on cn-main returns `0` (the core package's ontology graph content hash changes, so the sync
  replaces it; no migration). Same query with `https://linked.cm/ont/npm/` returns the new terms
  once something CN loads depends on `@_linked/npm` (PR adds CN's dependency; until then `0` is
  expected).
- The owner's path: sign in on :4040, open a project and its Ontology Manager.

**Done when.** K-core and K-npm hold as written; core's tests and build are green; the npm package
builds, passes its shape check and is a workspace member of CN (`npm ls @_linked/npm` from CN's
root resolves to `packages-local/_linked-npm`); both changesets exist; the purl query returns 0.

### Files (found in the code)

Core (`packages-local/_linked-core`):
- `src/ontologies/linked-core.ts` — `Package` `:28` (add `OntologyPackage`, `AssetPackage` next to
  it); `packageName` `:82` and in the export object `:117` (delete).
- `src/data/core.ttl` — `core:Package` `:34-37` (add the two classes with
  `rdfs:subClassOf core:Package`, label, comment); `core:packageName` `:139-142` (delete);
  `core:OntologySync`'s comment `:29-32` (rewrite: the `'default'` mode's record only).
- Delete `src/ontologies/npm.ts`, `src/ontologies/npm.register.ts`, `src/data/npm.ttl`.
- `src/index.ts:10-12` — the comment "(`core:`, `npm:`)" and the `npm.register.js` import.
- `src/shapes/OntologySync.ts` — `packageName` property `:31-35` (delete); the `@deprecated`
  JSDoc `:12-21` (rewrite); `ontologyTriples` `:43-47` goes with the fallback (also its term
  `core:ontologyTriples`, `linked-core.ts:84,119` and `core.ttl:122`, and the fixture's property shape)
  unless something outside the fallback reads it (`git grep -n ontologyTriples src` first).
- `src/ontology/syncOntologies.ts` (917 lines) — the fallback is wider than one function:
  `SyncOntologiesResult.fallback` `:110-116`; `ontologySyncNodeIri` `:131-137`, `toNTriplesLine`
  `:139-141`, `fromNTriplesLine`, `ontologyTriplesText` `:149-155`, `ontologySyncHash` `:157-163`;
  `StoredNode`, `readSyncNodes` and the per-package half of `readSyncState` `:230-271` (keep the
  `DEFAULT_GRAPH_ONTOLOGY_NODE` read — `'default'` mode); `removeSyncNode` `:365-383`; the
  fallback calls `:426-429`, `:496-499`, `:765-767`; `syncDefaultGraph` `:610-677` (the
  `OntologySync.upsert({packageName…})` at `:655`); the "remove earlier default-graph lines"
  branches in `syncGraphs` (`:479` onwards) and the shared and default modes (`:749`, `:846`) that
  use `nodes`. The JSDoc of `syncOntologies` `:396-405` and the file header `:1-50` describe the
  fallback.
- `src/ontology/hierarchyProbe.ts:51,134-170` — uses `OntologySync` as a default-graph shape; keep.
- `src/utils/ShapeCatalog.ts:30-33,61` — lists `OntologySync`; keep.
- `src/tests/fixtures/core-shapes.ttl:347-353` — the `OntologySync/packageName` property shape
  (and the node shape's `sh:property` line for it, `:328`); the `ontologyTriples` one if that goes.
- `src/tests/ontology-sync.test.ts` — header `:8` and `describe('syncOntologies: the default-graph
  fallback')` `:103` (delete); `:469` (a graph write failure is never a fallback: keep, reword).
  Other tests that mention the fallback or `OntologySync`: `ontology-sync-fuseki.test.ts`,
  `hierarchy-probe.test.ts`, `graph-query.test.ts`, `shape-graphs.test.ts`,
  `sparql-negative.test.ts`, `dataset-pin-identity.test.ts`,
  `property-path-named-resolution.test.ts`, `property-label-round-trip.test.ts`,
  `file-storage.test.ts` (`git grep -ln 'OntologySync\|fallback' src/tests`).
- `docs/architecture/ontologies.md:25-28` (core and npm registered like a package: npm goes),
  `:198` (the per-package sync node), and wherever it describes the default-graph fallback.
- `README.md` — check for the `npm` module and `core:packageName`.
- Unchanged and kept: registry records use `core:package` / `core:version`
  (`src/shapes/NamedGraph.ts:319,325,361`, `src/queries/graphRecords.ts:51-52`).

New `@_linked/npm` (`packages-local/_linked-npm`), on the layout of `packages-local/_linked-rdfs`
(its tracked files: `git -C packages-local/_linked-rdfs ls-files`):
- `.changeset/README.md`, `.changeset/config.json`, `.gitattributes`, `.gitignore`;
- `.github/workflows/pr.yml` and `publish.yml` calling `linked-fw/.github/.github/workflows/…@v1`
  (copy rdfs's; `require-tests` as rdfs has it);
- `renovate.json`, `LICENSE` (MIT), `NOTICE`, `README.md`, `CHANGELOG.md` (empty heading);
- `package.json`: name `@_linked/npm`, `"type": "module"`, exports `.`, `./*.js`, `./*` and
  `typesVersions` as rdfs, `"linked": {"kind": "ontology"}`, `linkedOntologies`
  `{"npm": {"namespace": "https://linked.cm/ont/npm/"}}`, scripts `build: linked build`,
  `test: node --test test/*.test.mjs`, dependencies `@_linked/core`, `@_linked/schema` (for
  `SoftwareSourceCode`, `Person`, `codeRepository`), devDependencies like rdfs;
- `src/package.ts` (`linkedPackage('@_linked/npm')`, as rdfs's), `src/index.ts`;
- `src/ontologies/npm.ts`, `npm.data.ts`, `npm.register.ts` generated by `linked generate-ontology`
  from `linkedOntologies` (`.data.ts` is generated, never edited: see rdfs's header);
- `src/data/npm.ttl` — the K-npm terms, each typed, labelled, commented, with the alignments
  (`npm:Package rdfs:subClassOf schema:SoftwareSourceCode`, `npm:repository rdfs:subPropertyOf
  schema:codeRepository`, people ranges `schema:Person`);
- `src/shapes/NpmPackage.ts`, `src/shapes/NpmDependency.ts`, `src/shapes/index.ts`;
- `test/shape-check.test.mjs` (copy rdfs's, mirrors list = the npm namespace only).
- CN picks it up through the `packages-local/*` workspace glob after `npm install` at CN's root
  (the postinstall hook restores the committed lockfile; never commit a lockfile listing
  `packages-local/`). Do not add it to CN's `package.json` here.

### Pitfalls

- **Two `linkedPackage`s.** `linkedPackage('<name>')` in `src/package.ts` is core's registration
  function and stays; only the `"linkedPackage": true` field of `package.json` is replaced (K-kind).
- **The npm package is read before LK lands.** Until LK, the CLI and server only treat a package
  as linked through `"linkedPackage": true`. Give `@_linked/npm`'s `package.json` both
  `"linked": {"kind": "ontology"}` and `"linkedPackage": true` so `linked build` and boot loading
  accept it now; RK removes the old flag with every other package's. Say so under Deviations.
- **Keep the `'default'` mode.** `OntologySync` is not only the fallback: the `'default'` graph
  mode's node and the hierarchy probe use it. Delete the per-package nodes, not the class.
- **The shape check and `schema:`.** `npm:Package ⊑ schema:SoftwareSourceCode ⊑
  schema:CreativeWork`; `@_linked/schema` has `CreativeWork` and `Person` shapes but no
  `SoftwareSourceCode` shape. Run the shape check early and follow what it asks (extend
  `CreativeWork`, or none); report a finding you cannot resolve without a design choice.
- **No migration.** Old `http://purl.org/on/npm/` triples in cn-main and app datasets heal on the
  next ontology sync (core's graph's content hash changes → `replaceContent`). CN's
  `src/services/projectOntologies.test.ts:25,30` has the purl IRI as fixture data only; leave it.
- **`create-ont-package` is not used**: it would name the package `npm-ont`.
- **Owner actions at release only** (plan 057 §Owner actions): repo `linked-fw/npm`, first publish
  by hand, trusted publisher. Never add a remote, push or publish.
- Rebuild core and npm in the main checkouts after landing (`npx linked build`), else the owner's
  CN runs the stale `lib/`.

### Architecture

- Core `docs/architecture/ontologies.md` (core's own vocabularies; ontology sync, the default
  mode, the per-package sync node) — update it in the same landing.
- CN arch-03 §Package types and §Standard-vocabulary packages
  (`/Users/rene/web/create_now/docs/architecture/03-packages-and-governance.md:15,41`), arch-01
  §Package (kinds as RDF subclasses).

### Tests

- **Quick gate (1–2 min, after each phase):** core
  `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/ontology-sync.test.ts src/tests/ontology-registry.test.ts src/tests/auto-load-ontology-data.test.ts src/tests/metadata.test.ts`;
  npm `npx linked build && npm test`.
- **Full gate (landing):** core `npm test` (jest + typecheck; the Fuseki suites need
  `FUSEKI_BASE_URL`/`FUSEKI_ADMIN_PASSWORD` of a Fuseki of your own, never :3030's datasets) and
  `npx linked build`; npm `npx linked build && npm test`; CN `npm run typecheck:gate` and
  `CN_TEST_PORT=4341 npm run test:regular` (CN code is unchanged, but it runs the new core).
- New tests: core — `coreOntology.OntologyPackage`/`AssetPackage` exist and `core.ttl` types them
  `rdfs:subClassOf core:Package`; `coreOntology` has no `packageName`; the `'package'` mode on a
  dataset without `graphQuery` throws. npm — the shape check; every K-npm term is exported and
  in `npm.ttl`.

## Progress

- [x] CK — landed on `dev` (core and the new npm repo); reports core
  [080](../reports/080-package-kinds-and-npm-out-of-core.md), npm `docs/reports/001-npm-ontology.md`.

## Follow-ups

- ~~`@_linked/server` reads the removed `fallback` result field~~ — done (core report 080, addendum).
- `@_linked/npm` first release (remote, lockfile, first publish, trusted publisher): npm
  `docs/backlog/001-first-release.md`; plan 057 §Owner actions.
