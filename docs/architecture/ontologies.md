---
summary: Why core ships its own copies of rdf, rdfs, owl, shacl and xsd, how they differ from the ontologies in packages, and the rule for which kind you are writing.
---

# Ontologies in core, and ontologies in packages

There are two kinds, and they are not the same thing wearing different names.

## Core's vocabularies are shortcuts

`src/ontologies/` here holds `rdf`, `rdfs`, `owl`, `shacl`, `xsd`, `npm` and `linked-core`.
These are **shortcuts core needs without depending on the packages that carry the full
ontologies**. Core cannot import `@_linked/xsd` to know what `xsd:string` is — that package
depends on core.

So they are deliberately minimal:

- a `ns()` IRI builder and the terms core itself references,
- a prefix registered directly through `Prefix.add`,
- **no data file, and no `linkedOntology()` call.**

They are not a smaller version of the real thing and should not grow into one. If core finds
itself wanting a term it does not have, the question is whether core should be reaching for
that term at all.

## A package's ontology is the full thing

Everywhere else — `@_linked/xsd`, `@_linked/schema`, `@_linked/sioc` and the rest — an
ontology is the complete vocabulary, and carries what core's shortcuts leave out:

| | core | a package |
|---|---|---|
| terms | only what core uses | the whole vocabulary |
| data file | none | `src/data/<prefix>.json`, loaded lazily |
| `linkedOntology()` | not called | called, from a sibling module |
| registered via | `Prefix.add` directly | `linkedOntology`, which also registers the prefix |

A package ontology **always** has a data file and a `loadData` that imports it dynamically,
even when that file is empty. The file being empty is fine; the function being absent is not,
because consumers load ontology data on demand and an ontology that cannot be asked is a
special case every caller then has to know about.

## Registration goes in a sibling module

`linkedOntology()` needs the ontology module's whole export namespace, and a module cannot
import itself once a bundler is involved: Rollup treats the self-reference as a circular
import and **elides it**, so the binding is `undefined` at runtime and the consuming app dies
at boot with `_this is not defined` — naming neither the ontology nor the package.

`tsc` preserves it, which is why the pattern survived for as long as packages were built with
`tsc` alone and only broke once an app bundled them.

So registration lives in `<prefix>.register.ts`, imported from the package entry:

```ts
import * as terms from './my-vocab.js';
import {linkedOntology} from '../package.js';
import {loadData, ns} from './my-vocab.js';

linkedOntology(terms, ns, 'my-vocab', loadData, '../data/my-vocab.json');
```

`linked create-ontology` scaffolds both files. Core's vocabularies need none of this, because
they never call `linkedOntology`.

## Terms are properties, not module bindings

A package ontology exports **one namespace object**, not a binding per term:

```ts
const Person = ns('Person');          // not `export const`
export const schema = {Person, ...};   // this is the export
```

Term names and shape class names collide — a shape and the ontology term it targets
deliberately share a name. Two top-level bindings of one name in a bundle scope make the
bundler rename one of them, and if the loser is the shape class then `constructor.name` is its
IRI, so the shape registers under a name nothing will ask for. A term that is not a top-level
binding cannot collide.
