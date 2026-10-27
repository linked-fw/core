---
"@_linked/core": minor
---

`isRegisteredPackage(name)` and `getRegisteredPackageNames()` (`@_linked/core/utils/Package`) say
which packages `linkedPackage()` registered, so callers no longer read `globalThis._linked._packages`.
Fixes: the callbacks waiting on a shape (value-shape links, the deferred tighten-only comparison)
run for a shape with no decorated properties of its own; `.some()` / `.every()` / `.none()` and
property access on a plural relation to a data-only shape (or a `sh:class`-only relation) no longer
throw; `registerInstalledOntologies` hands `importModule` a `/`-separated path.
