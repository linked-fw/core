---
summary: Two SPARQL-generation improvements in @_linked/core — structured sh:path on named
  properties now resolve to real property-path predicates (previously matched nothing), and nested
  selects can bound a related collection with .limit()/.offset()/.orderBy() (single-subject only,
  fails loudly otherwise). Shipped in PR #91.
---

# 015 — Structured Property Paths & Nested-Select Pagination

**PR:** [#91](https://github.com/linked-fw/core/pull/91) → `dev`.
**Changeset:** `.changeset/sparql-property-paths-and-nested-pagination.md` (minor).
**Reference docs:** `documentation/sparql-algebra.md`, `documentation/intermediate-representation.md`.
**Related:** `011-shacl-property-paths-and-prefix-resolution` (property-path foundations this builds on).

Two independent improvements to the IR→SPARQL pipeline, plus the review/cleanup that followed.

---

## Part 1 — Structured `sh:path` on named properties

### Problem
The pipeline (DSL → IR → SHACL → SPARQL) already implemented property paths end-to-end for **inline**
paths. But a query referencing a **named property** whose SHACL `sh:path` is *structured* (sequence
`[a, b]`, inverse `^p`, alternative `a|b`) fell through a fallback resolver that returned the property's own
(shadow) IRI — so it compiled to a triple matching nothing. Simple single-predicate properties worked.

### Root cause & fix
`resolvePropertyPredicateIri(propertyId): string` (`src/sparql/irToAlgebra.ts`) used `getSimplePathId`, which
returns `null` for any structured path, then fell through to `return propertyId` (the shadow IRI). The
property shape already held a full `PathExpr` at `propertyShape.path`, but the fallback never reached the
path-rendering machinery.

Replaced with **`resolvePropertyPredicateTerm(propertyId): SparqlTerm`**:
- Simple single-IRI path → `iriTerm(resolvedId)` (or `iriTerm(propertyId)` for unresolvable `linked://tmp/`
  ids) — **byte-for-byte unchanged**.
- Structured path → `{kind:'path', value: pathExprToSparql(shape.path), uris: collectPathUris(shape.path)}`
  — the same node the inline-`pathExpr` branches already produce. `serializeTerm`'s `case 'path'` renders it
  and collects its URIs for the PREFIX block.

All 7 predicate call sites (traverse, property_expr, context_property_expr, exists, create/update field,
blank-node walk) now call the term-returning resolver directly, dropping the outer `iriTerm(...)` wrapper.

### Where the fallback is reached
In the normal fluent pipeline, complex paths are inlined as `pathExpr` during desugaring (`IRDesugar`), so
the fallback is hit only via directly-constructed IR, `context_property_expr` (never inlines), and
mutation/blank-node sites. The fix makes the fallback robust regardless.

### Scope note (mutations)
The resolver is also used at the two write-template sites (CREATE/UPDATE). Writable properties are always
simple single predicates, so those keep emitting a plain IRI — no regression. A structured path is not a
writable target before or after the change.

---

## Part 2 — Nested-select inner pagination (`.limit()` / `.offset()` / `.orderBy()`)

### Capability
A nested select on a related collection can now be bounded, **when the outer query targets a single root
subject**:

```ts
Person.select((p) => p.friends.select((f) => f.name).orderBy((f) => f.name).limit(2)).for({ id });
```

Emits:
```sparql
SELECT DISTINCT ?a0 ?a1_name ?a1 WHERE {
  ?a0 rdf:type <…/person> .
  OPTIONAL {
    { SELECT ?a1 WHERE { <id> <…/friends> ?a1 . } ORDER BY ASC(?a1) LIMIT 2 }
    OPTIONAL { ?a1 <…/name> ?a1_name . }
  }
  FILTER(?a0 = <id>)
}
```

`orderBy` accepts a proxy callback (`f => f.name`, consistent with the rest of the DSL) or a property-name
string; defaults to ascending. A default `ORDER BY ?childVar` keeps windows deterministic when no inner
order is given.

### Key design decisions
- **Single-subject only (uncorrelated sub-SELECT).** A plain SPARQL sub-`SELECT … LIMIT n` is *uncorrelated*
  — it bounds **globally**, not per-parent (confirmed against Fuseki/Jena: 2 parents × 3 children, `LIMIT 2`
  returned only the first parent's two children and dropped the second entirely). It equals per-parent
  windowing **only** when the outer query has one root subject, which is inlined into the sub-SELECT.
- **Fail loudly, never silently global-limit.** An inner limit/offset throws when the outer query is not
  single-subject (`subjectId` unset / `subjectIds.length > 1`), when pagination targets a deeper (grandchild)
  collection (parent is multi-valued → effectively multi-parent), or when `.limit()` is called directly on a
  traversal without `.select(...)` (previously a silent no-op stub).
- **Wrap only the root→child traverse.** The sub-SELECT projects just the child variable; the child's own
  property triples stay *outside* (as OPTIONALs joined on the child var), so the flat-row structure and
  result mapping are unchanged.
- **OPTIONAL wrapper.** The sub-SELECT (+ child props) is wrapped in a single `OPTIONAL`, so a parent with an
  empty/fully-windowed-out child set is still returned.
- **Byte-for-byte unchanged** when no inner pagination is set.

### Implementation — vertical slice
| Layer | File | Change |
|---|---|---|
| Algebra | `src/sparql/SparqlAlgebra.ts` | new `SparqlSubSelect` node `{type:'subselect'; projection; inner; orderBy?; limit?; offset?}` |
| Serializer | `src/sparql/algebraToString.ts` | `'subselect'` case → `{ SELECT … WHERE { … } ORDER BY … LIMIT … OFFSET … }` |
| Lowering | `src/sparql/irToAlgebra.ts` | detect paginated traversals; single-subject + depth guards (throw); wrap root→child traverse in `SparqlSubSelect`; nest child props inside its OPTIONAL |
| IR | `src/queries/IntermediateRepresentation.ts` | `innerLimit?/innerOffset?/innerOrderBy?` on `IRTraversePattern` + `IRInnerOrderBy` |
| Lower | `src/queries/IRLower.ts` | `attachInnerPagination` carries inner pagination onto the child traverse |
| Desugar | `src/queries/IRDesugar.ts` | `DesugaredSubSelect` inner-pagination fields |
| DSL | `src/queries/FieldSet.ts` | `.limit()/.offset()/.orderBy()` record onto the sub-select FieldSet; `orderBy` accepts proxy callback or string |
| DSL | `src/queries/SelectQuery.ts` | bare `QueryBuilderObject.limit()` now throws a directive error (was a silent no-op) |

### Deferred — multi-parent per-group pagination
Per-group Top-N across multiple parents is **not** implemented (rejected with a clear error). It requires a
correlated **rank rewrite**, e.g.:
```sparql
SELECT ?p ?c WHERE {
  ?p :friends ?c .
  { SELECT ?p ?c (COUNT(?hi) AS ?rank) WHERE { ?p :friends ?c . ?p :friends ?hi . FILTER(STR(?hi) <= STR(?c)) } GROUP BY ?p ?c }
  FILTER(?rank <= n)
} ORDER BY ?p ?c
```
This is proven to work per-parent against Fuseki and kept as a reference test in
`nested-select-pagination.test.ts`. It needs an ordering contract per paginated collection, GROUP BY, and
tie-breaking. A type-level guard preventing `.limit()` on multi-root parents was considered but is blocked by
API ordering (single-vs-multi root is decided by `.for()`/`.forAll()` *after* the selection lambda runs); the
runtime throw is the pragmatic guard.

---

## Test coverage
- `src/tests/property-path-named-resolution.test.ts` — inverse / sequence / sequence+inverse / simple
  regression, at both the IR→SPARQL and Fuseki-execution levels.
- `src/tests/nested-select-pagination.test.ts` — IR→SPARQL golden (limit/offset/orderBy, no outer LIMIT);
  fail-loud guards (scan, multi-subject, deeper nesting, bare `.limit()`); regression (no inner limit ==
  existing OPTIONAL left-join); Fuseki execution (limit/offset/window-slide/orderBy/empty-child/scoped-to-
  subject); proxy-form `orderBy` parity; multi-parent rank-rewrite reference.
- Existing SELECT/mutation golden suites unchanged (byte-for-byte invariance).
- Totals: full suite **1102 passed / 0 failed** (114 skipped, env-gated; Fuseki auto-starts via Docker,
  skips gracefully when unavailable). `tsc --noEmit` clean; `yarn build` green.

## Public API surface
- `resolvePropertyPredicateTerm` is internal (not exported); no public signature changed for Part 1.
- Part 2 adds usable DSL methods on a nested `select()`'s result: `.limit(n)`, `.offset(m)`,
  `.orderBy(cb | name, 'ASC'|'DESC')`.
