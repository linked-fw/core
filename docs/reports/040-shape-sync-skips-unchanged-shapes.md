---
summary: >
  Shape sync skips unchanged shapes. Each synced NodeShape stores `core:shapeHash`, a SHA-256 of the
  canonical create data sync writes for it; `syncShapes` reads all stored hashes in one select and
  rewrites only shapes whose hash is missing or differs, so an unchanged app's boot writes nothing.
  `force: true` rewrites regardless. `SHAPE_HASH_VERSION` plus a golden/ledger test force a full
  rewrite when core changes its SHACL output. Minor (2.33.0); since 2.35.0 core's six built-in
  shapes are synced with the same skip.
packages: [core]
---

# 040 — Shape sync skips unchanged shapes (`core:shapeHash`)

## Problem

`syncShapes()` planned a delete (cascade) → create for every registered shape on every run, even
when the stored SHACL was identical, so every app boot wrote to app-data
(`synced shapes into app-data ...: 14 shape(s) written`). Create Now wants to fork a branch dataset
on its first write (CN backlog 115), so an unchanged boot must not count as a write.

## What was built

- **Hash.** `shapeSyncHash(data, iri)` (`src/shapes/syncShapes.ts`) is SHA-256 hex of
  `linked-shape-sync/<SHAPE_HASH_VERSION>\n` + a canonical form of `{iri, data}`, where `data` is
  the exact create data sync writes: the NodeShape, its flattened own and inherited property shapes,
  `sh:in` lists, paths, and the generated single-owner shapes (`core:generatedShape`). Canonical
  form: sorted object keys, sorted array values (an array in create data is always a set; ordered
  `rdf:List`s are nested `first`/`rest` objects, so their order is kept), tagged non-string
  scalars, shape classes written as their NodeShape IRI. No blank-node labels, key order or array
  order enter it.
- **Dependencies covered.** Inherited property shapes are flattened into the child's data (a parent
  change changes the child's hash); generated single-owner shapes are in the data and their `sh:or`
  owner classes come from registered sub-shapes (registering a sub-shape changes the declaring
  shape's hash). `sh:node` / `sh:class` references are IRIs, so another shape's content is not part
  of this shape's hash.
- **SHA-256.** `src/utils/sha256.ts`: small, synchronous, pure-JS SHA-256 over UTF-8; no
  `node:crypto`, no async SubtleCrypto, no dependency. Checked against FIPS vectors and
  `node:crypto`.
- **Term.** `core:shapeHash` (`https://linked.cm/ont/core/shapeHash`, `xsd:string`, max 1) in
  `src/ontologies/linked-core.ts`, registered as `NodeShape.shapeHash` in `src/utils/Package.ts`.
  The create writes it on the NodeShape (an IRI subject).
- **`syncShapes(ds, options)`** reads the stored hashes of all code shapes in one select against
  the same `ds` / router as the writes:
  ```sparql
  SELECT DISTINCT ?a0 ?a0_shapeHash WHERE {
    VALUES ?a0 { <…shape IRIs…> }
    ?a0 rdf:type shacl:NodeShape .
    OPTIONAL { ?a0 core:shapeHash ?a0_shapeHash . }
  }
  ```
  It builds a delete→create thunk only for a shape whose hash is missing or differs. It still
  returns an array of thunks, so its length is shapes written plus pruned orphans. The orphan sweep
  (`orphanScope`) is unchanged.
- **`syncShape(target, ds, options)`** still returns one thunk; unless `force` is set the thunk
  reads the one hash first and writes nothing when it matches.
- **Existing stores.** Shapes stored by earlier versions have no hash; each is rewritten once.
- **Built-in shapes (2.35.0, core#343, report 037).** `syncShapes` also writes core's six built-ins
  (`Shape`, `NodeShape`, `PropertyShape`, `List`, `PathNode`, `PathList`) with the same skip; they
  are rewritten only when their hash changes, e.g. when processes on different core versions sync
  one dataset. Under `orphanScope: 'ownedNamespaces'` core's namespace is never pruned.

## Public API (2.33.0, minor)

- `SyncShapesOptions.force?: boolean` and new `SyncShapeOptions {force?: boolean}` (third argument
  of `syncShape`); both types exported from the package root.
- Vocabulary term `core:shapeHash` / accessor `NodeShape.shapeHash`.
- `SHAPE_HASH_VERSION` is exported `@internal` (tests only).

```ts
import {syncShapes} from '@_linked/core';
const plan = await syncShapes(ds);             // [] when nothing changed
for (const run of plan) await run();
await syncShapes(ds, {force: true});           // repair a store edited outside sync
```

## Keeping the hash honest: `SHAPE_HASH_VERSION`

A core change that writes different triples for the same create data does not show in the hash.
Such a release must bump `SHAPE_HASH_VERSION`, so every stored shape is rewritten once.
`src/tests/shape-sync-output-equivalence.test.ts` enforces it: an append-only `SHAPE_HASH_LEDGER`
of `{version, goldenDigest}` (SHA-256 of `GOLDEN_SYNC_OUTPUT`) must be consecutive from 1 and its
last entry must equal the current version and golden digest. Regenerating the golden without a
bump, or bumping without a ledger entry, fails with the exact steps to fix it (verified by a
reverted experiment in the PR).

## Files

| File | Responsibility |
|---|---|
| `src/shapes/syncShapes.ts` | canonical form, `shapeSyncHash`, `SHAPE_HASH_VERSION`, the hash read and skip in `syncShapes` / `syncShape`, the options |
| `src/utils/sha256.ts` | synchronous SHA-256 |
| `src/ontologies/linked-core.ts`, `src/utils/Package.ts` | `core:shapeHash` term and `NodeShape.shapeHash` property |
| `src/index.ts` | exports `SyncShapesOptions`, `SyncShapeOptions` |
| `docs/architecture/owned-values.md`, `docs/architecture/ontologies.md` | the term and the skip |

## Tests

- `src/tests/shape-sync-hash.test.ts` (15): an unchanged second sync makes one select and returns
  `[]`; one changed shape is rewritten alone; a change that only shows in a generated single-owner
  shape rewrites the owner; a missing hash is rewritten once; `force` writes with no read; the
  orphan sweep under `'all'` / `'none'` and generated shapes; `syncShape` read-only rerun and
  `force`; hash stability (order-independent, sensitive to value, IRI, list order, literal type);
  a pinned canonical string and digest cross-checked with `node:crypto`.
- `src/tests/shape-sync-output-equivalence.test.ts`: the golden now has one `core:shapeHash`
  triple (checked separately, stripped before the comparison) and the ledger tests above.
- `src/tests/sparql-fuseki-shape-sync.test.ts` (live Fuseki): every synced shape carries a
  64-char hash and a re-sync returns `[]`; a deleted hash is rewritten then skipped; a changed
  `maxCount` rewrites only that shape with no orphan blank nodes. Idempotence and blank-node
  stability tests re-sync with `force: true`.
- `src/tests/single-owner-constraint.test.ts`: an unforced `syncShape` now makes one select (the
  hash read).
- At merge: 2263 unit tests and 303 live Fuseki tests passed.

## Known limits

- The hash records what sync last wrote, not what the store holds. If another writer edits or
  partly deletes the subtree but leaves the NodeShape and its hash, sync skips it until the code
  changes or `force: true` is used. A cheap presence check (e.g. `sh:property` count) was rejected:
  it catches only a removed link and turns the read into an aggregate.
- The create is one request, so hash and subtree land together; an interrupted delete→create
  leaves no hash and the next sync rewrites the shape.

## Follow-ups

- `@_linked/server` (`materializeShapes`): optional wording for the zero case ("all shapes up to
  date") and an env switch for `force`. Not recorded in a backlog.
- Create Now backlog 115 (fork the branch dataset on first write) depended on this; picked up
  through Renovate's core bump.

## PRs

- https://github.com/linked-fw/core/pull/340 (2.33.0)
