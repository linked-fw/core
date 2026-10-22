---
summary: >
  The class hierarchy in memory (`ontology/classHierarchy`: shape-tree edges plus the ontology
  triples, filled by `loadOntologyHierarchy`, which the ontology sync and the shape check call),
  `validateByClass` (SHACL class targeting in process), and direction I of the shape check with
  multiple inheritance (one in-scope superclass on the extends chain satisfies it; each one off
  the chain is a warning). Step K2 of CN plan 070.
packages: [core]
---

# 043 — The class hierarchy in memory and validate by class

Source: CN plan 070 (`create-now/docs/plans/070-store-inference-and-ontology-data.md`), step K2;
sub-plan [003](../plans/003-store-inference.md). Design: the master's §Decisions 13, 22, 23 and
its §Contracts "Class hierarchy in memory" and "Validate by class". Three phases, one commit each.

## What was built

**The class hierarchy in memory** — `src/ontology/classHierarchy.ts` (subpath
`@_linked/core/ontology/classHierarchy`, browser-safe: it imports `ShapeClass`, `registryCache`
and `sharedState` only). `setOntologyHierarchy(triples)`, `superClassesOf(iri)`,
`subClassesOf(iri)`, as contracted. The closure is the union of the shape tree's edges (every
shape whose class C differs from the class D of its nearest super-shape gives `C ⊑ D`) and the
ontology triples last set. The triples live in `sharedState('@_linked/core', 'classHierarchy')`
with a version, so two copies of core in one process agree; the closure is cached in a
`RegistryCache` (one per catalog, rebuilt when the shape registry moves) and rebuilt when the
triples' version moves. Walks are memoized per IRI; an unknown IRI gives `{iri}`; cycles end.

`loadOntologyHierarchy()` in `ontology/hierarchy` (server only): reads every registered package
(`readPackageOntologies`), sets the deduped, sorted union and returns it. The helper it uses,
`setHierarchyFromPackages` (internal, `registryData.ts`), is also what `syncOntologies` calls on
the parse it already does, so a sync parses once; `checkShapeHierarchy()` without a `hierarchy`
now calls `loadOntologyHierarchy` (with one, it sets nothing). Section "The class hierarchy in
memory" in `docs/architecture/ontologies.md`.

**`validateByClass(data, {types?, mode?, maxDepth?})`** — in `shapes/validation.ts`, exported from
the index beside `validate`. Shapes: for each class in `⋃ superClassesOf(type)`, the least
specific shapes of that class (`getShapesForTargetClass`), in id order: a sub-shape that inherits
its class (including a `sharedTargetClass` profile) is covered by its root, a sub-shape with its
own class runs for nodes of that class, data-only shapes count the same. Types from `types`, else
from the data's `type` or full `rdf:type` key (IRI strings, `{id}`, or a list). Section
"Validating by class" in `ontologies.md`.

Two points the contract left open, settled within it:
- **The closed check is over the union.** `validate` treats an undeclared key as a
  `sh:closed` violation; a Dog node checked against the Animal shape would otherwise report
  `breed`. A key one selected shape declares is not undeclared for the others; a key none declares
  is reported once (by the first shape). Nested nodes are unchanged.
- **The type key.** Every shape inherits `type` (`rdf:type`, an object property) from `Shape`, so
  a type given as an IRI string would fail its node kind; validateByClass checks those strings as
  the `{id}` references they stand for (and drops the key when no selected shape declares it).

Results are deduped (an inherited property checked by Dog's shape and Animal's reports once). No
known type, or no shape for any of them: `conforms: true` and one `sh:Info` result
(`sh:ClassConstraintComponent`) saying nothing was validated.

**Direction I with multiple inheritance** — `checkShapeHierarchy`'s `subclass-without-extends`.
The shape's *anchor* is its nearest domain ancestor of a real (non-meta) class in scope (its
package or a dependency). When an in-scope superclass shape sB is missing and the shape has an
anchor that sB is not a sub-shape of, sB is off the extends chain: a warning naming the multiple
inheritance. A sB below the anchor stays an error (the shape could extend sB instead); with no
anchor every in-scope B stays an error. The module JSDoc states the rule with CN's `Dataset`.

## Tests

- `src/tests/class-hierarchy.test.ts` (7): the closure from shape edges alone; a shape inheriting
  its class adds no edge; ontology triples joining and then replacing; a cycle; a shape
  registered after a read; `loadOntologyHierarchy` on a registered Turtle ontology; the check with
  and without `hierarchy`.
- `src/tests/ontology-sync.test.ts` (+1): the sync sets the hierarchy from its parse, also for a
  package outside `packages`.
- `src/tests/validate-by-class.test.ts` (9): a `Puppy` node (no shape; `Puppy ⊑ Dog` from the
  ontology) validated against Dog's and Animal's shapes, the missing `name` reported once with
  Animal's property shape as `sourceShape`; the same without the ontology (Info); a subclass's
  properties not undeclared for the superclass shape; a sub-shape with its own class runs, a
  `sharedTargetClass` sub-shape does not; two types (`rdf:type` key, string and `{id}`) with a
  key neither declares reported once; no type (Info); `types` overriding the data; a data-only
  shape; partial mode.
- `src/tests/shape-check-multiple-inheritance.test.ts` (4): CN's `Dataset` case in three packages
  (`createNow:Dataset ⊑ dcat:Dataset, schema:CreativeWork`; dcat ships `Resource` and no
  `Dataset` shape, as it does): Dataset extending CreativeWork → no error, one warning for dcat's
  `Resource`; the same classes extending nothing → errors for `Resource`, `CreativeWork`,
  `Thing`; a `Report ⊑ Article` extending CreativeWork → `Article` stays an error; without the
  dependency map → warnings only.

## Verification

Quick gates (each phase's test files plus the suites it touches, then `npm run typecheck`):

| Phase | Result | Time |
|---|---|---|
| 1 | `Test Suites: 6 passed, 6 total`, `Tests: 51 passed, 51 total` (class-hierarchy, ontology-sync, ontology-hierarchy, shape-check, shape-check-no-n3, ontology-registry); typecheck clean | 7.5 s + 3.6 s |
| 2 | `Test Suites: 5 passed, 5 total`, `Tests: 105 passed, 105 total` (validate-by-class, shape-validation-report, shape-validation-constraints, mutation-shape-validation, class-hierarchy); typecheck clean | 7.5 s + 4.7 s |
| 3 | `Test Suites: 5 passed, 5 total`, `Tests: 35 passed, 35 total` (shape-check-multiple-inheritance, shape-check, shape-check-no-n3, validate-by-class, class-hierarchy); typecheck clean | 46.7 s + 7.3 s |

Full gate (Fuseki: an own `secoresearch/fuseki:6.2.0` container on port 3976, compose project
`k2-fuseki`; the image comes with K1's store phase):

```
node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build
✔ Build successful            (8.1 s)

npm test                      (112 s)
FAIL src/tests/two-copies-built.test.ts      (backlog 060, also red on main)
Test Suites: 1 failed, 4 skipped, 118 passed, 119 of 123 total
Tests:       120 skipped, 2425 passed, 2545 total
Time:        93.988 s

npm run typecheck             clean (4.6 s)
npm run check:dts             clean (12.4 s)

FUSEKI_BASE_URL=http://localhost:3976 REQUIRE_FUSEKI=1 npm run test:fuseki    (17 s)
[fuseki] live tests: 304 total — 304 passed, 0 failed, 0 skipped
Test Suites: 110 skipped, 13 passed, 13 of 123 total
Tests:       2280 skipped, 304 passed, 2584 total

grep -rln "n3'" lib/esm --include='*.js'                → lib/esm/ontology/hierarchy.js
grep -n '^import' lib/esm/ontology/classHierarchy.js     → ShapeClass, registryCache, sharedState
```

Verify (CN worktree set, the built core through the overlay, `@_linked/schema` from the
integration set):

```
shape edges: Article ⊒ http://schema.org/Article
ontology triples 952
after load: Article ⊒ http://schema.org/Article http://schema.org/CreativeWork http://schema.org/Thing
CreativeWork subclasses 170
validateByClass({type: schema:Article, bogus: 1}) →
  conforms false; [CreativeWork, ClosedConstraintComponent, "Invalid property key: bogus. …"]
```

(schema has no `Article` shape, so the shape tree alone knows nothing above it; after
`loadOntologyHierarchy`, `CreativeWork`'s shape validates an Article node.) The script also logged
core's "2 copies of @_linked/core's shape registry" warning: in this layout `@_linked/schema`
resolves the integration set's core while the script resolves the step's; the hierarchy is in
shared state, so both copies agree.

## Follow-ups

- U1 reads `subClassesOf` for bulk access; K3 may read it for the owned-walk safety net
  (decision 22); V1's boot calls `loadOntologyHierarchy` (master §Control route).
- `two-copies-built` not running: [backlog 060](../backlog/060-two-copies-built-jest-module-cache.md).
