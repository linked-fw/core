---
summary: Added `exec(target?: IDataset)` to the four query builders for running a query against an explicit dataset/router instead of the global dispatch, and threaded an optional dataset through `syncShape`/`syncShapes`. `exec` is now async (rejects, never sync-throws); a shared guard validates optional mutation methods. No routing/`LinkedStorage` changes.
---

# Targeted query execution — `exec(target?)`

Implements [ideas/026-targeted-query-execution.md](../ideas/026-targeted-query-execution.md).

## Problem

A query's `.exec()` always dispatched through the **global** `getQueryDispatch()` → `LinkedStorage`
(routes by shape → default). Some callers need to run a query against **one specific dataset** that
isn't the global default — e.g. a host app materializing a shape into a per-project branch-metadata store
that lives *outside* the main router. The prior options were temporary global-routing mutation
(races under concurrency) or a second ambient context — both undesirable.

## Solution

Let the caller pass the target explicitly. Since a router **is** an `IDataset`, `target` can be a
plain store or a router:

```ts
Person.select(p => p.name).exec(someStore);        // run on someStore; router untouched
NodeShape.create(data).withId(iri).exec(branchStore);
```

- **No target → unchanged** (global dispatch). `await query` (the PromiseLike path) always stays
  global — only an explicit `.exec(target)` overrides.
- `target.<kind>Query(this)` hands over the **live (closed) query** — exactly the `IDataset`
  contract; no `lower()`/IR at this layer (the store lowers it).

## Key design decisions

- **`selectQuery` required, mutations optional.** On `IDataset`, `selectQuery` is required but
  `create/update/deleteQuery` are optional per store. So `SelectBuilder.exec` dispatches inline
  (`target ?? getQueryDispatch()`), while the three mutation builders route through a shared
  `resolveMutationDispatch(kind, target)` helper that validates the target implements the op and
  otherwise raises `"The target dataset does not support <kind> queries."` This was the one
  divergence from the idea doc's unguarded pseudo-code (an optional method would otherwise be a
  `TypeError: not a function` at call time).
- **`exec` is `async` on all four builders.** Every failure path — a missing global dispatch
  (`getQueryDispatch()` throws synchronously) or an unsupported-target guard — now surfaces as a
  **rejected promise**, never a synchronous throw. This makes `builder.exec(bad).catch(…)` reliable
  and keeps `exec`'s `Promise<…>` return contract honest. SelectBuilder's short-circuits
  (`null` for null-subject / unresolved pending-context) and its `UnresolvedContextError → null`
  mapping are preserved via `try/catch`.
- **Bulk-vs-single normalization unchanged.** Update (`forAll`/`where`) and Delete (`all`/`where`)
  still normalize to `void` via `.then(() => undefined)`; id-based forms return the node /
  `DeleteResponse`.
- **`syncShapes` `ds` is a plan-time parameter, not per-thunk.** `syncShapes` does an orphan-detection
  read at plan time (`NodeShape.select()` for store shapes no longer in code). That read **must hit
  the same `ds`** as the thunks, or orphans get computed against the wrong store. So `ds` feeds both
  the orphan read (`.select().exec(ds)`) and every delete/create thunk. The returned thunks stay
  nullary (`() => Promise<void>`), so callers batch them exactly as before.

## Public API surface

```ts
// All four builders — target defaults to the global dispatch when omitted.
SelectBuilder.exec(target?: IDataset): Promise<Result>
CreateBuilder.exec(target?: IDataset): Promise<CreateResponse<U>>
UpdateBuilder.exec(target?: IDataset): Promise<R>
DeleteBuilder.exec(target?: IDataset): Promise<R>

// queryDispatch.ts — new exports
type MutationKind = 'create' | 'update' | 'delete'
resolveMutationDispatch(kind: MutationKind, target?: IDataset): QueryDispatch

// syncShapes.ts — optional dataset added
syncShape(target: typeof Shape | string, ds?: IDataset): () => Promise<void>
syncShapes(ds?: IDataset): Promise<Array<() => Promise<void>>>
```

Motivating use (a host app binding a Person):

```ts
const {store} = await getBranchMetadataStore(projectId, branch);
await syncShape(Person, store)();   // Person's sh:NodeShape into branch-metadata; main router untouched
```

## File structure

| File | Change |
|---|---|
| `src/queries/queryDispatch.ts` | New `MutationKind` type + `resolveMutationDispatch(kind, target)` helper (validates optional mutation methods; falls back to global dispatch). |
| `src/queries/QueryBuilder.ts` | `SelectBuilder.exec(target?)` → `async`; dispatch via `target ?? getQueryDispatch()`; `try/catch` preserves null short-circuits and `UnresolvedContextError` mapping. |
| `src/queries/CreateBuilder.ts` | `exec(target?)` → `async`, one-line dispatch via `resolveMutationDispatch('create', target)`. |
| `src/queries/UpdateBuilder.ts` | `exec(target?)` → `async` via `resolveMutationDispatch('update', …)`; bulk normalization retained. |
| `src/queries/DeleteBuilder.ts` | `exec(target?)` → `async` via `resolveMutationDispatch('delete', …)`; bulk normalization retained. |
| `src/shapes/syncShapes.ts` | `buildSyncThunk`, `syncShape`, `syncShapes` take optional `ds` and thread it to the orphan read + every `.exec(ds)`. |

## Test coverage

- `src/tests/exec-target.test.ts` (new) — per-builder: `exec(target)` routes to the target and not
  the global default; `exec()` with no target stays global; the `await`/PromiseLike path stays
  global; and each mutation builder **rejects** (not sync-throws) when the target lacks the op.
- `src/tests/shacl-syncshapes.test.ts` (extended) — `syncShape(Shape, store)()` and
  `syncShapes(store)` isolate all reads/writes into the store with the global router untouched; the
  store's orphan is seeded distinct from the global mock's orphan, proving the orphan read hit the
  store (that orphan is pruned; the global mock's is never touched).

Validation: `tsc --noEmit` (CJS + ESM) clean; full non-Fuseki suite **1281 passed**, 0 regressions;
Fuseki suite (run serially) **177 passed**; dual-package build clean.

## Known limitations / deferred

- **Lazy `ds` validation in `syncShapes`.** If `ds` implements `selectQuery` but not
  `create/deleteQuery`, the plan builds and the orphan read succeeds; failure only surfaces when a
  thunk runs. A plan-time fail-fast was judged not worth the extra code (no current caller passes a
  partial store). Accepted as-is.
- **Pre-existing Fuseki harness race (not from this change).** The `test:fuseki` npm script omits
  `--runInBand`, so the three `sparql-fuseki-*` suites run in parallel against one shared Fuseki
  dataset and produce spurious failures; running with `--runInBand` is green. Candidate for a
  separate harness fix.

## Out of scope

No routing/config/`LinkedStorage` changes — purely an execution-target override on the builder.
Supersedes the dataset-threading note in ideas-025 (single-shape sync).
