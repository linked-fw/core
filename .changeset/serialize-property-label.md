---
'@_linked/core': patch
---

`syncShapes` now writes each property shape's label as `rdfs:label`.

`buildPropertyShapeData` used `ps.label` only to mint the property-shape IRI and
never serialized it, so on read-back a label had to be re-derived from the path's
local part. That is correct only while the two coincide. When they differ —
`@_linked/org` declares the label `memberships` on the path `org:hasMembership` —
the catalog reports `hasMembership`, `InstanceProvider` builds its columns from
those store labels and indexes the query proxy with them, and the proxy resolves
labels against the *class*, which only knows `memberships`. The guard in
`SelectQuery` then throws `Person.hasMembership is accessed in a query, but it
does not have a @linkedProperty decorator`.

Additive and backward compatible. `rdfs:label` is already a framework property
shape on `Shape`, and both catalog readers already prefer a stored label and fall
back to the path — so catalogs written before this change keep working, and
catalogs written after simply stop needing the fallback. No type change:
`label` is already required on `PropertyShapeData`, and `PropertyShapeWire` is
defined by subtraction from it.

Existing stores pick this up on the next sync, since `buildSyncThunk`
deletes and recreates each shape.
