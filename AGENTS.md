# AGENTS.md — @_linked/core repository

## Repository structure

Single-package repository for `@_linked/core` (query DSL, SHACL shape decorators, package registration, LinkedStorage). No internal package dependencies.

Tests: `npm test`

Live Fuseki tests: wrap them in `describeFuseki` (`src/test-helpers/fuseki-live.ts`), never an early `return`. jest globalSetup starts Fuseki (Docker, port 3939); without it the live blocks are skipped locally and the run fails under `CI` or `REQUIRE_FUSEKI=1`. `npm run test:fuseki` runs only the live blocks.

## Agent docs (`docs/`)

Use this folder structure:

- `docs/ideas` — brainstorming and exploration notes
- `docs/plans` — architecture and implementation planning docs
- `docs/reports` — implementation status, deviations, and wrap-up reports
- `docs/architecture` — durable architecture/process references (e.g. [publishing](docs/architecture/publishing.md) — the release/npm-publish flow; **run only with explicit user consent**)
- `docs/agents/skills` — workflow and mode skill definitions

For `docs/ideas`, `docs/plans`, and `docs/reports`: files are numbered with a 3-digit prefix for ordering within each folder. Names should be explicit about contents (lowercase-dash format). Each file starts with YAML frontmatter:

```yaml
---
summary: One-line description of what this document covers
packages: [core, react]
---
```

```bash
ls docs/ideas docs/plans docs/reports
head -4 docs/ideas/*.md
head -4 docs/plans/*.md
head -4 docs/reports/*.md
find docs/agents/skills -name SKILL.md | sort
```

## Workflow skill

Prefer using the `workflow` skill for any task that touches code or changes plans/docs.
If mode is not already explicit, ask whether to start with `ideation` (brainstorming) or `plan` before implementation work.
