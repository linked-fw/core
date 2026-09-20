---
"@_linked/core": patch
---

Emit SPARQL aggregate function names in uppercase (`COUNT(DISTINCT ?a0)` instead of `count(DISTINCT ?a0)`), matching every other keyword the emitter produces. The upper-casing happens in `algebraToString`, so it covers `SUM`/`AVG`/`MIN`/`MAX` and any future aggregate, while the IR keeps carrying the plain lowercase name. SPARQL is case-insensitive for function names so query behaviour is unchanged, but the emitted query **text** changes — anything asserting on the exact string of a generated aggregate query needs updating.
