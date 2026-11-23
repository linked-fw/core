# Backlog

Deferred / future work — one file per item, `NNN-topic.md`, with YAML frontmatter
(`summary`, `packages`). This is the single pile the workflow skills know about:
the `todo` skill creates items here, and `ideation` consumes one to seed a plan in
`docs/plans/`. Completed work is recorded in `docs/reports/`.

Closed without a report: 040 (one inheritance walk, `getSuperShapes`, commit 67e015b) left two small
gaps — an undecorated class between two shapes inherits its parent's static `shape`, so
`getSuperShapes` lists that parent twice; and `getSuperShapesClasses`/`getSubShapesClasses` return
classes only, so a data-only shape never appears in them.

## Index

Open items (one row per file in this folder; keep it in step when adding or closing one):

| # | Item |
|---|---|
| [001](001-remote-dataset-deferred-gaps.md) | RemoteDataset deferred gaps |
| [002](002-dsl-json-open-items.md) | DSL-JSON open items |
| [004](004-sparql-construct-support.md) | Idea: SPARQL CONSTRUCT Support |
| [006](006-dsl-aggregates-sum-avg-min-max.md) | DSL aggregates: sum / avg |
| [007](007-decoder-and-lowering-unification.md) | DSL-JSON decoder & lowering unification |
| [010](010-membership-rungs-2-4.md) | Membership: Rungs 2–4 |
| [011](011-create-with-computed-values.md) | Create with computed / subquery-derived values |
| [013](013-nested-builder-values-for-shapeless-properties.md) | Nested builder/Shape values for shapeless (polymorphic) properties |
| [014](014-prefixed-uris-in-json.md) | Prefixed URIs in JSON/Object Formats — Ideation |
| [018](018-transactions.md) | Transactions — Ideation |
| [020](020-distinct.md) | Distinct — Ideation |
| [021](021-computed-properties.md) | Computed Properties — Ideation |
| [024](024-fulltext-search-primitive.md) | Fulltext / `.search()` DSL primitive — Ideation |
| [026](026-shared-variable-bindings.md) | Shared Variable Bindings |
| [027](027-shape-remapping.md) | Shape Remapping (ShapeAdapter) |
| [028](028-strict-null-checks.md) | strictNullChecks Migration |
| [029](029-query-type-system-refactor.md) | Query Type System Refactor |
| [030](030-shacl-path-reader.md) | SHACL `sh:path` → `PathExpr` reader (bidirectional shape sync) |
| [031](031-byshape-polymorphic-projection.md) | `byShape` polymorphic projection (read a value by its runtime shape) |
| [032](032-stable-shape-uris.md) | Stable shape URIs outside the cli's bundler |
| [033](033-no-live-shape-instances.md) | Disallow live Shape instances outside queries |
| [034](034-validation-report-shape-classes.md) | Validation report shape classes |
| [035](035-sh-closed-opt-in.md) | `sh:closed` as opt-in |
| [036](036-ask-query-support.md) | `ASK`: what remains |
| [042](042-ask-and-count-with-aggregate-filters.md) | Aggregate filters that need a sub-SELECT (`ASK`, `COUNT`, inside `EXISTS`) |
| [043](043-language-tagged-literals-in-the-dsl.md) | Language-tagged literals in the DSL |
| [046](046-provenance-scoped-shape-pruning.md) | Provenance-scoped shape pruning |
| [052](052-generated-shape-lifecycle-edge-cases.md) | Generated-shape lifecycle edge cases |
| [054](054-blank-node-support-next-steps.md) | Blank-node support in core: next steps |
| [055](055-owned-walk-branch-count.md) | Owned-walk branch count |
| [059](059-property-inference-subpropertyof.md) | Property inference (`rdfs:subPropertyOf`) |
| [062](062-ontology-review-lows.md) | Ontology sync and shape check: review lows |
| [064](064-package-version-in-ontology-graph-records.md) | The package version in ontology graph records |
| [068](068-default-graph-shapes-of-removed-packages.md) | Default-graph shapes of removed packages |
| [069](069-per-instance-graph-functions.md) | Per-instance graph functions |
| [073](073-routed-paths-across-graphs.md) | Routed paths across graphs |
| [086](086-object-property-string-accessor-query-type.md) | The query type of an object property with a `string` accessor |
| [087](087-query-features-in-routers-and-baseline.md) | Query features in routers, and the baseline |
| [091](091-create-as-other-shape.md) | Writing one node through several shapes (`.as`) |
| [109](109-per-key-direction-grouped-and-nested-order.md) | Per-key directions in grouped and nested-select sorting |
| [111](111-outer-references-quantifiers-and-wire.md) | Outer references: wire form, deeper hops, routed reads |
| [112](112-inline-filter-and-size-lowering-edges.md) | Inline filter and size() lowering edges (what stays open) |
| [114](114-array-form-aggregate-row-and-fuseki-count-tests.md) | Array-form count through a hop; Fuseki count test; computed field types |
| [115](115-catalog-write-graphs-from-global-read-sets.md) | Catalog mutations take their write graphs from the global registry |
| [116](116-cached-expired-entry-pruning.md) | `cached()` never prunes expired entries it is not asked for again |

Closed by the backlog sweep (report 125): 019 → report 116, 023 → 119, 049 → 117, 070 → 124,
079 → 118 (its answering half folded into 042), 088 → 120, 108 → 115, 110 → 121, 113 → 123.

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
| 012 aggregate-group-filtering | backlog 012, **retired** → report 096 (implemented) |
| 013 shacl-property-paths | **retired** → report 011 (implemented) |
| 014 prefixed-uris-in-json | backlog **014** |
| 015 shacl-rdf-serialization | **retired** → report 016 (write side); reader → backlog **030** |
| 016 aggregations | backlog 016, merged into backlog **006** |
| 017 upsert | backlog 017, **retired** → plan 002 (`Shape.upsert`, implemented) |
| 018 transactions | backlog **018** |
| 019 multi-column-sorting | backlog 019, **retired** → report 116 (implemented) |
| 020 distinct | backlog **020** |
| 021 computed-properties | backlog **021** |
| 022 negation | **retired** → report 013 (implemented) |
| 023 duplicate-projection-fields | backlog 023, **retired** → report 119 (implemented) |
| 024 fulltext-search-primitive | backlog **024** |

(Historical reports 005/008/010/011/013/016 still cite the old `docs/ideas/NNN`
paths in their archival record; use the table above to resolve them. A few of those
citations were already dangling before the move — e.g. `ideas/006`, `ideas/007`,
`ideas/025` never existed in the final tree.)
