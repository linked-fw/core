---
summary: >
  In a `where` callback a string property is typed `QueryPrimitive<string>`, which declares only
  `equals`/`oneOf`/`notOneOf`; at runtime the proxy carries every string expression method
  (`lcase`, `contains`, `isNotDefined`, `replace`, …). Callers type the proxy `any` or cast it.
packages: [core]
---

# 082 — Expression methods on a where proxy's primitives are not typed

Source: Create Now's term search (CN report 204), `src/services/ontologyTermSearch.ts`.

## Problem

`Shape.select(...).where((t) => t.label.lcase().contains(q))` compiles to the right SPARQL and
runs, but does not type-check: `QueryPrimitive<string>` (`queries/SelectQuery.ts`) has no
`lcase`, `contains`, `isNotDefined`, … . The methods exist (`expressions/ExpressionMethods.ts`
`StringExpressionMethods`, `BaseExpressionMethods`) and `ExpressionUpdateProxy` already types them
for updates. Core's own tests write `(p: any) => p.name.contains('in')`; CN's `InstanceProvider`
does the same, and its term search casts the proxy to a local `TextTerm` type.

## First open questions

- Type `ToQueryPrimitive<string>` as `QueryPrimitive<string> & StringExpressionMethods` (and the
  numeric, date and boolean twins), as `ToExpressionProxy` does for updates?
- Should `ExpressionInput` accept a `QueryPrimitive`, so `Expr.firstDefined(t.label, …)` types?
