---
date: 2026-11-01
summary: >
  A shape's default read set: `static defaultReadGraphs` on a shape class names the graphs a
  select, count or ask of it reads without `.from()`. NodeShape and PropertyShape declare
  `graphs.allShapes`; `@_linked/rdfs`'s Class and Property (and OWL's term shapes through them)
  `graphs.allOntologies`. Put on the IR when lowered, `.from()` wins, writes unchanged, graph routes
  for such shapes refused. Minor (core and rdfs).
packages: [core, rdfs]
---

# 110 — A shape's default read set

## PR

**What changed**

- `static defaultReadGraphs` on `Shape` (a graph IRI or a list, portable names included, inherited
  by subclasses). `lower()` puts it on the IR's `graphs` of a select, count or ask that has no
  `.from()` (`src/queries/lower.ts`, `defaultReadGraphsOf` in `src/queries/readGraphs.ts`). It is
  read from the class registered in code for the shape IRI, so a query received as DSL-JSON and
  lowered inside a shape catalog gets it too. The DSL-JSON carries only what the caller wrote.
- `NodeShape` and `PropertyShape` declare `graphs.allShapes`. In `@_linked/rdfs`, `Class` and
  `Property` declare `graphs.allOntologies`, so OWL's `Class`, `Restriction`, `ObjectProperty`,
  `DatatypeProperty` and `AnnotationProperty` inherit it. `Resource` declares none.
- An explicit `.from()` wins. A subclass opts out with `static defaultReadGraphs = graphs.default`.
- Writes are unchanged. A graph route for a shape that has a default read set is refused
  (`graph-name-read-only`, `src/utils/graphRouting.ts`): its writes would go where its reads never
  look. A dataset pin is still fine.
- The default-graph shape sync (`syncShapes`: `readStoredHashes`, the orphan sweep) reads
  `.from(graphs.default)`, where it writes.
- `InMemoryDataset` (one graph) reads its graph for `graphs.allOntologies` / `graphs.allShapes`.
  Writes to them are still refused.
- Docs: `docs/architecture/ontologies.md`, "Reading graphs" → "A shape's default read set".
- Changesets: core minor (`.changeset/default-read-graphs.md`), rdfs minor (same name).

**Verification**

Core unit and live Fuseki suites, on a Fuseki of its own (port 3961):

```
FUSEKI_BASE_URL=http://localhost:3961 FUSEKI_ADMIN_PASSWORD=admin npm test
[fuseki] live tests: 493 total — 491 passed, 0 failed, 2 skipped
Test Suites: 4 skipped, 169 passed, 169 of 173 total
Tests:       122 skipped, 3330 passed, 3452 total
```

`npx tsc -p tsconfig-tests.json`: no errors. rdfs `npm test`: `# pass 2`, `# fail 0`.

The host app, worktree on this core and rdfs, `npm run test:feature -- ontologies`:
`Test Files 63 passed (63)`, `Tests 462 passed (462)`, Playwright `1 failed, 4 skipped, 90
passed (8.3m)`. The one failure, the ontology view cards spec, fails the same way on
the host app's `dev` without this change (`1 failed … 1 passed (50.7s)`, run from the main checkout): it
is the host app's `termUsage` → `dataGraphs()` → `GraphRoutingUnknownError` (the host app's backlog). The
worktree's `typecheck:gate` fails because a worktree loads two copies of core; it was run in the host app's
main checkout after landing (see the host app's report).

**Deviations**

- The term shapes are declared in `@_linked/rdfs`, not core, so the work spans core and rdfs.
  `@_linked/owl` needs no change.
- Triples reads get no default: they have no shape.
- Added after review: the registered-class lookup (shape catalogs dropped the rdfs/owl defaults),
  and the refusal of graph routes for these shapes (a route would write where reads never look).

**Follow-ups**

- The host app's backlog: OntologyUsageProvider's froms after the hub-sync rework lands; the host app's gateway
  checks the DSL-JSON's graphs, not the IR's; outside collaborators meet the M48 check on plain
  term and shape reads now.

## Details

**Where the default is applied.** It goes on the IR, not only into the compiled SPARQL (the way
`storedInGraph` works for the registry records). The host app's query-plane rule
(`authorizeProjectDataQuery`) reads `ir.graphs` to apply the workspace visibility rule (M48), so
a set added only at compile time would let a plain `OwlClass.select()` read workspace-private
ontology graphs without that check. With the set on the IR, the rule sees `graphs.allOntologies`,
as it would for an explicit `.from()`.

**Behaviour changes for callers.**
- Code that writes NodeShapes or term instances with the DSL into the default graph, and reads them
  back without `.from()`, now has to say `.from(graphs.default)`. The core tests that read after
  the legacy sync were changed that way (`shape-catalog.test.ts`, `select-node-type.test.ts`,
  `select-order-missing-last.test.ts`).
- A read that expands to no graph (no ontology or shape graph registered) matches nothing, as for
  an explicit `.from()`.
- A traversal from a shape shape into terms (`ns.targetClass.label`) reads the shape graphs only.
- Under the `'default'` graph target the set reads the default graph, as before.

**Review.** An independent review of the diff found two high issues and one medium, all fixed:
1. Shape catalogs dropped the rdfs/owl defaults (`getShapeClass` returns the catalog's classes).
   Fixed: the class registered in code first; test "a query received as DSL-JSON and lowered
   inside a catalog keeps the default", which fails without the fix.
2. DSL writes of these shapes go to the default graph or a route, and reads no longer look there.
   This is by design for unrouted shapes and is documented. Routed ones are now refused.
3. Medium: the legacy sync's reads with `.from(graphs.default)` would not follow a graph route for
   NodeShape. That is moot now, because such a route is refused.

The review's the host app's items (the gateway and outside collaborators) are in the host app's backlog.

**Tests added.** `src/tests/default-read-graphs.test.ts` covers select, count and ask; sub-shape
inheritance and opt-out; `.from()` winning; the DSL-JSON round trip; a catalog; route refusal; an
invalid declaration; and the in-memory store. `shape-graphs-fuseki.test.ts` checks that a NodeShape
read without `.from()` returns what `.from(graphs.allShapes)` returns, live. The rdfs test is
`test/default-read-graphs.test.mjs`.
