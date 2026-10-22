Installed-package fixtures for `ontology-register-installed.test.ts`: package roots laid out as the
cli's build lays them out (`lib/esm/ontologies/*.register.js`). Their `lib/` directories are
committed (see `.gitignore`). The modules import core's source by relative path, so the test and
the fixtures share one registry.

`source-only` is an unbuilt workspace package (`src/ontologies/*.register.ts`, no `lib/`), which
registers only through the `importModule` option.
