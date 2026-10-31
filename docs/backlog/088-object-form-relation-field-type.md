---
summary: >
  The object form of select types a single-valued relation field as the shape
  (`select((p) => ({friend: p.bestFriend}))` → `friend: Person`), while the row holds `{id}`.
  The array form types it `{id: string}` (report 094). Grouped rows already type a node key as
  `{id: string}` (report 096).
packages: [core]
---

# 088 — The type of a relation field in the object form of select

Source: report 096, found while typing grouped rows.

## Problem

```ts
const rows = await Person.select((p) => ({friend: p.bestFriend}));
type Friend = (typeof rows)[number]['friend']; // Person — the runtime value is {id: string}
```

`ObjectToPlainResult` maps each field through `QueryResponseToResultType<…, Shape, true>`, and
`HasName = true` with a `QueryShape` source yields the shape type instead of a node reference.
Code that reads `row.friend.name` compiles and gets `undefined`.

## First open questions

- Fix in `CreateQResult` for `HasName` (one branch), and check the report 094 typing tests and
  the probe files (`type-probe-*.ts`) for cases that rely on it.
- With a sub-select (`p.bestFriend.select(…)`) the field is an object of the selected fields:
  keep that.
