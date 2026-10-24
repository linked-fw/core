---
'@_linked/core': patch
---

Fixes from the named-graphs review.

- The ontology sync probes the store once per dataset before it moves the class hierarchy out of
  the default graph: a probe `subClassOf` and a typed instance in a temporary registered graph,
  read back through the normal query path. A store that infers from the registered graphs gets the
  move; one that infers only from the default graph keeps the default-graph sync; one that does not
  infer gets the package graphs and keeps the default-graph hierarchy too. The last two warn once.
  `probeHierarchyInference` and `resetHierarchyInference` are in `@_linked/core/ontology/hierarchyProbe`.
  The README's "Store requirements" now says what core needs from a store.
- Graph queries carry their conditions inside the update. Of two concurrent `graph_create`s exactly
  one writes and the other gets `graph-exists`. A replace or patch that races a drop writes nothing
  instead of leaving a half record. A `graph_create` of a graph that holds triples without a record
  is refused (`graph-exists`) instead of replacing them.
- A record-only graph update (`OntologyGraph.update(g).set({…})`) reports `changed: true`.
- The graph registry cache lives on `globalThis`, so every copy of core in a process shares it.
- `fromJSON`, `DeleteBuilder.fromJSON` and `lowerMutationJSON` take `{refuseKeepIncoming: true}`
  so a receiver can refuse `keepIncoming` from callers it does not trust.
- An `'own'` graph route of a package slugged `import` is allowed. Only a graph named exactly like
  an imported graph is refused.
- Live queries fold a local change with one remote echo only. A `feed` and an `app` change, or a
  second remote change with the same effects, each refetch.
