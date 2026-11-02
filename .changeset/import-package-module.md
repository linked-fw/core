---
'@_linked/core': minor
---

Add `@_linked/core/utils/importPackageModule` (server only), the one way framework code loads a package module it discovered at runtime:

- `importPackageModule(target)` loads a package specifier through the module loader the host installed at `MODULE_LOADER_KEY` (`Symbol.for('@_linked/core:importModule')`, which `linked start` sets in dev), so a package Vite bundles is not loaded a second time by Node; without one it is Node's `import()`. An absolute file path (or `file:` URL) is always Node's `import()`, by its `file:` URL: the host loader is only handed specifiers.
- `installedModuleLoader()` returns that loader, or undefined.

```ts
import {importPackageModule} from '@_linked/core/utils/importPackageModule';

const mod = await importPackageModule('@_linked/fuseki/shapes/FusekiStore');
```

`loadStores` and `registerInstalledOntologies` read the host loader through it; their behaviour is unchanged (`registerInstalledOntologies` still imports register modules through the loader by specifier). See `docs/architecture/loading-package-modules.md`.
