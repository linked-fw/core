---
summary: Explore disallowing live Shape instantiation (`new SomeShape()`) outside the query machinery, so the "live shapes never cross a serialization boundary" invariant is enforced by core rather than by convention.
---

# 033 — Disallow live Shape instances outside queries

## Motivation

Live Shape instances are the source of a recurring class of bug: when one crosses a
JSON boundary (JWT, SSR hydration payload, RPC result) it is serialized by `JSONWriter`
to a bare `{__s: nodeShapeURI, u: instanceURI}` reference — no field data, and a shape
the client must re-materialize (and which broke entirely when its URI was mangled, see
[[032-stable-shape-uris]]).

Concrete instance: `@_linked/auth`'s dev-signin built the session user via
`new (this.userShape)({ id })` — a live Shape. It reached the client as `{__s,u}` with
no usable `.id`, crashing `setQueryContext` and blanking the onboarding workspace name.
The fix was to pass **plain data** (`{ id }`, a QResult) instead. The `agents.md` rule
"never construct live Shape instances — use `Shape.select`/`.create`/`.update` or plain
data" captures this by convention; this backlog is about **enforcing it in core**.

## Current state (NOT already done)

Shapes can still be instantiated with `new`, and core itself does so internally:

- `Shape.mapPropertyShapes` — `new this()` to build a dummy shape, then wraps it in a
  `Proxy` for property-shape introspection (`packages/core/src/shapes/Shape.ts:220`).
- `setQueryContext` — `new (shapeType)()` to materialize a shape from a `{id}` result,
  then wraps it in a `QueryShape` (`packages/core/src/queries/QueryContext.ts:136`).
- The query builders lean on `QueryShape` / `QueryShapeSet` **proxies** heavily
  (`packages/core/src/queries/SelectQuery.ts`), but those proxies still wrap real
  instances in places.

So the runtime model is "instances exist, but queries mostly interact through proxies
over decorator-created shape objects." The invariant "no live instances outside queries"
is **not** enforced today.

## Proposed direction

Two levels, smallest-first:

1. **Guardrail (throw on external `new`).** Give `Shape`'s constructor an internal-only
   construction path — e.g. a module-private `Symbol` (or a `Shape.__internalCreate()`
   factory) that the query machinery passes. A public `new SomeShape()` without it
   throws with a clear message pointing at `select`/`create`/`update` / plain data. The
   internal call sites above (mapPropertyShapes, setQueryContext, QueryShape.create) opt
   in via the private path. This catches mistakes like `new userShape({id})` at the
   source, at zero cost to correct code.

2. **Proxy-only (deeper).** Eliminate real instances from the query path entirely so
   queries operate purely on proxies backed by the decorator-created shape objects —
   no `new this()` dummies. Larger refactor; do only if #1 shows the internal instance
   uses can be expressed as proxies cleanly.

## Tradeoffs / open questions

- **Escape hatches.** Some legitimate code may want a detached shape (tests, tooling).
  The factory/symbol path can be exported for those, or a dev-only bypass provided.
- **Error ergonomics.** The throw must name the shape and suggest the fix, or it'll be a
  footgun during migration (many call sites may currently `new` shapes).
- **Sequencing.** Pairs naturally with [[032-stable-shape-uris]]: fewer live instances →
  fewer serialization round-trips → less that must be URI-stable.
- **Diagnostic to find current leaks.** Before enforcing, run a sweep: temporarily
  replace `JSONWriter` boundary calls with plain `JSON.stringify` and catch the
  circular-structure throw that a live Shape produces — every throw is a call site
  still shipping a live instance across a boundary (the other signin paths in
  `@_linked/auth` `backend.ts` are prime suspects). Fix those to plain data first.

## Origin

Surfaced while debugging onboarding in a consumer app: `new (this.userShape)({ id })` in
dev-signin serialized to `{__s,u}` and broke client auth state. Fixed at the source with
plain data; this backlog captures making that a core-enforced invariant.
