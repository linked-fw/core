---
'@_linked/core': minor
---

Lists can page by subject. `.orderBy((p) => p)` (already emitted as `ORDER BY ?subject`) now
survives the DSL-JSON wire: the subject sorts as the empty path `{"": "ASC"}`, which `fromJSON`
used to reject. A node in a query gains `str()` (SPARQL `STR`), so a page continues after the last
IRI it returned: `.where((p) => p.str().gt(lastId)).orderBy((p) => p).limit(n)`. `str` joins the
reserved query names (a property labelled `str` is warned about at registration).
