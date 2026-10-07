# Live queries

A live query keeps its result current. You subscribe to a query once; whenever
something changes that the query *can* have read, it fetches again and tells
its listeners. The store that does this is framework-free and lives in core, so
it works in a React component, a Vue store, a Node worker or a test alike.

```ts
import {Team} from './shapes';

const live = Team.select((t) => [t.name, t.members.size()]).for({id: teamId}).live();

const first = await live;                       // first successful data; the handle stays live
live.subscribe((state) => render(state.data));  // every later result; returns the unsubscribe fn
live.close();                                   // release when done

// Shorthand: listener as the argument
Team.select((t) => t.members.name).for({id: teamId}).live((s) => render(s.data));
```

`.live()` exists on select, count and ask builders:

```ts
Team.select().toCount().live((s) => setTotal(s.data));         // number
AskBuilder.forNode(id).live((s) => setExists(s.data));         // boolean
```

Importing `@_linked/core` (the package root) registers the store. A bundle that
imports core only through deep paths (`@_linked/core/shapes/Shape`, …) and
never touches the root must import `@_linked/core/live` once, or `.live()`
throws an error saying so. The builders never import the store themselves, so a
client that only builds and forwards DSL-JSON stays free of the store and of the
IR lowering it needs.

## The handle

| Member | Meaning |
|---|---|
| `state` | `{status, data?, error?, notFound, refreshing}` — replaced, never mutated, on every change |
| `subscribe(cb)` | Add a listener; returns the unsubscribe function (the Svelte store contract) |
| `await live` | Resolves with the first successful `data`, rejects on the first error |
| `refresh()` | Fetch now, keeping the current data until the response lands |
| `patch(partialOrFn)` | Local edit of the cached data, no request; the next refetch overwrites it |
| `close()` | Detach this handle's listeners and release the instance |
| `key` | Identity of the underlying instance |

`status` is `pending` (nothing requested: no storage configured, or the subject
is a query context that is not set yet), `loading` (first request in flight),
`success` or `error`. On error the previous `data` is kept. `refreshing` is
true while a request is in flight and data is present. `notFound` is true when
a single-subject select answered `null`.

Do not `return` a handle from an `async` function: it is `PromiseLike`, so the
promise machinery would unwrap it.

## Templates and instances

Two queries that differ only in subject, subjects, `one`, `limit` or `offset`
share a **template**; each binding of those params is an **instance**. Identical
instances share one fetch. The template owns the *watch set* — which predicates
the query reads and which shapes it touches, computed once from the IR by
`queryDependencies(query)`:

- `narrow` — predicates read on nodes whose ids appear in the result (the root
  row and projected relation rows);
- `filter` — predicates that decide membership or order: `where`, scoped
  relation `where`, `minus`, `sortBy`, inner `orderBy`;
- `hidden` — predicates read on nodes whose ids are *not* in the result:
  `size()`, computed values over a traversal;
- `shapes` — the root scan, traversed value shapes, casts, declaring shapes.

`getLiveQueryStore().templates()` lists every registered template (its canonical
JSON and optional name) and `prepare()` computes every watch set eagerly — the
list of queries an application can fire, for a database to tune for.

Options on `.live(opts)` / `.live(cb, opts)`: `name` (registry metadata),
`reactive: false` (opt out of automatic refetching), `pinned` (keep the template
registered while it has no instances; component definitions use this).

## What triggers a refetch

Every change, from any source, is normalised to the same plain-data descriptor,
`MutationEffects` from `mutationEffects(mutation, result)`:

```ts
{op: 'create'|'update'|'upsert'|'delete', shape, props: Set<predicate>, ids?: Set<id>, membership: Set<shape>}
```

The matcher then selects instances:

1. **By id** — a change with known ids reaches the instances that mention those
   ids and read a written predicate on a projected node.
2. **Template-wide** — a written predicate that a template filters or sorts on,
   or reads on hidden nodes, reaches every instance of that template: membership
   or order may have changed for nodes no result mentions.
3. **Unknown ids** (`forAll`, `where`, `deleteAll`) — every instance of every
   template reading a written predicate.
4. **Membership** — a create or upsert reaches the unbound instances of templates
   touching that shape (or a related one in the class hierarchy); a delete
   reaches every instance mentioning a deleted id and every instance of
   templates touching the shape.

Rules 1–3 are scoped by shape: a predicate written on a `Team` node cannot change
a `Person`'s value of the same predicate, so templates with no shape overlap are
skipped. Where the store cannot tell, it refetches: an extra request costs little,
a stale screen costs trust.

Worked examples live in `src/tests/live-matching.test.ts`.

## Change sources

| Source | How |
|---|---|
| Local mutations | Automatic. Every `await Shape.update/create/delete(...)`, including `exec(target)`, is observed through `subscribeQueryDispatch`; the store publishes its effects once the mutation resolves. A rejected mutation publishes nothing. |
| A dataset's change feed | A dataset implements the optional `IDataset.subscribeChanges(listener)` and reports changes made elsewhere as `ChangeEvent`s. The store subscribes to every dataset `LinkedStorage` knows, now and later (`LinkedStorage.onRoutingChanged`). |
| Application code | `publishChange(event)` for transports you own (your own websocket, a server push). |
| Manual | `invalidate(Shape)`, `invalidate(shapeIri)`, `invalidate({id})`, `invalidate(query)` and `live.refresh()`. |

A `ChangeEvent` is either the mutation's DSL-JSON plus its result — what a server
already has after executing it — or precomputed effects:

```ts
{mutation: Team.update({...}).for(id).toJSON(), result}   // the receiver computes the effects
{effects: {op, shape, props, ids, membership}}            // sets may arrive as arrays
```

A local change and its remote echo usually carry identical effects; the store
folds identical events within `options.echoMs` (50 ms) into one refetch, and an
invalidation that lands while a fetch is in flight yields one follow-up fetch.
A dataset may declare `authoritativeChanges: true`: local mutations routed to it
then trigger nothing by themselves and the store waits for the dataset's own
change event, the server's confirmation.

## Query context

An instance bound to `getQueryContext('user')` stays `pending` until that
context is set. When it is set, changed or cleared, the store re-keys the
instance to the new subject, fetches, and notifies the same listeners; nothing
upstream has to rerender.

## Related

- `subscribeQueryDispatch(listener)` — the observation point every source builds on.
- `queryDependencies(query)` / `mutationEffects(mutation, result?)` — the two helpers; usable on their own.
- `docs/architecture/runtime-instances.md` — why the store, like the dispatch, is registered on `globalThis`.
