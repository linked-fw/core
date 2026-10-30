---
date: 2026-09-10
summary: >
  A shape property whose label collides with a `QueryShape` member — `equals`, `as`, `if`,
  `select`, `where`, `id`, `size`, `add`, `concat`, `oneOf`, `none`, `every`, `some` — is
  unreadable through the query DSL. The proxy returns the DSL method, and the field tracer
  fails with "Unknown trace result type: function". The meta-model's own `sh:equals`
  property hits this.
---

# 090 — property names that collide with the query DSL

Was backlog 041 (done; moved to reports on 2026-10-30).

> **Done.** Two changes. The meta-model's `sh:equals` accessor is now labelled
> `equalsConstraint` (matching the `PropertyShapeData` field; the predicate is unchanged),
> so the SHACL meta-shape can read its own constraint through the DSL again. And every
> registration path — `registerPropertyShape` for decorated and generated shapes,
> `registerRuntimeShape` for data-only ones — now checks the label against
> `RESERVED_QUERY_DSL_NAMES` (`queries/reservedQueryNames.ts`) and `console.warn`s once per
> shape+label, naming the shape, the property and why it will fail. A **warning, not a
> throw**: `size`, `id` and `some` are legitimate domain property names, the property still
> round-trips and is still reachable by path through DSL-JSON, and throwing at registration
> would break existing apps on upgrade over a property they may never select through the
> builder. (The DSL-JSON combinators `and`/`or`/`not` keep throwing — those have no escape
> hatch at all.) The reserved list is a literal rather than derived from the query classes,
> because the shape registry must not import the query builder; a test compares it against
> the live prototypes so it cannot drift. The description below is kept as the record of
> what was wrong.

## The behaviour

The query proxy resolves a key by checking the `QueryShape` instance first:

```ts
if (key in queryShape) {
  return queryShape[key];
}
// …only then look for a property shape with that label
```

So a property whose label matches a `QueryShape` member never reaches property resolution.
The caller gets the DSL method instead, and `FieldSet.convertTraceResult` throws:

```
Unknown trace result type: function () { [native code] }
```

Colliding names today: `equals`, `as`, `if`, `select`, `selectAll`, `where`, `id`, `size`,
`add`, `concat`, `create`, `every`, `some`, `none`, `oneOf`, `notOneOf`.

## Why it matters

`equals` is not hypothetical — **the SHACL meta-shape itself uses it.** `Package.ts`
registers the `sh:equals` constraint under the label `equals` (while
`PropertyShapeData` calls the field `equalsConstraint`), so
`PropertyShape.select(ps => [ps.equals])` cannot be written. Create Now's shape catalog
hit this the first time it was run against a real store, and had to drop the constraint
from its projection.

More generally: a person modelling a domain is free to name a property `size`, `id` or
`as`. Nothing warns them, and the failure surfaces as an internal tracer error naming a
native function.

## Two problems, one cause

1. **The meta-shape's own label is wrong.** `equals` should be `equalsConstraint`, matching
   the metamodel field. `syncShapes` is the only writer of that key, so the rename is
   contained. This alone makes `sh:equals` readable.
2. **The general collision remains.** Resolution order prefers the DSL surface over the
   user's data, silently. Options: look up property shapes FIRST and fall back to the
   `QueryShape` member; or keep the order and *throw a named error* when a shape declares a
   colliding label, at registration time rather than at query time — the model author can
   then rename it, which is a decision they should be allowed to make knowingly.

Registration-time detection is cheap: the labels are known when the shape is registered.

## Follow-up: the warning was too blunt

The first version warned identically for every reserved name. Measuring the two proxy
surfaces showed they are not the same problem:

- **On `QueryShape`** — `as`, `equals`, `id`, `limit`, `select`, `selectAll`, `oneOf`,
  `notOneOf`, `preloadFor`, the getters, plus the instance fields `subject`, `source`,
  `property`, `prop`, `proxy`, `queryShapes`, `originalValue`, `wherePath`. Always shadowed.
- **Only on `QueryShapeSet`** — `add`, `concat`, `every`, `none`, `size`, `some`, `where`,
  `buildPredicateExpression`, `callPropertyShapeAccessor`. `widget.size` reads the property
  perfectly well; it is `article.widgets.size` that returns the set's size.

`size`, `some`, `every` and `where` are among the most ordinary names a domain model has, so
warning about them as though they were always broken is how a warning gets ignored. The two
cases now get different messages, and `SET_CONTEXT_ONLY_NAMES` is pinned against the live
prototypes so a method moving between the surfaces cannot silently change which properties
are safe.

Both messages now name the way out, which already existed and was easy to miss:
`select(['size'])` takes the label as a string, never touches the proxy, and accepts
dot-paths. Verified working for a colliding name in both the array form and the
callback-returns-a-string form.
