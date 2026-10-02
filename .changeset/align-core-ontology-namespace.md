---
'@_linked/core': minor
---

The framework vocabulary now lives at `https://linked.cm/ont/core/` with the prefix `core`
(previously `https://linked.cm/ont/linked-core/`, prefix `linked_core`).

This follows the public ontology namespace rule, `https://linked.cm/ont/{ontologySlug}/{localName}`,
where the ontology slug defaults to the package's public slug (`@_linked/core` -> `core`) and the
prefix label equals that slug. The old `linked-core` segment was a leftover of a slug derivation
that has since been reverted. Every term moves: `core:displayRank`, `core:displayHidden`,
`core:contains`, `core:dependent`, `core:PathNode`, `core:Package` and the rest.

The `linked_core` prefix is deprecated but still registered as an alias, so prefixed names such as
`linked_core:displayRank` keep resolving — to the new IRIs. Compaction always emits `core:`. The
alias does not make the old full IRIs match.

Stored data under the old IRIs is not migrated. Triples such as
`https://linked.cm/ont/linked-core/displayRank` on synced shapes stay as they are; clear dev
datasets and resync shapes from code.

Released as a minor rather than a major: the previous move of this vocabulary (from
`purl.org/on/lincd` to `linked.cm`, #91) shipped as a minor in 2.8.0; these terms appear only in
code-derived shape and package metadata that shape sync rewrites from code; there is no real data
using them; and a core major would force every `@_linked` package to move its peer range.
