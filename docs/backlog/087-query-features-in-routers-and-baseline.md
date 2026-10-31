---
summary: >
  Query features (report 096) are checked where a select is handed to a dataset. Open: routers
  and forwarders outside core (`RemoteDataset` in @_linked/server) do not declare `supports`, so
  a grouped select through them is refused; and the baseline (an aggregate comparison in a where
  clause) is still sent to a store that may ignore it.
packages: [core, server]
---

# 087 — Query features in routers, and the baseline

Source: report 096 (grouped selects).

## Open items

- **`RemoteDataset` (@_linked/server)** declares no `supports`, so `exec(remote)` of a grouped
  select, or a `LinkedStorage` whose dataset is a `RemoteDataset` (a browser client), refuses it
  loudly. It forwards `toJSON()`, which carries `op: 'select'` and `requires`, so the server
  decides; it can declare `ALL_QUERY_FEATURES` once its server runs a core with report 096, or
  ask the server which features it supports.
- **The baseline is not tagged.** `.where((p) => p.friends.size().gt(2))` (HAVING per subject) and
  `.size()` need no feature, so a non-SPARQL store that ignores aggregates still answers them
  without the filter. Tagging them (`'having'`) would refuse them on every store written before
  features existed: a breaking change, for a minor or a major?
- **`orderBy` on a plain select with a computed expression** (`orderBy((p) => p.name.strlen())`)
  is ignored silently: `evaluateSortCallback` keeps property paths only. Aggregates now throw
  there; other expressions could too, or sort by the expression.
