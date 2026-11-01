---
summary: >
  Sorting keeps every instance and puts missing values last in both directions, for direct and
  nested paths; an unpaged where-aggregate with multi-valued rows filters per subject; a
  multi-valued leaf under a traversal maps to all its values. Closes backlog 089.
status: Tasks
packages: [core]
---

# 006 — Sorting keeps instances, missing values last

Source: backlog 089, report 098, the owner's decisions (below).

## The owner's decisions

1. Sorting never drops instances, and missing values sort last, in both directions, for direct
   and nested paths alike. `Person.select(p => [p.name, p.bestFriend.name]).orderBy(p =>
   p.bestFriend.name)` with Anna (best friend Bob), Carl (Ada) and Dirk (none): ASC returns Carl,
   Anna, Dirk; DESC Anna, Carl, Dirk. The sort traversal becomes OPTIONAL and each sort key gets
   a "bound first" key before the value. Report 098's MIN/MAX per subject and the IRI tie-break
   stay. It holds for paged and unpaged selects, grouped selects' `orderBy` on group fields, and
   `.one()`. Documented where `orderBy` is (README, DSL-JSON for stores answering envelopes
   themselves). Visible change for direct paths: minor changeset.
2. Backlog 089 item 1: an unpaged select with a where-aggregate and multi-valued rows uses the
   subject sub-SELECT, without LIMIT.
3. Backlog 089 item 3: a multi-valued leaf under a single-valued traversal maps to all values.

Backlog 089 item 2 (nested sort drops instances) is decision 1.

## Planning blockers

None: the behaviour is decided by the owner. The open items are how to lower it.

## Ideation

### Decision 1 of 5: the "bound first" key

- A. `DESC(BOUND(?k))` before the value key: `true` sorts after `false`, so DESC puts bound
  first in both directions. One short term, no IF/COALESCE.
- B. `ASC(!BOUND(?k))`: same effect, a negation to read.
- C. `ASC(IF(BOUND(?k), 0, 1))`: most explicit, longest.

Chosen: **A** (simplest SPARQL; `BOUND` never errors, so the key itself is always defined).

### Decision 2 of 5: where the nested sort traversal goes

- A. Treat an order path's traversal like a projected one: an OPTIONAL subtree
  (`buildOptionalTraversalSubtree`), unless the where or an inline filter requires it.
- B. A separate OPTIONAL block per order key.

Chosen: **A** (reuses the projection's path; a path both projected and sorted on reads one
variable, as today).

### Decision 3 of 5: keys that are not a variable

Ungrouped `orderBy` keys are always paths (variables) or the subject; paged keys are the page's
`?page_order_i` variables. A grouped select sorts by fields, which may be an aggregate
(`DESC(MAX(?x))`). `BOUND` needs a variable.

- A. The bound key reads the field's projection alias (`DESC(BOUND(?last))`): SPARQL orders
  after the select expressions, so an alias is in scope.
- B. `COALESCE(sameTerm(e, e), false)` for any expression.

Chosen: **A**. No bound key for the subject itself or for `COUNT` (always bound).

### Decision 4 of 5: the unpaged where-aggregate

Use `pageBySubject` without LIMIT/OFFSET whenever a where-aggregate (HAVING) meets rows that can
be more than one per subject, `.for(id)` included (its HAVING groups per subject and values too).

### Decision 5 of 5: nested leaf values

`collectNestedGroup` fills a nested entity's fields from its first binding. Fill them from all of
the entity's bindings with `populateFlatFields`, as the root does: a multi-valued leaf is an
array of its distinct values, a single-valued one its first value. Holds under multi-valued
traversals too.

### Selected route

1A, 2A, 3A, 4, 5 as above. Unpaged selects keep their row ORDER BY (an instance sorts at its
first row, so MIN ascending and MAX descending already); no tie-break is added there.

## Plan

### Architecture decisions

- `irToAlgebra.selectToAlgebra`: `collectRequiredTraversalAliases` no longer reads `orderBy`;
  in an ungrouped select the order paths' traversal aliases join the OPTIONAL traversal set
  (with the projected ones). Each order condition becomes two: `DESC(BOUND(?k))`, then the value.
  A grouped select's non-variable key binds through its projection alias.
- `pageBySubject`: each `?page_order_i` key gets `DESC(BOUND(?page_order_i))` before it, in the
  page and in the outer ORDER BY; the subject key and the IRI tie-break do not.
- A where-aggregate with more than one row per subject goes through `pageBySubject` with no
  LIMIT/OFFSET (`.for(id)` too).
- `resultMapping.collectNestedGroup`: nested fields from all the entity's bindings.

### Contracts

- `orderBy` (DSL, IR, DSL-JSON `sortBy`/`groupOrderBy`): an instance (or group) without a value
  for a key sorts after every instance with one, in both directions; no key drops an instance.
  Multi-valued or nested key: MIN ascending, MAX descending, over the values it has. Ties: by
  the subject IRI when paged.
- A where-aggregate is evaluated per subject, paged or not.
- A multi-valued field of a nested entity is an array of its distinct values.

### Expected file changes

- `src/sparql/irToAlgebra.ts`, `src/sparql/resultMapping.ts`.
- Tests: new `src/tests/select-order-missing-last.test.ts` (lowering + live), golden entries in
  `src/tests/sparql-select-golden.test.ts`, existing goldens and live tests that assert the old
  order (`select-subject-paging`, `select-group-by`, `sort-and-aggregate`, goldens with ORDER BY).
- Docs: README "Sorting, limiting, one" and groupBy, `documentation/dsl-json.md`,
  `documentation/sparql-algebra.md`, `SelectBuilder.orderBy`/`limit` JSDoc, backlog 089 removed.
- `.changeset/*.md`: minor.

### Pitfalls

- An order path also in the where stays required (the where needs it anyway).
- The page's pruning (`prunePagePattern`) must keep the OPTIONAL order traversal: it binds a
  needed variable.
- Grouped ORDER BY on an aggregate expression: the bound key must read the alias, not repeat
  the aggregate inside `BOUND`.
- Nested multi-valued fields now return arrays where they returned one value (a fix; listed in
  the changeset).

## Tasks

### Phase 1: failing tests

- New test file with lowering and live tests for the three decisions (Anna/Carl/Dirk data,
  plus the 089 examples), and golden entries.
- Validation: the new tests fail for the stated reasons (quoted in Phase results).

### Phase 2: implementation

- Order traversal OPTIONAL, bound keys (unpaged, paged, grouped), where-aggregate sub-SELECT,
  nested field mapping.
- Validation: new tests pass; the whole core suite with live Fuseki passes after updating the
  tests that assert the old order (each change listed); `npx linked build`.

### Phase 3: docs and changeset

- README, dsl-json, sparql-algebra, JSDoc; backlog 089 removed; minor changeset.
- Validation: docs read the shipped rule; `npm run typecheck`.

### Dependencies

Phase 1 → 2 → 3, one agent, sequential.

## Phase results
