---
'@_linked/core': patch
---

The published `.d.ts` now type-checks in a `strict` consumer. `SelectQuery.d.ts` passed `null` as a type argument to parameters constrained to `string | number | symbol`, `Shape` and `QueryPrimitive`, which is only legal without `strictNullChecks`. TypeScript 6+ makes `strict` the default, so every consumer without `skipLibCheck` failed with eight TS2344 errors inside core. The `null` sentinels in key positions are now `never` (identical in non-strict mode: a mapped type over either is `{}`), `QueryResponseToResultType`'s unused shape parameter defaults to `Shape`, and `QueryPrimitiveSet` admits `null` in its constraint. Adds `npm run check:dts`, which checks the built declarations under `strict` with `skipLibCheck: false`.
