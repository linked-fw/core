---
summary: Add per-query variables (declare + bind, a `{$var}` marker and `vars` envelope parallel to today's `{$ctx}`) and conditional field inclusion (`@include`/`@skip`-style `$if`) to the core query DSL and DSL-JSON. Genuinely new capabilities, split out of the GraphQL-style selection proposal (idea 025) which defers them.
---

# Query variables and conditional field inclusion

## Context

Two GraphQL features surfaced in the GraphQL-style nested-selection proposal
([idea 025](../ideas/025-graphql-style-nested-selection.md)) are **new
capabilities, not re-spellings** of the existing DSL — so they were deliberately
held out of that proposal's v1 and tracked here as core-DSL work. They are
useful independently of the GraphQL surface; once they exist in the core DSL,
exposing them in idea 025's object form is a small additive follow-up.

### 1. Per-query variables

A query declares typed parameters once, then runs many times with different
bound values — the mechanism behind persisted/cached/parameterized queries.

GraphQL:
```graphql
query getFriends($name: String!, $max: Int) {
  Person(where: {name: {equals: $name}}) { knows(limit: $max) { name } }
}
```

What exists today in `@_linked/core` is **query context** (`setQueryContext` /
`getQueryContext`, the `{$ctx}` marker in DSL-JSON) — but context is *ambient*
(resolve-once values like the current user), not a per-invocation parameter you
bind differently each call. Idea 008 (shared variable bindings) is a different
concept again (reusing one SPARQL variable across paths for structural joins).
There is no per-query parameterization today.

Target shape (core DSL):
```typescript
const q = Person.select((p) => p.knows.name).where((p) => p.name.equals(Var('name')));
await q.bind({ name: 'Alice' });
await q.bind({ name: 'Bob' });
```

DSL-JSON: a `{$var}` marker parallel to `{$ctx}`, plus a top-level `vars`
envelope declaring name → `{type, default?}`. Resolution happens at the same
lowering stage `{$ctx}` resolves today; an unbound required var is an error
(mirror `UnresolvedContextError`). This is additive → wire bump `v: 1.1`.

### 2. Conditional field inclusion (`@include` / `@skip`)

Include or omit a field based on a boolean (usually a variable), so one stored
query serves several views without rebuilding the field list.

GraphQL: `birthDate @include(if: $withDetails)`.

For *live* TS this is just a conditional spread, so it only earns its keep for
**serialized/stored** queries (a CMS query-editor, persisted queries) — which is
why it pairs naturally with variables and lands here rather than in idea 025 v1.

DSL-JSON: a field-level `if` option whose value is a boolean expression or a
`{$var}` reference; the field is dropped from the projection when it resolves
falsy.

## Why deferred (the test that routed them here)

Idea 025's rule: a `$`-option is folded into the GraphQL surface for free only
when it is a second *spelling* of something the chainable DSL already does.
`$where`/`$orderBy`/`$limit`/`$offset`/`$one`/`$on`/`$as`/`$path`/`$minus`/`$count`
all pass (verified existing features). Variables and conditional inclusion
**fail** it — they add new runtime, new DSL-JSON, and new IRDesugar handling —
so they get their own justification (persisted queries) and their own cycle
here.

## Open questions

- Variable typing: infer from use site, or require an explicit declaration?
- Interaction with `{$ctx}` — share one resolution pass, or keep distinct
  marker namespaces (`$var` vs `$ctx`)?
- `bind()` ergonomics on the builder vs a separate compiled-query handle.
- Does conditional inclusion need `@skip` (inverse) as well, or is `$if` + `not`
  enough?
- Persisted-query story (hash + vars over HTTP) — in scope here or its own node?

## Related

- [idea 025 — GraphQL-style nested selection](../ideas/025-graphql-style-nested-selection.md) (defers these)
- [idea 008 — shared variable bindings](../ideas/008-shared-variable-bindings.md) (different concept: structural joins)
- [backlog 002 — DSL-JSON open items](./002-dsl-json-open-items.md)
