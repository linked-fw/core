# Backlog

Deferred / future work — one file per item, `NNN-topic.md`, with YAML frontmatter
(`summary`, `packages`). This is the single pile the workflow skills know about:
the `todo` skill creates items here, and `ideation` consumes one to seed a plan in
`docs/plans/`. Completed work is recorded in `docs/reports/`.

Closed without a report: 040 (one inheritance walk, `getSuperShapes`, commit 67e015b) left two small
gaps — an undecorated class between two shapes inherits its parent's static `shape`, so
`getSuperShapes` lists that parent twice; and `getSuperShapesClasses`/`getSubShapesClasses` return
classes only, so a data-only shape never appears in them.

## Consolidation note (was `docs/ideas/`)

The former `docs/ideas/` directory — a pre-workflow convention for exploratory
"future work" — was merged into this backlog (report 024 wrapup), since it served
the same role and lived outside the skill tooling. Larger exploratory items
(CONSTRUCT, named graphs, transactions, upsert, type-system refactor, …) and
smaller scoped deferrals now coexist here; the `summary` frontmatter says which is
which.

Three ideas were already implemented and were retired rather than moved
(see the report for each). The remaining ideas were moved; where an idea's number
collided with an existing backlog item it was renumbered. Mapping for anyone
following an old `docs/ideas/NNN` reference in a historical report:

| Old `ideas/NNN` | Now |
|---|---|
| 002 storage-config-and-graph-management | backlog 025, **retired** → reports 048–057, 075 (implemented) |
| 004 sparql-construct-support | backlog **004** |
| 005 named-graph-support | backlog 005, **retired** → reports 049, 051, 056 (implemented) |
| 008 shared-variable-bindings | backlog **026** |
| 009 shape-remapping | backlog **027** |
| 010 strict-null-checks | backlog **028** |
| 011 query-type-system-refactor | backlog **029** |
| 012 aggregate-group-filtering | backlog **012** |
| 013 shacl-property-paths | **retired** → report 011 (implemented) |
| 014 prefixed-uris-in-json | backlog **014** |
| 015 shacl-rdf-serialization | **retired** → report 016 (write side); reader → backlog **030** |
| 016 aggregations | backlog 016, merged into backlog **006** |
| 017 upsert | backlog 017, **retired** → plan 002 (`Shape.upsert`, implemented) |
| 018 transactions | backlog **018** |
| 019 multi-column-sorting | backlog **019** |
| 020 distinct | backlog **020** |
| 021 computed-properties | backlog **021** |
| 022 negation | **retired** → report 013 (implemented) |
| 023 duplicate-projection-fields | backlog **023** |
| 024 fulltext-search-primitive | backlog **024** |

(Historical reports 005/008/010/011/013/016 still cite the old `docs/ideas/NNN`
paths in their archival record; use the table above to resolve them. A few of those
citations were already dangling before the move — e.g. `ideas/006`, `ideas/007`,
`ideas/025` never existed in the final tree.)
