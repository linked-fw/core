---
summary: Add an index-backed text-search primitive `.search(text, options?)` to the query DSL — universal entry point that picks the fastest available path per IDataset backend (Lucene FTS on Fuseki, FILTER fallback on bare SPARQL, future SQL FTS on relational backends).
packages: [core, fuseki]
---

# Fulltext / `.search()` DSL primitive — Ideation

## Context

The Linked Query DSL today exposes per-property predicates for text matching, all of which compile to SPARQL `FILTER` expressions (O(n) literal scans):

| Method | SPARQL | Use |
|---|---|---|
| `.equals(value)` | `?x = value` | exact equality |
| `.matches(pattern, flags?)` | `REGEX(?x, pattern, flags)` | regex (structural patterns, validation) |
| `.contains(substr)` | `CONTAINS(?x, substr)` | case-sensitive substring scan |
| `.startsWith(prefix)` | `STRSTARTS(?x, prefix)` | case-sensitive prefix scan |
| `.endsWith(suffix)` | `STRENDS(?x, suffix)` | case-sensitive suffix scan |

**Gap**: there is no index-backed FTS primitive. On a Fuseki dataset with the `text:` Apache Jena Lucene extension enabled, queries like `text:query "alice*"` execute in milliseconds against an inverted index. The DSL has no way to express this — callers either use the slow `.contains() / .startsWith()` fallbacks or drop down to raw SPARQL strings.

### Concrete trigger (CN context)

Create Now's `InstanceProvider.searchInstances` (in `packages/create-now-js/src/shapes/InstanceProvider.ts`, originally authored by Carlen Young in February 2026 as `ProjectProvider.searchInstances`, then extracted in iter-4) uses raw SPARQL:

```sparql
PREFIX text: <http://jena.apache.org/text#>
SELECT DISTINCT ?subject ?label ?image WHERE {
  (?subject ?score) text:query "${safeText}*" .
  GRAPH <${defaultGraph}> {
    ?subject a <${targetClassUri}> .
    ...
  }
}
```

This powers `CustomMultiSelect` (the multi-select picker for object-property form fields in CN's CMS-mode UI). After CN promoted "raw SPARQL is a smell" to a Phase-1 architectural rule (arch-10), `searchInstances` is one of the sites that must convert — but it can't until the DSL has an index-backed FTS primitive.

### What exists today in `@_linked/core`

**DSL expression methods** — `SelectQuery.ts:856–857`:
```
'concat', 'contains', 'startsWith', 'endsWith', 'substr', 'before', 'after',
'replace', 'ucase', 'lcase', 'strlen', 'encodeForUri', 'matches',
```
All compile to SPARQL FILTER expressions via `ExpressionNode` (e.g. `REGEX` for `.matches()` at `ExpressionNode.ts:263`).

**SPARQL emission** — `SparqlDataset` compiles `IRExpression` → SPARQL string. No special-casing for Lucene `text:query`.

**Backend abstraction** — `IDataset` has `selectQuery / updateQuery / createQuery / deleteQuery`. No capability declaration mechanism (a dataset can't currently say "I support fulltext").

## Use cases

| # | Scenario | Concrete example |
|---|---|---|
| **UC1** | Prefix autocomplete ("typeahead") | User types `al` in a person picker → match `Alice`, `Alex`, `Alan`. |
| **UC2** | Token-aware multi-word search | User types `john smith` → match `"John Smith"`, `"Smith, John"`, `"Dr. Smith John Q."` (both tokens present, order-independent). |
| **UC3** | Fuzzy / typo-tolerant (**future, not v1**) | User types `jhon` meaning `john` → still finds `John`. |

Phrase ("contains exact word sequence in order") is **NOT** a separate mode — it's equivalent to `mode: 'contains', caseSensitive: false` for non-tokenized backends and only meaningfully different from contains+ci when the engine also tokenizes (rare in DSL-typical use cases like Person/Topic search).

## How existing systems handle these

| | UC1 prefix | UC2 token-aware | UC3 fuzzy |
|---|---|---|---|
| **ElasticSearch** | `prefix` query | `match` query | `match` with `"fuzziness":"AUTO"` |
| **PostgreSQL FTS** | `to_tsquery('al:*')` | `to_tsquery('john & smith')` | `pg_trgm` ext (separate) |
| **Apache Jena Lucene** | `text:query "al*"` | `text:query "john smith"` | `text:query "jhon~"` |
| **MongoDB $text** | not native (use $regex) | `$search: 'john smith'` | not native |
| **Algolia** | auto (prefix-by-default) | `search('john smith')` | auto typo tolerance |
| **Meilisearch** | auto | `search('john smith')` | auto typo |
| **Prisma** | not exposed | `{ search: 'john & smith' }` | not exposed |

Two naming camps: search-engine-shaped libs (Algolia/Meilisearch/Prisma) use a single `.search()`; query-language libs (ES/PG) use distinct methods per mode. We pick the search-shaped pattern (single `.search()` + options) for terseness and natural feel.

## Goals

1. **Single canonical text-search entry point** — `.search(text, options?)` — with per-call mode + case-sensitivity options.
2. **Backend-portable** — DSL surface unchanged across `SparqlDataset` (Fuseki, with or without Lucene), future `SqlDataset` (with PG FTS / MySQL FULLTEXT), future API-backed datasets.
3. **Graceful degradation** — when a backend doesn't support an index-backed mode, the call still works (falls back to the equivalent FILTER pattern that `.contains() / .startsWith()` would produce today). Never silently changes semantics.
4. **Unify the existing slow predicates** — `.contains() / .startsWith() / .endsWith()` become 1-arg sugar over `.search()` preserving today's case-sensitive default behavior, but now route through the same backend dispatch and get the fast path for free when available.
5. **Compose with the rest of the DSL** — `.search()` returns an `ExpressionNode` like any other predicate; works inside `.where(p => p.name.search('al').or(p.email.search('alice')))`.

## Decisions (locked-in during iter-7 ideation)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | API name | `.search(text, options?)` | Natural ("`p.name.search('al')`"), single method matches Algolia/Prisma convention, doesn't collide with existing `.matches()` (regex) or `.contains()` (substring scan). Considered `.fulltext()` (more explicit but more technical) — rejected for being heavier than needed once we collapsed the slow predicates into the same router. |
| D2 | Semantics | **Both** property-scoped (`p.name.search('alice')`) and shape-wide (`p.search('alice')` — expands internally to OR over all literal properties of the shape). | Property-scoped is the explicit case; shape-wide is what `CustomMultiSelect`-style pickers actually want (search across name/email/title/etc. without enumerating). Implementation reads the shape's literal-property metadata to expand the OR. |
| D3 | Operator surface (v1) | `mode: 'prefix' \| 'contains' \| 'suffix' \| 'tokens'` + `caseSensitive: boolean` option. Default `{ mode: 'tokens', caseSensitive: false }` — matches a user typing in a search box. No fuzzy/phrase in v1. | `'tokens'` covers the user's intuition (typing `"john smith"` finds anyone with both names); other modes target specific UX (typeahead = prefix, substring search = contains). Auto-escape Lucene/SPARQL special characters so callers can pass arbitrary user input without breaking the query. |
| D-Legacy | Legacy predicates | `.startsWith(s) / .contains(s) / .endsWith(s)` stay as **1-arg sugar** over `.search()`. They route through the same backend dispatch (gaining fast-path access on FTS-capable backends) but preserve today's case-sensitive default behavior. For case-insensitive, callers use `.search(s, { mode: 'prefix' / 'contains' / 'suffix' })` directly. | Migration is transparent — existing call sites compile and behave the same. Users can't accidentally pick the slow path when a fast one exists. One-arg keeps the sugar lightweight; full options surface is on `.search()`. |
| D-Regex | `.matches(regex, flags?)` | **Stays separate.** Not subsumed under `.search()`. Different operator (structural pattern match, returns boolean, no relevance ranking). No rename to `.match` (singular) — migration cost outweighs naming-purity gain; `.matches()` is also semantically accurate (Java `Matcher.matches()`). | Regex has real non-search use cases: structural URI matching, format validation, data-quality scans, migration queries. Conceptually distinct from "search for things matching this text". |
| D-Phrase | Phrase mode | **Not a separate mode.** Equivalent to `mode: 'contains', caseSensitive: false` for non-tokenized backends. | Phrase only meaningfully differs from contains+ci when the engine tokenizes AND you want adjacency+order constraints. For DSL-typical use (Person/Topic search, short literals), phrase IS contains. Don't add false complexity. |

### Compile dispatch table per IDataset

How each backend handles each `{ mode, caseSensitive }` combination:

| mode | caseSensitive | Lucene-backed Fuseki | Bare SPARQL (Fuseki without text:) | Future SqlDataset |
|---|---|---|---|---|
| `prefix` | true | `STRSTARTS(?x, "al")` (Lucene index is case-folded; can't help with case-sensitive) | `STRSTARTS(?x, "al")` | `?x LIKE 'al%'` |
| `prefix` | false | `text:query "al*"` (fast indexed) | `STRSTARTS(LCASE(?x), "al")` | PG: `?x ILIKE 'al%'` or FTS prefix |
| `contains` | true | `CONTAINS(?x, "al")` (Lucene wildcards slow + case-folded — not worth it for case-sens) | `CONTAINS(?x, "al")` | `?x LIKE '%al%'` |
| `contains` | false | `text:query "*al*"` (Lucene wildcard, slowish) OR `CONTAINS(LCASE(?x), "al")` — backend's choice | `CONTAINS(LCASE(?x), "al")` | PG: `?x ILIKE '%al%'` |
| `suffix` | true / false | `STRENDS(?x, "al")` (Lucene has no suffix index — always slow) | `STRENDS(?x, "al")` (LCASE wrap if !cs) | `?x LIKE '%al'` |
| `tokens` | (always insensitive) | `text:query "${text}"` (default tokenize) | tokens.split → AND of `CONTAINS(LCASE(?x), tok_i)` (slow but correct) | PG: `to_tsquery('${tokens.join(' & ')}')` |
| `fuzzy` (future) | (always insensitive) | `text:query "${text}~"` | throw `[IDataset] fuzzy not supported on this backend` OR fall back to closest-edit-distance substring | PG: `pg_trgm` similarity |

## Out of scope

- **Phrase as a first-class mode** — see D-Phrase. Use `mode: 'contains', caseSensitive: false`.
- **`.matches()` → `.match()` rename** — see D-Regex. Keep as-is.
- **Subsuming regex into `.search()`** — see D-Regex. Different operator, different mental model.
- **Multi-property explicit list** — e.g. `p.search('alice', { properties: ['name', 'email'] })`. Current scope is: explicit single property OR all-literal-properties via shape-wide. If a future use case wants "these 3 specific properties," add `properties` option then; YAGNI for v1.
- **Relevance scoring** — `text:query` returns a `?score`; we ignore it for v1 (return order is whatever the backend produces). If scoring is needed, that's a follow-up.

## Decisions D4–D6 (locked)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D4** | Backend capability declaration | **None at the instance level.** Each IDataset CLASS encodes its backend's capabilities by virtue of what it compiles to — `FusekiStore` IS "Fuseki + Lucene" by definition; we don't need an external registry telling us so. Base `SparqlDataset` compiles `.search()` to the FILTER fallback (correct on every SPARQL backend, slow). `FusekiStore` overrides to use `text:query` for modes Lucene supports. A future `SqlDataset` compiles to PG FTS / `ILIKE`. Genuinely-unsupported modes (e.g. `fuzzy` on bare SPARQL — no edit-distance) **throw at compile time** with a clear `[search] mode 'X' not supported by this IDataset` error. Silent fallback hides correctness/perf issues; throwing forces an explicit decision. Future enhancement: a SHAPE/RDFS-class-level "this feature isn't available at all" declaration (not currently needed — every mode either has a fallback or is opt-in like fuzzy). |
| **D5** | Where the primitive lives in `@_linked/core` | **Option B — new `IRSearchExpression` IR kind + per-dataset pre-IR rewriter.** Add `IRSearchExpression` as a new IR kind alongside `IRFunctionExpression` and `IRAggregateExpression`. The shared compiler (`selectToSparql` in `algebraToString.ts`) stays oblivious to search. Each IDataset overrides `selectQuery` to walk the query IR, find `search_expr` nodes, and rewrite them into backend-appropriate shapes BEFORE calling the shared compiler. Base SparqlDataset: simple expression swap (replace with `function_expr` calling `STRSTARTS` / `CONTAINS` / `STRENDS` / etc.). FusekiStore: **more involved** — Lucene `text:query` has unusual SPARQL syntax (`(?subject ?score) text:query "alice*" .` is a triple pattern, not a function expression). The rewriter must inject BGP (basic graph pattern) triples into the WHERE block, not just rewrite expressions. Pattern reference: how `EXISTS`/`NOT EXISTS` inject sub-graph patterns. |
| **D6** | Test fixtures | **Three test layers, each pulling its weight.** (1) DSL→IR: pass query through DSL, snapshot the IR shape. Cheap, fast, hundreds of cases. (2) IR→SPARQL golden: input IR shapes, expect SPARQL strings. Matches existing `sparql-select-golden.test.ts` pattern. Fast. (3) Integration: extend `packages/core/src/tests/sparql-fuseki.test.ts` infrastructure with a Lucene-configured dataset variant. Real Fuseki+Lucene container, seeded fixtures, assert results against real queries. The integration layer is the one infra piece this primitive adds — verify Lucene config behavior (tokenization, indexed predicates) matches expectations. |

### Compile-time error contract (per D4)

When an IDataset's rewriter encounters a `search_expr` with a mode it cannot support and cannot reasonably fall back from:

```
Error: [search] mode 'fuzzy' not supported by SparqlDataset.
  Use a backend that declares this capability (e.g. FusekiStore with Lucene),
  or remove the {fuzzy: true} option from this query.
```

Genuinely-unsupported modes today:
- `fuzzy` on bare `SparqlDataset` (no SPARQL edit-distance function)
- (Anything else? None as of v1.)

Modes that always have a fallback (no throw):
- `prefix` / `contains` / `suffix` / `tokens` — all reducible to `STRSTARTS` / `CONTAINS` / `STRENDS` chains or tokens-as-AND-of-CONTAINS. Always correct, sometimes slow.

## Implementation hints

### DSL surface

Add `'search'` to the `EXPRESSION_METHODS` set in `packages/core/src/queries/SelectQuery.ts` (around line 852). The proxy machinery already converts `p.name.search('al', opts)` into an `ExpressionNode` invocation; we then need a corresponding `search(text, opts)` method on `ExpressionNode` that builds the IR.

For the shape-wide form (`p.search('al')`), the proxy receiver is the shape root rather than a property — needs a separate dispatch path. Look at how `.equals()` works when called on the root vs on a property (lines 909–925).

### IR (per D5 = option B)

Add `IRSearchExpression` to `packages/core/src/queries/IntermediateRepresentation.ts`:

```ts
export type IRSearchExpression = {
  kind: 'search_expr';
  subject: IRExpression;            // the property or shape-wide root
  text: string;
  mode: 'prefix' | 'contains' | 'suffix' | 'tokens';
  caseSensitive: boolean;
  shapeWide?: boolean;              // when true, expand to OR over literalProperties
  literalProperties?: string[];     // resolved at IR-build time for shape-wide form
};
```

Add to the `IRExpression` union. Update `QueryBuilderSerialization.ts` with serialize/deserialize branches (same pattern as the existing `IRAggregateExpression` handling).

The shared compiler (`algebraToString.ts`) does NOT need a case for `'search_expr'` — each IDataset's pre-IR rewriter replaces all `search_expr` nodes before the IR reaches the compiler.

### Per-dataset rewriting (per D5 = option B)

Each IDataset overrides `selectQuery`:

```ts
async selectQuery(query: SelectQuery): Promise<SelectResult> {
  const rewritten = this.rewriteSearchForBackend(query);
  const sparql = selectToSparql(rewritten, this.options);
  const json = await this.executeSparqlSelect(sparql);
  return mapSparqlSelectResult(json, query);
}

protected rewriteSearchForBackend(query: SelectQuery): SelectQuery {
  // walk IR, find IRSearchExpression nodes, replace per backend conventions
  // base SparqlDataset: swap with function_expr ('STRSTARTS' / 'CONTAINS' / etc.)
  // FusekiStore: inject text:query BGP + bind ?subject (see below)
}
```

### SPARQL emission for FusekiStore (Lucene)

Lucene's `text:query` is a **triple pattern**, not a function expression:

```sparql
SELECT ?subject WHERE {
  (?subject ?score) text:query "alice*" .   # <-- triple pattern with magic predicate
  GRAPH <...> {
    ?subject a <Person> .
    ?subject schema:name ?name .
  }
}
```

So FusekiStore's rewriter has TWO jobs:

1. **Inject a triple pattern** at the BGP level: `(?subject ?score) text:query "<escaped text><mode-suffix>" .`
2. **Replace the `search_expr` node** in the WHERE expression — either remove it entirely (if the BGP injection is sufficient to constrain `?subject`) or replace with a no-op `true` expression.

Pattern reference: how `EXISTS`/`NOT EXISTS` patterns inject sub-graph patterns in the existing IR compilation pipeline. Search rewriting follows the same shape — emit auxiliary BGP, adjust the expression.

Lucene query string composition needs to:
- **Escape** Lucene-reserved characters in the user text: `+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /`
- **Append `*`** for prefix mode (after escaping).
- **No special suffix** for tokens mode (default behavior).
- **Wrap in `"..."`** for contains mode (escape internal `"`) and surround with `*...*` wildcards.
- **Append `~`** for fuzzy mode (future).

Reference: Apache Jena `jena-text` config + query syntax — https://jena.apache.org/documentation/query/text-query.html

### Sugar-method routing

`.startsWith(s)` etc. live on the property proxy. After this change they should:
- Build the same IR node `.search()` builds, with `{ mode: 'prefix' / 'contains' / 'suffix', caseSensitive: true }` hardcoded.
- Visible to backends as "this is a search-IR, here are the options" — backends route uniformly. Generic SparqlDataset emits today's `STRSTARTS` / `CONTAINS` / `STRENDS` (no behavior change). FusekiStore COULD route to text:query for `mode: 'prefix' + caseSensitive: false` — but for the legacy sugar (always cs:true) it's identical to the existing emission. No behavior change for existing callers.

## Tests (per D6 = three layers)

### Layer 1 — DSL→IR (unit, cheap, fast)

1. **Sugar parity**: `.startsWith('Al')` produces identical `IRSearchExpression` to `.search('Al', { mode: 'prefix', caseSensitive: true })`. Same for `.contains` / `.endsWith`.
2. **Mode + case-sensitivity carried into IR**: `.search('al', {mode: 'tokens', caseSensitive: false})` produces an IR node with `{mode: 'tokens', caseSensitive: false}`.
3. **Shape-wide expansion at IR-build time**: `Person.where(p => p.search('alice'))` produces IR with `shapeWide: true` AND `literalProperties: ['<schema:name>', '<schema:email>', ...]` resolved from Person's shape metadata.
4. **Defaults**: bare `.search('text')` (no options) produces `{mode: 'tokens', caseSensitive: false}`.

### Layer 2 — IR→SPARQL golden (per-backend emission)

5. **Base SparqlDataset emission**: 4 modes × 2 case-sens = 8 golden SPARQL snapshots, all using FILTER predicates.
6. **FusekiStore emission**: same 8 cases — but `prefix-ci` / `tokens` / `contains-ci` / future `fuzzy` use `text:query` BGP injection; `prefix-cs` / `suffix` / `contains-cs` stay on FILTER (Lucene can't help).
7. **Lucene character escaping**: `.search('a+b\\?c', {mode: 'prefix'})` against FusekiStore emits `text:query "a\\+b\\\\\\?c*"` (all reserved chars escaped).
8. **Genuinely-unsupported mode throws**: requesting `mode: 'fuzzy'` against base `SparqlDataset`'s rewriter throws `[search] mode 'fuzzy' not supported by SparqlDataset` at compile time.

### Layer 3 — integration vs real Fuseki+Lucene

Extend `packages/core/src/tests/sparql-fuseki.test.ts` infrastructure with a Lucene-configured dataset variant.

9. **Case-sensitivity round-trip**: seed `["Alice", "alice", "ALICE"]`. `.search('al', {mode: 'prefix', caseSensitive: false})` returns all three; `.search('al', {mode: 'prefix', caseSensitive: true})` returns only the lowercase one.
10. **Tokens default**: seed `["John Smith", "Smith, John", "John Doe"]`. Default `.search('john smith')` returns first two, not the third.
11. **Shape-wide search**: seed people with various name/email combinations. `Person.where(p => p.search('alice'))` returns people whose ANY literal property contains "alice" (tokenized).
12. **Sugar method delegation**: `p.name.startsWith('Al')` against real Fuseki returns the same results before and after the conversion to sugar-over-`.search()`.

The integration test infra needs:
- A Fuseki test container configured with `text:` extension + a Lucene index covering the test dataset's literals.
- Fixture data that exercises tokenization (multi-word names), case variants, and special characters.
- `cn-main-test`-style isolation: per-test-run prefixed slugs, drop the test dataset at suite end.

## Status / sequencing

**Currently deferred from CN Phase 1** — the trigger (CN's `InstanceProvider.searchInstances`) is Carlen Young's February 2026 code, predating CN's Phase 1.7 raw-SPARQL cleanup recency cutoff (~2026-03-22). It will be converted when CN's Phase 2 or 3 reviews the CMS feature surface that depends on `searchInstances`.

This `@_linked/core` ideation can land independently — the primitive is useful beyond CN's specific trigger (any Linked Query consumer with Lucene-enabled Fuseki can use it immediately).

**Suggested implementation order:**

1. Lock the remaining D4-D6 decisions.
2. Implement the IR kind + DSL surface.
3. Implement bare-SparqlDataset FILTER emission (no behavior change for existing sugar-method callers).
4. Implement FusekiStore Lucene emission for the modes that benefit.
5. Convert the sugar methods (`.startsWith / .contains / .endsWith`) to route through the new search-IR.
6. Add tests per D6.
7. Document in `@_linked/core` README.

**Related ideation:**
- Upsert (`Shape.upsert`, plan `002-shape-upsert.md`) — orthogonal but referenced from CN's Phase 1.7 ideation (we hit a similar upsert gap with `UserProjectContextProvider.setActiveBranch`).
- `006-dsl-aggregates-sum-avg-min-max.md` (and the grouping of report 096) — related but distinct (this idea is about WHERE-clause text predicates; those are about SELECT aggregations).
- `020-distinct.md` — also a WHERE/SELECT modifier; not directly related but similar surface-area question.

## Notes / open hands

- DSL aesthetics matter more than my analysis says. If `.search()` ever feels wrong in real CN code, revisit.
- The shape-wide form (`p.search('al')`) is where most of the implementation complexity lives — it has to enumerate the shape's literal properties at IR-build time. Property-scoped (`p.name.search('al')`) is straightforward.
- Future modes (fuzzy, phrase-with-tokens, boost/ranking) all extend `options` rather than the method surface — that's the whole point of D3's options-bag choice.
