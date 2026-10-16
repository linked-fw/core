---
"@_linked/core": minor
---

Shape sync skips unchanged shapes. Each synced NodeShape now stores `core:shapeHash`, a SHA-256 of the canonical data the sync writes for it (property shapes, `sh:in` lists, paths and generated single-owner shapes included). `syncShapes()` reads the stored hashes of all code shapes in one select and returns a delete→create thunk only for shapes whose hash is missing or differs, so syncing an unchanged app writes nothing and the plan length is the number of shapes actually written (plus pruned orphans). `syncShape()` does the same check inside its thunk. Shapes stored by earlier versions have no hash and are rewritten once. New option `force: true` (on `syncShapes` options and as a third `syncShape` argument) rewrites regardless — use it to repair a shape whose stored subtree was changed outside shape sync, which the hash does not detect.
