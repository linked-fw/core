---
"@_linked/core": minor
---

Add `sharedState(pkg, name, init)`, which keeps module state on `globalThis` under `Symbol.for('<pkg>:<name>')` so two copies of a module share it, and `brandLinkedError(Cls, pkg, name)` with `isLinkedError(err, Cls)`, which recognises an error thrown by another copy of its defining module, where `instanceof` does not.
