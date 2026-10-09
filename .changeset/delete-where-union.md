---
"@_linked/core": patch
---

A delete's WHERE no longer multiplies its parts. It chained the incoming references and every cascade block as OPTIONALs, so the solutions were the product of all of them; deleting one shape description during the shape sync gave ~27,000 solutions for ~130 triples and took over 30 seconds on Fuseki, which made an app's second boot (`syncShapesOnBoot`) take minutes. The WHERE is now the type guards joined with one UNION of the blocks, which deletes the same triples. A UNION chain is also serialized flat (`{a} UNION {b} UNION {c}`).
