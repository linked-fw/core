---
"@_linked/core": patch
---

Fix `askToAlgebra` silently dropping a `HAVING`. An `ASK` whose where clause contained an aggregate — `.where(p => p.friends.size().gt(2)).exists()` — lowered to `GROUP BY` + `HAVING`, of which only the pattern was carried over, so the query answered the *unfiltered* question and returned `true` for any store holding one instance of the shape. It now throws, exactly as `countToAlgebra` already did for the same lowering: answering it needs a nested sub-SELECT carrying `GROUP BY`/`HAVING`, which the algebra cannot express yet (see `docs/backlog/042`).
