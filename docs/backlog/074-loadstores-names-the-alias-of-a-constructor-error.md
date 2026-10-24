---
summary: >
  A store that checks its graph targets in its constructor (FusekiStore since fuseki 3.8) throws
  before `loadStores` can name the entry, so `Invalid ontologyGraph "x"` no longer says
  `datasets.<alias>.config.ontologyGraph`. Prefix constructor errors with the alias.
packages: [core]
---

# 074 — `loadStores` names the alias of a constructor error

`loadStores` checks an entry's `config.ontologyGraph` / `config.shapeGraph` in `applyGraphTargets`
and names the source (`(from datasets.main.config.ontologyGraph)`). That check runs after
`new StoreClass(entry.config)`. `FusekiStore` now passes both settings to `SparqlDataset`, whose
constructor checks them first, so a bad value fails inside the constructor with only
`Invalid ontologyGraph "x": expected …` — no alias, no path.

Fix: in `loadStores`, wrap the constructor call and rethrow with `loadStores: alias "<alias>"
(<store>): ` before the message (keep the cause). A store cannot do it itself: nothing runs before
`super()` that could catch.

Found by the review of fuseki report 004.
