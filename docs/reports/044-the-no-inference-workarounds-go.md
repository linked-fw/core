---
summary: >
  Core relies on the store's RDFS class inference: the owned-link check accepts the value shape's
  class and `sh:class` only, the single-owner constraint names one `sh:class`
  (`SHAPE_HASH_VERSION` 2), owned-walk cycle hops are typed `?n a <C>`; the walk's class holders
  read the in-memory hierarchy (a safety net) and a guarded edge covered by a more general guard
  is not repeated. Every decorator tighten-only widening throws; `override-not-tightened` is an
  error for decorated shapes; `autoLoadOntologyData` and xsd `Bytes` are removed; `NodeShape` and
  `PropertyShape` carry typed metamodel accessors. Step K3 of CN plan 070.
packages: [core]
---

# 044 — The no-inference workarounds go

Source: CN plan 070 (`create-now/docs/plans/070-store-inference-and-ontology-data.md`), step K3;
sub-plan [003](../plans/003-store-inference.md). Design: the master's §Decisions 14, 20-23 and its
§Contracts "Tighten-only", "Class hierarchy in memory", "Shape check". Two phases, one commit
each. Released as a **minor** (the owner's decision; the changeset states the store requirement
and lists the removals and new errors).

## What changed

**Owned-link check** (`src/sparql/ownedLinkCheck.ts`). Accepted classes are the value shape's
`targetClass` and the property's `sh:class`; registered sub-shapes are no longer enumerated. The
types query reads the store's inferred types, so a subclass instance (with or without a shape)
carries the accepted class. The message says "… only owns instances of `<C>` … and their
subclasses".

**Single-owner constraint** (`src/shapes/singleOwnerConstraint.ts`). The qualified shape is
`[ sh:class <declaring class> ]`; the `sh:or` of every registered sub-shape's class is gone.
`SHAPE_HASH_VERSION` 1 → 2 (the golden fixture has no sub-shape, so its digest is unchanged; the
ledger records version 2 with the same digest and says why), so the next sync rewrites every
stored shape once.

**Owned walk** (`src/sparql/irToAlgebra.ts`).
- A cycle hop is typed with the declaring shape's class, `?n a <C>`; a declaring shape without a
  `targetClass` uses the most general classes of its sub-shapes (`FILTER IN`, as before).
- Decision 22's safety net: `classHolders(C)` returns every shape whose class is in
  `subClassesOf(C)` (shape tree plus the ontology data once loaded), since `?n a <C>` now matches
  them all. `blockedGuard` therefore refuses a guard whose class has a subclass held by a plain
  holder of the predicate, naming it ("its targetClass's subclass `<X>` is held by …").
- `withoutCoveredEdges`: an edge whose predicate and target are already followed unguarded or
  under a superclass's guard is not added again (the more general guard matches the subclass's
  nodes). Fewer UNION branches for sub-sub-shapes.
- The walk cache keys on the ontology hierarchy's version too (`ontologyHierarchyVersion()`,
  `@internal`, in `ontology/classHierarchy`), so `setOntologyHierarchy` is seen.
- `blockedGuard`'s rules and `blankCapableProperties` are otherwise unchanged; comments corrected
  (a node carries its superclasses' types).

**Tighten-only** (`src/shapes/SHACL.ts`, `tightenOnly.ts`, `checkShapeHierarchy.ts`). Every
widening of a decorated override throws at registration: minCount, maxCount, nodeKind (as before),
datatype, value shape (also when compared later, for a `[package, name]` value shape registered
after the override), `contains: false`, a changed path, and a new label redeclaring an inherited
path. A refused override found while another shape registers (the deferred value-shape
comparison runs as that shape's callback) no longer leaves that shape half-registered:
`applyLinkedShape` runs every pending callback, finishes the registration (`targetClass`), then
throws the first error (review finding). Data-only shapes stay warnings (the text no longer promises an error). The shape check's
`override-not-tightened` is an `error` for a decorated shape, a `warning` for a data-only one.

**Removed:** `autoLoadOntologyData` (export and state); xsd `Bytes` from core's
`src/ontologies/xsd.ts`.

**Metamodel typing:** `NodeShape` and `PropertyShape` carry a typed accessor for every metamodel
property registered in `utils/Package.ts` (owner answer 2's terms — `sh:name`,
`targetSubjectsOf`, `deactivated`, `message`, `severity`, `andShapes`, `notShape`, `xoneShapes`;
`flags`, `languageIn`, `uniqueLang`, `qualifiedMinCount`, nested `properties` — and the rest), so
`NodeShape.select((s) => [s.name, …])` and subclasses such as CN's `CatalogNodeShape` type-check.
The registrations were all there since K1 phase 3; what C6 found missing was the typed surface
(`TS2339: Property 'name' does not exist on type 'QShape<NodeShape…>'`). A test pins that every
accessor is a registered property.

**Docs:** README (store requirements under Installation, owned links, walk, polymorphic bulk
mutations, single owner, override rules), `owned-values.md`, `ontologies.md`.

## Tests

- Live fixtures load their hierarchy: `src/test-helpers/class-hierarchy-fixture.ts`
  (`shapeTreeHierarchy`, `insertClassHierarchy`); used by `owned-walk-recursion` and the new suite.
- New `inference-features-fuseki.test.ts`, one live test per row of the master's §Features that
  depend on inference: owned-link check; single-owner constraint through Jena SHACL; owned-cycle
  walk through a subclass node; class-scoped select, count, ask and `EXISTS`; bulk update and
  bulk delete; a delete by id through the superclass shape; superclass instance count; store
  SHACL `sh:targetClass` reaching a subclass node.
- Unit: owned-link accepted classes and a stub store with and without the inferred type; single
  owner one `sh:class`; walk dedupe and the safety net (`setOntologyHierarchy` blocks, clearing
  it unblocks); the `QR/QSharer` case now blocks under `QM` too; tighten-only errors for every
  case; shape-check severity per kind of shape; typed metamodel accessors.
- Fixtures that relied on a widening now keep the inherited path: `Employee.name` (query
  fixtures) uses Person's `name` predicate (goldens updated), and nine test shapes that declared
  a `label` accessor on their own predicate (the base `Shape`'s `label` is `rdfs:label`) name it
  `caption` (or `code`).

## Gate

Phase 1 (quick gate: full jest + typecheck): 2453 passed / 120 skipped, only `two-copies-built`
failing; `[fuseki] live tests: 317 total — 317 passed`; jest 1:16 wall, typecheck 4.0 s.

Full gate before landing, after the review fixes (store: `LINKED_FUSEKI_IMAGE=linked-fuseki:dev`,
`FUSEKI_BASE_URL=http://localhost:3988`, compose project `linked-core-k3`):

```
npm test
Test Suites: 1 failed, 4 skipped, 122 passed, 123 of 127 total
Tests:       120 skipped, 2454 passed, 2574 total
[fuseki] live tests: 317 total — 317 passed, 0 failed, 0 skipped
npm test  101.14s user 25.68s system 304% cpu 41.627 total        (the failure: two-copies-built, backlog 060)

REQUIRE_FUSEKI=1 npm run test:fuseki
Tests:       2295 skipped, 317 passed, 2612 total
REQUIRE_FUSEKI=1 npm run test:fuseki  41.91s user 8.08s system 233% cpu 21.376 total

npm run typecheck    6.87s user 0.27s system 222% cpu 3.205 total   (clean)
npm run check:dts    3.59s user 0.16s system 250% cpu 1.495 total   (clean)
node …/_linked-cli/lib/esm/launch.js build   ✔ Build successful (5.9 s)
```

## Consumers checked (in `~/web/wt/070-K3`, every localized repository nested so one core loads)

```
@_linked/schema   npm test                 # tests 97  # pass 97  # fail 0
@_linked/server-utils npm run test:calls   # tests 95  # pass 95  # fail 0   (test:unit is red in this layout before the change too, report 003)
@_linked/server   npm test                 Tests: 409 passed; only two-copies.test.ts fails (as on store-inference, backlog 060)
CN npm run typecheck:gate                  No new type errors. 0 pre-existing errors still in the baseline. (22.9 s)
CN npx vitest run                          Test Files 273 passed | 1 skipped (274); Tests 2355 passed | 5 skipped (55.4 s)
```

## What later steps must know

- **webid.email's `Passkey` will throw at load** with this core: it declares
  `@literalProperty({path: wie.label}) get label()`, and every shape inherits the base `Shape`'s
  `label` (`rdfs:label`), so it is a path change, now refused (decision 14). Fix in webid.email:
  use `rdfs:label` for it, or name the accessor differently. No other localized package or CN
  shape declares an override with a changed path (searched; CN vitest and its shape check pass).
- The single-owner constraint and the owned-link check now depend on the dataset holding the
  synced hierarchy; a dataset without it under-counts owners and refuses subclass instances.
- CN's catalog read (`getCatalogNodeShapes`) can become a typed `CatalogNodeShape` select (C6's
  note); not done here (CN).
- Follow-up from the review, recorded as [backlog 061](../backlog/061-value-shape-callbacks-need-own-properties.md):
  callbacks waiting on a `[package, name]` value shape run only when that shape has decorated
  properties of its own (older behaviour, not changed here).

## Review

An independent read-only review of the diff against §K3, §Contracts and decisions 20-23 found
one medium (a deferred refusal left the triggering value shape half-registered; fixed in the
fourth commit) and lows/nits (addressed, or argued: the SHACL rows validate through `ds`, whose
view takes its hierarchy from the data graph). Its re-review: "No open medium or high findings".
