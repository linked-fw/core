---
summary: Completed the projected-optional traversal fix in @_linked/core and
  the runtime follow-up needed for PeaceGame's Fuseki-backed active-event query.
---

# 014 — Projected Optional Traversals

## Outcome

This work fixed the query path behind PeaceGame's `EventProvider.getActive()`
by completing two related changes:

- `@_linked/core` now lowers projection-only singular object traversals into
  nested `OPTIONAL` subtrees instead of required joins
- the PeaceGame Fuseki runtime now queries the correct named graph and emits
  ontology/path IRIs instead of SHACL shape-property IDs

As a result, queries that project nullable nested objects such as event image
or default team no longer drop the root event row when the nested object is
missing.

## Problem

The original regression showed up in an app's sign-in page
through `EventProvider.getActive()`.

Two independent behaviors combined into an empty response:

1. `@_linked/core` treated projected single-value object traversals as required
   joins in the root BGP.
2. The runtime query path still used SHACL shape/property IDs and read the
   Fuseki default graph instead of the PeaceGame named graph
   `https://www.peacegame.earth/data`.

The first issue could remove rows when `image` or `defaultTeam` was absent.
The second issue could remove all rows even if the OPTIONAL semantics were
correct, because the query looked at the wrong graph and the wrong IRIs.

## Final Behavior

### Projected nullable traversals

Projection-only traversals with `maxCount <= 1` are now emitted as nested
optional subtrees when they are not made required by filter or traversal
semantics.

Representative shape:

```sparql
?event rdf:type <http://lincd.org/ont/irlcg/Event> .
OPTIONAL {
  ?event <http://schema.org/image> ?image .
  OPTIONAL {
    ?image <http://schema.org/contentUrl> ?contentUrl .
  }
}
```

This replaces the earlier inner-join-like behavior where the parent traverse
was required or where child triples could be detached from the parent optional
scope.

### Shape/property IRI resolution

Root type scans and property predicates are now resolved through registered
shape metadata before SPARQL emission:

- root shape scan: `ShapeClass.targetClass.id`
- property predicate: simple `PropertyShape.path`

Fallback behavior remains intact for temporary IDs and unresolved properties:

- keep the original shape/property ID when no stable ontology/path IRI is
  available
- never rewrite `linked://tmp/...` placeholders into fake ontology IRIs

### Fuseki named graph support

`FusekiStore` now accepts and uses `defaultGraph` for SELECT execution by
adding `default-graph-uri=...` to the SPARQL endpoint request.

PeaceGame's default store is configured with:

- dataset: `pg-test`
- default graph: `process.env.DATA_ROOT || https://www.peacegame.earth/data`

That aligns the storage bootstrap with the actual test dataset layout.

## File Responsibilities

### `packages/core/src/sparql/irToAlgebra.ts`

Primary implementation file.

Responsibilities after this change:

- resolve root scan IRIs via `resolveShapeScanIri()`
- resolve property predicates via `resolvePropertyPredicateIri()`
- build traversal triples through `buildTraverseTriple()`
- identify projected traversal aliases that can be lowered as optional
  subtrees
- preserve parent-child nesting for projected singular traversals
- keep required traversal semantics for filtered or otherwise required paths
- stay ESM-safe by using normal imports rather than runtime `require(...)`

### `packages/core/src/tests/sparql-algebra.test.ts`

Structural coverage for the algebra tree:

- nested singular optional traversal lowering
- sibling optional traversal isolation
- no child-triple escape into unrelated traversal branches

### `packages/core/src/tests/sparql-select-golden.test.ts`

Serialized SPARQL coverage:

- nested `OPTIONAL` structure for nullable projected traversals
- resolved ontology/path IRIs in emitted queries

### `packages/core/src/tests/sparql-fuseki.test.ts`

Behavioral coverage against a real SPARQL runtime:

- root rows survive missing singular nested objects
- missing nested objects map to `null`
- sibling nullable traversals do not remove the root row

### `packages/fuseki/src/shapes/FusekiStore.ts`

Runtime transport fix:

- adds `defaultGraph` support to select execution
- keeps update/import behavior unchanged except for using the same graph option
  where applicable

### The app's `scripts/storage-config.js`

App bootstrap fix:

- configures the default store to read from the PeaceGame named graph
- keeps app-level routing inside the existing storage-model architecture

## Key Decisions

### 1. Fix the compiler instead of patching PeaceGame queries

The root semantic bug lived in the SPARQL lowering layer, not in the app
query. Fixing `@_linked/core` preserves behavior for all consumers that expect
nullable projected object traversals to keep the root row.

### 2. Limit optional lowering to singular projected traversals

The change targets projection-only single-value traversals (`maxCount <= 1`).
Plural traversals still follow the existing semantics because changing them
would alter grouping and row cardinality much more broadly.

### 3. Keep child triples inside the parent optional subtree

This preserves correct SPARQL semantics on Fuseki and prevents unrelated child
matches from binding after a missing parent object.

### 4. Resolve through shape metadata before SPARQL emission

The runtime needed ontology/path IRIs, not SHACL shape-property IDs. The
compiler now resolves through the registered shape catalog, with safe fallback
for temporary IDs.

### 5. Remove the lazy CommonJS loader path

An intermediate version tried to avoid circular dependencies by lazy-loading
`ShapeClass` with `require(...)`. That broke the ESM runtime used by PeaceGame
with `ReferenceError: require is not defined`. The final implementation uses
direct imports, which build and execute correctly in the current package graph.

## Public Behavior Changes

### `@_linked/core`

User-visible behavioral changes:

- singular nested object projections are now nullable by default when used only
  for projection
- SPARQL output uses ontology/path IRIs when registered shape metadata is
  available

Affected internal API surface:

- `selectToAlgebra()`
- `selectToSparql()`

No new public exports were added.

### `@_linked/fuseki`

User-visible behavioral changes:

- `FusekiStore` can scope SELECT queries to a named graph through the
  `defaultGraph` constructor option

Example:

```ts
const store = new FusekiStore('pg-test', process.env.FUSEKI_BASE_URL, {
  defaultGraph: 'https://www.peacegame.earth/data',
});
```

## Edge Cases Covered

- root rows without a singular nested object are still returned
- sibling nullable traversals stay isolated from each other
- temporary `linked://tmp/...` shape/property IDs are not rewritten
- ESM runtime no longer attempts CommonJS `require(...)`
- named-graph querying works without changing the query DSL

## Validation

Completed during implementation and wrapup:

- passed: `cd packages/core && yarn test`
- passed: `cd packages/core && yarn build`
- passed: `cd packages/fuseki && yarn build`

Review-stage validation decision:

- skipped: `cd packages/the-game && yarn test`

Reason:

- the package script is a broad Playwright signup-flow suite rather than a
  focused regression test for the SPARQL/runtime changes in scope
- the user explicitly chose to defer it for this fix

## Architecture Compliance

Reviewed against the host app's architecture docs on packages and governance, the storage
model and code structure.

Findings:

- no architecture violations were found
- no architecture docs required updates

Why:

- query lowering remained in `@_linked/core`
- store transport behavior remained in `@_linked/fuseki`
- app dataset wiring stayed in `storage-config.js`, which matches the storage
  model's split between code-level routing and environment-level dataset
  binding

## Limitations

- the optional-lowering rule is intentionally narrow and currently targets
  singular projection-only traversals
- this work does not change mutation lowering
- this work does not redefine null-rejecting top-level filter semantics
- there is still no dedicated app-level automated test covering the PeaceGame
  `getActive()` scenario end-to-end

## Follow-up Notes

- if app-level regression coverage is needed later, add a focused runtime test
  around the active-event query rather than relying only on the broad signup
  Playwright flow
- if future query behavior needs plural projected traversals to become optional
  too, that should start as a separate ideation item because it will affect
  result grouping and row multiplicity

## PR Readiness

The implementation is ready for PR preparation once changesets are written for:

- `@_linked/core`
- `@_linked/fuseki`

No further code or documentation cleanup is required for this scope.
