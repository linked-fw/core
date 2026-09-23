---
'@_linked/core': minor
---

A shape can name itself, and a renamed one says so.

A shape's IRI is `<baseUri>shape/<package>/<name>` and `Server.call` routes on
it, so the name is persisted data rather than a label. Taking it from
`constructor.name` couples that data to how the code was compiled — a minifier
renames the class, and so does an ordinary name collision, because a shape and
the ontology term it targets deliberately share a name.

`@linkedShape` now accepts an optional `name`:

```ts
@linkedShape({name: 'BackendAPIStore'})
export class BackendAPIStore extends Shape {}
```

Optional, defaulting to `constructor.name`, so no existing shape changes.

Two warnings now fire where the cost is cheap — at registration, rather than as
a `No provider for …` several layers later:

- a class name ending in a digit with no explicit name given, which is almost
  always a bundler disambiguating a collision;
- the existing shape-identity duplication guardrail, which **now also runs in
  production**. It was dev-only on the reasoning that production is minified and
  would false-fire; it does not — full minification produces `za`, which the
  check ignores. What it does catch is `BackendAPIStore2`, which only happens in
  a production build. The warning was suppressed in the one place the bug occurs.
