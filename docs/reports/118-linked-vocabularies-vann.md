---
date: 2026-11-10
summary: >
  The first-party linked vocabularies (core, auth, fuseki, npm, s3, sentry, server, server-utils,
  translation) carry their suggested prefix as vann data and declare their ontology in package.json
  linkedOntologies; the seven hand-written modules stay hand-written ("generated": false). Patch.
packages: [core, auth, fuseki, npm, s3, sentry, server, server-utils, translation]
---

# 118 — Linked vocabularies: vann data and one declaration

## PR

**What changed.** The suggested prefix of an ontology is data. Each first-party linked vocabulary's
`src/data/<name>.ttl` now states it on its `owl:Ontology` node, with the namespace:

```turtle
@prefix vann: <http://purl.org/vocab/vann/> .
core:
    … ;
    vann:preferredNamespacePrefix "core" ;
    vann:preferredNamespaceUri "https://linked.cm/ont/core/" .
```

The prefix written is the one each ontology registers today, so Turtle output does not change.
Every package declares its ontology in `package.json` `"linkedOntologies"`, keyed by its name:

- auth and npm already had their entry and generated modules; `linked generate-ontology --check`
  reads the new vann data and finds the modules current (no module changed).
- core, fuseki, s3, sentry, server, server-utils and translation keep their hand-written modules:
  they export more than the generator writes (`_self`, grouping objects such as `coreOntology`,
  `tr` and `server`, terms kept out of module scope so a bundler does not rename a shape class of
  the same name). Their entry says `"generated": false`, so the build checks their vann data and
  generates nothing; core's says `"module": "linked-core"` (its name is `core`). server and
  server-utils declare only the module that registers the ontology, not their `lincd-*` twins.

No public import path or export changed; the deprecated prefix labels (`linked_core`,
`lincd-fuseki`, `lincd-server`, `lincd-server-utils`) are untouched. A patch changeset per package.

**Verification** (each package in its own checkout, the cli from the same release line):

`linked generate-ontology --check`, exit 0 in all nine:

```
core: 41 terms from src/data/core.ttl (modules written by hand: vann data checked, nothing generated)
auth: 37 terms from src/data/auth.ttl
fuseki: 1 terms from src/data/fuseki.ttl (modules written by hand: vann data checked, nothing generated)
npm: 20 terms from src/data/npm.ttl
s3: 8 terms from src/data/s3.ttl (modules written by hand: vann data checked, nothing generated)
sentry: 2 terms from src/data/sentry.ttl (modules written by hand: vann data checked, nothing generated)
server: 11 terms from src/data/server.ttl (modules written by hand: vann data checked, nothing generated)
server-utils: 1 terms from src/data/server-utils.ttl (modules written by hand: vann data checked, nothing generated)
translation: 95 terms from src/data/translation.ttl (modules written by hand: vann data checked, nothing generated)
Every ontology module is current.   (each)
```

`linked build`: `✔ Build successful` in all nine (s3 and server-utils "with warnings", unchanged
dependency warnings). `npm test`:

| package | result |
|---|---|
| core | `Tests: 623 skipped, 2883 passed, 3506 total` |
| auth | `# pass 626 # fail 0` |
| fuseki | `Tests: 5 skipped, 21 passed, 26 total` |
| npm | `# pass 4 # fail 0` |
| s3 | `Tests: 66 passed, 66 total` |
| sentry | `# pass 10 # fail 0` |
| server | `Tests: 2 skipped, 543 passed, 545 total` |
| server-utils | `# pass 119 # fail 0` |
| translation | `Tests 386 passed (386)` |

**Deviations.** The hand-written modules were not converted to generated ones: each holds more
than the generator writes, so they are declared with `"generated": false` instead.

**Follow-ups.**

- `linkedOntology` still registers the name as a prefix; the seven hand-written ontologies rely on
  it. Recorded in [backlog 117](../backlog/117-linked-ontology-registers-no-prefix.md).

## Details

- Per repo: `src/data/<name>.ttl` (vann prefix declaration and two triples), `package.json`
  (`linkedOntologies`, except auth and npm which had it), `.changeset/ontology-vann-data.md`.
  Reports in the other repos point here: auth 025, fuseki 007, npm 002, s3 002, sentry 002,
  server 030, server-utils 008, translation 004.
- The vann namespace is written as a literal, the form the cli's message suggests.
