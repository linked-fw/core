---
'@_linked/core': patch
---

A mutation sent as DSL-JSON now keeps the concrete shape of its nested values, so it validates and writes the same as when it runs in-process.

**What was wrong.** A nested value whose shape differs from the property's declared value shape is sent with `__shape`. `fromJSON()` and `lowerMutationJSON()` read that shape to decode the value's fields, then dropped it, and the mutation was checked against the declared shape instead:

- a subclass value under a base-typed property was rejected because of its subclass-only fields (`Invalid property key: department. The shape Person does not have …`);
- any nested value under a property that declares no value shape, such as `PropertyShape.path`, was rejected with `the property declares no shape for its values`. A shape sync that reaches its dataset over the mutation wire could not write an inverse, alternative or `*`/`+`/`?` path.

**What works now.** The decoded value carries its shape as the reserved `shape` key, and both decode paths validate and lower it against that shape:

```ts
Person.create({friends: [{shape: Employee, name: 'Eve', department: 'Research'}]});
```

That form now also works in-process: the `shape` key of a nested value may name a subclass of the property's declared shape, where before it had to be the declared shape itself. A `shape` that is not the declared shape or a subclass of it is still rejected. A `__shape` naming a shape the receiver has not registered now fails in `fromJSON()` too, as it already did in `lowerMutationJSON()`, instead of quietly validating against the declared shape.
