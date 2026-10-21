---
summary: >
  Lists can page by subject: `.orderBy((p) => p)` survives the DSL-JSON wire (the subject sorts
  as the empty path), and a node in a query gains `str()`, so a page continues after the last IRI
  with `.where((p) => p.str().gt(lastId))`. CN plan 070, §C4 (CN's instance lists page by key).
packages: [core]
---

# 046 — Order and page by subject

## Why

CN's instance lists page with `OFFSET`, which costs 0.5-1 s deep into a class of ~87k instances
(CN plan 070, decision 9) and is not even stable without an order. Paging by key needs an order
and a cursor. Measured on core's `store-inference` tip before this change:

- `.orderBy((p) => p)` already lowered to `ORDER BY ASC(?a0)` in process, but its wire form
  `{"": "ASC"}` failed in `fromJSON`: `Property '' not found on shape 'Person' while resolving
  path ''`.
- `p.str()` on a node threw `Person.str is accessed in a query, but it does not have a
  @linkedProperty decorator`. The IR and the DSL-JSON codec could already express
  `STR(?subject) > "…"` (`{"@path": ""}` is the subject); only the builder had no way in.

## What

- `QueryBuilderSerialization.deserializeSortByPath`: the empty path is the subject
  (`new PropertyPath(shape, [])`), so a subject sort round-trips, alone or after property sorts.
- `QueryShape.str()`: `STR` of the node (the subject at the root, a related node's IRI on a
  single-valued hop). `str` joins `RESERVED_QUERY_DSL_NAMES`.
- `documentation/dsl-json.md` §Paths: the empty path.
- Changeset: minor.

## Tests

`src/tests/subject-order-and-cursor.test.ts` (7): ASC and DESC subject order, the wire round
trip alone and after a property sort, the cursor filter and its round trip, `str()` on a related
node. `sparql-fuseki-coverage.test.ts` §5 gains a live case: pages of two by subject over five
people continue without overlap and return all five in order.

## Gates

On a throwaway Fuseki of `linked-fuseki:dev` (port 3184):

```
FUSEKI_BASE_URL=http://localhost:3184 jest (full)  50 s
Test Suites: 2 failed, 4 skipped, 120 passed, 122 of 126 total
Tests:       4 failed, 120 skipped, 2435 passed, 2559 total
[fuseki] live tests: 307 total — 303 passed, 4 failed, 0 skipped
tsc -p tsconfig-tests.json                          exit 0
```

The failures are not this change: `two-copies-built.test.ts` (core backlog 060, fails on `main`
too) and four Jena SHACL cases of `sparql-fuseki-shape-sync.test.ts`, which fail identically on
the integration tip against the same Fuseki (a CN compose Fuseki, which serves no `ds` dataset
with the `shacl` endpoint those cases validate through).
