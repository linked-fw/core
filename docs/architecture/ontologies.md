---
summary: Why core ships its own copies of rdf, rdfs, owl, shacl and xsd, how they differ from the ontologies in packages (Turtle data, the registry, the hierarchy reader, the ontology sync, mirror packages), and the rule for which kind you are writing.
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

`linked-core` is core's own vocabulary: the terms of its SHACL meta-model extensions, such as
`core:contains`, `core:dependent`, `core:displayHidden`, and `core:generated` /
`core:generatedShape` (the marker and ownership edge of the shapes shape sync generates, see
[owned-values](owned-values.md)), and `core:shapeHash` (the content hash shape sync stores on each
NodeShape it writes, so the next sync skips an unchanged shape). The `shacl` shortcut likewise grows only by the terms core
writes, e.g. `sh:targetObjectsOf` for those generated shapes.

## A package's ontology is the full thing

Everywhere else — `@_linked/xsd`, `@_linked/schema`, `@_linked/sioc` and the rest — an
ontology is the complete vocabulary, and carries what core's shortcuts leave out:

| | core | a package |
|---|---|---|
| terms | only what core uses | the whole vocabulary |
| data file | none | `src/data/<name>.ttl` (Turtle), read on the server only |
| `linkedOntology()` | not called | called, from a sibling module |
| registered via | `Prefix.add` directly | `linkedOntology`, which also registers the prefix |

## Ontology data is Turtle

A package's vocabulary ships as Turtle under `src/data/`, one file per vocabulary, written by a
deterministic writer (fixed prefix block, subjects sorted, `a` first, predicates sorted), with no
blank nodes and no graphs. `linked build` copies `src/**/*.ttl` into `lib/esm/` with the same
layout, so a module's relative path to its data holds in both trees.

The ontology module reads it with `loadOntologyFiles`:

```ts
// src/ontologies/my-vocab.ts
import {loadOntologyFiles} from '@_linked/core/ontology/loadOntologyFiles';
export const dataFiles = ['../data/my-vocab.ttl'];
export const loadData = () => loadOntologyFiles(import.meta.url, dataFiles);
```

`loadOntologyFiles(moduleUrl, files)` resolves each file against the module URL and reads it as
text. Ontology modules are reachable from browser bundles, so the loader imports
`node:fs/promises` dynamically through a variable specifier (kept out of bundles); calling it in
a browser rejects. A missing file rejects, naming the file.

An ontology without data passes no `loadData`. A `loadData` that resolves to anything other than
a list of strings (a package whose data is still JSON) is skipped with one warning naming the
package.

Nothing loads the data at registration. `autoLoadOntologyData` is a no-op kept until the next
major.

## The registry

Every `linkedOntology(terms, ns, prefix, loadData?, dataSource?)` records
`{packageName, prefix, ns, load, files, terms}` (`terms`: the module's exports, read by the
mirror check) in core's shared state (`getRegisteredOntologies()` from `utils/Package`), keyed by
package and prefix, so a module evaluated twice (Vite SSR) or seen by two copies of core
registers once. A package may register several ontologies (dcmi registers
three); the readers group them by package.

### Installed packages register explicitly

A package registers from its `ontologies/<prefix>.register.js` modules, which its index and
`shapes/index` import. An app that deep-imports one shape file
(`@_linked/schema/shapes/Person`) never evaluates them, so the registry would lack that
package's data. Whoever syncs or checks therefore registers the installed packages first:

```ts
import {registerInstalledOntologies} from '@_linked/core/ontology/registerInstalled'; // server only

const names = await registerInstalledOntologies(packageDirs); // package roots
```

It imports `<dir>/lib/esm/ontologies/*.register.js` of each directory (the cli's build layout),
in the order given and by file name within a package, and returns the names of the packages it
registered. A directory without register modules is skipped silently, a directory given twice
(also through a symlink) is imported once, and a register module that throws is warned about,
naming the file, and its package left out. Registration is idempotent, so a package the app
already imported is unaffected. The server's boot and `POST /admin/sync-shapes` call it with
every linked package directory they discovered (transitively) before the ontology sync and the
shape check; the cli's build check calls it with the package's own directory and its
`@_linked/*` dependencies'.

## The hierarchy reader

`@_linked/core/ontology/hierarchy` (server only; it imports `n3` dynamically):

- `hierarchyFromTurtle(texts, sources?)` — every `rdfs:subClassOf` between two IRIs in the
  default graph, deduped and sorted by subject then object. Blank-node superclasses (OWL
  restrictions), literals, named graphs and every other predicate are dropped. A parse error
  rejects naming the source; the callers skip only that package.
- `subClassClosure(triples)` — class → every transitive superclass (pure).
- `definedTermsFromTurtle(texts)` — every IRI subject: the terms the data defines.

Only the hierarchy leaves the file. Labels, comments and the rest of the vocabulary stay in the
Turtle, for tools that read it directly.

## The class hierarchy in memory

`@_linked/core/ontology/classHierarchy` (browser-safe) answers class questions synchronously,
for code that cannot ask the store:

- `superClassesOf(iri)` / `subClassesOf(iri)` — reflexive and transitive; an unknown IRI gives
  `{iri}`.
- `setOntologyHierarchy(triples)` — replaces the ontology triples it uses.

Its closure is the union of two sources. The shape tree is always there: a shape targeting C that
extends a shape targeting D gives `C ⊑ D`, so a browser has these edges too. The ontology triples
are there once set: `loadOntologyHierarchy()` (in `ontology/hierarchy`, server only) parses every
registered package's data and sets their union. The ontology sync sets it from the parse it
already does, the shape check loads it when not given a `hierarchy`, and an app's boot loads it
whether or not it syncs. The shape check requires every shape edge in the ontology data, so on a
server the union is the ontology closure. The closure is rebuilt when the shape registry or the
triples change, and kept per catalog.

### Validating by class

`validateByClass(data, {types?, mode?, maxDepth?})` (`@_linked/core`, beside `validate`) is SHACL
class targeting in process: it validates a node against every registered shape that targets one
of its types or a superclass of one (`superClassesOf`). The types come from `types`, else from
the data's `type` (or full `rdf:type` IRI) values. Per class the least specific shapes run
(`getShapesForTargetClass`): a sub-shape that inherits its class is covered by its root, a
sub-shape with its own class runs for nodes of that class; data-only shapes count the same. The
node is described by all of them together, so a property one declares is not undeclared for the
others; results are in shape-id order without duplicates. No known type, or no shape for any,
validates nothing: the report conforms and carries one `sh:Info` result saying so. The store's
SHACL validation stays the one that matters; this is for checking data before it is written.

## The ontology sync

The store infers `rdf:type` through `rdfs:subClassOf`, so each app dataset must hold the class
hierarchy of every package the app registers. `syncOntologies(ds?, {force, packages,
orphanScope})` (`@_linked/core/ontology/syncOntologies`, server only) writes it:

- per package, the kept triples (its hierarchy) as sorted N-Triples lines, hashed with SHA-256
  (`linked-ontology-sync/1\n` + the lines);
- the hash and the lines are stored on a sync node per package,
  `https://linked.cm/ont/core/ontologySync/<encodeURIComponent(packageName)>`, of the built-in
  shape `OntologySync`;
- an unchanged hash writes nothing (an unforked branch stays unforked); a changed package is
  updated one subject class at a time (`add` = new − old, `remove` = old − new minus the triples
  another package lists), the sync node last, so an interrupted sync is redone by the next one;
- triples a dataset held before its first sync are never removed by it; packages no longer
  registered are pruned only under `orphanScope: 'all'`.

It runs at app boot and through the app's control route, before shape sync. Everything goes
through Linked Queries, in the default graph.

## A package that mirrors a standard

A package that mirrors a published vocabulary (`@_linked/schema`, `dcat`, `org`, `rdfs`, …) holds
only that standard's terms, and declares the namespace(s) it mirrors:

```ts
export const {linkedShape, linkedOntology} = linkedPackage('@_linked/schema', {
  mirrors: 'http://schema.org/',
});
```

The shape check (`@_linked/core/shapes/checkShapeHierarchy`) then reports every IRI in a
mirrored namespace that a shape or an exported term uses and the package's data does not define
(`mirror-undefined-term`). Custom shapes and terms belong in their own package and namespace,
optionally `rdfs:subClassOf` the standard class.

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
import {dataFiles, loadData, ns} from './my-vocab.js';

linkedOntology(terms, ns, 'my-vocab', loadData, dataFiles);
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
