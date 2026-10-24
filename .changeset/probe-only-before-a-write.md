---
'@_linked/core': patch
---

The ontology sync probes the store only before it writes its first package graph, so a sync with nothing to write sends no request beyond its reads (an unforked branch stays unforked). No probe answer keeps a copy of the class hierarchy in the default graph any more: on every store with graph queries the sync writes package graphs only and removes what an earlier sync kept in the default graph. A store that infers only from the default graph, or not at all, gets one warning that class-scoped reads miss subclass instances.
