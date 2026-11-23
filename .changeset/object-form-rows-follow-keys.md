---
"@_linked/core": minor
---

**The object form of select returns rows that follow the keys you write, and its types match them.** A key names a top-level field of the object it is written in (the row, or a sub-select's member row) and holds the value its expression yields; the hops of a deeper path no longer appear in the row. Through single-valued hops a key holds the value (or `null`); through any multi-valued hop, the array of distinct values (`[]` when none). A sub-select or `preloadFor` under a key holds the member row(s) `{id, …fields}`, and a `size()` or expression inside a sub-select is computed per member.

Rows that moved (dataset: p1 → best friend p2 → best friend p3; p1's friends p2 and p3):

| Select | Before (p1's row) | Now |
|---|---|---|
| `({n: p.bestFriend.name})` | `{id, bestFriend: {id, n}}` | `{id, n: 'Moa'}` (`null` without a best friend) |
| `({bb: p.bestFriend.bestFriend})` | `{id, bestFriend: {id, bb: {id}}}` | `{id, bb: {id}}` |
| `({names: p.friends.name})` | `{id, friends: [{id, names}, …]}` | `{id, names: ['Jinx', 'Moa']}` |
| `({fbf: p.friends.bestFriend.name})` | `{id, friends: [{id, bestFriend: {id, fbf}}, …]}` | `{id, fbf: ['Jinx']}` |
| `({fb: p.friends.bestFriend})` | `{id, friends: [{id, fb}, …]}` | `{id, fb: [{id}]}` |
| `({w: p.friends.where(…)})` | `{id, friends: [{id}]}` | `{id, w: [{id}]}` |
| `({w: p.friends.where(…).name})` | `{id, friends: [{id, w}]}` | `{id, w: ['Moa']}` |
| `({x: p.friends.select((f) => ({…}))})` | `{id, friends: [{id, …}]}` (key dropped) | `{id, x: [{id, …}]}` |
| `({x: p.bestFriend.select((b) => ({…}))})` | `{id, bestFriend: {id, …}}` (key dropped) | `{id, x: {id, …}}` (or `null`) |
| `({pre: p.bestFriend.preloadFor(c)})` | `{id, bestFriend: {id, …c}}` (key dropped) | `{id, pre: {id, …c}}` (or `null`) |
| `p.friends.select((f) => ({n: f.bestFriend.name}))` | `{id, friends: [{id, bestFriend: {id, n}}]}` | `{id, friends: [{id, n}]}` |
| `p.friends.select((f) => ({c: f.friends.size()}))` (a lone count in a sub-select) | `{id, c}` on the row, counting every friend's friends | `{id, friends: [{id, c}, …]}`, one count per friend |
| `p.friends.select((f) => [f.name, f.bestFriend.friends.size()])` (a count through a hop or a filter beside a field) | count missing from the friends' rows | `{id, friends: [{id, name, friends: 0}, …]}` |
| `({x: p.friends.select((f) => ({e: f.name.equals('Moa')}))})` (an expression in a keyed sub-select) | `{id, e}` on the row (key dropped) | `{id, x: [{id, e}, …]}` |
| `.select((p) => ({n: p.hobby})).preload('bestFriend', c)` (a key beside a preload) | key `n` dropped (`hobby`) | `{id, n, bestFriend: {id, …c}}` |
| DSL-JSON `{ "bestFriend.name": { "as": "n" } }` | `as` ignored: `{id, bestFriend: {id, name}}` | `{id, n}` (`as` names the key, like `customKey`) |

Also fixed: a `size()` beside a field reading the same relation counted 1 per value (`{fn: p.friends.name, c: p.friends.size()}`, `{c: p.friends.size(), fb: p.friends.bestFriend.name}`, the same inside a sub-select): it now counts every member (its own traversal, so the sibling's GROUP BY keys do not split it).

**The array form changed too, where it was wrong:** a `size()` or expression inside an array-form sub-select is computed per member and sits in the member's row (`p.friends.select((f) => f.friends.size())`: `{id, friends: n}` on the root row counting every friend's friends → `{id, friends: [{id, friends: n}, …]}`; `p.friends.select((f) => [f.name, f.bestFriend.friends.size()])`: the count was missing → in each friend's row; the same for a computed field of a sub-select). Its SPARQL groups by the member as well (one more `GROUP BY` variable). Other array-form selects are unchanged (`p.bestFriend.name` → `{bestFriend: {id, name}}`).

Unchanged: keys on the row's own properties (`{n: p.name}`, `{fs: p.friends}`, `{c: p.friends.size()}`), the subject as a field (`{person: p}` → `{id}`, now also typed so), and grouped selects.

Now answered instead of refused: two reads of one relation under two keys, e.g. `({all: p.friends.name, moa: p.friends.where((f) => f.name.equals('Moa')).hobby})` and `({a: p.friends.where(A), b: p.friends.where(B)})`.

Refused when the select is built, naming the key: a nested plain object or an array as a value (`{info: {friend: p.bestFriend}}`, which threw `Unknown trace result type`), `null` as a value (which threw the same), and the key `id` (which overwrote the row's id). Their result type is a `SelectError` (new exported type) whose `__error` says why, so reading such a row does not compile; the select call itself still compiles, as before (callbacks returning `unknown`, `object`, an interface, or generic wrappers are unaffected). Also refused: a DSL-JSON field with two different names (`as` and `customKey`), and a relation selected under a key and also, apart from it, by a `.preload()` or an unkeyed sub-select of it (`({x: p.friends.select(…)})` with `.preload('friends', c)` put the component's fields into the keyed rows).

Types: a key's type is the value above (`n: string`, `names: string[]`, `x: {id, …}[]`); the subject as a field is `{id: string}`; `preloadFor` carries the component's fields, in both forms (`p.bestFriend.preloadFor(c)` → `bestFriend: {id, name}`).

Live queries: a key, keyed sub-select or preload read through a hop now refetches when the node it was read on changes (`{n: p.bestFriend.name}` on renaming the best friend; `{x: p.bestFriend.friends.select(…)}` on adding a friend to the best friend).

**Migration:** code that read the old nested shape (`row.bestFriend.n`, `row.friends[i].names`, `row.bestFriend` for a keyed sub-select or preload) reads the key directly: `row.n`, `row.names`, `row.x`. Typed code already did; it compiles against values that now arrive. Code that read a `size()` or computed field of an array-form sub-select on the root row reads it in each member's row. To keep the nested shape, select it without a key (array form) or with a sub-select under the relation's own name: `({bestFriend: p.bestFriend.select((b) => ({n: b.name}))})`. See `README.md` ("Custom keys (object form)") and `documentation/intermediate-representation.md` ("Object form: where a key sits").
