---
'@_linked/core': minor
---

Select types that match what the query returns.

- A multi-valued literal (`get nickNames(): string[]`, no `maxCount: 1`) in an array select is
  typed as a `string[]` field of the row (`select((p) => [p.nickNames])` was typed as `string[]`
  for the whole row).
- A single-valued literal on a query path has the expression methods of its type in its type:
  `.where((p) => p.hobby.isDefined())`, `p.name.strlen().gt(3)`, `p.name.lang()`; they already ran.
  `BaseExpressionMethods` adds `lang`, `datatype`, `iri`, `isIri`, `isLiteral`, `isBlank`,
  `isNumeric`, `md5`, `sha256`, `sha512`.
- A relation on a query path has `isDefined()` and `isNotDefined()` (now reserved names).
- Fixed: a relation projected bare next to a `where` that traverses it
  (`select((u) => [u.ofKey]).where((u) => u.ofKey.ofShape.equals(…))`) returned `null`; it returns
  its `{id}`.
- The inline `where` of a primitive (`p.hobby.where((h) => h.equals(…))`) is typed by what it
  answers, `equals`.
