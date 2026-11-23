---
summary: >
  In the object form of select, a custom key on a deeper path, a sub-select or preloadFor, the
  subject as a field, and a nested plain object give rows whose shape differs from their type
  (key moved or dropped at runtime, malformed type, or a runtime error). Needs one decision:
  change the rows or the types.
packages: [core]
---

# 110 — Object form of select: row shape vs. type

Source: report 120 (relation field type in the object form), found while checking what the rows
hold for each case. The leaf values are typed right since report 120; the structure around them
is not. Each case below was run through `selectToSparql` + `mapSparqlSelectResult` on a small
dataset (p1 → bestFriend p2 → bestFriend p3).

## Problem

| Select | Runtime row (p1) | Type |
|---|---|---|
| `({bb: p.bestFriend.bestFriend})` | `{id, bestFriend: {id: p2, bb: {id: p3}}}` | `{id, bb: {id, bestFriend: {id}}}` |
| `({n: p.bestFriend.name})` | `{id, bestFriend: {id, n}}` | `{id, n: {id, name}}` |
| `({x: p.friends.select((f) => ({bf: f.bestFriend}))})` | `{id, friends: [{id, bf}]}` (key `x` dropped) | `{id, x: {id, friends: [{id, bf}]}}` |
| `({bf: p.bestFriend.preloadFor(c)})` | `{id, bestFriend: {id, name}}` (key dropped) | `{id, bf: {id}}` |
| `({person: p})` (subject as a field) | `{id, person: {id}}` | `person: QResult<Shape, {'': {id: string}}>` |
| `({info: {friend: p.bestFriend}})` | throws `Unknown trace result type` | compiles |

Also: the fields a `preloadFor` component selects are in the row but not in its type, in both
forms (`p.bestFriend.preloadFor(c)` types as `{bestFriend: {id}}`).

`src/tests/type-probe-deep-nesting.ts` TEST 2/19 type `{friendNames: {friends: [...]}}` and TEST
3/20 type `{friendDetails: [{name}]}` for the same construct; neither is what the rows hold.

The grouped select states the subject key as `{id: string}` itself (`GroupKeyValue` in
`GroupedSelectBuilder.ts`) to work around the subject case.

## First open questions

- Which side moves: should a custom key always name a top-level field of the row (change
  `resultMapping` / the field-set key handling), or should the types follow today's rows? The
  first is what users expect from `{key: …}` and is what the grouped select already assumes for
  its keys.
- Subject as a field: the root `QueryShape<S, null, ''>` reaches `CreateQResult` with
  `Source = null`, which matches `QueryShape<…>` without strict null checks (see backlog 028).
- A nested plain object: refuse it in the `QueryBuildFn` type, or support it at runtime.
