---
"@_linked/core": major
---

Prefixes are the app's, and ontologies register with one call per package.

- `registerOntologies(ontologies, moduleUrl)` replaces `linkedOntology`, which is removed. A package's `src/ontologies/index.ts` imports its terms modules (only `{id}` literals) and registers them all: `registerOntologies([{name, namespace, terms, data?, suggestedPrefix?}], import.meta.url)`, `data` relative to `moduleUrl`. It registers no prefix. `OntologyRegistration` has `namespace` and `suggestedPrefix` instead of `ns`; `suggestedPrefixes()` lists `{packageName, name, namespace, prefix}`.
- `registerInstalledOntologies` imports `<pkg>/ontologies/index` instead of `ontologies/*.register` modules.
- No ontology registers a prefix, core's own included (`rdf`, `rdfs`, `owl`, `xsd`, `shacl`, `sd`, `prov`, `core`; the deprecated `linked_core` label is gone). An app loads its map with `Prefix.load(map)` (replaces the map in use; `PrefixMap` is `Record<prefix, namespace>`); `Prefix.toMap()` returns it.
- An unknown prefix throws `UnknownPrefixError` (naming the prefix and the value) wherever a prefixed name is expanded: `Prefix.toFull`, query subjects (`.for('ex:a')`), `update().for` and `delete` ids (which were never expanded before), and property path steps (which were written as `<p:x>` with a warning). A string with `://` or the scheme `http`, `https`, `urn`, `mailto`, `did`, `file` or `data` is a full IRI (`Prefix.isFullIri`).
- Expansion and compaction take an optional explicit map, for code acting for another app: `Prefix.toFull`, `toPrefixed`, `toPrefixedIfPossible`, `getFullURI`, `getPrefix`, `findMatch`, `resolveUriOrThrow`, `resolveNodeId`, `pathRefIri`, `expandPrefixedName`.
- Removed: `Prefix.toFullIfPossible`, `resolvePrefixedUri`, `expandRegisteredPrefixedName` (now `expandPrefixedName`, which throws), `linked-core.register`. `linked-core.ts` exports `coreOntology` only (no `ns`, `_self`, `dataFiles`, `loadData`).
