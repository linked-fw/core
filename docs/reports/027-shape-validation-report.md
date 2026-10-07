---
summary: One SHACL-aligned validator behind create, update, and standalone callers — `validate(shape, data)` returns a materializable `ValidationReport` instead of throwing on the first problem, replacing the split where `toJSON()` checked values and `lower()` checked required fields, and adding enforcement for `sh:datatype`, value ranges, lengths, `sh:pattern` and `sh:in` (with the serializer now honouring declared datatypes).
source_plan: docs/plans/001-shape-validation-report.md (converted; plan removed)
packages: [core]
---

# 027 — Shape validation report

Status: **done**. Suite **1565 passed / 117 skipped**, typecheck green (baseline before this work: 1472 passed).

PRs: [#188](https://github.com/linked-fw/core/pull/188) (merged, released as 2.16.0) and the
unresolvable-shape follow-up [#194](https://github.com/linked-fw/core/pull/194), both → `dev`.

## The problem

Write-validation lived in three places with two different trigger points: cardinality and node-kind
checks in `MutationQuery.validateAgainstShape`, an unknown-key throw in `convertNodeDescription`, and
required-field checks in `CreateBuilder._lowerSpec`. Consequences:

1. `create(data).toJSON()` accepted data that `lower(create(data))` rejected — an artifact of where
   code landed, not a real distinction.
2. No way to validate a plain object without building a builder and calling a serialization method.
3. Fail-fast only: the first violation threw, so "how well does this object fit the shape?" — the
   question a document-extraction pipeline actually asks — was unanswerable.
4. Violations were `Error` strings, with no machine-readable path, constraint, or severity, even
   though `PropertyShapeData` already carried the full SHACL constraint set and
   `ontologies/shacl.ts` already exported the `sh:ValidationReport` vocabulary.

## Architecture

```
data object ──▶ validate()  ──▶ walk: node → properties → values
                    │                    │
                    │                    ├─ CARDINALITY_CONSTRAINTS  (need the whole value set)
                    │                    ├─ VALUE_CONSTRAINTS        (need only the value in hand)
                    │                    └─ recurse into nested node descriptions
                    ▼
             ValidationReport {conforms, results[]}

CreateBuilder.toJSON ─┐
CreateBuilder lower  ─┤
UpdateBuilder.toJSON ─┼──▶ MutationQueryFactory.describe({validate: mode}) ──▶ assertValid ──▶ normalize
UpdateBuilder lower  ─┘
```

`describe()` is the single gate. It receives the already-resolved object (so the callback form of
`.set()` is covered without a second code path), validates, then normalizes. All four call sites pass
their mode, so `toJSON()`, `lower()` and `exec()` reject identical input.

**Create and update differ only in which constraints apply, not in where validation runs.** Create is
`complete` — properties absent from the data are genuinely absent, so `sh:minCount` presence is
decidable. Update is `partial` — the store holds what the payload omits, so presence is not. That is
one flag on one validator. Every other check needs only the value in hand and runs in both modes.

## Files

| File | Responsibility |
| --- | --- |
| `src/shapes/validation.ts` | The validator: report types, `validate` / `assertValid`, `ShapeValidationError`, the constraint registry, the node/property/value walk. New. |
| `src/queries/MutationQuery.ts` | `describe()` gains `DescribeOptions` and becomes the validation gate. `validateAgainstShape`, `expectsLiteral`, `expectsNode` deleted; the unknown-key guard now shares its message with the validator via `undeclaredPropertyMessage()`. |
| `src/queries/CreateBuilder.ts` | Inline required-fields block and its stale `TODO` deleted; passes `{allowTopLevelId: true, validate: 'complete'}`. |
| `src/queries/UpdateBuilder.ts`, `src/queries/lower.ts` | Pass their validation mode to `describe()`. |
| `src/queries/lowerMutationJSON.ts` | `assertInboundDataValid` — the inbound DSL-JSON path validates through the same validator as the builders. |
| `src/sparql/irToAlgebra.ts` | `findPropertyShapeById` (shared registry lookup), `resolvePropertyDatatype`, `numericDatatype`, `dateToTerm` — literals now honour the declared `sh:datatype`. |
| `src/ontologies/shacl.ts` | 13 vocabulary terms added (below). |
| `src/index.ts` | Exports `validate`, `assertValid`, `ShapeValidationError` and the report types. |

## Public API

```ts
import {validate, assertValid, ShapeValidationError} from '@_linked/core';

const report = validate(Slide, extractedFromDocument);
// { conforms: false, results: [ … ] }

report.results.filter(
  (r) => r.sourceConstraintComponent.id === shacl.MinCountConstraintComponent.id,
); // which required fields the document did not fill

validate(Slide, patch, {mode: 'partial'});   // an update: check only what is provided
validate(Slide, data, {maxDepth: 3});        // bound the descent into nested creates

assertValid(Slide, data);                    // throws ShapeValidationError
try { … } catch (e) { (e as ShapeValidationError).report.results }
```

`validate` accepts a shape class or the plain `NodeShapeData` it carries. It never throws for invalid
*data* — a violation is a result. It does throw when the *shape* argument is unusable.

### Callers need no shape classes

A caller holding only decorator-generated shape objects — a document-mapping pipeline, say — can
validate with those alone. Neither inheritance nor nesting is carried *in* the shape object: a
subclass's `propertyShapes` holds only its own, and a property's `valueShape` is a bare `{id}`. The
validator resolves both through the registry by id, so passing the class is a convenience, never a
requirement, and `validate(Slide, data)` and `validate(Slide.shape, data)` return the same report.

That resolution can fail — for a shape object whose id was never registered, e.g. one deserialized
where the definitions were never loaded. It used to fail *silently*: inherited required properties
went unchecked (and any supplied looked undeclared), and an unresolvable nested value was skipped, so
a node could be reported as conforming on the strength of a branch never looked at. Both now produce
an `sh:NodeConstraintComponent` violation naming the unresolved shape. The two cases are distinguished
in the message, because they are fixed differently: a property declaring a shape that is not
registered, versus a property declaring none at all (where the fix is a `shape` on the
`@objectProperty` decorator, or a `shape` key on the value).

## The report is 1-1 with SHACL, and materializable

This library has no triple layer and this work does not add one. The guarantee is stronger than
SHACL-flavoured naming: a report is **materializable as-is** by an ordinary create query against
shape classes for `sh:ValidationReport` / `sh:ValidationResult` — `ValidationReport.create(report)` —
with no transform step.

| Report key | SHACL property | Value form |
| --- | --- | --- |
| `conforms` | `sh:conforms` | boolean literal |
| `results` | `sh:result` | nested node descriptions |
| `focusNode` | `sh:focusNode` | `{id}` |
| `resultPath` | `sh:resultPath` | `{id}` |
| `value` | `sh:value` | literal or `{id}` |
| `sourceShape` | `sh:sourceShape` | `{id}` |
| `sourceConstraintComponent` | `sh:sourceConstraintComponent` | `{id}` |
| `resultSeverity` | `sh:resultSeverity` | `{id}` |
| `resultMessage` | `sh:resultMessage` | string literal |
| `propertyPath` | — (extension) | string literal |

Three rules enforced by the walk:

- **Absent keys are omitted, never `undefined`** — the create pipeline should not see a key carrying
  no value.
- **`sh:value` holds RDF terms only.** A literal or `{id}` reference is one; a plain object, array or
  function is not, so it is left off and the message names the offender instead. Cardinality
  violations carry no `sh:value` at all — they are about the property, not any one value.
- **IRI-valued fields are `{id}` refs**, including `focusNode` and `sourceShape`.

Two deliberate departures: `results` is plural where SHACL's repeated property is `sh:result` (a
shape class picks its own label for a path, so this still maps 1-1), and `propertyPath` — the dotted
label path through nested shapes — is a non-SHACL extension, because `sh:resultPath` names the
property but not where the nesting reached it. The standards-correct alternative is `sh:detail`
linking parent to child results, which trades a flat list for a tree; a caller iterating violations
wants the flat list, so it stayed flat and `sh:detail` was added to the ontology for later.

Ontology terms added: `MinCountConstraintComponent`, `MaxCountConstraintComponent`,
`NodeKindConstraintComponent`, `ClosedConstraintComponent`, `MinInclusiveConstraintComponent`,
`MaxInclusiveConstraintComponent`, `MinExclusiveConstraintComponent`,
`MaxExclusiveConstraintComponent`, `PatternConstraintComponent`, `InConstraintComponent`, `Warning`,
`Info`, `resultMessage` (distinct from the pre-existing `sh:message`, which declares a custom message
on a *shape*), and `detail`.

## Constraint components

Each check is a `(values, ctx) => ValidationResult[]` function in one of two registries, so adding a
component is one function and one test.

| Component | Applies to | Notes |
| --- | --- | --- |
| `sh:minCount` / `sh:maxCount` | value counts | `CARDINALITY_CONSTRAINTS` — needs the whole value set |
| `sh:nodeKind` | every value | literal vs relation; ambiguous kinds (`sh:IRIOrLiteral`, or nothing to infer from) unenforced |
| `sh:datatype` | every value | see the table below |
| `sh:min/maxInclusive`, `sh:min/maxExclusive` | numbers | non-numbers are the datatype check's business |
| `sh:min/maxLength` | strings | |
| `sh:pattern` | strings | |
| `sh:in` | every value | literals by equality, node refs by id |
| `sh:closed` | undeclared keys | node-level; currently unconditional (see backlog 035) |

Not covered: `sh:languageIn` / `sh:uniqueLang` (skipped at serialization time too — report 024, G5 —
so there is no metadata to check against) and `sh:hasValue`.

Two rules keep the output readable: **one violation per mistake** — a node reference given to a typed
literal property is a node-kind violation only, and a non-number given to a bounded property is a
datatype violation only — and **`sh:pattern` regexes are rebuilt without `g`/`y` flags**, whose
`lastIndex` would otherwise make a shape-level regex match every *other* value.

## Datatype enforcement, and why it is a Violation

The plan recommended `sh:Warning` for coercible mismatches. That was wrong. Mutation literals are
typed from the *JavaScript* value when they reach SPARQL (`irToAlgebra.fieldValueToTerms`): a number
becomes `xsd:integer`/`xsd:double`, a boolean `xsd:boolean`, a `Date` `xsd:dateTime`, a string an
untyped literal. A string handed to an `xsd:integer` property does not merely skip a check — it
writes the wrong RDF term, silently. There is nothing to warn about.

| Declared | Accepts |
| --- | --- |
| `xsd:string` | string |
| `xsd:boolean` | boolean |
| `xsd:integer`, `xsd:long` | number, integral |
| `xsd:decimal`, `xsd:float`, `xsd:double` | finite number |
| `xsd:date`, `xsd:dateTime` | `Date` — nothing else |
| `xsd:time` | a lexical string, `HH:MM:SS` (+ optional ms and offset) — **amended, see below** |
| `xsd:duration`, `xsd:gYear`, `xsd:Bytes` | unchecked (no obvious JS counterpart) |

### The serializer had to follow

Temporal properties taking only a `Date` would have made `xsd:date` **unwritable**: every `Date` was
serialized as a full `xsd:dateTime` timestamp. `fieldValueToTerms` now takes the property's declared
datatype and derives the term from it:

| Declared | One `Date` of `2020-06-15T09:30:00Z` becomes |
| --- | --- |
| `xsd:date` | `"2020-06-15"^^xsd:date` |
| `xsd:dateTime` | `"2020-06-15T09:30:00.000Z"^^xsd:dateTime` |
| `xsd:time` | *(amended — see below)* |
| none | `"…"^^xsd:dateTime` (unchanged) |

Numbers use the same hook (`numericDatatype`): a property declared `xsd:long` previously stored
`xsd:integer`, and `xsd:decimal` stored `xsd:double`, so the store round-tripped a different term
than the shape said it held. Inference remains the fallback where no datatype is declared. Strings
stay plain literals — `"a"` *is* an `xsd:string` in RDF 1.1, so emitting it explicitly would be noise.

The datatype is resolved from the shape registry by property id (`findPropertyShapeById`, a single
cached scan now shared with predicate resolution), so **neither the IR nor the wire format changed**.

## Set modifications

`{tags: {add: ['42']}}` used to skip every check — the whole `{add, remove}` object counted as
undecidable, leaving open the exact hole the datatype work closed everywhere else. Only the *count*
is undecidable. A set modification now runs `VALUE_CONSTRAINTS` over `add`, including recursion into
nested creates, and skips cardinality. `remove` is left to normalization, which already requires
`{id}` references there.

Ordering matters more than it looks: `isSetModification` reads `.add` off the value, and a resolved
query-context reference is a proxy that throws on any undecorated key. Deferred values — expressions,
context refs, callbacks, `undefined` — are ruled out by `isDeferredValue` *before* anything reads a
property off a value. The existing `mutation-serialization` suite caught this.

## Resolved edge cases

- **`shape` is a reserved key.** Nested node data may carry `shape` to name the value's shape when
  the property shape declares none (`rdfList`, and `syncShapes` through it). It joins `id`/`__id` as
  reserved, and nested-shape resolution mirrors `convertUpdateValue`: `valueShape` first, then the
  value's own `shape` key. Eleven tests caught this.
- **Nested required fields** are now checked; previously unchecked at any level. Nested descriptions
  inherit the parent's mode.
- **`null` vs `[]`** — both spellings of "clear it" are the same cardinality violation.
- **Bare `{id}` references** are not descended into; an object with an id *and* data is a nested
  create with a predefined id, and is.
- **Non-object data** is a node-level violation, not a crash.

## Behaviour changes

1. `create(data).toJSON()` throws on missing required fields — the asymmetry this set out to fix, but
   real for anyone who used `toJSON()` as a lenient serializer.
2. Required properties of nested creates are now checked.
3. A failing mutation reports every violation, not the first. Individual messages are carried over
   verbatim; the aggregated `Missing required fields for 'X': a, b` string is gone, replaced by one
   `sh:minCount` result per property.
4. Value constraints (datatype, ranges, lengths, pattern, `in`) are enforced where they previously
   were not — on creates, updates, and set-modification values.
5. `xsd:date`/`xsd:dateTime` properties reject lexical strings. (`xsd:time` now *requires* one —
   amended, see below.)
6. `xsd:long` and `xsd:decimal` properties emit their declared datatype instead of `xsd:integer` /
   `xsd:double`.

One existing test changed: `mutation-shape-validation` → "an ambiguous node-kind property skips the
kind check" built a `Team` without its required `members`, which now fails for an unrelated reason.
It supplies `members` and still asserts exactly what its name says.

## Test coverage

| Suite | Tests | Covers |
| --- | --- | --- |
| `shape-validation-report.test.ts` | 33 | Report structure and SHACL vocabulary, `complete` vs `partial`, nested descriptions and `maxDepth`, skipped values, `assertValid`, pipeline parity between `toJSON()` / `lower()` / inbound DSL-JSON |
| `shape-validation-constraints.test.ts` | 42 | Every value component, which checks need a whole node, set modifications, and the SPARQL terms produced for dates and numbers |
| `shape-validation-materialization.test.ts` | 6 | Declares shape classes straight from the SHACL vocabulary and pushes a real report through a create query |
| `mutation-shape-validation.test.ts` | 14 | Pre-existing cardinality / node-kind behaviour, carried through unchanged |

`shape-validation-materialization` proves the 1-1 mapping rather than asserting it: if a result ever
grows a key those shapes do not declare, the create throws `Invalid property key` and the suite
fails. That keeps the contract honest whether or not core ever ships the classes (backlog 034).

## The inbound wire path

`lowerMutationJSON` — the entry point a store uses to lower a DSL-JSON mutation straight to IR —
never touches a builder, so it never reached `describe()`. Found during wrapup review: an inbound
mutation was checked only for property existence, skipping everything the local DSL enforces, on the
*less* trusted of the two inputs. The builder wire path (`CreateBuilder.fromJSON`) was already
covered, since it re-enters through `.set()`.

`assertInboundDataValid` closes it: `decodeNodeDataToRaw` produces exactly the raw form `describe()`
would have validated — it is what `CreateBuilder.fromJSON` feeds through `.set()` — so both paths run
the same checks with no second walk and no validator entry point shaped around normalized data. The
extra decode happens once per inbound mutation, at a boundary where that is the right trade.

Creates validate as `complete`, updates as `partial`, matching the local pipeline.

## Known limitations

- **A set modification can exceed `sh:maxCount` undetected.** `{tags: {add: [1, 2, 3]}}` on a
  `maxCount: 1` property conforms, because the final count depends on the store. A lower bound is
  derivable from the count of *distinct* added values, but added values may duplicate ones already
  held, so the bound is only sound for distinct additions — left alone rather than risk a false
  positive on a re-added value.
- **`sh:closed` is unconditional**, not per-shape (backlog 035).
- **Fuseki-backed integration tests were not run** (117 skipped): no Docker in this environment. All
  changed behaviour is covered by unit and serialization tests.

## Deferred

- `docs/backlog/034-validation-report-shape-classes.md` — ship `ValidationReport` /
  `ValidationResult` as shape classes. Open: whether core owns them, `contains` semantics on
  `sh:result`, the extension IRI for `propertyPath`, and the name collision with the interfaces.
- `docs/backlog/035-sh-closed-opt-in.md` — honour `sh:closed` / `sh:ignoredProperties` per shape.
  Written up as a decision, not a task: the unconditional check is a useful typo guard, and honouring
  the flag literally makes unknown keys silent no-ops on open shapes.
- **Validating nodes read back from the store.** The engine is shape-driven and would need only a
  different input adapter.

## Architecture docs

None updated: `docs/architecture/` holds `publishing.md` and `runtime-instances.md`, neither of which
covers validation, mutation contracts, or serialization. No new architecture doc was warranted —
this work changed enforcement inside an existing pipeline, not its structure or boundaries.


---

## Amendment — `xsd:time` takes a string, not a `Date`

Landed after this report. Recorded here rather than in a new report, because it reverses a
decision this document states and leaving both standing would make the record untrustworthy.

**What changed.** `xsd:date` and `xsd:dateTime` are unchanged and still take a `Date` and only a
`Date`. `xsd:time` now takes a pattern-checked **string** and rejects a `Date`.

**Why the original decision did not hold.** A time of day is not an instant. Using `Date` for one
means inventing a date to carry it — and this report's own serializer table shows the
consequence: `"09:30:00.000Z"^^xsd:time` was derived by slicing a full timestamp and discarding
the date half. That half is not merely redundant; it makes two identical clock times recorded on
different days compare unequal, and it forces a caller to pick an arbitrary date to express
"half past nine".

JavaScript has no time-only type. `Temporal.PlainTime` is the right answer and is not available
in Node yet, so the lexical form is the honest representation.

**Accepted:** `HH:MM:SS` with optional milliseconds and an optional `Z` / `±HH:MM` offset. Ranges
are enforced by the pattern (hours `00-23`, minutes and seconds `00-59`), so `"25:00:00"` is
rejected rather than written as a malformed literal no engine will match.

**The serializer still follows the declared datatype**, which is what makes this safe. Mutation
literals are typed from the *JavaScript* type when they reach SPARQL, so a plain string would be
written as a plain literal and silently stop matching the property it was meant to fill. A string
on an `xsd:time` property is typed from the declaration instead:

| Declared | Value | Term |
| --- | --- | --- |
| `xsd:time` | `'14:30:00'` | `"14:30:00"^^xsd:time` |

That behaviour is driven by an explicit allow-list (`STRING_LEXICAL_DATATYPES`) rather than
"type every string from whatever is declared". A string reaching a numeric property is a mistake
`assertValid` rejects; typing it from the declaration would instead write a plausible-looking
`"abc"^^xsd:integer` and hide the error in the data. Only datatypes for which a string is a valid
lexical form belong in the list.

**Impact.** Breaking for `xsd:time` only. Two tests in `shape-validation-constraints.test.ts`
encoded the old behaviour and were updated with the reasoning inline. Covered by
`src/tests/xsd-time-string.test.ts` (22 cases).
