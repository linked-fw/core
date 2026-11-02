---
summary: >
  `Shape.upsert(values).for({id})` — one round-trip create-or-replace, retiring the
  `exists() ? update : create` branch userland keeps hand-rolling. Lowers to the DELETE/INSERT/WHERE
  the update path already emits, plus the `rdf:type` triple the update path omits.
status: Implementation
packages: [core]
source_backlog: docs/backlog/038-upsert.md, docs/backlog/017-upsert.md
---

# 002 — `Shape.upsert()`

## Planning blockers explored

### B1 — Is a single-request upsert actually reachable?

**Yes, and more cheaply than backlog 038 assumed.** `updateToAlgebra` seeds its WHERE with an
*empty BGP* and wraps every old-value pattern in `OPTIONAL`. The golden test
(`sparql-mutation-golden.test.ts`) pins the emitted form:

```sparql
DELETE { <p1> <hobby> ?old_hobby . }
INSERT { <p1> <hobby> "Chess" . }
WHERE  { OPTIONAL { <p1> <hobby> ?old_hobby . } }
```

A WHERE consisting solely of an OPTIONAL yields one (empty) solution mapping even when nothing
matches, so **the INSERT already fires against a node that does not exist**. `update` is therefore
90% of an upsert today. The one missing piece: `generateNodeDataTriples` (the create path) pushes
`?s rdf:type <Type>`; `processUpdateFields` (the update path) never does. An `update` against an
absent id today writes its properties onto an **untyped** node.

So: `upsert = update + the type triple`. No `ASK`, no precheck, no new SPARQL form, no
`IDataset` change.

### B2 — Is re-asserting the type triple safe on an existing node?

Yes. RDF graphs are sets, so `INSERT`ing a triple that is already present is a no-op. The type
triple needs no `OPTIONAL`/`FILTER NOT EXISTS` guard.

### B3 — What happens to expression-valued fields when the node is absent?

They break, quietly. `age: p.age.plus(1)` lowers to a `BIND` over `?old_age`, which is unbound
when the node does not exist. SPARQL drops any INSERT triple containing an unbound variable, so
the property is **silently skipped** — a write that reports success and stores nothing. This is
the same silent-wrong-branch failure class the feature exists to remove, so it must not be
allowed through.

## Decisions

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| D1 | Semantics | Replace the **named properties** and ensure the type triple; not a whole-node replace | Matches what every hand-rolled branch approximates and reuses the update lowering unchanged. Whole-node replace is a different, more destructive promise nobody asked for. |
| D2 | Round-trips | **One**, via the existing DELETE/INSERT/WHERE + `OPTIONAL` | B1 shows the algebra already carries it. Two round-trips and the race between them are the defects being removed; a precheck would reintroduce both. |
| D3 | Name | `upsert` | The term used by the backlog, consumer apps' own comments and every comparable library. `ensure`/`save` read as synonyms for `create` — 038 warns against exactly that. |
| D4 | API shape | `Shape.upsert(values).for({id})` | Mirrors `Shape.update(values).for({id})`, so there is one shape to learn. The id is **required** — an upsert with no known identity is a `create`. |
| D5 | Builder | Reuse `UpdateBuilder` in an upsert **mode**; no new builder class | id/set/serialisation/dispatch/thenable machinery is identical; a parallel class would duplicate ~200 lines and drift. `.where()` and `.forAll()` are rejected in this mode — an upsert targets one known node. |
| D6 | IR | A distinct **`kind: 'upsert'`**, sharing `updateToAlgebra`'s body internally | A flag on `IRUpdateMutation` is less code but degrades silently: a consumer that ignores it writes an untyped node and reports success. A distinct kind makes TS exhaustiveness enforce handling at compile time and makes unaware consumers fail loudly. Chosen for maintainability over raw line count. |
| D7 | Return value | Same as `update`; no created-vs-updated discrimination | Knowing which branch happened needs the read D2 exists to avoid. 038 notes a boolean return reintroduces the boolean whose mishandling caused the original production bug. |
| D8 | Expressions | **Rejected** at build time with an explicit error | Per B3 they lower to a silently-dropped triple. Refusing loudly is the only option consistent with the feature's purpose. Revisitable if a caller supplies a default. |

## Selected route

Extend the existing mutation pipeline with a seventh mutation kind that reuses the update lowering:

```
Shape.upsert(values).for({id})
  → UpdateBuilder (mode: 'upsert')
  → IRUpsertMutation { kind: 'upsert', shape, id, data, traversalPatterns? }
  → upsertToAlgebra()  ── shares buildUpdatePlan() with updateToAlgebra(), adding the type triple
  → SparqlDeleteInsertPlan (delete_insert)
  → existing SPARQL serialisation, unchanged
```

Rejected alternatives: a `createIfNotExists()` terminal on `UpdateBuilder` (hides a semantic
change behind a modifier on an existing call, and leaves `update`'s untyped-node behaviour
undocumented); property-matching upsert à la SQL `ON CONFLICT` (RDF identity is the URI — there is
no unique-constraint concept to conflict on).

---

# Plan

## D9 — wire format (decision surfaced during planning)

The DSL-JSON envelope needs its own answer, and it is **not** the same as D6's.

Reusing `op: 'update'` with a new `mode: 'upsert'` looks natural — but consider an older consumer
receiving it. `lowerMutationJSON`'s `case 'update'` tests `mode === 'for'`, then `mode === 'where'`,
and **falls through to `buildCanonicalUpdateWhereMutationIR` with no where clause** — an update
applied to *every instance of the shape*. A forward-compatible-looking envelope would silently
become a mass overwrite.

So: **`op: 'upsert'`**. `fromJSON` already ends its switch with a `default:` that throws
*"Unknown query op"*. A distinct op turns an unaware consumer's outcome from catastrophic-silent
into loud-and-safe, reusing a guard that already exists.

## Architecture

```
Shape.upsert(values)            → UpdateBuilder { _upsert: true }
  .for({id})                    → _mode = 'for'  (.where()/.forAll() throw here)
  → _lowerSpec()                → { …, upsert: true }
  → lowerUpdate()               → IRUpsertMutation { kind: 'upsert', shape, id, data, traversalPatterns? }
  → upsertToAlgebra()           → SparqlDeleteInsertPlan  (shares buildDeleteInsertPlan with update)
  → deleteInsertPlanToSparql()  → unchanged
```

`UpdateBuilder.__queryKind` stays `'update'`, so `lower.ts` needs no new case — `lowerUpdate`
branches on the spec. `IRUpdateQuery` widens to include `IRUpsertMutation`, so `UpdateQuery`
consumers keep type-checking.

## Contracts

**Public API**

```ts
// create-or-replace in one round-trip; id required
await SourceDocument.upsert(values).for({id});

// replaces the branch this retires:
//   if (await S.exists({id})) await S.update(v).for({id}); else await S.create({id, ...v});
```

- Replaces **only the named properties**; untouched properties on an existing node survive (D1).
- Always asserts `?id rdf:type <shapeTargetClass>` — the triple `update` omits (B1).
- Returns what `update` returns; no created-vs-updated signal (D7).
- `.where()` / `.forAll()` throw — an upsert targets one known node (D5).
- Expression-valued fields throw at build time (D8/B3).

**Emitted SPARQL** — identical to `update` plus one INSERT triple:

```sparql
DELETE { <id> <p> ?old_p . }
INSERT { <id> a <Type> . <id> <p> "v" . }
WHERE  { OPTIONAL { <id> <p> ?old_p . } }
```

**Wire**: `{v, op: 'upsert', shape, mode: 'for', targetId, data}`.

## Expected file changes

| File | Change |
|---|---|
| `src/queries/IntermediateRepresentation.ts` | `IRUpsertMutation` type; add to `IRMutation` union |
| `src/queries/UpdateQuery.ts` | widen `IRUpdateQuery` |
| `src/queries/IRMutation.ts` | `buildCanonicalUpsertMutationIR` |
| `src/queries/UpdateBuilder.ts` | `_upsert` flag, guards on `.where()`/`.forAll()`, `toJSON`/`fromJSON`/`_lowerSpec` |
| `src/queries/lowerMutationJSON.ts` | `case 'upsert'` |
| `src/queries/fromJSON.ts` | `case 'upsert'` → `UpdateBuilder.fromJSON` |
| `src/queries/MutationSerialization.ts` (+ JSON types) | `UpsertMutationJSON` / widen op union |
| `src/sparql/irToAlgebra.ts` | extract `buildDeleteInsertPlan`; add `upsertToAlgebra` / `upsertToSparql` |
| `src/shapes/Shape.ts` | `static upsert()` |
| `src/tests/*` | golden SPARQL, builder, serialisation round-trip, guard errors, Fuseki integration |
| `docs/` + `.changeset/` | documentation and a `minor` changeset |

## Pitfalls

1. **The type triple must use the same IRI resolution as create** — `resolveShapeScanIri(shape)`,
   not the raw shape id, or upserted nodes get a type the select path cannot find.
2. **Do not let the guard break `update`.** `buildDeleteInsertPlan` must default to *not* emitting
   the type triple; every existing update golden test has to stay byte-identical.
3. **`traversalPatterns` and the `contains` cascade come along for free** — they are computed in
   the shared body. Do not special-case them; do assert the cascade still fires for an upsert over
   an existing node.
4. **Expression rejection must run before lowering**, so the error names the property rather than
   surfacing as an unbound-variable mystery.
5. `mutation-serialization` and `ir-mutation-parity` tests enumerate mutation kinds — both will
   need the new kind added or they will under-cover it.

---

# Phases

Strictly sequential: P2 and P3 both edit `UpdateBuilder`, and P3's wire tests need P2's builder.
P1 is independently testable and carries the whole risk of regressing `update`.

### Phase 1 — IR and lowering

1. `IRUpsertMutation` in `IntermediateRepresentation.ts`; add to the `IRMutation` union.
2. Widen `IRUpdateQuery` in `UpdateQuery.ts`.
3. `buildCanonicalUpsertMutationIR` in `IRMutation.ts` (mirrors the update builder; rejects
   expression-valued fields per D8).
4. In `irToAlgebra.ts`, extract `updateToAlgebra`'s body into `buildDeleteInsertPlan(subjectTerm,
   query, options, {ensureType?: string})`. `updateToAlgebra` calls it with no `ensureType`;
   `upsertToAlgebra` passes `resolveShapeScanIri(query.shape)`. Export `upsertToSparql`.

**Validation**
- Every existing test in `sparql-mutation-golden.test.ts` passes **byte-identical** — proves the
  extraction did not perturb `update`.
- New golden test: upsert SPARQL equals the update SPARQL for the same fields **plus** exactly one
  `<id> a <Type>` INSERT triple.
- Full suite green; `npm run typecheck` clean.

### Phase 2 — Builder and public API

1. `UpdateBuilder`: private `_upsert` flag; `_lowerSpec()` carries it.
2. `.where()` / `.forAll()` throw when `_upsert` is set, naming `upsert` in the message.
3. `Shape.upsert(values)` static returning `UpdateBuilder` in upsert mode, with a doc comment
   pointing at the branch it retires.
4. Expression-valued fields rejected with an error naming the offending property.

**Validation**
- `Shape.upsert(v).for({id})` lowers to `kind: 'upsert'`.
- `.where()` / `.forAll()` / expression field each throw with a message naming the cause.
- `.for()` still required (existing "requires .for(id)" error preserved).

### Phase 3 — Wire format

1. `UpsertMutationJSON` (or widen the op union) in the mutation JSON types.
2. `UpdateBuilder.toJSON()` emits `op: 'upsert'` when `_upsert`; `fromJSON` accepts it.
3. `fromJSON.ts`: `case 'upsert'` → `UpdateBuilder.fromJSON`.
4. `lowerMutationJSON.ts`: `case 'upsert'` → `buildCanonicalUpsertMutationIR`.

**Validation**
- Round-trip: `builder → toJSON → fromJSON → toJSON` is stable, and lowers to the same IR.
- An unknown op still throws "Unknown query op" (the D9 guard is intact).
- `mutation-serialization` and `ir-mutation-parity` cover the new kind.

### Phase 4 — Integration, docs, changeset

1. Fuseki integration test: upsert an absent id (node created **and typed**), upsert the same id
   again with different values (properties replaced, untouched properties survive, no duplicates).
2. Documentation for the new primitive alongside `create`/`update`.
3. `minor` changeset (additive).
4. Update backlog `038-upsert.md` to point at this work.

**Validation**
- `npm run test` green; `npm run test:fuseki` green for the new spec.
- Changeset present and user-facing.


---

# Progress

## Phase 1 — IR and lowering ✅

`IRUpsertMutation` + union entry, `IRUpdateQuery` widened, `buildCanonicalUpsertMutationIR`
(with the D8 expression guard), and `updateToAlgebra`'s body extracted into
`buildDeleteInsertPlan(query, options, {ensureType?})` — `upsertToAlgebra`/`upsertToSparql`
pass `resolveShapeScanIri(shape)`, `update` passes nothing.

**The discriminated union paid for itself immediately** (D6): adding the kind produced a
compile error at `SparqlDataset.updateQuery`, the one runtime dispatch site, before any test
ran. A flag on `IRUpdateMutation` would have compiled and silently written untyped nodes.
`mapSparqlUpdateResult` was widened to accept both (it reads only `id` and `data.fields`),
which is D7 falling out of the types rather than being enforced by hand.

**Validation**
- Suite **1667 passed / 120 skipped**, byte-identical to the pre-work baseline — the
  extraction did not perturb `update` (pitfall 2 cleared).
- Typecheck clean.
- 4 new golden tests, including one asserting the *only* line-level difference between the
  update and upsert SPARQL is the type triple plus its PREFIX header, and one pinning that
  the WHERE is a bare OPTIONAL (the property the whole design rests on).
- Correction during the phase: the serialiser emits `rdf:type` + a `PREFIX rdf:` header, not
  the `a` shorthand my first expectations assumed. Matching `create`'s output; tests fixed,
  implementation unchanged.

## Phase 2 — Builder and public API ✅

`UpdateBuilder` gained an `_upsert` flag (carried through `clone`, `_lowerSpec`, `toJSON`),
`UpdateBuilder.upsertFrom()`, guards on `.where()`/`.forAll()`, and an upsert-specific
"requires .for(id)" message. `Shape.upsert()` added.

**A better outcome than planned on D8.** `Shape.upsert`'s signature deliberately omits
`update`'s expression-callback overload, so typed callers cannot express an expression at
all — the failure is a compile error, not a runtime throw. The runtime guard stayed, because
it still covers untyped call sites (a consumer app calls shapes as `any`) and expressions arriving over
DSL-JSON. Both are pinned, the compile-time one with `@ts-expect-error` so the test fails if
the overload is ever widened.

**Correction during the phase:** the first guard iterated `Object.entries(updates)`, but a
`NodeDescriptionValue` exposes `{shape, fields, __id}` — property values live in `.fields`.
It matched nothing and the test caught it. Rewritten to walk `.fields` and use
`isExpressionNode(field.val)`, mirroring `toSingleFieldValue` so the guard cannot drift from
the lowering it protects.

**Validation** — suite 1678 passed, typecheck clean, 7 new builder tests.

## Phase 3 — Wire format ✅

`UpsertMutationJSON` (`op: 'upsert'`, `mode: 'for'` only), `toJSON`/`fromJSON` both ways,
`fromJSON.ts` and `lowerMutationJSON.ts` cases. `UpdateQuery.toJSON` widened to the union.

`fromJSON` was restructured to branch on `op` **before** `mode`, so each envelope keeps its
own narrowed type. The runtime `mode !== 'for'` check needs a cast, since the type says the
field can only be `'for'` while an inbound envelope is untrusted data — a comment records
that this is deliberate, not a workaround.

**Validation** — suite 1684 passed, typecheck clean, 6 round-trip/serialisation tests
including one asserting the unknown-op guard still fires (the reason D9 chose a distinct op).

## Phase 4 — Integration, docs, changeset ✅

Four Fuseki integration tests against a real store, `documentation/dsl-json.md` §Upsert, and a
`minor` changeset.

**The integration tests are the load-bearing evidence** — everything before them proves the
right string is generated, not that a triplestore does the right thing with it:

| Behaviour | Result |
|---|---|
| Absent id → node created **and typed** | ✅ |
| Second upsert → property replaced, exactly one value | ✅ |
| Type triple not duplicated on re-assert | ✅ |
| Unnamed properties survive (D1, named-property replace) | ✅ |

**Correction during the phase:** the hand-built IR wrapped field values as
`{kind:'literal', value}`; a real IR carries the bare value. Three tests failed, and the type
triple still landed (it does not depend on field values), which is exactly the untyped-vs-typed
distinction the suite is there to detect.

**Validation** — suite **1688 passed** (baseline 1667), typecheck clean.

## Gaps found in review and addressed

| # | Gap | Fix |
|---|---|---|
| G1 | `src/sparql/index.ts` exported `updateToAlgebra`/`updateToSparql` but not the upsert pair — a consumer implementing `IDataset` could see `kind: 'upsert'` (by design, D6) and have no exported way to lower it. Shipping-blocking. | Both exported. |
| G2 | `documentation/intermediate-representation.md` listed the IR kinds without `IRUpsertMutation`. | Added in all three places. |
| G3 | `documentation/dsl-json-llm-prompt.md` advertised `op: "create\|update\|delete"`, so an LLM generating DSL-JSON would never emit an upsert. | Union updated. |
| G4 | `IDataset.updateQuery` did not say it may receive an upsert, nor what to do when unsupported. | Contract comment added: throw, do not fall through — an upsert lowered as an update writes an untyped node and reports success. |
| G5 | No test that the upsert flag survives a `toJSON`/`fromJSON`/`lower` round-trip with an explicit target. | Added. |

**Final validation** — suite **1689 passed / 120 skipped** (baseline 1667, +22), 68 suites,
typecheck clean.

---

# Review

Three findings survived the pass.

**R1 — `update().for({id})` against an absent id silently writes an untyped node.** Uncovered by
B1 and never addressed: it is the *pre-existing* behaviour this feature was built beside, not
something this work introduced. A caller who reaches for `update` on a node that turns out not to
exist gets triples written under an id with no `rdf:type`, so every shape-scoped select misses it —
and the write reports success. This is plausibly the mechanism behind the consumer-app production incident
that motivated backlog 038 in the first place, and core currently documents it nowhere.

**R2 — the `contains` cascade under upsert is untested.** The plan's own pitfall 3 said to assert
it and the implementation never did. The cascade rides along in the shared `buildDeleteInsertPlan`
body, so it *should* fire identically — but "should, by construction" is exactly the claim the
suite exists to check, and this one governs whether replaced owned nodes orphan.

**R3 — nested object values under upsert are untested.** Probed and correct (the nested node
carries its own `rdf:type` from the create path; only the *subject* ever lacked one), but nothing
pins it.

Not addressed here, deliberately: migrating a consumer app's `LinkedDocumentRepository` off its six
create-or-update branches. That is consumer work in another repo and wants its own change.

## Iteration 1 — Ideation

### Gap 1 of 3: `update`'s untyped-node behaviour (R1)

Three ways to treat it.

*Fix it* — make `update`'s WHERE require the type triple, so an update against an absent node
becomes a no-op. Arguably the correct semantics, and it makes `upsert` the only way to create.
But it changes the behaviour of every existing `update` call in every consumer, silently turning
some current writes into no-ops. Too large and too risky to smuggle in beside a new primitive.

*Make `update` assert the type too* — i.e. make update an upsert. Erases the distinction this work
just introduced and makes `create` vs `update` meaningless.

*Document it precisely, and file the semantic decision.* **Chosen.** The behaviour is surprising
and undocumented; that is the part fixable today without a breaking change. A backlog item carries
the real decision, with the evidence this work produced. Priority framework: the first option is a
scalability/correctness win but fails long-term maintainability *right now* — an unannounced
semantic change to the most-used mutation is how you get another silent-wrong-write incident.

### Gap 2 of 3: cascade coverage under upsert (R2)

Assert on the emitted SPARQL rather than round-tripping through Fuseki: the cascade is a lowering
concern, the existing cascade suite already tests it that way, and matching its style keeps the two
readable together. Test that an upsert replacing a `contains` property emits the same cascade the
equivalent update does — plus the type triple, and nothing else.

### Gap 3 of 3: nested value coverage under upsert (R3)

Pin what the probe showed: the subject gets exactly one type triple from the upsert, the nested
node keeps the one it already got from the create path, and the two are not confused.

## Iteration 1 — Plan

No production-code change. One doc comment on `Shape.update`, one paragraph in
`documentation/dsl-json.md`, a new backlog item, and three tests.

| File | Change |
|---|---|
| `src/shapes/Shape.ts` | Document `update`'s absent-id behaviour on the `update` doc comment |
| `documentation/dsl-json.md` | Same, in the Update section, pointing at upsert |
| `docs/backlog/039-update-absent-id.md` | New — the semantic decision, with evidence |
| `src/tests/shacl-cascade.test.ts` | Cascade parity under upsert |
| `src/tests/sparql-mutation-golden.test.ts` | Nested value under upsert |

## Iteration 1 — Phases

### Phase 5 — Document R1 and file the decision
**Validation** — the doc comment states the behaviour and points to `upsert`; backlog item exists
with the reproduction.

### Phase 6 — Close the coverage gaps
**Validation** — cascade parity and nested-value tests pass; full suite green; typecheck clean.

## Iteration 1 — Progress

### Phase 5 — Document R1 and file the decision ✅

`Shape.update`'s doc comment and `documentation/dsl-json.md` §Update now both state that an
update against an absent id writes untyped and reports success, and point at `upsert`. New
`docs/backlog/039-update-absent-id.md` carries the semantic decision (leave / no-op / throw) with
the reproduction and the reasoning for why option 2 — no-op — is probably right but needs a
breaking-change window rather than a quiet flip.

### Phase 6 — Close the coverage gaps ✅

Cascade parity and nested-value tests added.

**The cascade test caught a wrong assumption of mine, and confirmed pitfall 1 is handled.** I
expected the asserted type to be `TBag.shape.id`; it is the shape's **targetClass**
(`http://example.org/c#TBag`), which is what `resolveShapeScanIri` returns and what the select
path scans for. Had the implementation used the shape id, every upserted node would have been
invisible to queries — the precise failure the primitive exists to prevent. The test now asserts
the two IRIs differ and that the emitted one is the targetClass, so a regression here cannot pass.

It also showed that an update which only *removes* has no `INSERT` block at all, and the upsert
grows one to carry the type triple — so "the only difference is one line" is really "one line,
plus the block that holds it" for that shape of mutation.

**Validation** — suite **1691 passed / 120 skipped** (baseline 1667, +24), 68 suites, typecheck
clean.

## Iteration 2 — API symmetry with `create` (raised in review)

**Question:** does `upsert({id, ...values})` work without `.for()`, as `create({id, ...})` does?

**Probed, not assumed:**

| Form | Behaviour |
|---|---|
| `create({name})` | id generated (ULID) — minted at SPARQL lowering, the IR carries none |
| `create({__id, name})` / `create({id, name})` | uses that id |
| `update`/`upsert` `({id, …})` **with** `.for()` | throws *"You cannot use id in the top level of an update object"* |
| `update`/`upsert` `({id, …})` **without** `.for()` | threw *"requires .for(id)"* — never mentioning the id that was passed |

So upsert is consistent with update, and the asymmetry with `create` is deliberate and correct:
for `create` the id names the node being made, while for update/upsert `.for()` names the subject
and the data object is properties only. **No semantic change made** — allowing id-in-data would
give two ways to say one thing, and an ambiguity when both are supplied.

**One real defect though, in the last row.** The likely first mistake when migrating from
`create({__id: id, ...values})` — the exact call upsert replaces — is to write
`upsert({id, ...values})`. That got a bare "requires .for(id)" that never mentioned the id the
caller *had* provided, leaving them to guess it was ignored. `_lowerSpec` now detects a top-level
`id`/`__id` and says where it belongs, naming `create` as the one that differs. Both spellings,
both mutations.

Documented on `Shape.upsert` and in `documentation/dsl-json.md`.

**Correction during the phase:** I asserted `create({...})` with no id produces a truthy `data.id`.
It does not — the IR carries no id and the ULID is minted at SPARQL lowering. Test now pins that.

**Validation** — suite **1694 passed / 120 skipped** (baseline 1667, +27), typecheck clean.
