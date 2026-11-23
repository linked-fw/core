---
summary: Step S8 of plan 006 (backlog 110) — object-form select rows follow the keys the user wrote; the types match; nested objects and the key `id` are refused; DSL-JSON `as` names the key.
packages: [core]
status: Tasks
---

# 007 — Object-form rows follow their keys

Sub-plan of `docs/plans/006-backlog-sweep-master.md`, step S8 (decisions 13, 18–21). Report 121.
Consumes backlog 110. Deleted at wrapup; its content goes into report 121.

## Contract (from plan 006, S8)

- A key names a top-level field of the object it is written in: the root row, or a sub-select's
  member row. Its value is the expression's yield: through single-valued hops only, the leaf or
  `null`; through any multi-valued hop, an array of distinct values (`[]` when empty). A sub-select
  or preload under a key is the member row(s) `{id, …fields}`. Intermediate hops never appear in
  the row. The subject as a field is `{id}`. Expressions and `size()` inside a sub-select are per
  member. Keys are honoured per entry (`.preload()` beside keyed fields). DSL-JSON `"as"` names the
  key.
- Refused in the type and at build time: a nested plain object; the key `id`.
- The array form is unchanged.

## Design

### IR (`IntermediateRepresentation.ts`)

`IRResultMapEntry` gains three optional fields (additive: an array-form query has none of them, so
its IR and SPARQL goldens do not change):

- `container?: IRAlias` — the row the field belongs to: the root alias, or a sub-select's member
  alias. Absent = the root row (array form: nested under the hops from the root).
- `keyed?: true` — an object-form key: the value is the expression's yield read through the hops
  from the container (collapsed), as one field `key` of the container's row. Absent: nested under
  each hop from the container (array form).
- `members?: true` — a keyed sub-select or preload: `alias` is the members' traversal target; the
  field holds their rows `{id, …}`. No projection item for it.

An entry carries `container` when its row is not the one its hops from the root reach: a keyed
field, a field inside a keyed sub-select, and an expression or aggregate inside any sub-select
(per member).

### Lowering (`IRDesugar.ts`, `IRLower.ts`)

- Desugar honours keys per entry: when every entry is keyed, one `custom_object_select` (as now);
  otherwise a keyed entry becomes a one-entry `custom_object_select`, an unkeyed one a plain
  selection. `FieldSetEntry.alias` (DSL-JSON `as`) is read as the key when there is no `customKey`.
- `collectProjectionSeeds` tracks the container (alias of the row) and whether the field is keyed.
  A keyed sub-select emits a `members` entry (key, member alias, container) and recurses with the
  member alias as container. The key of a sub-select is no longer dropped.

### Build-time refusals (`FieldSet.ts`)

A nested plain object or array as an object-form value, and the key `id` (proxy trace and DSL-JSON
`customKey`/`as`), throw naming the key.

### Result mapping (`resultMapping.ts`)

Rows are built per container alias: the root, a members group's member, or an array-form nested
group's entity. Each row holds its unkeyed fields nested under hops (as today), its keyed values
(collapsed; plural → distinct values, else first value or `null`) and its keyed members groups
(grouped by member id, plural → array, else first row or `null`). An aggregate or expression with a
container is a flat field of that container's row.

### SPARQL (`irToAlgebra.ts`)

An aggregate whose entry has a non-root container groups per member: the container alias (and the
traversals leading to it) is projected, so it becomes a GROUP BY key. Counts are `COUNT(DISTINCT …)`,
so a root-level count beside it is unchanged.

### Duplicate checks (`projectionDuplicates.ts`)

`positionOf` gives the row path: the keyed groups (sub-select keys) leading to the field's
container, then the hops nested from the container (unkeyed only), then the key. Each row segment
carries its reading (a hop's canonical step + pagination; a keyed group's canonical path), so two
seeds that share a row segment name but read it differently are refused. The pagination refusal
moves to traversals: two seeds sharing a traversal (identical canonical steps from the root) with
different pagination at that depth are refused, whatever their keys. The keyed-advice refusals
(the Carl case, two filters under two keys) are lifted: their keys sit apart.

### Types (`SelectQuery.ts`, `GroupedSelectBuilder.ts`)

`ObjectToPlainResult` maps each key through a new `KeyedFieldResult<V>`: walk `V`'s source chain;
plural if any hop (or the value itself) is a set. Leaf: primitive, `{id}` for a node (subject
included), `number` for `size()`, the member row `QueryResponseToResultType<QF>` for a sub-select,
`{id} & component fields` for `preloadFor`. A plain object/array value or the key `id` is refused
by a constraint on the select callback's response type. `preloadFor` infers the component's
response so its fields are in the type (array form too). `GroupKeyValue` shrinks to unwrapping an
array.

### Live (`queryDependencies.ts`)

A keyed value read through hops below its container: the hop predicates below the container and
the leaf are `hidden` (the nodes they are read on are not in the row), the chain above it `narrow`.

## Phases

Dependency graph: 1 → 2 → 3; 4 depends only on the contract (could run beside 2–3); 5 after all.
One agent, sequential, one commit per phase.

### Phase 1 — IR, lowering, build-time refusals

Tasks:
- `IntermediateRepresentation.ts`: `container`, `keyed`, `members` on `IRResultMapEntry`.
- `IRDesugar.ts`: keys per entry; `alias` as key.
- `IRLower.ts`: seeds carry `container`/`keyed`; keyed sub-select → `members` entry; container
  on sub-select expressions/aggregates.
- `FieldSet.ts`: refuse nested object/array values and the key `id` (trace + DSL-JSON).

Validation (quick gate): typecheck; new tests in `src/tests/object-form-rows.test.ts`
(IR result maps for each case of the S8 table: `container`/`keyed`/`members`; refusals throw naming
the key; mixed keyed + unkeyed keeps keys); `ir-select-golden`, `sparql-select-golden`: array-form
cases unchanged (object-form goldens listed in Deviations if they move).

### Phase 2 — result mapping + sub-select aggregate grouping

Tasks: `resultMapping.ts` container rows; `irToAlgebra.ts` projects containers of per-member
aggregates.

Validation: unit tests with hand-written bindings for every case of the S8 table (rows equal the
contract: `n: string|null`, `bb: {id}|null`, `names: string[]`, `fbf: string[]`, `x: [{id,…}]`,
`x: {id,…}|null`, `w: [{id}]`, `w: string[]`, `pre: {id, name}|null`, `person: {id}`, no extra
`bestFriend` key, lone sub-select `size()` per member); a `[fuseki]` block with the same cases run
against oxigraph in scratch; goldens; `sparql-result-mapping`, `nested-select-pagination`.

### Phase 3 — `positionOf` + lifted refusals

Tasks: row paths in `projectionDuplicates.ts`; traversal-based pagination refusal; advice texts.

Validation: `duplicate-projection-fields` updated (Carl case and two filters under two keys now
answer, both lists checked on oxigraph); pagination refusal kept; new collisions refused
(two keyed groups with one key from DSL-JSON, `{x: p.name}` beside `{x: sub-select}` impossible in
JS but via DSL-JSON).

### Phase 4 — types incl. grouped and preload

Tasks: `KeyedFieldResult`, response constraint, `preloadFor` component fields, `GroupKeyValue`,
update pinned shapes (`select-result-typing.test.ts:103-104`, `type-probe-deep-nesting.ts` TEST
2/3/19/20).

Validation: strict `Equals` tests for every case for root, `.one()`, `.for()` and grouped;
`@ts-expect-error` for nested object and key `id`; full typecheck.

### Phase 5 — live dependencies, docs, changeset

Tasks: `queryDependencies.ts` hidden predicates for collapsed hops; live test (renaming p2
refreshes `{n: p.bestFriend.name}`); README, `documentation/intermediate-representation.md`,
`sparql-algebra.md`, `dsl-json.md`; minor changeset listing every moved row.

Validation: `query-dependencies`, `live-query-store`, `live-matching`; DSL-JSON round trip of each
case; full typecheck.

Full gate at review: the step's landing gate (plan 006 + task prompt).

## Status

- Phase 1: pending
- Phase 2: pending
- Phase 3: pending
- Phase 4: pending
- Phase 5: pending

## Deviations

(none yet)

## Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|-------|---------|--------|-------------|-----------|
| 1 | design, IR | How to mark object-form entries | Three optional fields on `IRResultMapEntry` (`container`, `keyed`, `members`), only where the default placement is wrong | A container on every entry | Contract asks for additive IR so array-form goldens stay put |
