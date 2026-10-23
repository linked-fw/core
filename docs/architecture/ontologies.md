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

A dataset keeps named graphs on purpose (a package's whole ontology data, its shapes,
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

### Reading graphs

A read names its graphs with `.from(graph | graph[])` on a select, count or ask (`.count()` and
`.exists()` keep it); without it a read uses the default graph, as before. The names travel as
written, in the DSL-JSON field `graphs` and the IR field `graphs`, and the store expands them:

| Name | Read as |
|---|---|
| a graph IRI, `graphs.registry` | itself |
| `graphs.allOntologies`, `graphs.allShapes` | every graph the registry lists with an `OntologyGraph` / `ShapesGraph` record |
| `graphs.default` alone | the default graph, as without `.from()` |
| `graphs.default` with other graphs | the default graph under the store's name for it, through `VALUES` (below) |
| `graphs.union` alone | the store's name for it (`SparqlOptions.mapGraphName`; Fuseki `urn:x-arq:UnionGraph`) |

`graphs.union` together with other graphs is refused (`unsupported-query-kind`; it holds them
already), and so is `graphs.default` with other graphs on a store without a name for it
(`mapGraphName`). A set that expands to no graph matches nothing; the store answers it without a
request.

`SparqlDataset` compiles one graph as `GRAPH <iri> { … }` around the whole pattern, and several
as `FROM NAMED <g1> … <gK>` with one `GRAPH ?g_<subject> { … }` block per subject: a subject's
data lives in one graph, so its graph variable is shared by all its blocks, OPTIONAL and EXISTS
ones included. A set holding the default graph has no `FROM NAMED` (on Jena any `FROM NAMED`
hides the default graph, even from `VALUES` and `GRAPH <urn:x-arq:DefaultGraph>`); each subject
then reads `VALUES ?g_<subject> { <urn:x-arq:DefaultGraph> <g1> … }` with its `GRAPH` block.

```ts
import {graphs} from '@_linked/core/ontologies/graphs';
const people = await Person.select((p) => [p.name, p.knows.name]).from(graphs.allOntologies);
```

```sparql
SELECT DISTINCT ?a0 ?a0_name ?a1_name ?a1
FROM NAMED <https://linked.cm/pkg/a/graph/ontology>
FROM NAMED <https://linked.cm/pkg/b/graph/ontology>
WHERE {
  GRAPH ?g_a0 { ?a0 rdf:type schema:Person . }
  OPTIONAL {
    GRAPH ?g_a0 { ?a0 schema:knows ?a1 . }
    OPTIONAL { GRAPH ?g_a1 { ?a1 schema:name ?a1_name . } }
  }
  OPTIONAL { GRAPH ?g_a0 { ?a0 schema:name ?a0_name . } }
}
```

**`isolateLinkedTypeChecks`** (a `SparqlOptions` flag, set per store, never per query): a subject
reached through a link that carries an inferred type check gets that check in a second block on
the same graph variable, after the block that reads one of its stored triples. The rows are the
same; on Jena, which reorders the patterns inside one block and would run the type check in every
allowed graph, it is about twice as fast (the measurements are in `graphScope.ts`). The generator
emits no linked type check (graph routing does not need one: a subject's graphs come from its
shape, see below), so the flag changes no generated query.

**The registry cache.** A store reads its registry once per dataset and process (one `SELECT` on
`graphs.registry`) and keeps it: its own graph queries update the cache in the same step, so its
next read sees a new or dropped graph; `invalidateGraphRegistry(dataset?)` (on the store, and as a
package export by cache key) drops it when another process changed the graphs (CN pushes this to
the apps it runs); an entry older than 30 seconds (`GRAPH_REGISTRY_MAX_AGE_MS`) is re-read. A
store keys the cache with `graphRegistryKey()` (default: one key per instance; a store overrides
it with its dataset's identity). Writes never depend on the cache.

### Graph routing

Storage rules pick the graph the way they pick the dataset: a **route** maps a shape to one named
graph of one dataset, so ordinary code never names a graph. Without routes everything lives in the
default graph, exactly as before routing existed.

Routes live in the app's code (its `linked.backend.storage.ts`), never in the datasets config,
which keeps what changes per deployment. A route states intent; developers do not write graph
IRIs:

```ts
import {dataGraph} from '@_linked/core/ontologies/graphs';

LinkedStorage.setDatasetForShapes(store, [Article, Comment], {graph: 'own'});
LinkedStorage.setDatasetForShapes(store, [Tag, Category], {graph: dataGraph('taxonomy')});
```

| Route | Graph |
|---|---|
| `'own'` | `{DATA_ROOT}/graph/{package slug}/{shape name}` — one graph per shape |
| `dataGraph('slug')` | `{DATA_ROOT}/graph/{slug}` — shared by the shapes routed to it |
| an absolute graph IRI | as given (advanced use) |

- **`'own'`**: the package is the one the shape class was registered by (`linkedPackage(name)`); its
  slug is `packageNameToSlug(name)` (npm scope dropped, every run of characters other than ASCII
  letters and digits → `-`, trimmed, lower-cased: `@acme/news-site` → `news-site`); the shape name
  is the shape IRI's last segment, case kept (`@linkedShape({name})`, else the class name). So
  `Article` of `@acme/news-site` → `{DATA_ROOT}/graph/news-site/Article`. A shape no package
  registered is refused.
- **`dataGraph(slug)`**: the slug is one or more `/`-separated segments, each
  `^[a-z0-9]+(?:-[a-z0-9]+)*$` (`articles`, `news/archive`); anything else throws.
- **`DATA_ROOT`** is the store's: `IDataset.dataRoot()` (a `SparqlDataset` returns its
  `SparqlOptions.dataRoot`, the root it mints ids under), else the process's `DATA_ROOT`; trailing
  slashes dropped (`dataRootOf(dataset)`). It is joined each time the routing is read, so a root
  the store learns later is the one used. A route that needs a root the store lacks is refused when
  resolved, with the shape named.

`setShapeGraphs(dataset, {<shape IRI>: route})` records routes directly (a composite dataset
registers them on the store it forwards to); `getShapeGraphs(dataset)` returns them resolved, and
`graphRoutingFor(dataset)` is what reads and writes compile with. Routes are kept per dataset
object, by shape IRI.

- **A shape's graph** (where its instances are written): its own route, else its nearest routed
  super-shape's, else the default graph.
- **A shape's read set**: its graph, every registered sub-shape's graph, and the read set of every
  shape that owns it through a `contains` property (an owned node is written into its owner's
  graph).

**Reads** with no `.from()` give each subject group the read set of its shape: the root's shape,
an object property's value shape, or, through a `contains` property, the owner's set. A subject
of unknown shape may be in any routed graph or the default graph. The forms:

| Situation | SPARQL |
|---|---|
| every subject reads only the default graph | unchanged |
| every subject reads the same single graph | `GRAPH <g> { whole pattern }` |
| named graphs only | `FROM NAMED` their union; per subject `GRAPH <g>` (one graph), `GRAPH ?g` (the whole union) or, for a type-checked subject with a narrower set, `VALUES ?g { … }` + `GRAPH ?g` |
| the default graph with named graphs | no `FROM NAMED`; default-only subjects plain, one-graph subjects `GRAPH <g>`, others `VALUES ?g { <store default name> … }` + `GRAPH ?g` |

`VALUES` is written where a subject's graph variable is first bound, not again in the OPTIONAL
blocks that join on it. With `SparqlOptions.namedGraphUriParameter` the `FROM NAMED` set goes to
the transport as the protocol's `named-graph-uri` parameters instead
(`executeSparqlSelectWithNamedGraphs`, which a store with the option overrides; the default
refuses rather than read every named graph).

**Writes.** A create goes into the shape's graph (`INSERT DATA { GRAPH <g> { … } }`); nested
(owned) nodes are created there too. An update or delete of existing subjects runs in the graph the
subject lives in: when the shape's read set is one graph, `WITH <g>` before the
`DELETE`/`INSERT`; when it holds several (a sub-shape's or an owner's graph), the same update finds
the graph:

```sparql
DELETE { GRAPH ?g_w { … } } INSERT { GRAPH ?g_w { … } }
WHERE {
  { SELECT DISTINCT ?g_w WHERE { VALUES ?g_w { <people> <staff> } GRAPH ?g_w { <bob> ?p ?o } } }
  GRAPH ?g_w { … }
}
```

A subject found in none of them is left alone; an upsert of one creates it in the shape's graph
(`BIND(COALESCE(…))`); a bulk update or delete runs in every graph of the set where it matches; a
delete of several ids is one operation per id in one request. Old values, incoming references and
owned walks are read and removed in that graph only. Under routing an owned node lives in its
owner's graph: the owned-link check reads the linked node's types in every graph and refuses one
that lives elsewhere. `.into(graph)` on a create, update or delete builder overrides the graph, only
to a graph in the shape's read set (else `GraphQueryError('graph-not-routed')`; a portable name, the
registry or a store-reserved name is `graph-name-read-only`). `.into()` is never carried in
DSL-JSON: a process that receives a mutation derives its graph from its own routing.

**Live queries.** `QueryDependencies.graphs` (the `.from()` names, or the routed read sets) and
`MutationEffects.graph` (the `.into()` graph, the routed graph of a create, or the one graph of a change to existing subjects; unknown when the read set holds several) are set when the dataset `LinkedStorage`
routes the shape to has routes; the matcher skips a template that does not read the written graph.

### Shape graphs

A package's shapes live in its shape graph, `{package IRI}/graph/shapes`
(`ShapesGraph.iriFor(pkg)`), recorded as a `ShapesGraph` (never a hierarchy source). Readers read
`graphs.allShapes` (every graph the registry lists as a `ShapesGraph`) plus the app's own shape
graph.

**Stored as declared.** A shape is written with its own property shapes only, plus
`core:isExtending` to the shape it extends; inherited property shapes are not copied. A reader that
needs a shape's full property set follows `core:isExtending` (the property readers do so through
the registry for a shape known only as data, and end its chain at the root `Shape`, whose `label`
and `type` every shape inherits). SHACL applies a super-shape to a sub-shape's instances through its
`sh:targetClass` and `rdfs:subClassOf`.

**`shapes.ttl`** (`@_linked/core/shapes/shapesToTurtle`, server only):

- `shapesToTurtle(shapes, {prefixes?})`: the shapes (classes or node shape data) as declared, in a
  fixed form: the prefix block `core`, `rdf`, `rdfs`, `sh`, `xsd` plus the caller's (sorted; a fixed
  name cannot be rebound), then one block per IRI subject sorted by IRI, the subject on its own
  line, then one `predicate object` per line (`a` first, then by predicate IRI, then by the written
  object), `;` between, `.` at the end, a blank line between blocks. The triples are the ones core's
  create pipeline writes for a `NodeShape`. Blank nodes only for complex `sh:path` values (SHACL
  requires them; sequence and alternative lists are blank-celled), each the object of exactly one
  triple and written inline on its owner's line (`[ sh:inversePath ex:p ]`, `( ex:a ex:b )`);
  `sh:in`, `sh:languageIn`, `sh:and` and `sh:xone` lists have IRI cells (`{IRI}/in/0`, `{IRI}/and/0`).
  Same shapes and prefixes, same bytes.
- `packageShapes(pkg)`, `packageShapesTurtle(pkg)`: a package's registered shapes (for
  `@_linked/core`, its built-ins) and their Turtle. `linked build` writes it to
  `lib/esm/data/shapes.ttl`.
- `singleOwnerShapesTurtle(shapes)`: the single-owner shapes generated from `contains` properties
  (with the owners' `core:generatedShape` links), for the app's own shape graph
  `{DATA_ROOT}/graph/shapes`. Their `sh:qualifiedValueShape` is an inline blank node too.

**The sync** (`@_linked/core/shapes/syncShapeGraphs`): `syncShapeGraphs(ds?, {force, packages,
turtleFor, appShapes, orphanScope})` → `{written, skipped, pruned, cleaned, appGraph?,
defaultGraph?}`. Per package, the body is `turtleFor(pkg)` (a server passes the installed
`shapes.ttl`) or `packageShapesTurtle(pkg)`; the hash is `sha256Hex('linked-shape-graph/1\n' +
text)`, compared with the record's `core:contentHash`; equal → no write; else the graph is created
or replaced whole in one graph query (`sources` `data/shapes.ttl`). `appShapes: {graph, package?}`
writes the generated single-owner shapes of every registered shape to the app's graph the same way.
After the graphs, the package shapes an earlier sync wrote into the default graph (`NodeShape`s with
`core:shapeHash`) are deleted there with their owned subtrees, once. `orphanScope: 'all'` drops the
shape graphs of packages no longer registered (never an app's graph). A store without graph queries
gets the default-graph `syncShapes` instead (`defaultGraph` counts its writes).

**Patching a shape** (`NamedGraph.patchContent`): the unit is the shape's concise bounded
description: its statements and, through each blank object, the blank node's statements,
recursively. A store deletes each blank-node structure as a pattern through its IRI subject
(`DELETE { GRAPH <g> { <s> sh:path ?b0 . ?b0 sh:inversePath ex:p } } WHERE { … FILTER(isBlank(?b0)) }`)
and inserts the new statements; a delete body whose blank node is the object of two triples, or
hangs off no IRI subject, is refused.

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
