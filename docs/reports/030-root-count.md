---
summary: >
  A root-level COUNT landed in the query DSL — `SelectBuilder.count()`, a public
  `toCount()` and `Shape.count()`, resolving to a real `number` and lowering to
  `SELECT (count(DISTINCT ?a0) AS ?count) WHERE { … }`. Built as a sibling builder and IR kind
  modelled on `ask`, so `limit`/`offset` are unrepresentable rather than ignored, and
  `IDataset.countQuery` is optional so no implementer breaks.
source_plan: docs/plans/003-root-count.md (converted; plan removed)
packages: [core]
consumers: ["@_linked/shape-ui — selectInstances returns a row total for server-side paging"]
---

# 030 — Root-level `COUNT`

Status: **done**, merged as PR #224 (`feat(core): a root-level COUNT for the query DSL`). Suite
**1897 passed / 0 failed / 120 skipped / 2017 total** across 76 suites; baseline at the branch point
was 1817 / 1938. Typecheck and build clean. One `minor` changeset.

"How many instances of this shape match this filter?" was previously unanswerable. The only count in
the DSL was `.size()` on a **property's value set**, which is a different question (see §6).

## 1. API

```ts
const total    = await Person.count();                                       // every instance
const matching = await Person.select().where((p) => p.name.equals('Semmy')).count();
const scoped   = await Person.select().minus(Employee).for(entity('p1')).count();

const envelope = Person.select().where(…).toCount().toJSON();                 // {op: 'count', …}
```

- **`SelectBuilder.count(target?): Promise<number>`** — the symmetric twin of `.exists(target?)`.
  It is `this.toCount().exec(target)`.
- **`SelectBuilder.toCount(): CountBuilder`** — **public**, unlike the private `_toAsk()`, because a
  router or RPC boundary needs the envelope (`toCount().toJSON()`) to *forward* the query rather than
  execute it. `@_linked/shape-ui` crossing an HTTP boundary is exactly that caller.
- **`Shape.count(target?): Promise<number>`** — the no-filter shorthand. On the **base class** it
  rejects: a shapeless count would count every node in the store under any type or none, and no
  caller means that. (Contrast `Shape.exists(uri)`, where the shapeless reading is useful and cheap.)
  It is `async`, so the refusal rejects rather than throwing synchronously past the caller's `catch`.

Emitted form — no `GROUP BY`, no `SELECT DISTINCT`, no `ORDER BY`, no window:

```sparql
PREFIX rdf: <…>
SELECT (count(DISTINCT ?a0) AS ?count)
WHERE {
  ?a0 rdf:type <…Person> .
  ?a0 <…name> ?a0_name .
  FILTER(?a0_name = "Semmy")
}
```

`count(DISTINCT …)` counts **subjects, not rows**. `selectToAlgebra` emits `SELECT DISTINCT` for
every non-aggregate query for good reason: a shape scan joined with property triples yields one row
per property-value combination, so a `where` on a multi-valued property produces several rows per
subject. Counting rows would inflate the total for exactly the queries this feature exists to serve.

## 2. Why a sibling builder and IR kind, not a flag on select

This is the central decision, and it is a correctness argument rather than a taste one.

`selectToAlgebra` does two things unconditionally: it pushes the root alias as a plain projected
variable before converting any projection item, and — once any aggregate is present — it makes every
non-aggregate projected variable a `GROUP BY` target. An `IRSelectQuery` whose only projection item
is `aggregate_expr('count', …)` therefore lowers to

```sparql
SELECT ?a0 (count(?a0) AS ?count) WHERE { … } GROUP BY ?a0
```

— one row per entity, each counting 1. Not a rounding error: a *plausible-looking wrong number*.
Producing the root form out of `IRSelectQuery` means a mode flag honoured in two separate places
inside one 560-line function, where forgetting either yields a silently wrong total. A `countOnly`
flag would also have to *ignore* `limit`/`offset` in a type that carries them, and squeeze a
`ResultRow[]` result into a number.

So a count follows the **`ask` pipeline** instead, which exists for precisely this class of problem:
a query whose answer is a scalar, for which projection, ordering and pagination are meaningless, and
whose types make those fields unrepresentable rather than ignored. `countToAlgebra` takes the
*pattern* from `selectToAlgebra` (passing `projection: []`) and discards its projection, building its
own from the existing `aggregate_expr` node — so shape scans, traversals, filters and `MINUS` keep
exactly one implementation, and **`algebraToString.ts` needed no change at all**
(`{kind: 'aggregate', expression: {kind: 'aggregate_expr', name: 'count', distinct: true}, alias}`
already serializes as `(count(DISTINCT ?a0) AS ?count)`; `groupBy`/`limit`/`offset`/`having` are all
optional and omitted when unset). The count plan simply *is* a `SparqlSelectPlan`.

## 3. `limit`/`offset` are dropped, not rejected

Kept across `toCount()`: shape, subject(s), `where`, `minus` — everything that decides membership of
the match set. Dropped: projection, preloads, `orderBy`, `limit`, `offset`.

Dropped rather than an error because:

1. There is exactly one sensible interpretation — `count()` answers a question about the match set,
   not about a page of it, as `OFFSET` skips rows of a *solution sequence* and a count has none.
2. The paging caller holds **one** builder. It wants the page *and* the total from the same filter;
   rejecting the combination would force it to rebuild the builder without the window, by hand, for
   zero correctness gain.
3. `.exists()` already made this call for this reason, so the DSL keeps **one** rule: *a
   scalar-answering query drops the solution-sequence modifiers.*

The drop happens once, in `toCount()`, and **cannot be half-applied**: `CountQuery`, `CountQueryJSON`
and `IRCountQuery` have no field a window could live in, and `countToAlgebra` returns a plan with
`limit`/`offset`/`orderBy`/`groupBy` all undefined. A golden test asserts a paginated builder's count
is byte-identical to a bare one's.

`CountBuilder` is deliberately **non-generic** (`implements PromiseLike<number>, Promise<number>`), so
it cannot perturb `SelectBuilder<S, R, Result>`'s inference — it participates in none of it, and
`.count()` is `Promise<number>` whatever `R`/`Result` were. `src/tests/type-probe-count.ts` pins this
at typecheck time, and was verified to *discriminate*: asserting `exists()` (a `Promise<boolean>`)
against the `Promise<number>` probe produces `error TS2345`, so a regression fails the build.

## 4. The path, layer by layer

```
SelectBuilder.count(target?)
  └─ toCount(): CountBuilder                      drops projection/preloads/orderBy/limit/offset
       ├─ toJSON() → {v:'1.1', op:'count', shape, …}     fromJSON routes it back
       └─ exec(target?)
            └─ resolveCount(dispatch, query)              queryDispatch.ts
                 └─ IDataset.countQuery?(query)
                      └─ SparqlDataset.countQuery
                           ├─ lower(query) → IRCountQuery            lower.ts / lowerCount
                           ├─ countToSparql → countToAlgebra         irToAlgebra.ts
                           │    ├─ selectToAlgebra(…) for the PATTERN
                           │    └─ + the count aggregate projection
                           │    └─ selectPlanToSparql (UNCHANGED)
                           └─ mapSparqlCountResult                   resultMapping.ts
```

`IRCountQuery` carries `kind`, `root` (an `IRShapeScanPattern`), `patterns`, optional `where`,
`subjectId`/`subjectIds`, and `alias` — the variable the `COUNT` binds to, held in the IR rather than
hardcoded in two places so lowering and result mapping cannot disagree. There is deliberately no
`projection`, `orderBy`, `limit` or `offset`. Result mapping reads `sanitizeVarName(query.alias)`,
the same function the serializer uses, so they cannot drift.

**Wire.** `{"v": "1.1", "op": "count", "shape": "…/Person", "where": {…}}`. `WIRE_VERSION` stays
`'1.1'` — a new additive `op` is exactly what `assertWireVersion`'s MAJOR-only policy tolerates, and
bumping the minor would churn every golden envelope that pins `v`. Unlike ask's, `shape` is
**required**. There is no `fields`, `limit`, `offset`, `sortBy` or `one`, so a receiver has nothing to
ignore; an older peer hits `fromJSON`'s `default:` and throws `Unknown query op "count"` — loud, not
reinterpreted as a select.

**Refusals never answer `0`.** `resolveCount` enforces the contract once for every store: a missing
`countQuery` throws naming the method; the answer must be a finite, non-negative integer, and
anything else throws rather than being coerced; failures propagate. A count that reports an
unreachable store as "0 rows" renders an empty table and looks like data. `mapSparqlCountResult` is
strict for the same reason: a missing binding, an empty result set, a blank lexical form or a
non-integer all throw.

A null or unresolved subject (`.for(null)`) answers **`0` without querying** in `CountBuilder.exec`,
mirroring `exists()` answering `false`; *lowering* such a query is refused loudly.

`toCount()` and `_toAsk()` share one private `_patternSpec()` on `SelectBuilder` rather than two
verbatim copies, with a parity test asserting the two envelopes carry an identical pattern for six
builder shapes — a drift would mean `count === 0` sitting beside `exists === true` from the same
builder. A live `PendingQueryContext` subject survives `toCount()` as itself rather than being
narrowed to `{id}`, so it is resolved by the receiver's context map, not this process's.

## 5. Two real bugs the review pass caught

Both have regression tests that were **verified to fail when the fix is reverted**.

**An unresolved context subject counted the whole shape.** `lowerCount` refused `nullSubject` and a
missing shape, but not a `PendingQueryContext` with no `id`. `buildSelectQuery` narrows a subject with
`'id' in subject` and `PendingQueryContext` has an `id` *getter*, so an unresolved one quietly yielded
`subjectId: undefined` and the emitted query was `SELECT (count(DISTINCT ?a0)) WHERE { ?a0 a Person }`
— **every instance of the shape, reported as the count of one node**. `CountBuilder.exec`
short-circuits that case, but the path that skips `exec` is exactly the one `toCount()` is public
*for*: a receiver that rehydrates the envelope with `fromJSON` and hands the builder straight to a
store. The one case that actually crosses a process boundary was the unguarded one. Fixed by
resolving in `lowerCount` via `resolveContextId(name, true)`, which throws `UnresolvedContextError`
when unset — the same "not ready" a where-clause reference raises, never a plausible number. Pinned
at three levels (wire, golden, Fuseki).

**`mapSparqlCountResult` could still return `0`.** `Number('')` is `0` and `Number.isFinite(0)` is
`true`, so a blank lexical form returned the single value the function's own doc comment forbids it to
invent. The integer and non-negative checks also lived *only* in `resolveCount`, which
`SparqlDataset.countQuery` does not route through — and calling a store's `countQuery` directly is a
supported entry point that the Fuseki suite uses. Fixed by rejecting a blank form before the numeric
check and repeating the integer/non-negative checks in the mapper, with a comment saying why they are
repeated.

Two smaller findings: `toJSON()` could emit `shape: ''` for the receiver's `fromJSON` to reject — the
refusal moved to serialization time, where the caller who holds the shape can act on it; and the
README's counting section covered only `.size()`.

Checked and confirmed clear: no `limit`/`offset` leak path exists (no IR *pattern* kind carries a
window — they appear only on `IRSelectQuery`); the alias-collision worry is not real
(`selectToAlgebra`'s aggregate rename only walks `query.projection`, which `countToAlgebra` passes as
`[]`, and generated aliases are `a<N>` / `a<N>_<prop>`); and the HAVING guard is sufficient, since
`groupBy` is only set when aggregates are present, which with an empty projection can only come from
the having expression.

## 6. `.count()` vs `.size()` — different questions

`.count()` counts **instances at the query root**: one number for the whole match set.
`.size()` counts a **property's value set, per row** (`p.friends.size()`), requires a
`subject.property`, and lowers to a `HAVING` clause over a per-subject group. It cannot count
instances at the root. The README's "Counting" section (`README.md` §Counting) presents both side by
side and states the distinction directly.

## 7. Dataset contract — optional, so nothing breaks

`IDataset.countQuery?` is **optional**, unlike the required `askQuery`. A required method would break
every implementer at compile time, which a `minor` cannot do. `SparqlDataset.countQuery` is concrete,
so **anything extending `SparqlDataset` gets it for free with no edit** — including every subclass in
every consumer. A store or router defined as a bare `setQueryDispatch({…})` literal needs a
`countQuery` arm added by hand, and until then fails loudly with an error naming the method and what
to implement (noted in the changeset for consumers).

## 8. Tests

1817 / 1938 at the branch point → **1897 passed, 0 failed, 120 skipped, 2017 total**, 76 suites
(`--runInBand`; the Fuseki suites share a dataset per worker).

- **`sparql-count-golden.test.ts`** (new, 23) — IR goldens carrying no `limit`/`offset`/`projection`
  key; byte-exact SPARQL for every fixture including `VALUES ?a0 { … }` for multiple subjects and the
  `MINUS` form; `countPaginated`/`countNormalised` byte-identical to `countAll`/`countWhere`; no
  `GROUP BY`/`LIMIT`/`OFFSET`/`ORDER BY` in any fixture's output; the DISTINCT; the HAVING guard
  throwing; the unresolved-context-subject refusal.
- **`count-wire.test.ts`** (new, 30) — envelope shape per pattern form and the absence of any
  answer-shaping field; `fromJSON` returning a `CountBuilder` that round-trips to identical IR; an
  unknown op still throwing; a shape-less envelope refused; `resolveCount` rejecting a missing
  method, a non-number, a negative and a non-integer, and **rejecting rather than returning `0`** when
  the store throws; the blank/fractional/negative binding forms; the public entry points
  (`SelectBuilder.count`, `Shape.count`, `await builder`) against a dispatch lacking `countQuery`;
  the `toCount()`/`_toAsk()` pattern-parity assertion; and the unresolved-context-in-`where`
  asymmetry — select answers `null`, count **rejects**.
- **`sparql-fuseki.test.ts`** (+9, live Fuseki) — counts every instance; respects `where`, a subject
  filter, `MINUS` and explicit subjects; ignores a window; refuses an unresolved context subject;
  `SparqlDataset.countQuery` end to end. Including a demonstration that **stripping `DISTINCT` from
  the emitted query changes the answer from 1 to 2** — the row-vs-subject inflation, measured.
- **`type-probe-count.ts`** (new, not a test — compiled by `npm run typecheck`) — `.count()` is
  `Promise<number>` regardless of the builder's generics, `toCount()` is a `CountBuilder`, `await
  countBuilder` is a `number`.
- Support: `countFactories` in `query-fixtures.ts` (kept out of `queryFactories` because `.count()`
  is terminal), and a `countQuery` arm on `query-capture-store.ts`.

## 9. Known limitations and deferred work

- **Counting a HAVING-filtered group set is refused, loudly.** A `where` containing an aggregate
  (`p.friends.size().gt(2)`) lowers to `HAVING` + `GROUP BY` on the select plan; `countToAlgebra`
  carries over only the plan's `algebra`, so the filter would vanish and the count would be of the
  *unfiltered* match set. Supporting it needs
  `SELECT (count(DISTINCT ?a0) AS ?count) WHERE { SELECT ?a0 WHERE { … } GROUP BY ?a0 HAVING(…) }`,
  and `SparqlSubSelect` carries no `groupBy`/`having` today. `countToAlgebra` detects the `having` and
  throws, naming the limitation. Deferred, not silently wrong.
- **`CountBuilder` and `AskBuilder` are near-identical files** — roughly 150 duplicated lines that a
  shared scalar-query base (or a small generic over the answer type) would remove. Left alone
  deliberately: it changes `AskBuilder`, which was out of scope here, and wants its own review.
- **`askToAlgebra` has the same HAVING silent-drop that `countToAlgebra` guards against.** Pre-existing
  and not introduced by this work, so not fixed here: `.where(p => p.friends.size().gt(2)).exists()`
  emits an `ASK` with the aggregate filter *missing*, so it answers "does any Person exist". The fix
  needs the same nested-sub-SELECT work the count guard defers. **No backlog entry exists for it yet
  — one should be filed.**

## 10. Consumers

`@_linked/shape-ui`'s `selectInstances` uses this to return a row total alongside a page so a host can
paginate server-side — the reason `toCount()` is public. Create Now's backlog item
`docs/backlog/049-overview-page-back-onto-the-dsl-read.md` (in the `create_now` repo) depends on it.
