---
"@_linked/core": patch
---

`limit` and `offset` on a select page over the root subjects instead of SPARQL solution rows: a page holds `limit` instances, each with all its values, and an instance is never split across two pages. An `orderBy` on a multi-valued path sorts an instance by its lowest value ascending and its highest descending, ties broken by IRI. `.one()` reads the first instance with all its values. Grouped selects still count groups.
