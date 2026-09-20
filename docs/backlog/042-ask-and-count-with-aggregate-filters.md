---
summary: An ASK whose where clause contains an aggregate (`.friends.size().gt(2)`) used to drop the filter and answer the unfiltered question. It now refuses loudly, like `countToAlgebra` — answering it properly needs a nested sub-SELECT carrying GROUP BY/HAVING, which `SparqlSubSelect` cannot express.
packages: [core]
---

# 042 — `ASK` and `COUNT` over an aggregate-filtered where clause

**Status:** the silent-wrong-answer half is fixed — `askToAlgebra` now refuses, matching
`countToAlgebra`. What remains open is *answering* these queries, which needs a sub-SELECT
that carries `GROUP BY`/`HAVING`.

## The problem

An aggregate comparison in a where clause — `.where(p => p.friends.size().gt(2))` — does not lower
to a `FILTER`. It lowers to `GROUP BY ?a0` plus `HAVING(COUNT(?a0_friends) > 2)` on the select plan,
because that is the only correct way to express "subjects with more than two friends" in SPARQL.

`askToAlgebra` builds its pattern by delegating to `selectToAlgebra` and keeping **only**
`plan.algebra`. The projection is discarded on purpose (an `ASK` has none), and the `GROUP BY` /
`HAVING` live on the plan next to the projection — so they were discarded with it, unnoticed.

### Reproduction

```ts
Person.select().where((p) => p.friends.size().gt(2)).exists()
```

emitted, before the fix:

```sparql
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
ASK WHERE {
  ?a0 rdf:type <…/Person> .
  OPTIONAL {
    ?a0 <…/hasFriend> ?a0_friends .
  }
}
```

The `HAVING` is simply gone. The traversal survives inside an `OPTIONAL`, so the query degenerates
to "does any Person exist" and answers `true` for a store where nobody has three friends.

## Why it matters

This is the failure mode that costs the most to find: not an error, but a **plausible wrong
answer**. A thrown error stops at the call site with a stack trace pointing at the query. A silently
dropped filter returns a boolean of the right type, for the wrong question, and travels on into
whatever branch it gates. Nothing downstream can detect it. An `exists()` used as a permission or
pre-condition check is exactly where that is most expensive.

## How `countToAlgebra` handles it

`countToAlgebra` has the same shape — delegate to `selectToAlgebra`, keep only `algebra` — and it
already guards:

```ts
if (inner.having) {
  throw new Error('Cannot count a query whose where clause contains an aggregate …');
}
```

with a comment recording why it is a refusal rather than a fix: counting a HAVING-filtered group set
needs

```sparql
SELECT (COUNT(DISTINCT ?a0) AS ?count) WHERE { SELECT ?a0 WHERE { … } GROUP BY ?a0 HAVING(…) }
```

and `SparqlSubSelect` carries no `groupBy`/`having` fields, so this layer cannot emit it.

`askToAlgebra` now does the same, for the same reason: the correct `ASK` is

```sparql
ASK { SELECT ?a0 WHERE { … } GROUP BY ?a0 HAVING(COUNT(?a0_friends) > 2) }
```

— the same nested sub-SELECT, equally inexpressible today.

## What is left open

Answering, rather than refusing, both cases. That is one piece of work, not two:

1. extend `SparqlSubSelect` with `groupBy`, `having` and projected aggregate bindings, and emit them
   in `algebraToString`;
2. have `askToAlgebra` / `countToAlgebra` wrap `inner` in such a sub-SELECT when `inner.having` is
   present, instead of throwing;
3. goldens for both, plus Fuseki coverage — the semantics of an aggregate inside a nested select are
   exactly where a golden-only test is not enough.

Related: **012** (aggregate group filtering) and **016** (aggregations) cover the select-side
aggregate surface, not this lowering gap.

## Workaround

Filter without an aggregate, or run the `SELECT` and inspect the rows — the select path applies
`GROUP BY`/`HAVING` correctly. Only the `ASK` and `COUNT` reductions cannot carry them.
