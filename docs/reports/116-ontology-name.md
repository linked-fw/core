---
date: 2026-11-10
summary: >
  linkedOntology's third argument is the ontology's name within its package, not a prefix;
  OntologyRegistration.prefix became .name and the registry is keyed by package + name. The
  Prefix.add and `_prefix` side effects stay for now (backlog 117).
packages: [core]
---

# 116 — `linkedOntology` takes a name

## PR

**What changed.** An ontology is addressed by its package's npm name and its name within the
package. `linkedOntology(terms, ns, name, loadData?, dataFiles?)` names its third parameter
`name` (unique in the package, `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`, need not equal the module's file
name); `OntologyRegistration.prefix` is now `name`; the registry key, the package-tree key and
every message of `registryData` use the name. `registrationsByPackage` skips an entry an older
copy of core wrote (a `prefix` and no `name`) with one warning, as it already did for an entry
without a package name. JSDoc and the README (new §Registering an ontology) no longer say the
argument must match the file name, and say the suggested prefix is data
(`vann:preferredNamespacePrefix`). `linkedOntology` still calls `Prefix.add(name, ns(''))` and
sets `_prefix`: several packages get their only prefix registration from it.

**Verification.**

- `npx linked build`: `✔ Build successful`.
- `npm test`: `Test Suites: 19 skipped, 159 passed, 159 of 178 total`, `Tests: 623 skipped, 2883
  passed, 3506 total`, then `tsc -p tsconfig-tests.json` clean.
- `git grep -n "prefixAndFileName\|suggestedPrefixAndFileName\|registration.prefix" src`: no
  output (exit 1).

**Deviations.** None. `checkShapeHierarchy` reads `packageName`, `ns`, `load` and `terms` of a
registration, never its prefix, so it did not change.

**Follow-ups.**

- Remove `Prefix.add` and `_prefix` from `linkedOntology` once every ontology module adds its own
  prefix from its vann data: [backlog 117](../backlog/117-linked-ontology-registers-no-prefix.md).
- The README's "`ontologies/<prefix>.data` module" names generated module files, which
  `linked generate-ontology` (`@_linked/cli`) decides; it changes with the generator, not here.

## Details

- `src/utils/Package.ts`: `OntologyRegistration.name`; `linkedOntology` parameter `name`; the
  registry key `packageName\u0000name`; JSDoc of both declarations.
- `src/ontology/registryData.ts`: messages and `sources` labels use the name; the skip of an
  older entry covers a missing `name`, naming its `prefix` in the warning.
- Tests: `core-ontology`, `ontology-register-installed`, `ontology-registry` read `.name`; two new
  cases in `ontology-registry.test.ts` (one name in two packages; an older entry skipped with one
  warning).
- No reader outside core uses `OntologyRegistration` or `getRegisteredOntologies` (checked in
  every linked package source checked out alongside), hence a minor changeset.
