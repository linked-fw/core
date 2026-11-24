---
date: 2026-11-01
summary: >
  Triples reads by object (`TriplesBuilder.toNode`) and by predicate (`withPredicate`, which needs
  `.from()`), `.exists()` as their ask, the query feature `triplesPattern`, DSL-JSON 1.4; and an
  IRI-valued graph-record field, `NamedGraph.attributedTo` (`prov:wasAttributedTo`), written in the
  same graph query as the content. Minor. Unblocks the host app's raw SPARQL rows G1, G2 (property
  half) and G6.
packages: [core]
---

# 102 — Object and predicate triples reads; an IRI-valued graph-record field

## PR

### Summary

The host app still runs raw SPARQL to count the references to a term in the ontology graphs (G1,
`termUsage.ts:96-106`), to ask whether a predicate is used in the data graphs (G2,
`termUsage.ts:114-124`), and to mark the graphs it writes with `prov:wasAttributedTo` beside their
registry record (G6, `hubGraphSync.ts:98-108`). Core now has all three:

```ts
// G1: the triples whose object is the term, in the ontology graphs (counted in JS).
const refs = await TriplesBuilder.toNode({id: term}).from(graphs.allOntologies).exec(ds);
const n = refs.filter((t) => t.predicate.id !== rdf.type.id && t.subject.id !== term).length;

// G2, property half: is predicate P used anywhere in these graphs?
const used = await TriplesBuilder.withPredicate({id: p}).from(dataGraphs).exists(ds);

// G6: the mark rides in the same update as the content, and reads back as {id}.
await ShapesGraph.update(g).set({attributedTo: {id: SYSTEM_ACTOR}}).replaceContent(c).exec(ds);
const rows = await ShapesGraph.select((r) => [r.package, r.contentHash, r.attributedTo]).exec(ds);
```

### Changes

- `src/queries/triplesQuery.ts`: `TriplesQuery.predicate` and `.object` (absolute IRIs; the object
  is a node). Rules: a read needs a node (subject or object) or graphs; a predicate read without a
  node needs graphs; all three positions fixed is refused (nothing left to read).
  `checkTriplesTerm`, `triplesQueryPartsOf` (each part checked; the whole read is checked when it is
  sent, so `withPredicate(p)` can wait for `.from()`), `triplesQueryFeatures`. The dead
  `checkTriplesSubject` is gone (never exported from the index).
- `src/queries/TriplesBuilder.ts`: `toNode({id})`, `withPredicate({id})` (static, and on any read to
  narrow it), `exists(target?)` (the read with `limit: 1`, `true` when a triple comes back; the
  builder's own limit is kept). A missing id throws at build time.
- `src/queries/queryFeatures.ts`: `triplesPattern`. `src/queries/queryDispatch.ts`:
  `resolveTriples` refuses a read that fixes the predicate or the object on a target that does not
  list it (after the method check); `assertQuerySupported` shares the check.
- `src/queries/wireVersion.ts`: 1.4.
- `src/sparql/triplesToSparql.ts`: fixed positions are terms, only open ones are projected, the
  answer takes fixed positions from the query. The routing fallback applies to node reads only.
- `src/queries/graphRecords.ts`: a `GraphRecordField` is a literal field or a node field
  (`nodeKind: 'iri'`, values `{id}`); `GraphRecordValue`, `isGraphRecordNode`, `recordValueFor`
  (refuses a string, a blank label or a relative IRI on a node field, and `{id}` on a literal
  one). `null` clears a field (an update deletes its values and writes none; a create skips it).
  `src/sparql/graphQueryToSparql.ts` writes `<iri>` for a node value.
- `src/ontologies/prov.ts` (new, terms only). `src/shapes/NamedGraph.ts`: `attributedTo`
  (`@objectProperty`, `prov:wasAttributedTo`, nodeKind IRI, maxCount 1) and `attributedTo?: {id:
  string} | null` in every class's `recordFields`. Core's shapes golden gains the property shape.
- `src/utils/fanOutNotice.ts`: the notice names node reads. Docs: README (triples reads, fan-out),
  `documentation/dsl-json.md` (a triples-read section, 1.4), `docs/architecture/ontologies.md`,
  the `IDataset.triplesQuery` doc. Changeset `object-predicate-triples-reads-attributed-to.md`
  (minor).

### Verification

Failing tests first (unit/golden in `triples-read.test.ts`, `graph-query.test.ts`; live in
`triples-read-fuseki.test.ts`, `graph-query-fuseki.test.ts`), against a Fuseki of the suite's own
(`FUSEKI_BASE_URL=http://localhost:3077`):

```
Tests:       17 failed, 101 passed, 118 total
```

After the work and the rebase onto core `dev` (with report 101), `npx linked build`:

```
✔ Build successful
```

Whole suite, live suites included, then `tsc -p tsconfig-tests.json` (exit 0):

```
[fuseki] live tests: 470 total — 468 passed, 0 failed, 2 skipped
Test Suites: 4 skipped, 164 passed, 164 of 168 total
Tests:       122 skipped, 3187 passed, 3309 total
```

One earlier run on a machine at load average 46 timed out in the hooks of
`sparql-fuseki-shape-sync` and in the two race tests of `graph-query-fuseki` (19 failed); those
suites passed alone (`17 passed`, `16 passed`) and in the run above.

From the host app's main checkout, after landing and `npx linked build` in its core checkout,
`npm run typecheck:gate`:

```
No new type errors. 0 pre-existing errors still in the baseline.
```

### Deviations

- **No in-memory dataset.** Core has no in-memory dataset that answers triples reads (the
  `MemoryGraphStore` test helper answers graph queries and record selects only), so there was none
  to extend. A dataset other than `SparqlDataset` is covered by the feature check: without
  `triplesPattern` in `supports` it is refused before it is asked.
- **No IR.** A triples read has no IR beyond itself (report 093: plain data is its own wire form);
  "through IR" is the `TriplesQuery` fields.
- **The ask is `.exists()` on the triples read**, not an `AskBuilder.forPredicate`: it travels the
  channel every router already forwards, and `SELECT … LIMIT 1` stops at the first match as `ASK`
  does. An ask kind would need a predicate pattern in `AskQuery`'s IR, its lowering and wire form,
  and a select fallback that cannot exist without a shape.
- **K3 as a core field**, as decided: nothing in the code argued for a host-registered field. Added
  beyond the brief: `null` clears a record field (the review found `attributedTo` could not be
  unset).
- **Added:** a read with all three positions fixed is refused (no open position, no SELECT).

### Follow-ups

- `core-tx`'s area, `LinkedStorage.triplesQuery`: datasets are checked one by one as the join
  reaches them, so `exists()` stopping at the first answer can skip a later dataset that lacks
  `triplesPattern` (which would have been refused had it come first). Checking every dataset's
  features before the loop makes the refusal independent of order.
- The host app (batch B2): `termUsage.ts`/`OntologyUsageProvider.ts` move to `toNode`/`withPredicate`; every
  router and the execution gateway that forwards `triplesQuery` must list `triplesPattern` in its
  `supports`, and the gateway's triples arm needs its rule for registered ontology graphs (the host app's
  inventory, question 3). The host app (B3): `hubGraphSync.ts` moves to `attributedTo`.
- `withPredicate(p).from(graphs.union)` reads every named graph, as `readContent(graphs.union)`
  does; the rule is that a predicate read names its graphs, not that the set is small.
