---
summary: >
  A nested create without `__id` returns the id it is written under: `SparqlDataset` mints nested
  ids into the IR (`mintNestedIds`) before compiling, so the compiler and the result mapper read the
  same id (create, update, upsert). Under graph routing, a nested node two levels deep that belongs
  in the mutation's own graph no longer crashes the compiler (`Invalid IRI … null`). Backlog 072
  closed, 071 dropped, 063's react part done (react's test double, its record-form typing).
packages: [core, react]
---

# 054 — Nested create ids

## PR

### Summary

A nested create without `__id` was written under a minted IRI but returned with `id: ''`, so the
caller could not address the node it had just created (backlog 072). The store now mints nested
ids into the IR when it builds it, as it already did for the subject, and the compiler and the
result mapper both read that id. The same code had a crash under graph routing: a nested node two
levels deep whose shape belongs in the mutation's own graph (A in the default graph, nesting B
routed to gB, nesting C in the default graph) got `target: null` and failed with `Invalid IRI for
SPARQL output: null`. That is fixed for create, update and upsert.

Backlog 071 (default-graph `syncShape` cuts incoming links) is deleted without change: the owner
decided it concerns the legacy layout; apps on current dependency ranges use shape graphs.
Backlog 063 is narrowed to shape-ui; react's part is in react's own PR.

### Changes

- `src/sparql/irToAlgebra.ts`: `mintNestedIds(ir, options)` (exported, also from
  `@_linked/core/sparql`) walks a create / update / upsert / update-where IR and gives every nested
  create that the compiler writes as an IRI and that has no id a `generateEntityUri` id, in place,
  under the IR's shape catalog. Nested values in single fields, arrays and set `add` items are
  covered. A value under a blank-capable `sh:nodeKind` keeps no id (it is still written as a blank
  node); `sh:Literal` still errors in the compiler.
- `src/sparql/irToAlgebra.ts` `childPlacement`: `target` is `null` (the plan's own graph) only when
  the holder is written there too; below a holder written elsewhere, the plan graph is named and
  collected as a block of its own.
- `src/sparql/SparqlDataset.ts`: `createQuery` and `updateQuery` call `mintNestedIds` right after
  lowering (before the owned-link check and the compile).
- Tests: `graph-routing-nested.test.ts` (ids in create / update / upsert results, a set add writes
  a minted id, a new id per run, two levels deep across graphs in create, update, upsert,
  update-where and with a named plan graph),
  `graph-routing-nested-fuseki.test.ts` (live: the minted id is selectable and in its own shape's
  graph; two levels deep in create, update, upsert), `blank-nested-nodes.test.ts` (blank-capable
  values stay without id). Fixture: `NGPerson.favoritePhoto` (a link to `NGPhoto`).
- Changeset `nested-create-ids.md` (patch).
- Docs: backlog 071 and 072 removed, 063 narrowed to shape-ui; report 051's "Observed, not
  changed" points here.

### Verification

Worktree `fwfix`, own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3303 (compose project
`fuseki-fwfix`), `FUSEKI_BASE_URL=http://localhost:3303 LINKED_CORE_TEST_COMPOSE_PROJECT=fuseki-fwfix
REQUIRE_FUSEKI=1` exported before every jest run.

- The new unit tests fail without the fix: 5 `✕`, three with `Invalid IRI for SPARQL output: null.`
- `npx linked build`: `✔ Build successful`.
- jest without `two-copies-built` (backlog 060): `Test Suites: 4 skipped, 134 passed, 134 of 138
  total`, `Tests: 120 skipped, 2698 passed, 2818 total`, `[fuseki] live tests: 359 total — 359
  passed, 0 failed, 0 skipped`.
- `two-copies-built.test.ts` alone: `Module cache already has entry …/lib/esm/shapes/SHACL.js. This
  is a bug in Jest` (backlog 060, known).
- `npm run typecheck`: clean. `npm run check:dts`: clean.
- Dependents grepped for reliance on the empty id (CN `src`, `packages/*/src`, server,
  server-utils, auth, react, shape-ui): none reads a nested create result's `id` as "not created".

### Deviations

- React needed more than the test double to pass against current core: a type fix in
  `LinkedComponent.ts` (published code) and a cast in one test; see Details.
- The changeset is a patch although it adds the `mintNestedIds` export, as the task asked: the
  export is a helper for stores, the change is a fix.

### Review

An independent read-only review of the core diff found no medium or high issues. Low findings
applied: the set-add test no longer claims a returned id, the named-plan-graph update test checks
which block the grandchild lands in, update-where has its own case, the changeset names both the
default and a named plan graph. Not applied: returning set-add ids in the update result (below),
and deriving `mintsAsIri` and `nestedNodeKind` from one helper (the blank-node test pins both).

### Follow-ups

- Shape-ui's test double: backlog [063](../backlog/063-test-doubles-in-other-repos-need-graphquery.md).
- The jest module-cache crash also stops react's `across-copies.test.tsx` locally (core linked
  from `packages-local`): backlog 060.

## Details

### Why mint in the IR

The subject's id was already minted in `SparqlDataset.createQuery` after `lower()` and written
back into `ir.data.id`; the compiler (`generateNodeDataTriples`) only fell back to
`generateEntityUri` for nodes without an id, and `mapSparqlCreateResult` / `mapSparqlUpdateResult`
echo the IR. Minting nested ids at the same point keeps one source of truth: the IR. Handing the
compiler's minted ids back to the mapper would have needed a side channel out of the pure
compile functions. The compiler fallback stays, for callers that compile IR directly
(`createToSparql(ir)`), which get the old behaviour.

### Which nodes get an id

`mintsAsIri(property)` mirrors `nestedNodeKind`'s "without id" column: unset, `sh:IRI` and
`sh:IRIOrLiteral` mint an IRI; `sh:BlankNode`, `sh:BlankNodeOrIRI` and `sh:BlankNodeOrLiteral`
write a blank node and must not get an id (an id would turn a `BlankNodeOrIRI` value into an IRI,
and make `BlankNode` values throw); `sh:Literal` is left to the compiler's error. Nested values are
found where the compiler finds them: a single nested object, array items, and `add` items of a set
modification (`remove` items are references). The walk recurses into every nested create,
including blank ones, since an IRI node can sit below a blank one.

Minting is in place on a fresh IR: `lower()` builds a new IR on every `exec`, so running the same
builder twice mints new ids (tested).

`update_where` also mints, for uniformity; its INSERT runs per WHERE solution, so every matched
subject links the same nested node — the same as before, when the compiler minted once per compile.
Its result is still `{id: ''}` (unchanged).

### The placement crash

`NestedPlacement.target` is `null` for "the plan's own graph" (the triples returned to the caller,
which the plan puts in its `GRAPH`, `WITH` or default graph) or a graph IRI for an `elsewhere`
bucket. `nestedCreateTriples` keeps a child's triples with its holder when the targets are equal,
else moves them to `elsewhere[child.target]`. A grandchild back in the plan graph under a holder in
`elsewhere` got `null` from `childPlacement`, unequal to the holder's graph, and was stored under
the key `null`. Now `childPlacement` returns `null` only when the holder's target is `null`; below
an `elsewhere` holder it returns the plan graph's IRI, which `elsewhereBlocks` emits as a block of
its own (plain triples for the default graph without `WITH`; under `WITH <g>`, `GRAPH <g>`, or the
store's default-graph name for the default graph). With `writeGraphs` (plan graph found at write
time) `planGraph` is `undefined`, so no child was ever `null` there.

### Dependents

Grep of CN `src`, `packages/*/src`, `@_linked/server`, `server-utils`, `auth`, `react` and
`shape-ui` for `id === ''`, `id: ''` and `!x.id` on mutation results found no caller treating a
nested create's empty id as meaningful. No dataset implementation outside core overrides
`createQuery`/`updateQuery` of `SparqlDataset` (`FusekiStore` inherits them); remote datasets send
the query to a server whose `SparqlDataset` now returns the ids.

### React (`@_linked/react`, its own PR)

- `src/tests/fixtures.ts`: `ScriptedDataset.graphQuery` throws `unsupportedGraphQuery(query)`
  (`unsupported-query-kind`), following core's `unusedDatasetMethods`. Its other methods already
  existed and are used by the tests (the double performs mutations), so they were kept.
- Against current core two more suites failed to compile: `linkedSetComponent({people: query}, …)`
  typed `people` as `never` (react's `GetCustomObjectKeys` / `ToQueryResultSet` matched only
  `FieldSet`, and `QueryBuilder` is no longer structurally one), fixed in
  `src/utils/LinkedComponent.ts`; and a test constructed the result of `getOrCreateShapeAdapter`,
  now typed as the abstract `Shape`, cast to `ShapeConstructor` in the test.
- The `@_linked/core` dev range is raised to the current core; patch changeset.

### Known limitation

A set modification's `add` items are minted and written, but the update result maps an `{add,
remove}` value to `null` (`fieldValueToResult`), so their ids are not returned. That predates this
work; returning them would change the result shape.
