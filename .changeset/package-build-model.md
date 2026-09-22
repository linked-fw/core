---
"@_linked/core": patch
---

Compile the whole `src` folder, and let a bare import resolve under Node10.

The build only emitted what an entry transitively reached, so any module
nothing imported was never built — and never type-checked, so it rotted
quietly. `include` now covers `src/**/*` with tests excluded explicitly.

`typesVersions` maps every specifier through `lib/esm/*`, so a `types` value
that already carried that prefix had it applied twice and no consumer on
classic Node10 resolution could `import` the package by its bare name.

