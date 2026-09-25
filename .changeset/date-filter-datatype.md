---
'@_linked/core': patch
---

A `Date` in a query filter is emitted as a TYPED SPARQL literal.

`.equals(new Date(…))` on a date property used to render a plain
`"2020-01-01T00:00:00.000Z"`, while `create`/`update` write
`"2020-01-01T00:00:00.000Z"^^xsd:dateTime`. In SPARQL those are not equal — the
comparison is a type error and the row is dropped — so every date filter silently
matched nothing against data the same library had written. Measured against Fuseki:
zero rows for a triple that was present.

`toIRExpression` now carries the `Date` through instead of flattening it to its ISO
string, and the SPARQL layer types it from the compared property's declared
`sh:datatype`, the same rule the mutation side already applied: an `xsd:date`
property compares against `"2020-01-01"^^xsd:date`, not against a full timestamp
that could never equal it. Applies to `=`/`!=`/range comparisons and to
`oneOf`/`notOneOf`.
