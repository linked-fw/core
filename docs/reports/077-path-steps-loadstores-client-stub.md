---
date: 2026-10-25
summary: >
  A property path step reaches a query only as `<IRI>` or as a registered prefixed name, and a bad
  stored path fails at load with `InvalidPropertyPathError` (backlog 008). `loadStores` names the
  alias of a store constructor error (backlog 074). Client builds get a `loadOntologyFiles` stub
  through export conditions, so no `import(variable)` reaches a Vite or Metro bundle. Backlog
  housekeeping: 008, 040, 044, 074 deleted, 032 narrowed, 060 corrected. Minor.
---

# 077 — Path steps, `loadStores` errors, a client stub for `loadOntologyFiles`

## What changed

### Property path steps (backlog 008, SEC4)

- `pathExprToSparql` writes every step through `formatUri` (`<…>` plus `assertSafeIri`, then prefix
  shortening). A string step counts as a prefixed name only when it is one SPARQL
  `PN_PREFIX? ':' PN_LOCAL?` token (§19.8, `PN_LOCAL_ESC` excluded) and its prefix is registered; it
  is expanded first. So `rdf:type?o.?s?p?o.FILTER(true)#` becomes one IRI, and a `urn:prop:a` step
  in a complex path is `<urn:prop:a>` instead of an undeclared prefix (a parse error).
- `collectPathUris` returns the full IRI of a registered prefixed-name step, so its `PREFIX` line is
  declared (before, a path like `rdf:type/ex:b` relied on another term declaring it).
- The parser keeps a bracketed IRI without `://` (`<urn:prop:a>`) as `{id}`; as a bare string it
  would read as a prefixed name.
- A step with an unregistered prefix warns once per prefix (bare-IRI schemes such as `urn:` and
  `mailto:` excepted), since `<shcema:name>` matches nothing.
- New `src/paths/propertyPathSafety.ts`: `assertSafePropertyPath` checks every step when a path
  loads, in `normalizePropertyPath` (decorators), `fromWire`, `ShapeCatalog.from` and
  `registerRuntimeShape`. A string step must be a prefixed-name token or a bare absolute IRI
  without path operators; an `{id}` must pass `assertSafeIri`. Anything else throws
  `InvalidPropertyPathError` (exported, branded), carrying `step` and `propertyShape`. A
  `{id: undefined}` ref, which a simple store reader gives for a blank-node path, is tolerated: it
  writes nothing into a query.
- Tests: `security-path-injection.test.ts` (the investigation's payloads in every path position,
  the `urn:` case, the grammar, each load point); `property-path-sparql.test.ts` registers `ex`.

### `loadStores` (backlog 074)

The store constructor call is wrapped; an error is rethrown as
`loadStores: alias "<alias>" (<entry.store>): <message>` with the original as `cause`. Test in
`load-stores-loader.test.ts`.

### `loadOntologyFiles` in client bundles

- `package.json` has exact entries for `./ontology/loadOntologyFiles` and `.js`, before the
  wildcards: `react-native` and `browser` resolve to `lib/esm/ontology/loadOntologyFiles.browser.js`,
  `import`/`default` to the real module. The stub holds no `import()` and rejects with
  "loadOntologyFiles is server only".
- Core's own `ontologies/linked-core.ts` and `ontologies/npm.ts` import it by the package
  specifier (a self-reference), since a relative import ignores export conditions. This is the
  form every vocabulary package's generated `<prefix>.data` already uses. `tsconfig.json` `paths`
  and a jest `moduleNameMapper` entry map the specifier to the source for typecheck and tests; the
  emitted `.d.ts` does not mention it. Both modules are stateless, so a self-reference that
  resolves to another installed copy is harmless.

### Backlog

- Deleted: 008 (closed above), 074 (closed above), 044 (closed by #258), 040 (done in 67e015b;
  its two small gaps are one paragraph in `docs/backlog/README.md`).
- 032 is rewritten down to what remains: bundlers other than the cli's Vite config, and no build
  step that injects `@linkedShape({name})`.
- 060 is corrected: the crash comes from Create Now's hoisted jest 29.7, not jest 30; under core's
  own jest 30 `two-copies-built` passes. The fix is in Create Now.

## Proof for the client stub

- Scratch Vite 8.3.5 browser build of an app importing `@_linked/core`, `@_linked/schema` and
  `linked-core`'s `loadData`, with this branch's tarball (deduped, one core):
  `grep -o "node:fs/promises" -r dist | wc -l` → `0`, and no `import(<identifier>)` in `dist`. The
  same build with core 2.42.1 from npm: `1`.
- cli react-native template (Expo 57, RN 0.86), scaffolded with the cli at main, with
  `rejectComputedImports` removed from `babel.config.js`:
  - core 2.42.1: `npx expo export --platform ios` fails in Hermes, `error: Invalid expression
    encountered` at `return yield import(/* @vite-ignore */ /* webpackIgnore: true */specifier);`.
  - this branch's `lib` and `package.json`: `iOS Bundled 13039ms apps/mobile/index.ts (716
    modules)`, `Exported: ../../../export-new`. The `.hbc` holds `loadOntologyFiles is server only`
    once and `node:fs/promises` zero times. Metro honours the `react-native` condition.

## Gate

Standalone clone, own Fuseki on 3341 (`FUSEKI_BASE_URL=http://localhost:3341`,
`FUSEKI_ADMIN_PASSWORD=admin`), after rebasing onto `origin/main`:

- `npx linked build`: `✔ Build successful`
- `npm test` (jest, then typecheck): exit 0. `Test Suites: 4 skipped, 144 passed, 144 of 148
  total`; `Tests: 122 skipped, 2913 passed, 3035 total`; `[fuseki] live tests: 398 total — 396
  passed, 0 failed, 2 skipped`. `two-copies-built` passes.
- `npm run check:dts`: clean.

## Review

An independent review found no high findings. Medium: (1) an unregistered prefix now fails
silently as `<prefix:local>` — fixed with the once-per-prefix warning; (2) one refused stored path
fails the whole `ShapeCatalog.from` — kept, because the brief asks a bad stored path to fail loudly;
the changeset names it and says to write such a step as `{id}`. Lows: the jsdom/browser-condition
test environment gets the stub (now in the changeset); `loadStores` rethrows a plain `Error` (as
specified, original kept as `cause`); `canonicalPathKey` expands `{id: 'ex:name'}` while the query
does not (older behaviour, left); the 040 gaps live in the README, not an item (as asked).

## Follow-ups

- The 040 gaps (duplicate parent through an undecorated intermediate class; data-only shapes absent
  from `get*ShapesClasses`): `docs/backlog/README.md`.
- 032 (other bundlers, injected names) and 060 (CN's jest): their backlog items.
- The cli react-native template drops its `rejectComputedImports` Babel plugin once this is
  released (cli PR).

## PR

**What changed**

- **Path steps (backlog 008).** Every property path step is written through `formatUri`. A string
  step is a prefixed name only when it is one SPARQL `PN_PREFIX ':' PN_LOCAL` token with a
  registered prefix; anything else is `<IRI>`, so `rdf:type?o.?s?p?o.FILTER(true)#` is one IRI and
  `urn:prop:a` no longer breaks a complex path. The parser keeps `<urn:…>` as `{id}`. Paths are
  checked when they load (`normalizePropertyPath`, `fromWire`, `ShapeCatalog.from`,
  `registerRuntimeShape`); a bad step throws the new `InvalidPropertyPathError`. An unregistered
  prefix warns once. `collectPathUris` returns the expanded IRI of a prefixed step, so its PREFIX is
  declared.
- **`loadStores` (backlog 074).** A store constructor error is rethrown as
  `loadStores: alias "<alias>" (<store>): <message>`, the original as `cause`.
- **`loadOntologyFiles` stub.** `./ontology/loadOntologyFiles` has `react-native`/`browser` export
  conditions pointing to a stub that rejects ("server only") and has no `import()`. Core's own
  ontology modules import it by package specifier so the conditions apply to them too.
- **Backlog.** Deleted 008, 040 (gaps recorded in the backlog README), 044, 074; narrowed 032;
  corrected 060 (CN's hoisted jest 29.7, not jest 30).

**Verification**

- Vite 8.3.5 browser build with this branch's tarball: `grep -o "node:fs/promises" -r dist | wc -l`
  → `0` (core 2.42.1 from npm: `1`).
- cli react-native template with its Babel plugin removed, `npx expo export --platform ios`:
  core 2.42.1 → `error: Invalid expression encountered` (Hermes, at the `import(specifier)`); this
  branch → `iOS Bundled 13039ms apps/mobile/index.ts (716 modules)`, `Exported: …`.
- Gate (standalone clone, own Fuseki on 3341, rebased on `origin/main`): `✔ Build successful`;
  `npm test` exit 0 — `Test Suites: 4 skipped, 144 passed, 144 of 148 total`, `Tests: 122 skipped,
  2913 passed, 3035 total`, `[fuseki] live tests: 398 total — 396 passed, 0 failed, 2 skipped`;
  `check:dts` clean.

**Deviations**

- `{id: undefined}` path refs (what a simple store reader gives for a blank-node path) load
  without error; they write nothing into a query.
- Review medium kept as specified: one refused stored path makes `ShapeCatalog.from` throw for the
  whole catalog. The changeset says so.

**Follow-ups**

- 040's two gaps: `docs/backlog/README.md`. 032 and 060: their backlog items.
- cli: remove the react-native template's `rejectComputedImports` Babel plugin after this release.
