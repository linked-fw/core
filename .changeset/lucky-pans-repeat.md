---
'@_linked/core': patch
---

A failed query now carries the error it wrapped as `cause`

`QueryBuilder._run` wraps a dataset's error in a new `Error` that names the query — useful for a
human reading a log, and unchanged. But it discarded the original, so everything that error knew (a
store's HTTP status, its endpoint, its own class) survived only as text inside a message string.

That made ordinary states indistinguishable from real faults. "This dataset does not exist" — a
404/405 on the endpoint itself, which is what you get when a name is derived from an id that has no
data yet — reads exactly like "this query is wrong", and the only way left to tell them apart was to
pattern-match the message. Create Now hit this in `getShapeCatalog`, where an unknown project id
produced a 500 where an empty catalog belonged.

The wrapper now sets `cause` to the original error, so callers can branch on structure:

```ts
for (let e: any = err; e; e = e.cause) {
  if (e.status === 404 || e.status === 405) return EMPTY;
}
throw err;
```

Message and stack are unchanged, so nothing that reads the text is affected. Written with
`Object.defineProperty` rather than `new Error(msg, {cause})` because this package targets es6,
where that overload is not in the typings; the resulting property (own, non-enumerable) is identical
to the native one.
