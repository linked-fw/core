---
summary: A boolean existence check for the query API — `Shape.exists(id)` and a terminal `.exists()` on the select builder — replacing the `select().where(…).one().catch(() => null)` workaround, whose row-or-null result invited a swallow that made an unreachable store indistinguishable from a missing node. Reuses the existing SELECT path (no `ASK`, no `IDataset` change) and normalises the query to one variable, one type triple, one filter, `LIMIT 1`.
source_plan: docs/plans/001-shape-exists.md (converted; plan removed)
packages: [core]
---

# 028 — `Shape.exists()` — a boolean existence check

Status: **done**. Suite **67 suites / 1654 passed / 120 skipped**, typecheck green (baseline before
this work: 1626 passed). Additive `minor`.

PR: [linked-fw/core#PR](https://github.com/linked-fw/core/pulls) → `dev`.

## The problem

Create Now carries this helper on ~12 save paths, to choose between `create` and `update`:

```ts
async function exists(shape: any, id: string): Promise<boolean> {
  return Boolean(await shape.select().where((item: any) => item.equals({id})).one().catch(() => null));
}
```

Three things are wrong with it, and only the third is about SPARQL:

1. **It cannot distinguish "absent" from "could not ask."** `.catch(() => null)` collapses a store
   outage, a transport error and a lowering failure into `false`. Every `exists ? update : create`
   then becomes an unconditional `create`, silently, in production.
2. **Its correctness is accidental.** It works today only because `mapSparqlSelectResult` has an
   internal fast path for an empty `resultMap` that returns `{id}` rows — behaviour no test guarded
   as public. And it is built on `select()` with no callback, which core's own test describes as
   *"selects nothing"* (`query-builder.test.ts`).
3. **The question had no direct expression.** `.one()` resolves to a row or `null`; converting that
   to a boolean was the caller's job, and the obvious way to do it was the swallow in (1).

### On the reported malformed query

The brief attributed the CN failure to an empty projection — `SELECT  WHERE {…}`, rejected by
Fuseki at column 3. **That does not reproduce on 2.17.0.** `selectToAlgebra` has unconditionally
projected the root alias since `4aba4da` (Mar 2026):

```ts
// Always include root alias as first projection variable
projection.push({kind: 'variable', name: rootAlias});
```

A probe of the exact CN call shape against this tree emits valid SPARQL, `Person.select()` has a
golden test asserting `SELECT DISTINCT ?a0`, and CN's installed `lib/esm` (2.17.0) contains the
same line. So on current core the workaround is *functionally* fine — which means whatever CN is
hitting (an older core, a shape without a resolvable scan IRI, or an unrelated failure) was
**hidden by the `.catch`**. That sharpens the case for this work rather than weakening it: the
defect is the swallow, and the swallow existed because the API offered nothing better.

## Public API

```ts
// The common case — mirrors the .for({id}) call it replaces
if (await SourceDocument.exists({id})) {
  await SourceDocument.update(values).for({id});
} else {
  await SourceDocument.create({id, ...values});
}

// "Does anything match?" — composes with everything the builder expresses
await Person.select().where((p) => p.name.equals('Semmy')).exists();
await Person.selectAll().forAll([a, b]).exists();

// Optional explicit dataset, as for .exec()
await Person.exists({id}, someStore);
```

`Shape.exists(id, target?)` is sugar over `QueryBuilder.from(this).for(id).exists(target)`. Both
return a real `Promise<boolean>` — never a row, never `null`, never an array to interpret.

## Key design decisions

- **`SELECT … LIMIT 1`, not `ASK`.** `ASK` is semantically the exact question, but reaching it
  means ~15 files across 3 packages: a `SparqlAskPlan`, `askPlanToSparql`, a new wire op and
  version bump, `mapSparqlAskResult` (`SparqlJsonResults` has no `boolean` field), and an
  **optional** `IDataset.askQuery`. Against a triple store both forms are one indexed lookup
  bounded at a row; `ASK` saves a small payload and nothing else. And an optional store method
  means every non-implementing store silently falls back — reintroducing the quiet-wrong-answer
  mode this feature exists to delete. Reusing SELECT means every store supports it as-is, with no
  IR, algebra, wire or contract change. Deferred to [backlog 036](../backlog/036-ask-query-support.md).

- **A terminal on the builder, plus a static.** `.exists()` lives on `SelectBuilder`, so one
  implementation serves both "does this id exist?" and "does anything match this where clause?".
  `Shape.exists` follows the `deleteAll` / `deleteWhere` precedent of a one-line static.

- **`Shape.exists` returns a `Promise`, not a lazy builder** — deliberately breaking the
  "statics return builders" convention. `exists` is a terminal question; handing back a thenable
  reproduces the "what does this actually resolve to?" ambiguity that caused the bug.

- **The API owns the cost, not the caller.** `.exists()` normalises before executing, so
  "cheapest correct SPARQL" is a property of the method rather than of how carefully the chain was
  written.

- **`p.id` is not projectable.** `QueryShape.get id()` returns `undefined` on the proxy target and
  `FieldSet.traceFieldsWithProxy` silently returns `[]` — so `select(p => p.id)` is
  indistinguishable from `select()`. The root-alias projection is what answers the question.

## Normalisation — what is dropped and what is kept

| | |
|---|---|
| **Dropped** | projection (`selectFn` / `fieldSet` / `selectAllLabels`), preloads, sorting, **pagination** (`limit`, `offset`) |
| **Kept** | filters (`where`), `minus` entries, the subject / subject list |
| **Applied** | `LIMIT 1` |

Projected properties lower to `OPTIONAL` traversals and `ORDER BY` never removes rows, so neither
can change whether a match exists.

Pagination is dropped rather than honoured, and this is the one non-obvious rule. `OFFSET` skips
rows of the **solution sequence**, whose cardinality depends on the projection — a multi-valued
projected property yields several rows per subject. Keeping `offset` while dropping the projection
let the same chain answer both ways:

```ts
// p1 has two friends.
Person.select(p => p.friends.name).for({id: p1}).offset(1).exists()
// un-normalised: 2 rows, skip 1 → true
// projection dropped, offset kept: 1 row, skip 1 → false
```

So `exists()` answers a question about the **match set, not about a page of it**. That also
settles the degenerate `.limit(0).exists()`, which now reports `true` when rows exist.

## Emitted SPARQL

```sparql
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0
WHERE {
  ?a0 rdf:type <https://linked.cm/shape/core/Person> .
  FILTER(?a0 = <linked://tmp/entities/p1>)
}
LIMIT 1
```

One projected variable, the shape's type triple, an equality filter on the subject, `LIMIT 1`. No
`OPTIONAL`, no property predicates, no `ORDER BY`, no `OFFSET` — regardless of what was chained
before `.exists()`. Pinned as a literal golden string.

Note this means existence is **shape-scoped**: `Person.exists(id)` asks "exists *as a Person*",
because every select scan emits the type triple. Existence without that constraint would need
`ASK` — backlog 036.

## Errors

`.exists()` contains no `catch`. A store, transport or lowering failure rejects.

That required separating it from `exec()`, which intentionally converts `UnresolvedContextError`
into `null` — "not ready", for a reactive layer that re-runs once the context lands. Inheriting
that would have flattened "could not ask" into `false`: the precise defect being fixed. `exec()`'s
body is now a shared private `_run(target, swallowUnresolvedContext)`; `exec` passes `true`
(behaviour unchanged), `exists` passes `false`.

Both entry points are `async`, so a malformed string IRI (`resolveUriOrThrow`, inside `.for()`)
rejects rather than throwing synchronously past the caller's `.catch()`.

The **only** case resolving `false` without a query is a query with no subject to ask about:
`.for(null)`, `.for(undefined)`, or an unresolved `PendingQueryContext` *as the subject*. "Does the
node with no id exist?" has a correct total answer.

## Files

| File | Responsibility |
|---|---|
| `src/queries/QueryBuilder.ts` | `exists()` terminal; `exec()` body extracted to `_run(target, swallowUnresolvedContext)` |
| `src/shapes/Shape.ts` | `static async exists(id, target?)` |
| `src/test-helpers/query-fixtures.ts` | `existsFactories` — kept **out of `queryFactories`** (see below) |
| `src/tests/query-builder.test.ts` | IR-level and mapping coverage |
| `src/tests/sparql-select-golden.test.ts` | literal SPARQL goldens |
| `src/tests/sparql-fuseki-coverage.test.ts` | live-store coverage |
| `package.json` | `--runInBand` for `test:fuseki` |

## Test coverage

| Suite | Tests | Covers |
|---|---|---|
| `query-builder.test.ts` | 13 | IR is bare (`projection`/`resultMap` empty, `limit 1`, no `sortBy`); a chained `select`/`orderBy` lowers identically to a bare exists; pagination dropped; `where` and `minus` retained; `.forAll()` subjects retained; row→`true` / `null`→`false` / `[]`→`false`; `.for(null)` resolves `false` **without dispatching**; a throwing store **rejects**; an unresolved where-context **rejects while `exec()` still resolves `null`**; a malformed IRI rejects rather than throwing synchronously; `.exists()` returns a `Promise`, not a builder |
| `sparql-select-golden.test.ts` | 4 | literal SPARQL for `existsById` and `existsWhere`; a decorated chain emits byte-identical SPARQL to a bare exists; the paginated chain emits no `OFFSET` and `LIMIT 1` |
| `sparql-fuseki-coverage.test.ts` | 11 | present → `true`, absent → `false`; string IRI accepted; shape-scoped (a `Dog` iri is not a `Person`); where-clause matching and not; unset projected property does not gate existence; `offset` does not flip the answer on a genuinely multi-row projection; `limit(0)`; `forAll` any-of; "any at all" before and after `clearAllData()`; a real `FusekiStore` on a non-existent dataset **rejects** |

The store-failure test exists in both the stub form (Phase 2, always runs) and the live form — the
anti-regression test for the original bug must not be skippable when Docker is absent.

## Behaviour changes

1. `exec()` is refactored but behaviourally identical, including the `UnresolvedContextError` →
   `null` convention.
2. `test:fuseki` now passes `--runInBand`. Without it the three matched suites ran in parallel
   workers against one shared dataset and clobbered each other's seed data — ~40 pre-existing
   failures for anyone running the documented command. `npm test` always passed the flag.

## A note on `queryFactories`

`existsFactories` is a separate export on purpose. Every entry in `queryFactories` must return a
live, serializable builder — `dsl-json-roundtrip.test.ts` enumerates them all and calls `.toJSON()`
on each. `.exists()` is terminal and returns `Promise<boolean>`; it has no wire representation
because it needs none, lowering to an ordinary SELECT.

## Known limitations

- Existence is shape-scoped (the `rdf:type` triple is always emitted).
- `exists()` has no DSL-JSON wire form. It does not need one — the SELECT it produces serializes
  normally — but a remote caller cannot send "an exists query" as such.

## Deferred

- [backlog 036](../backlog/036-ask-query-support.md) — `ASK` end-to-end, if a boolean on the wire
  or type-free existence is ever wanted.
- [backlog 037](../backlog/037-fuseki-suites-share-one-dataset.md) — the seven live-Fuseki suites
  share one hardcoded dataset, so any run without `--runInBand` corrupts itself.

## Downstream

Create Now's `src/features/document-studio/services/LinkedDocumentRepository.ts` should drop its
local `exists()` helper for `Shape.exists({id})` once this is released. **Not changed here** — that
file is owned elsewhere. The important part of the migration is deleting the `.catch(() => null)`,
not the call-shape change.
