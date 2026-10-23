---
summary: >
  On Jena (`linked-fuseki:071`, 6.2.0-2) `FROM NAMED <urn:x-arq:DefaultGraph>` matches nothing,
  while `GRAPH <urn:x-arq:DefaultGraph>` alone and `VALUES ?g { <urn:x-arq:DefaultGraph> … }`
  work. Report 049 therefore refuses `graphs.default` (and `graphs.union`) together with other
  graphs in `.from()`. Graph routing (K4) must add the default graph to a set some other way.
packages: [core]
---

# 066 — The default graph in a set of named graphs

Source: CN plan 071 decision 9 ("Limits, for phase 2") and §Contracts, Graph routing; core report
049.

## Problem

Decision 9's limits say data configured in the default graph is added to the `FROM NAMED` set
under the store's name for it (Jena: `urn:x-arq:DefaultGraph`). Measured on the step's own store
(default graph `<http://e/f>`, graphs `<http://e/g1>`, `<http://e/g2>`):

```
SELECT ?s ?g WHERE { GRAPH <urn:x-arq:DefaultGraph> { ?s ?p ?o } }                                   => [["http://e/f",null]]
SELECT ?s ?g FROM NAMED <urn:x-arq:DefaultGraph> FROM NAMED <http://e/g1> WHERE { GRAPH ?g { ?s ?p ?o } } => [["http://e/a","http://e/g1"]]
SELECT ?s ?g WHERE { VALUES ?g { <urn:x-arq:DefaultGraph> <http://e/g1> } GRAPH ?g { ?s ?p ?o } }     => [["http://e/f","urn:x-arq:DefaultGraph"],["http://e/a","http://e/g1"]]
SELECT ?s ?g FROM NAMED <urn:x-arq:UnionGraph> WHERE { GRAPH ?g { ?s ?p ?o } }                        => []
```

So the default graph drops out of a `FROM NAMED` set silently. Core refuses the combination
(`unsupported-query-kind`) rather than answer without it.

## Open questions

- K4: put the default graph's store name in a `VALUES ?g { … }` for the groups whose set includes
  it (VALUES works on Jena), or read it as a separate `UNION` branch without `GRAPH`?
- Does any other store (the owner's graph database) accept the default graph's name in
  `FROM NAMED`?
