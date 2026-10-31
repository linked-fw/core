---
"@_linked/core": patch
---

The query-feature check before dispatch no longer throws when evaluating a select or where callback fails; the error surfaces when the dataset lowers or serializes the query, as it did before the check existed.
