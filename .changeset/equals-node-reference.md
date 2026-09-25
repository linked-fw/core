---
'@_linked/core': patch
---

`.equals({id})` on an object property declared as a string now type-checks

`@objectProperty({path: …}) get project(): string` is an accepted idiom — the accessor returns the
referenced node's IRI, so the natural declared type is `string`. `ToQueryBuilderObject` can only see
that declared type, so the property projects to a `QueryPrimitive<string>` rather than a
`QueryShape`. That projection is correct. What was wrong is that `QueryPrimitive.equals` accepted
only `JSPrimitive | QueryBuilderObject`, while the documented way to match an object property is by
node reference — `docs/backlog/014-prefixed-uris-in-json.md` lists `.where(…).equals(val)` as taking
`JSNonNullPrimitive | NodeReferenceValue`.

So the documented call was a type error at every call site. Create Now had 24 of them:

```
LinkedDocumentRepository.ts(268,100): error TS2353: Object literal may only specify known
properties, and 'id' does not exist in type 'Date | QueryBuilderObject<any, any, any>'.
```

(`Date` is in that message because the compiler lists only the object-typed members of
`JSPrimitive | QueryBuilderObject` when rejecting an object literal.)

This is a typing fix only — the lowering always handled the reference form. `toIRExpression` turns
`{id}` into a `reference_expr`, so the comparison renders as `FILTER(?x = <iri>)`, never a string
literal. The 24 call sites were compiling under `as any` casts or failing a typecheck gate; none of
them were producing wrong SPARQL.

`equals`, `oneOf` and `notOneOf` on `QueryPrimitive` now take a named `ComparisonValue =
JSPrimitive | QueryBuilderObject | NodeReferenceValue`. Nothing is widened to `any`:
`.equals({name: x})` and `.equals({id: 42})` are still rejected, asserted by `@ts-expect-error` in
`src/tests/object-property-reference.test.ts`.
