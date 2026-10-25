---
"@_linked/core": minor
---

A property path step can no longer reach a query verbatim. A string step is written as a prefixed name only when it is one SPARQL `PN_PREFIX ':' PN_LOCAL` token with a registered prefix; every other step goes through `formatUri` (`<…>` plus the IRI check). So a stored `sh:path` step such as `rdf:type?o.?s?p?o.FILTER(true)#` is one IRI, not extra patterns, and a `urn:prop:a` step in a complex path is now `<urn:prop:a>` instead of a parse error. The path parser keeps `<urn:…>` as an `{id}` step. Paths are also checked when they load (`normalizePropertyPath`, `fromWire`, `ShapeCatalog.from`, `registerRuntimeShape`): a step that is neither a prefixed-name token nor an absolute IRI throws the new `InvalidPropertyPathError`. `collectPathUris` now returns the full IRI of a registered prefixed-name step, so its PREFIX is declared.

Behaviour changes:

- A string step whose prefix is not registered is written as `<prefix:local>` rather than `prefix:local`, and warns once per prefix (except bare-IRI schemes such as `urn:` and `mailto:`). Import the ontology that registers the prefix before querying.
- A shape whose stored path has a refused step fails to load: `ShapeCatalog.from` throws for the whole catalog. Write such a step as `{id}` (a hierarchical IRI with `?`, `*`, `+`, `(` or `!` in it is refused as a bare string).
