---
'@_linked/core': patch
---

`fromWire` no longer discards an already-compiled `sh:pattern`.

`propertyFromWire` destructured `pattern` out and restored it only when it was a
source string. Handed a shape that was already in metamodel form, it therefore
**dropped every RegExp pattern** — and a shape whose pattern constraint has
silently vanished validates values it should reject.

That mattered because nothing guarantees which form a shape is in.
`isNodeShapeWire` is a structural guess: the two types differ only by
`parentNodeShape` and by `pattern` being a RegExp rather than a string, so a
shape carrying neither satisfies both. A shape with no property shapes always
reads as wire, because `[].every()` is vacuously true.

The conversions are now idempotent in both directions — `fromWire(fromWire(x))`
equals `fromWire(x)`, and `toWire` already tolerated a pattern that was already a
string. Misclassifying a shape now costs nothing, which is what makes the guess
safe to keep.
