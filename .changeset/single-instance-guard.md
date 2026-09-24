---
'@_linked/core': patch
---

The shape registry reports when more than one copy of it is loaded.

A duplicated framework module never announces itself. Its symptoms accuse correct
application code — `Invalid property key: projectSlug. The shape Project does not have
a registered property with this name`, for a property declared correctly two files away,
or a pinned shape resolving to the default dataset. Finding the real cause took a day.

Loading a second copy now logs once, naming what is actually wrong: that the app is
reaching this package by two paths, one resolving to its source and one to its build
output. It reports rather than throws — a throw at import time breaks tooling that
legitimately loads a module twice, and the shared registry makes a second copy
survivable.

`getShapeRegistryInstanceCount()` now counts **distinct copies** rather than
evaluations. The previous count was incremented by Vite's HMR on every hot
re-evaluation in the same process, so it would have reported phantom duplicates after a
few edits.
