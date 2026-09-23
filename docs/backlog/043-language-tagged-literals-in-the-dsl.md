---
summary: The DSL has no notion of a language-tagged literal. `rdf:langString` cannot be declared on a property shape, selected per-language, or filtered by tag, so any multilingual model has to reify language as its own node — which is what `@_linked/translation` does, at real cost.
packages: [core]
---

# 043 — Language-tagged literals in the DSL

**Status:** open. No code written; this records the gap and why it matters.

## The gap

RDF's native way to say "this literal is in French" is a language-tagged literal —
`"Bonjour"@fr`, of datatype `rdf:langString`. The DSL cannot express it at any layer:

- **Declaration.** `@literalProperty({path, datatype})` takes an `xsd:` datatype. There is no
  way to say "this property holds `rdf:langString`", nor to constrain the permitted tags
  (SHACL's `sh:languageIn` / `sh:uniqueLang`).
- **Selection.** A query cannot ask for one language — no `.lang('fr')` or equivalent — nor
  read the tag off a value that has one.
- **Filtering.** No access to SPARQL's `LANG()` / `LANGMATCHES()`.
- **Writing.** `create`/`update` cannot attach a tag to a literal being written.

## Why it matters — the cost is already being paid

`@_linked/translation` models translations as an explicit per-language **node**
(`tr:TranslationUnit`) rather than a tagged literal. Its own source records why:

> Explicit per-language node (not `rdf:langString`) so it can be filtered per-language
> through the LINKED DSL AND carry management metadata — review `state` and provenance —
> that a bare literal cannot hold.

Half that reasoning is sound and would survive language support: review state, provenance and
approval genuinely need a node, because a literal cannot carry them. **The other half —
"so it can be filtered per-language through the LINKED DSL" — is a workaround for this gap.**
Without it, a model that only needs `label@en` / `label@nl` still has to reify.

This is not only about the translation package. Any multilingual domain model in this
ecosystem currently faces the same choice: reify language, or step outside the DSL into raw
SPARQL. That is a notable hole for a framework whose premise is that the DSL is the way to
talk to the graph.

## Shape of a solution (not a decision)

Roughly in order of usefulness:

1. **Read**: expose the tag on a value, and allow `LANGMATCHES`-style filtering in a where
   clause.
2. **Select**: pick a language, with a fallback chain (`fr`, then `en`, then any) — the
   behaviour applications actually want.
3. **Declare**: `rdf:langString` as a datatype on a property shape, plus `sh:languageIn` and
   `sh:uniqueLang` so the constraint is expressible in the metamodel that already carries the
   rest of SHACL.
4. **Write**: attach a tag on create/update.

Steps 1–2 are additive and unblock reading existing tagged data, which is likely where real
value starts. Step 3 touches `nodeShapeData` / `nodeShapeWire` and the SHACL serialization,
so it needs the same care as any metamodel addition.

## Related

- The mirror of this item lives in `@_linked/translation`'s backlog: if language support
  lands here, that package should revisit whether its per-language node is still the right
  model, or whether only the management metadata needs one.
