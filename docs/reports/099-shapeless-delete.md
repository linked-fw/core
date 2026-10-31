---
date: 2026-10-31
summary: >
  A shapeless delete: `Shape.delete(ids)` on the base class deletes every triple of those subjects
  and every link to them in the dataset's routed named graphs, never the default graph or the
  union. IR `delete_shapeless`, DSL-JSON 1.3 `mode: 'shapeless'`, one SPARQL update, query feature
  `shapelessDelete` (a dataset is sent one only when it declares it), LinkedStorage fan-out with
  the 095 notice; server-side `_inGraphs()` and `_includingDefaultGraph()`. Minor.
packages: [core]
---

# 099 — Shapeless delete

## PR

### Summary

Core's typed delete (`Person.delete(ids)`) needs the shape of what it deletes. There was no delete
for nodes whose types the caller does not know. On the base class it now means one:

```ts
await Shape.delete([{id: a}, {id: b}]).exec(dataset);   // every triple of a and b, and the links to them
await Shape.delete(ids)._keepingIncoming().exec(dataset); // their own triples only
```

It deletes in the graphs the dataset routes (its graph routing's named graphs). It never deletes in
the default graph or `graphs.union`, which is the scoping rule the shapeless triples reads have
behind CN's gateway (CN report 361). A dataset without routing refuses it (`graph-not-routed`):
it has nowhere to delete. There is no type guard and no blank-value or owned cascade, since there
is no shape to read them from. `.where()`, `.all()` and `.into()` are refused on it.

### API as shipped

| Call | Effect |
|---|---|
| `Shape.delete(ids)` | `DeleteBuilder<Shape>`, shapeless: `isShapeless` true, `shape` undefined, `requiredFeatures()` `['shapelessDelete']` |
| `._keepingIncoming()` | only the subjects' own triples (carried in DSL-JSON as `keepIncoming`) |
| `._inGraphs(graphs)` | @internal, server-side: exactly these graphs, each one the store routes, else `graph-not-routed` |
| `._includingDefaultGraph()` | @internal, server-side: the default graph too |
| `DeleteBuilder.forNodes(ids)` | what `Shape.delete` calls on the base class |

`toJSON` refuses a builder that has `_inGraphs` or `_includingDefaultGraph`. A receiver therefore
decides its own scope.

**TypeScript.** `Shape` is abstract, so `this: ShapeConstructor<S>` (a `new` signature) does not
accept `Shape` itself. `delete` now takes `this: ShapeConstructor<S> | typeof Shape`, as
`Shape.exists` already does, with a runtime `this === Shape` branch. A subclass still infers its
own `S`. Overloads were not used: a subclass's static side is assignable to `typeof Shape`, so an
overload on it would capture `Person.delete` too. `DeleteQuery.shape` and `DeleteBuilder.shape`
are now `NodeShapeData | undefined`, as `AskQuery.shape` already is. That is a small type change
for code that reads `.shape.id` on a delete.

### Changes

- **IR.** `IRDeleteShapelessMutation` (`{kind: 'delete_shapeless', ids, graphs?,
  includeDefaultGraph?, keepIncoming?}`) is part of `IRDeleteQuery` and `IRQuery`.
  `buildCanonicalDeleteShapelessMutationIR` builds it. `lower()` refuses an id that is not an
  absolute IRI (a `_:` label too).
- **DSL-JSON 1.3** (`WIRE_VERSION`).
  - The envelope is `{v: '1.3', op: 'delete', mode: 'shapeless', ids, keepIncoming?}`, with no
    `shape`.
  - `DeleteBuilder.fromJSON` and `lowerMutationJSON` refuse a `shape` on it, empty `ids` and
    non-IRIs. They honour `refuseKeepIncoming`.
  - A reader before 1.3 refuses the envelope, because it has no shape.
- **SPARQL.** `deleteShapelessToAlgebra` / `deleteShapelessToSparql` (exported from
  `@_linked/core/sparql`) build one update:
  `DELETE { GRAPH ?g_del { ?x_del ?p_del ?o_del . ?s_del ?p2_del ?x_del } } WHERE { VALUES ?x_del {…} VALUES ?g_del {…} GRAPH ?g_del { {own} UNION {incoming} } }`.
  The default graph is the store's own name for it (`mapGraphName`), or a refusal.
- **`SparqlDataset.deleteShapeless`.**
  - Its scope is the routed named graphs, plus the default graph when `includeDefaultGraph` is
    set, narrowed by `graphs`.
  - It refuses a graph outside that set, an empty scope, and a reserved name in the scope.
  - `FusekiStore` inherits it.
- **Features.** The new `QueryFeature` `'shapelessDelete'` is in `ALL_QUERY_FEATURES`, so
  `SparqlDataset` declares it. `DeleteBuilder.exec(target)` runs `assertQuerySupported`.
- **`LinkedStorage.deleteQuery`.**
  - A shapeless delete goes to every dataset. All of them must declare the feature, which is
    checked before any of them is sent the delete.
  - The datasets run in turn and the answers are joined.
  - The fan-out notice (095) has a new kind, `delete`.
- **Live queries.**
  - The effects of a shapeless delete are its ids, with every registered shape as membership, so
    every live query refetches.
  - Effects sent as data reach each catalog with that catalog's shapes as membership
    (`_decodePerCatalog`).
- Docs: README (Delete, "Shapeless delete"), `documentation/dsl-json.md`,
  `documentation/intermediate-representation.md`. Changeset `shapeless-delete.md`: minor.

### Verification

`npm test` (jest, then `tsc -p tsconfig-tests.json`; no Fuseki variables, so the live suites skip)
after rebasing onto `dev` (82547c7):

```
Test Suites: 19 skipped, 148 passed, 148 of 167 total
Tests:       572 skipped, 2695 passed, 3267 total
```

The new suites are `src/tests/shapeless-delete.test.ts` (16 tests: builder and refusals, wire,
SPARQL, server-side scope, `supports`, LinkedStorage fan-out, live effects) and
`src/tests/shapeless-delete-fuseki.test.ts`. The live suite ran against a Fuseki of its own
(`FUSEKI_BASE_URL=http://localhost:3971`; global setup starts and stops it):

```
[fuseki] live tests: 3 total — 3 passed, 0 failed, 0 skipped
Tests:       19 passed, 19 total
```

It covers:
- the subject and the links to it gone in both routed graphs, while the default graph, an
  unrouted graph and another node stay;
- `_keepingIncoming()`;
- `_inGraphs()`;
- `_includingDefaultGraph()`.

`npx linked build`: `✔ Build successful`.

### Deviations

- `_includingDefaultGraph()` is an internal exception to the rule that a shapeless delete never
  touches the default graph. Create Now's undo-import and Remove-documents deletes need it: an
  unrouted app shape's instances live in the default graph. They first refuse every IRI outside
  the project's own data root (CN report 375). It is server-side only and never serialized.
- A delete without a target goes to every dataset, as a shapeless ask does. The first refusal
  stops it, and the datasets before it have already deleted.

### Follow-ups

- Blank nodes that a deleted subject points at are left in place, because there is no shape to
  cascade from. Home: this report.
- `TriplesQuery` has no predicate filter, so CN's gateway reads a subject's whole description to
  learn its types (CN report 375). A types read (`typesOf(ids)`) would make that one small query.
  Home: CN backlog 091, item 2.

## Details

The review of this step was independent and covered this diff and CN's together. Its core
findings were fixed:
- live effects in catalogs (medium);
- a reserved routed graph refusing a narrowed delete (low).

The access rule and its review are in CN report 375.
