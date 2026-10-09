---
"@_linked/core": patch
---

The `build` script is now `linked build`, the same build CI and the release workflow already run, so a local build produces the published `lib/`. `@_linked/cli` is added as a dev dependency to provide it, and the `rimraf` dev dependency is removed.
