---
summary: Why core ships its own copies of rdf, rdfs, owl, shacl and xsd, how they differ from the ontologies in packages (Turtle data, the registry, the hierarchy reader, the ontology sync, named graphs and the graph registry, mirror packages), and the rule for which kind you are writing.
---

# Ontologies in core, and ontologies in packages

There are two kinds, and they are not the same thing wearing different names.

## Core's vocabularies are shortcuts

`src/ontologies/` here holds `rdf`, `rdfs`, `owl`, `shacl`, `xsd`, `npm` and `linked-core`.
`rdf`, `rdfs`, `owl`, `shacl` and `xsd` are **shortcuts core needs without depending on the packages that carry the full
ontologies**. Core cannot import `@_linked/xsd` to know what `xsd:string` is — that package
depends on core.

So they are deliberately minimal:

- a `ns()` IRI builder and the terms core itself references,
- a prefix registered directly through `Prefix.add`,
- **no data file, and no `linkedOntology()` call.**

They are not a smaller version of the real thing and should not grow into one. If core finds
itself wanting a term it does not have, the question is whether core should be reaching for
that term at all.

`linked-core` (`core:`) and `npm` are different: they are registered like a package's ontology
(`linked-core.register.ts`, `npm.register.ts`, imported by core's index), with Turtle data in
`src/data/core.ttl` and `src/data/npm.ttl` that types, labels and describes every term.

`linked-core` is core's own vocabulary: the terms of its SHACL meta-model extensions, such as
`core:contains`, `core:dependent`, `core:displayHidden`, and `core:generated` /
`core:generatedShape` (the marker and ownership edge of the shapes shape sync generates, see
[owned-values](owned-values.md)), and `core:shapeHash` (the content hash shape sync stores on each
NodeShape it writes, so the next sync skips an unchanged shape). The `shacl` shortcut likewise grows only by the terms core
writes, e.g. `sh:targetObjectsOf` for those generated shapes.

## A package's ontology is the full thing

Everywhere else — `@_linked/xsd`, `@_linked/schema`, `@_linked/sioc` and the rest — an
ontology is the complete vocabulary, and carries what core's shortcuts leave out:

| | core's shortcuts | a package |
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

Registration does not load the data.

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
already imported is unaffected.

A workspace package in dev has no `lib/` (nothing builds it), only
`src/ontologies/*.register.ts`. For such a directory the helper imports those source modules
through `options.importModule` (absolute file path), when given; without it the directory is
skipped as before. The server passes Vite's `ssrLoadModule` in dev:

```ts
await registerInstalledOntologies(packageDirs, {importModule: (file) => vite.ssrLoadModule(file)});
```

The server's boot and `POST /admin/sync-shapes` call it with
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
hierarchy of every package the app registers. Core relies on it (README, Store requirements):
class-scoped reads and bulk mutations, the owned-link check (it accepts the value shape's class
and `sh:class`, and a subclass instance through its inferred type), the owned walk's cycle hops
(`?n a <C>`) and the single-owner constraint (one `sh:class`) carry no list of subclasses of
their own. The owned walk also reads the in-memory hierarchy (`subClassesOf`) to find every shape
its guards match. `syncOntologies(ds?, {force, packages,
orphanScope})` (`@_linked/core/ontology/syncOntologies`, server only) writes each package's
**whole ontology data** (labels, comments and the rest along with the hierarchy) into its own
ontology graph (see the next section):

- the graph is `OntologyGraph.iriFor(packageName)` (`{package IRI}/graph/ontology`), recorded in
  the graph registry as an `OntologyGraph` (`package`, `sources`: the data files), which feeds
  the store's hierarchy; the store needs to build its hierarchy from the registry
  (`ghcr.io/linked-fw/fuseki:6.2.0-2` or later);
- the hash is `ontologyGraphHash(texts)`: SHA-256 of `linked-ontology-sync/2\n` + the package's
  raw data file texts in registration order, joined with `\n`, recorded as the graph's
  `core:contentHash`; bumping the prefix makes every dataset rewrite its graphs once;
- an unchanged hash writes nothing (an unforked branch stays unforked); a changed or new package
  is created or replaced whole in one graph query, the body sent as N-Triples (each file parsed
  with its own blank-node prefix, so prefixes and blank-node labels of several files never
  clash); `force` replaces every package;
- after a package's graph is written (or found unchanged), what the earlier default-graph sync
  kept for it is removed: the lines its `OntologySync` node lists, except those another
  remaining node lists, then the node; a hand-written default-graph axiom no node lists stays,
  and the store keeps inferring through it;
- `orphanScope: 'all'` (without `packages`) drops the ontology graph of every package no longer
  registered, and removes the default-graph lines and node of such a package.

A store without graph queries (`unsupported-query-kind`, or a dataset class without
`graphQuery`) gets the earlier **default-graph sync**: each package's `rdfs:subClassOf` triples
as sorted N-Triples lines, hashed with `linked-ontology-sync/1\n` + the lines, stored on a sync
node per package (`https://linked.cm/ont/core/ontologySync/<encodeURIComponent(packageName)>`,
the built-in shape `OntologySync`, deprecated) and diffed into the default graph one subject
class at a time (`ClassAxioms`); only lines a node lists are ever removed, and a triple another
package lists is kept.

It runs at app boot and through the app's control route, before shape sync.

## Named graphs and the graph registry

A dataset keeps named graphs on purpose (a package's whole ontology data, later its shapes,
ontology-editor drafts), and records each one in the **graph registry**, a named graph at
`https://linked.cm/pkg/core/graph/registry` (`graphs.registry`), the same IRI in every dataset.
A record is described with SPARQL Service Description plus core terms; its subject is the graph
IRI:

```turtle
# in GRAPH <https://linked.cm/pkg/core/graph/registry>
<https://linked.cm/pkg/schema/graph/ontology> a core:OntologyGraph ;
  sd:name <https://linked.cm/pkg/schema/graph/ontology> ;
  core:package "@_linked/schema" ; core:version "1.7.0" ;
  core:contentHash "3f9c…" ; core:feedsHierarchy true ;
  dcterms:modified "2026-10-30T10:12:00Z"^^xsd:dateTime ;
  dcterms:source "data/schema.ttl" .
```

The record's class is the graph's kind, a built-in shape in `@_linked/core/shapes/NamedGraph`:
`NamedGraph` (`sd:NamedGraph`, fields `name`, `contentHash`, `feedsHierarchy`, `modified`,
`sources`), `OntologyGraph` and `ShapesGraph` (adding `package`, `version`) and `DraftGraph`, each
class `rdfs:subClassOf sd:NamedGraph` in `core.ttl`. Selecting `NamedGraph` returns every kind's
records through the store's inference; its `select()` reads the registry (the shapes declare
`static storedInGraph`), so callers never name it. `feedsHierarchy` is true for an
`OntologyGraph` unless its creator sets it false, and always false for the other kinds; a store that builds its hierarchy from the registry reads
it to decide which graphs feed inference.

Package graphs are `{package IRI}/graph/{kind}` (`OntologyGraph.iriFor('@_linked/schema')` →
`https://linked.cm/pkg/schema/graph/ontology`); graphs a dataset owns hang under its data root,
`{DATA_ROOT}/graph/{kind}`.

**Graph queries.** A graph and its record change together, through `IDataset.graphQuery`
(required; a store without graph support throws `GraphQueryError('unsupported-query-kind')`).
The statics build one graph query per call, and a SPARQL store runs it as one update (one
transaction):

| Call | Graph query |
|---|---|
| `OntologyGraph.create({id, package, version}).withContent(c)` | `graph_create` (refused when registered: `graph-exists`) |
| `NamedGraph.replaceContent(iri, c)` | `graph_replace` (refused when not registered: `graph-not-registered`) |
| `NamedGraph.patchContent(iri, {insert, delete})` | `graph_patch` |
| `OntologyGraph.update(iri).set({version})` | `graph_patch` with a record and no body (hash kept) |
| `OntologyGraph.update(iri).set({version}).replaceContent(c)` | `graph_replace` with the record |
| `OntologyGraph.delete(iri)` | `graph_drop` (graph and record) |

Content is `{mediaType: 'text/turtle' | 'application/n-triples', text}`. Core fills the record's
automatic fields: `sd:name`, `core:contentHash` (`sha256Hex` of the content text, or a hash the
caller passes; for a patch, of its delete text, a newline and its insert text) and
`dcterms:modified`. The calls are server-only (a browser call throws; the import does not), and a
store parses each body before it enters a request. A receiving process checks a graph query that
arrived as JSON with `parseGraphQuery`.

**Portable names** (`@_linked/core/ontologies/graphs`): `graphs.default`, `graphs.union`,
`graphs.allOntologies`, `graphs.allShapes` and `graphs.registry`, under
`https://linked.cm/pkg/core/graph/`. A store maps them to its own names; every write to one is
refused (`graph-name-read-only`), the registry included: it is written only as part of a graph
query on another graph. A store also refuses its own reserved names (`SparqlDataset`'s
`isReservedGraphName`, by default Jena's `urn:x-arq:` names).

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
