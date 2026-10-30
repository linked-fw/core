---
summary: >
  An `@objectProperty` declared with a `string` accessor (`get ofShape(): string`) is typed on a
  query path as a string literal with every string expression method, but at runtime it is a
  relation (`QueryShape`), which answers only `equals`, `oneOf`, `notOneOf`, `str`, `isDefined`
  and `isNotDefined`. `k.ofShape.strlen()` compiles and throws. Also: `ExpressionInput` does not
  accept a query path, so `Expr.firstDefined(t.label, …)` needs a cast.
packages: [core]
---

# 086 — The query type of an object property with a `string` accessor

Source: report 094 (select typing gaps), which typed the expression methods of literal paths.

## Problem

`ToQueryBuilderObject` picks the query type from the accessor's TypeScript return type, the
runtime (`QueryBuilderObject.generatePathValue`) from the property shape. They differ for an
`@objectProperty` whose accessor returns `string` (an IRI): the type is
`QueryPrimitive<string> & StringExpressionMethods`, the runtime a `QueryShape`. Comparisons by
`{id}` work on both; the string methods throw at runtime.

The second question of the former backlog 082 is still open: `ExpressionInput` takes
`ExpressionNode | string | number | boolean | Date`, not a query path, although the path proxy
converts a path argument (`p.a.gt(p.b)`) at runtime.

## First open questions

- Can the decorator carry the kind into the type (a branded return type, or a `NodeIri` alias
  for IRI accessors), so the path is typed as a relation?
- Add `QueryBuilderObject` to the argument type of the path expression methods only (not of
  `ExpressionNode` itself)?
