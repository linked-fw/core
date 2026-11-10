---
summary: >
  linkedOntology still registers its name as a prefix (Prefix.add) and sets `_prefix` on the
  exports. Remove both once every ontology module adds its own prefix, read from its vann data.
packages: [core]
---

# 117 — `linkedOntology` registers no prefix

Source: report 116. Since report 116 the third argument of `linkedOntology` is the ontology's
name within its package, not a prefix. It still calls `Prefix.add(name, ns(''))` and sets
`exports._prefix = name`, because several packages (fuseki, s3, server, server-utils,
translation) get their only prefix registration from it.

1. Every ontology's data carries `vann:preferredNamespacePrefix` and its generated data module
   calls `Prefix.add` with that prefix.
2. Then remove `Prefix.add` and `_prefix` from `linkedOntology`, and the tests that read
   `_prefix` (`@_linked/fuseki` `fuseki.register.test.ts`, `@_linked/server`
   `ontology-prefix.test.ts`). Check with `git grep "Prefix.add"` in every ontology package
   that each registered ontology adds its own prefix.

Since report 118, seven ontologies keep hand-written modules (`"generated": false` in
`linkedOntologies`: core, fuseki, s3, sentry, server, server-utils, translation). No generated data
module adds their prefix, so they still get it from `linkedOntology` (sentry, server-utils and core
also add it by hand). Their vann data carries the prefix; step 1 above does not cover them.
