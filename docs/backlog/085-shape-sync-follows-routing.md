---
summary: >
  The boot sync writes shape and ontology graphs to the app's default dataset only. With several
  datasets it should write each package's graphs to every dataset the storage routing sends that
  package's shapes to. Builds on 076.
packages: [core, server]
---

# 085 — Shape sync follows routing

## Today

`syncShapeGraphs` (boot sync) writes a package's shape and ontology graphs to the app's default
dataset only. An app whose storage routing sends some of a package's shapes to another dataset
never gets the graphs there.

## Wanted

With several datasets, write each package's graphs to every dataset the routing sends any of its
shapes to (the unit is the whole package). Read the targets from the same routing the app uses for
queries (the routes report, `GET /admin/routes`). Related: [076](076-sync-follows-routing.md).

## Moot until

Apps have more than the `main` slot.
