---
date: 2026-11-01
summary: >
  Sorting never drops an instance, and missing values sort last in both directions, for direct
  and nested paths (paged, unpaged, `.one()`, grouped, a nested select's own orderBy). An
  unpaged where-aggregate over multi-row subjects filters per subject; a nested entity's
  multi-valued field keeps all its values. Minor (visible order change). Closes backlog 089;
  new backlog 092.
packages: [core]
---

# 101 — Sorting keeps instances, missing values last

## PR

### Summary

The owner's rule: **sorting never drops instances, and missing values sort last, in both
directions, for direct and nested paths alike.** With Anna (best friend Bob), Carl (Ada) and
Dirk (none), `Person.select((p) => [p.name, p.bestFriend.name]).orderBy((p) =>
p.bestFriend.name)` returns Carl, Anna, Dirk ascending and Anna, Carl, Dirk descending. Before,
the nested sort path was a required join (Dirk was missing), and a direct path kept Dirk but
put him first ascending.

Shipped rules (README "Sorting, limiting, one", `documentation/dsl-json.md`,
`documentation/sparql-algebra.md` step 10, JSDoc of `SelectBuilder.orderBy`/`limit` and
`GroupedSelectBuilder.orderBy`):

- A sort path's traversal is OPTIONAL (only the where and inline filters make a traversal
  required). Each key is preceded by `DESC(BOUND(?k))`. None for the subject itself or a
  `COUNT`.
- Paged (subject sub-SELECT, report 098): `DESC(BOUND(?page_order_i))`, then `MIN` ascending /
  `MAX` descending per subject, then the IRI tie-break, in the page and the outer ORDER BY.
- Grouped `orderBy` on fields: the group without the key's value, or whose aggregate has no
  value, sorts last. An aggregate field is tested through its projection alias
  (`DESC(BOUND(?a2)) DESC(MAX(?a0_birthDate))`).
- `.one()`: the first instance that has the value, if any has it.
- A nested select's own `orderBy` (`p.friends.select(...).orderBy('hobby')`): the key is
  OPTIONAL inside its window, bound first.
- DSL-JSON: `sortBy`/`groupOrderBy` never remove a subject or group, missing last both ways; a
  where holding an aggregate holds per subject. A store answering envelopes itself must sort,
  filter and page the same way.

Backlog 089:

1. An unpaged select with a where-aggregate and multi-row subjects
   (`Person.select((p) => [p.name, p.friends.name]).where((p) => p.friends.size().equals(2))`)
   grouped per (subject, values) and matched nobody. It now uses the subject sub-SELECT
   without LIMIT/OFFSET, `.for(id)` included. The same sub-SELECT now also sorts an ungrouped
   select that projects an aggregate (its sort path was outside its GROUP BY, so the sort did
   nothing; review R2).
2. Nested sort dropping instances: the rule above.
3. `Person.select((p) => p.bestFriend.nickNames)` mapped to `{nickNames: 'C'}`; now `['C', 'D',
   'E']`. Cause: `collectNestedGroup` filled a nested entity's fields from its first binding.
   The coordinator's case (the host app's report), a multi-valued leaf in a nested select under a
   multi-valued traversal (`Import.select(i => [i.created.select(c => [c.shape,
   c.instances])])`), has **the same cause** and is fixed by the same change (test "a
   multi-valued leaf in a nested select under a multi-valued traversal": `K`, `X` before,
   `['K', 'L']`, `['X', 'Y']` after).

### Changes

- `src/sparql/irToAlgebra.ts`: `collectRequiredTraversalAliases` reads only the where and
  inline filters; order aliases join the OPTIONAL traversal set; `boundFirst`,
  `orderWithBoundFirst`; `pageBySubject` keys; `subjectSubSelect` (paging, where-aggregate over
  multi-row subjects, projected aggregate with a sort); the nested-select window's order keys.
  Count and ask keep refusing a where-aggregate, now by reading the IR (`containsAggregate`).
- `src/queries/irExpressions.ts`: `containsAggregate` (moved from `GroupedSelectBuilder`).
- `src/sparql/resultMapping.ts`: nested fields from all of an entity's bindings
  (`populateFlatFields`); `populateFields` removed.
- `src/utils/Package.ts`: `PropertyShape.path` declares `maxCount: 1` (SHACL: exactly one
  `sh:path`). Found by the host app's smoke run: The host app's shape catalog reads `ns.properties.select((ps) =>
  [ps.path, …])`, and with the mapping fix the undeclared-cardinality `path` came back as a
  list, so every shape was skipped ("Invalid property path step"). `fixtures/core-shapes.ttl`
  regenerated (one line).
- Tests: new `src/tests/select-order-missing-last.test.ts` (9 lowering/mapping, 14 live);
  three goldens in `sparql-select-golden.test.ts`. Updated for the new order: `sparql-algebra`,
  `sparql-fuseki-coverage` (`[hobby, name]`), `subject-order-and-cursor`, `select-group-by`,
  `property-path-integration`, `select-subject-paging`, `nested-select-pagination`;
  `sparql-result-mapping` (two hand-built IRs gained `maxCount: 1` on `name`, as lowering gives
  it).
- Docs as above; backlog 089 removed; backlog 092 added.
- `.changeset/sort-missing-last.md`: **minor**, names the visible change for direct paths.

### Verification

- New tests before the change: `Tests: 17 failed, 1 passed, 18 total`, `[fuseki] live tests:
  11 total — 0 passed, 11 failed`; goldens `5 failed, 88 passed`.
- Final, whole core suite against an own Fuseki (`FUSEKI_BASE_URL=http://localhost:3967 npm
  test`): `Tests: 122 skipped, 3169 passed, 3291 total`, `[fuseki] live tests: 467 total — 465
  passed, 0 failed, 2 skipped`; typecheck clean. `npx linked build`: `✔ Build successful`.
- The host app's main checkout, core landed and built there: `npm run typecheck:gate`: `No new type errors.
  0 pre-existing errors still in the baseline.` `npm run test:feature -- data,apps,ontologies
  --tier smoke`: typecheck, `unit (vitest, 136 files) PASS`, gateway package PASS, playwright
  `1 failed, 10 passed`. The first run failed 4 specs (`app-scope`, `gateway-shapeless-delete`,
  `gateway-triples`, `llm-data-queries`), all from the shape catalog's `ps.path` arriving as a
  list; fixed in core (`PropertyShape.path` `maxCount: 1`). The one left,
  `gateway-shapeless-delete` "with the flag, a dataset-wide writer deletes a person", is not
  core's: in the smoke tier it runs without the untagged test before it that turns the
  connection's flag on (`setFlag(true)`), so it gets `shapeless-delete-not-allowed`. The whole
  spec passes: `npx playwright test --project=integration
  tests/integration/gateway-shapeless-delete.spec.ts`: `6 passed (40.7s)`.

### Deviations

- Count and ask: their refusal moved from `inner.having` to the IR where, since the sub-SELECT
  now carries the HAVING.
- A nested multi-valued field without values maps to `[]` (was `null`), as on the root.
- Unpaged selects keep their row ORDER BY (an instance sorts at its first row, which is MIN
  ascending and MAX descending already); no IRI tie-break added there.

### Host app impact

No host-app change was needed. Callers checked:

- `orderBy` in the host app: three server-side calls sort by the subject only (`orderBy((p) => p)`), which gets no bound key: unchanged. No
  host-app caller sorts by a nested path. DSL-JSON `sortBy` from the AI data queries now puts
  instances without the key last; the `llm-data-queries` smoke passes.
- The term search's `rowLimitOf` (`.limit(...)` on its term select): the term
  select projects multi-valued `label`/`comment`, so since report 098 its limit counts terms,
  not rows; the ×4 headroom now over-reads (no wrong results). Not changed.
- The document staging code reads the import's created record at the top level and then
  `ImportCreated.select(...).forAll(ids)` (the host app's report), working around the nested
  multi-valued mapping fixed here; it can go back to one nested select. Not changed.
- The shape catalog query (`fetchShapeCatalog`, `ns.properties.select((ps) =>
  [ps.path, …])`): broke on the mapping fix, fixed in core (above).
- The host app's smoke spec `gateway-shapeless-delete` depends on an untagged test's `setFlag(true)`:
  a host-app test issue, for whoever owns that spec.

### Follow-ups

- Backlog 092: `orderBy` on a computed expression is dropped silently; a filter on a sort path
  is ignored; `p.friends.nickNames` throws in the proxy.
- The host app (not recorded there, for the coordinator): document staging can return to one nested
  select; `rowLimitOf` headroom can go; the `gateway-shapeless-delete` smoke test's order
  dependency.

## Details

### Review

Two independent read-only review rounds.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R1 | high | A nested select's own `orderBy` joined its key as a required triple in its window, with no bound-first key: children without it were dropped | Fixed |
| R2 | medium | An unpaged select projecting an aggregate sorted by a path outside its GROUP BY: no effect (older) | Fixed: the subject sub-SELECT sorts it |
| R3 | medium | `orderBy` on a computed expression dropped silently (older) | Backlog 092 |
| R4 | low | Filter on a sort path ignored; sort path sharing a filtered projection's alias (older) | Backlog 092 |
| R5 | low | Bound key also on always-bound keys (`count().plus(1)`, where-required paths) | Kept: harmless |
| R6 | low | The unpaged where-aggregate sub-SELECT computes MIN/MAX with no LIMIT | Kept: they feed the outer ORDER BY |
| R7 | low | Count/ask refuse an aggregate inside an exists too, with a HAVING message | Kept: that where yields invalid SPARQL anyway |
| R8 | low | A nested multi-valued field without values is `[]` (was `null`) | In the changeset |
| R9 | low | Report 098 states the old rule | Historical; this report supersedes it |

Second round (on the fixes): both hold (multi-key inner order, `.for(id)`, `.limit`, colliding
aliases, where-aggregate). Lows: `orderBy((p) => p)` alone next to an aggregate triggered a
needless sub-SELECT (fixed: only a key that is not the subject triggers it); an inner `orderBy`
without `limit` does not order the children in the outer rows, and a colliding-alias count is
per row (both older, not changed).
