---
summary: >
  `isNodeShapeWire` decides "already in wire form" with `.every()` over `propertyShapes`, which is
  vacuously true for an empty or missing array. A shape that has LOST its property shapes is
  therefore indistinguishable from one that legitimately has none, and silently skips conversion.
packages: [core]
---

# 044 — `isNodeShapeWire` is vacuously true for an empty shape

**Status:** open, latent. No known bug traced to it — recorded because it was inspected closely
while investigating a shape arriving with no `propertyShapes`, and it is the kind of check that
will eventually hide one.

## The check

`packages/core/src/shapes/nodeShapeWire.ts:51-59`:

```ts
export function isNodeShapeWire(
  shape: NodeShapeData | NodeShapeWire,
): shape is NodeShapeWire {
  return (shape.propertyShapes ?? []).every(
    (prop) =>
      !(prop as PropertyShapeData).parentNodeShape &&
      !((prop as PropertyShapeData).pattern instanceof RegExp),
  );
}
```

It answers "is this already wire form?" by checking that no property shape carries the two things
wire form drops — the parent back-reference and a live `RegExp` pattern.

**With no property shapes, there is nothing to check, so `.every()` returns `true`.** An empty or
absent `propertyShapes` reads as *already in wire form*.

## Why that is not obviously fine

The function's own comment says so and calls it harmless:

> a shape with no patterns and no parent links satisfies both types, which is harmless because the
> conversions are then identities

That reasoning holds for a shape that **legitimately** has no property shapes — converting it is
indeed a no-op, so it does not matter which branch is taken.

It does not hold for a shape that has **lost** them. The two cases are byte-identical to this
predicate, and the consequence differs: a legitimately-empty shape converts to itself, while a
damaged one skips conversion and travels on as though it were already correct. The check cannot
tell you which you have, so a defect upstream of it arrives downstream wearing a valid-looking type
guard.

`propertyShapes` is also the **one hand-maintained field** in a type whose entire premise is that
nothing is hand-maintained. `NodeShapeWire` is defined by subtraction —
`Omit<NodeShapeData, 'propertyShapes'> & {propertyShapes: PropertyShapeWire[]}` — precisely because
that field's element type changes. The file's header explains why subtraction was chosen:

> Every field added to `PropertyShapeData` is therefore carried automatically — the single biggest
> maintenance failure of the `ShapeDetails` type this replaces was that it enumerated a subset by
> hand and silently fell behind.

So the one field the design could not automate is also the one this predicate is blind to.

## Options

Not urgent, and worth choosing deliberately rather than tightening reflexively:

1. **Leave it, document the limit.** Cheapest, and arguably correct: an empty shape genuinely is
   convertible either way. The risk is only that a *damaged* shape passes silently.
2. **Distinguish absent from empty.** `propertyShapes === undefined` is a different statement from
   `[]` — the first says "nobody set this", the second "there are none". Treating absent as *not*
   wire would make a lost field fail loudly at the conversion boundary instead of passing through.
3. **Make it structural rather than inferential.** A `__wire: true` marker, or a version field,
   removes the guessing entirely. Heavier, and it changes the wire format.

Option 2 is the smallest change with real value, but it needs a check that nothing legitimately
constructs a `NodeShapeData` without the field — plenty of code spreads partial shapes, and
`toWire` itself already tolerates `?? []`.

## Origin

Surfaced while diagnosing a `Project` NodeShape reaching validation with no `propertyShapes` while
the registry's class-backed shape had 27. **That turned out to be something else entirely** — a
Playwright transform not supporting `experimentalDecorators`, so `@literalProperty` registered
nothing in the test process (see CN `docs/reports/043`). This predicate was not the cause; it was
inspected as a suspect and found to be independently fragile.
