# @_linked/core

A type-safe graph query builder and OGM for linked data — like Drizzle or Prisma, but for RDF and SPARQL.

Linked gives you a schema-parameterized query language and SHACL-driven Shape classes for graph data. Every query has one canonical, language-neutral form — **[DSL-JSON](./documentation/dsl-json.md)** — that serializes losslessly, crosses any boundary, and rehydrates anywhere. Datasets execute these queries however they like; the built-in SPARQL dataset lowers them to a normalized [IR](./documentation/intermediate-representation.md) and on to SPARQL.

## Linked core offers

- **Schema-Parameterized Query DSL**: TypeScript-embedded queries driven by your Shape definitions.
- **Fully Inferred Result Types**: The TypeScript return type of every query is automatically inferred from the selected paths — no manual type annotations needed. Select `p.name` and get `{id: string; name: string}[]`. Select `p.friends.name` and get nested result types. This works for all operations: select, create, update, and delete.
- **DSL-JSON, the standard wire format**: Every query — select, create, update, delete — serializes to a compact, lossless JSON structure with `query.toJSON()` and rehydrates with `fromJSON(json)`. This is the canonical interchange format for Linked queries: send it over HTTP, cache it, queue it, or implement it in another language. See **[DSL-JSON](./documentation/dsl-json.md)**.
- **Dynamic Query Building**: Build queries programmatically with `SelectBuilder` (and `Create`/`Update`/`DeleteBuilder`), compose field selections with `FieldSet` — for CMS dashboards, dynamic forms, and API-driven query construction.
- **Shape Classes (SHACL)**: TypeScript classes that generate SHACL shape metadata.
- **Full CRUD Operations**: Query, create, update, and delete data using the same Shape-based API — including expression-based updates, conditional mutations, bulk operations, and automatic cleanup of owned (`contains`) values on replace/remove/delete (see [Owned properties](#owned-properties-contains--dependent)).
- **Dataset Routing**: `LinkedStorage` routes query objects (by their target shape) to your configured dataset(s) that implement `IDataset`.
- **Automatic Data Validation**: SHACL shapes can be synced to your store for schema-level validation, and enforced at runtime by stores that support it.

## Installation

```bash
npm install @_linked/core
```

### Store requirements

Core works with any SPARQL 1.1 store. It checks what a store does by asking it, never by its
product or version.

- **Always:** SPARQL 1.1 Query and Update. Core sends standard queries and updates only.
- **The graph API** (`NamedGraph`, `OntologyGraph`, `.from()`, `.into()`, graph routing): named
  graphs. A graph query is one update whose conditions are part of the update (a create writes
  only while its graph has no record and holds no triples; a replace or patch only while the
  record exists), so concurrent writers are decided in the store's own transaction. A store
  without graph queries refuses them (`unsupported-query-kind`), and the ontology sync falls back
  to the default graph.
- **Polymorphic reads:** RDFS class inference. A node stored as `ex:Project` must also answer as
  every superclass (`schema:CreativeWork`, `schema:Thing`), with the hierarchy built from the
  stored `rdfs:subClassOf` triples of the **default graph** and of **every graph the registry marks
  `core:feedsHierarchy true`** (the package ontology graphs `syncOntologies` writes, or the shared
  one; see [Ontology and shape graphs](#ontology-and-shape-graphs)). Under `ontologyGraph:
  'default'` the ontology is in the default graph, so a store that infers from the default graph
  only is enough there. Class-scoped
  selects, counts, asks and `EXISTS`, bulk mutations (`deleteAll`, `deleteWhere`,
  `update().forAll()` / `.where()`), the owned-link class check, the owned walk's cycle hops and
  the single-owner SHACL constraint rely on it. Only classes are inferred: `rdfs:subPropertyOf`,
  `rdfs:domain` and `rdfs:range` are not needed.
- **The hierarchy where the instances are.** A store infers from the ontology graphs it holds. The
  routed ontology sync writes a package's ontology into every dataset the shapes using its classes
  are pinned to (see [Ontology and shape graphs](#ontology-and-shape-graphs)), so a store holding
  instances also holds their hierarchy.
- **No graph-target setting.** A store takes no ontology or shape graph setting: where the syncs
  write is the process's one global setting (see [Ontology and shape graphs](#ontology-and-shape-graphs)),
  and every store's readers follow it.
- **A store that infers over all graphs** works too. The caveat: drafts and other graphs the
  registry marks `feedsHierarchy false` then feed the hierarchy as well, so a draft ontology's
  classes infer before it is published.

How the ontology sync measures the store (`syncOntologies`, `@_linked/core/ontology/syncOntologies`;
run by `@_linked/server` at boot): before it writes its first package graph (or the shared graph),
it probes the store once per dataset. It writes a probe `rdfs:subClassOf` into a temporary registered graph and a typed
instance into a second graph that does not feed the hierarchy, asks through the normal query path
whether the instance is found by its superclass, then removes the probe. A sync with nothing to
write runs no probe; unless an earlier sync left a default-graph hierarchy to remove (once), it
sends nothing but its reads. On every store with named graphs the ontology
data is written into package graphs only, and the hierarchy an earlier sync kept in the default
graph is removed, so readers of `graphs.allOntologies` see the same everywhere. The answer only
decides a warning. See [ontologies](./docs/architecture/ontologies.md).

| The store infers from | The sync does |
|---|---|
| the registered graphs | writes each package's ontology data into its own graph |
| the default graph only | the same; warns once that class-scoped reads miss subclass instances |
| nothing | the same; warns once that class-scoped reads miss subclass instances |

A store that infers only from the default graph therefore needs an inferring store (above) for
polymorphic reads: core never copies the hierarchy into the default graph. Under `ontologyGraph:
'default'` the probe tests the default graph instead (it writes a probe axiom and instance there,
asks, and removes them) and warns once when the store does not infer from it.

The probe runs only before a write: a sync with nothing to write sends no request beyond its reads,
in every mode. Its answer never stops the sync.

**Without inference** core still reads and writes, but everything that matches by class sees
only nodes stored with exactly that class. Selects, counts and asks of a superclass miss the
instances of its subclasses; bulk mutations skip them; the owned-link check refuses a link to a
subclass instance; the single-owner constraint does not see it.

`@_linked/fuseki`'s image (`ghcr.io/linked-fw/fuseki`, its `tdb2` datasets) is one store that meets
these requirements. Core does not depend on it: any store with the behaviour above works.

### Ontology and shape graphs

Where the syncs keep the registered packages' ontology data and shapes is **one global setting of
the process**, two strings set by the host. It is not a store's setting: no store, store option or
datasets config entry takes it.

| Setting | Env variable (read by `@_linked/server`) | Values |
|---|---|---|
| `ontologyGraph` | `LINKED_ONTOLOGY_GRAPH` | `'package'` (the default), `'default'`, or an absolute graph IRI |
| `shapeGraph` | `LINKED_SHAPE_GRAPH` | the same |

```ts
import {setGraphTargets, getGraphTargets} from '@_linked/core';

setGraphTargets({ontologyGraph: 'default'}); // once, at boot, before the stores load and the syncs
getGraphTargets(); // {ontologyGraph: 'default', shapeGraph: 'package'}
```

`@_linked/server` reads both variables at boot and calls `setGraphTargets` once, before it loads
the stores and before the syncs; an invalid value stops the boot. A host of its own does the same
(`setGraphTargets(graphTargetOptionsFromEnv(process.env))`, `@_linked/core/utils/graphTargets`).
Core itself never reads `process.env` for them. With nothing set both are `'package'`. Each call
replaces both settings (one left out is `'package'`). A value that is neither keyword must be an
absolute IRI (not a portable graph name such as `graphs.default`, and not the same IRI for both
settings); anything else throws, naming the setting and where it came from.

**The frontend needs nothing** when its queries go through the backend: a browser's
`.from(graphs.allOntologies)` or `.from(graphs.allShapes)` travels to the backend as the portable
name, and the backend's store expands it under the backend's setting. A store used directly in a
browser expands it under the browser's own setting (`'package'` unless set).

Every copy of core in a process must be this version or later: an older copy's stores still read
targets of their own and ignore the global setting.

| Mode | Ontology sync (`syncOntologies`) | Shape sync (`syncShapeGraphs`) |
|---|---|---|
| `'package'` | One `OntologyGraph` per package, `{package IRI}/graph/ontology`, replaced whole when the package's hash changes. | One `ShapesGraph` per package, `{package IRI}/graph/shapes`, plus the app's generated shapes in `{DATA_ROOT}/graph/shapes`. |
| an IRI | One shared `OntologyGraph` at that IRI (`feedsHierarchy` true) holding every registered package's ontology data. When any package's hash changes it is rebuilt whole in one update. Its record lists `packageHashes` (`"{package} {sha256}"`) and `sources` (`{package}/{file}`). | One shared `ShapesGraph` at that IRI with the run's packages' shapes and the app's generated ones, rebuilt whole on any change; the same record fields. `packages`, when given, names every package the graph holds (the server leaves out packages without `shapes.ttl`). |
| `'default'` | The **whole** ontology (not only the hierarchy) in the default graph. When the combined hash changes, one update deletes every package-owned term and inserts every package's current data. | The default-graph shape sync (`syncShapes`): each shape replaced on its own hash, keeping the links other shapes hold to it. Every registered shape is synced (`packages` and `orphanScope` do not apply). |

The shared graph IRI may not be a package's own graph name (`…/pkg/{slug}/graph/ontology` or
`/graph/shapes`).

The readers follow the mode: on every store, `graphs.allOntologies` and `graphs.allShapes` read the
package graphs, the shared graph, or the default graph. `.from()` and readers built on them work the same in every
mode. An unchanged sync writes nothing in every mode (and so probes nothing).

**`'default'` mode's package-owned terms.** A package-owned term is every subject whose IRI starts
with a registered package's ontology namespace (`ns('')` of each ontology that ships data), and
every subject of a package's current Turtle. Each goes with all its outgoing triples and,
recursively, the blank nodes they lead to (OWL restrictions, lists; at most
`DEFAULT_GRAPH_TERMS_DEPTH`, 8, blank-node steps deep). Subjects outside that set are never
touched: instance data uses the app's IRIs, and a class of no package stays. The combined hash is
kept on `https://linked.cm/pkg/core/ontology-sync/default-graph`, replaced in the same update. The
sync refuses, before writing, a namespace that holds the store's data root or a registered shape,
a blank node no IRI subject links to, and a store without `replaceDefaultGraphTerms`
(`SparqlDataset` has it). When a package's data cannot be read, the shared and default modes skip
the rebuild with a warning, since a rebuild without it would drop its terms. What the sweep cannot
see stays: a subject outside every namespace that a package drops from its Turtle (say
`schema:Person rdfs:subClassOf …` written by a package that does not own `schema:`), and every
term of a package that is no longer registered. Remove those by hand. A namespace must end in `/` or
`#`.

**A package's ontology Turtle is the source of its terms.** Any triples about a package's terms
must live in that package's Turtle. Anything else written about them (by hand, by another tool) can
be overwritten by the next sync: in `'default'` mode it is deleted, in the other modes the graph is
replaced whole.

**Switching modes needs clearing first.** Each kind of data lives only where its mode puts it, and
the syncs never copy or move it. A sync that finds another mode's data (package graphs while in
`'default'` or shared mode, a shared graph while in `'package'` mode, the default-graph ontology or
default-graph shapes while in another mode) logs one warning naming it and leaves it. To switch, drop
the old graphs and records (`OntologyGraph.delete(iri)`, `ShapesGraph.delete(iri)`), or remove the
default-graph terms, then set the new mode and sync. The `'package'` and shared modes need a
store with graph queries; the ontology sync refuses one without them.

**CN-managed apps must use `'package'` for both.** Create Now reads package graphs (catalogs, the
gateway's graph rules) and reports another mode as an error.

**Which datasets the syncs write to.** `syncShapeGraphs(ds)` and `syncOntologies(ds)` write into the
one dataset they are given. The routed syncs (`syncShapeGraphsRouted`, `syncOntologiesRouted`,
`@_linked/core/shapes/syncTargets`; what `@_linked/server`'s boot runs) follow the storage routing
instead, and `graphSyncTargets()` tells where each graph goes:

| Graph | Goes to |
|---|---|
| a package's shape graph | every dataset one of the package's shapes routes to, and the dataset(s) the shapes of `sh:NodeShape` / `sh:PropertyShape` route to |
| a package's ontology graph | every dataset one of the package's shapes routes to, every dataset a shape targeting one of its classes (a class in its namespace) routes to, and the dataset(s) the ontology term shapes (`rdfs:Class`, `owl:Class`, `rdf:Property`, …) route to; so an ontology-only package follows the shapes that use it, and the hierarchy is where the instances are |
| the app's shape graph | every dataset a shape it constrains routes to (the shapes that declare `contains` properties and their sub-shapes), and those of `sh:NodeShape` / `sh:PropertyShape` |

A sub-shape follows its parent's pin; shapes the routing does not pin go to the default dataset,
so an app without pins writes everything into the default dataset, exactly as before. Each package's
text is read or generated once and every target gets the same bytes and hash. In the shared and
`'default'` modes a dataset's graph holds the packages routed to it. A dataset that cannot be read
or written fails alone: the routed sync reports it (`failed`) and syncs the others.

When routing no longer sends a package's graph to a dataset (a pin moved), the routed sync drops
it **only in the default dataset**. In another dataset it leaves the graph and reports it
(`leftovers`, one warning): a store several apps share may hold another app's copy there. Drop
those by hand once nothing reads them. The routed sync reads only the datasets the router knows, so
a dataset nothing is pinned to any more is not looked at. In the `'default'` ontology mode the sync
keeps one combined state per dataset and sweeps only the namespaces of the packages routed to it,
so the terms of a package routed away stay in that dataset's default graph (it warns once).

`graphContent()` (same module) answers what the `'package'`-mode syncs would write for each
package (shape graph Turtle, ontology graph N-Triples, the hash each record gets, its sources) and
for the app's graph, writing nothing. A host that writes an app's graphs itself reads them through
`@_linked/server`'s `POST /admin/graph-content`.

## Repository setup (contributors)

After cloning this repository, run:

```bash
npm install
npm run setup
```

`npm run setup` installs agent skills and syncs tooling configuration.

## Related packages

- `@_linked/rdf-mem-store`: in-memory RDF store that implements `IDataset`.
- `@_linked/react`: React bindings for Linked queries and shapes.

## Documentation

- **[DSL-JSON — the Linked query wire format](./documentation/dsl-json.md)** — the canonical, standardized query structure.
- [Intermediate Representation (IR)](./documentation/intermediate-representation.md) — the internal algebra the SPARQL dataset lowers to.
- [SPARQL Algebra Layer](./documentation/sparql-algebra.md)
- [Live queries](./documentation/live-queries.md) — `query.live()`, change sources, and what triggers a refetch.

## How Linked works — from shapes to query results

Linked turns TypeScript classes into a type-safe query pipeline. Here is the full flow, traced through a single example:

```
Shape class → DSL query → IR (AST) → Target query language → Execute → Map results
```

### 1. SHACL shapes from TypeScript classes

Shape classes use decorators to generate SHACL metadata. These shapes define the data model, drive the DSL's type safety, and can be synced to a store for runtime data validation.

```typescript
import {createNameSpace} from '@_linked/core/utils/NameSpace';

const ns = createNameSpace('https://example.org/');

// Example ontology references
const ex = {
  Person: ns('Person'),
  name: ns('name'),
  knows: ns('knows'),
  // ... rest of your ontology
};

@linkedShape
export class Person extends Shape {
  static targetClass = ex.Person;

  @literalProperty({path: ex.name, maxCount: 1})
  get name(): string { return ''; }

  @objectProperty({path: ex.knows, shape: Person})
  get friends(): ShapeSet<Person> { return null; }
}
```

### 2. Type-safe query DSL with inferred result types

The DSL uses these shape classes to provide compile-time checked queries. You cannot write a query that references a property not defined on the shape. The result type is **fully inferred** from the selected paths — no manual type annotations needed:

```typescript
// TypeScript infers: Promise<{id: string; name: string}[]>
const result = await Person.select(p => p.name);

// TypeScript infers: Promise<{id: string; friends: {id: string; name: string}[]}[]>
const nested = await Person.select(p => p.friends.name);
```

### 3. SHACL-based Intermediate Representation (IR)

The DSL compiles to a backend-agnostic AST — the [Intermediate Representation](./documentation/intermediate-representation.md). This is the contract between the DSL and any store implementation.

```json
{
  "kind": "select",
  "root": { "kind": "shape_scan", "shape": ".../Person", "alias": "a0" },
  "projection": [
    { "alias": "a1", "expression": { "kind": "property_expr", "sourceAlias": "a0", "property": ".../name" } }
  ],
  "resultMap": [{ "key": ".../name", "alias": "a1" }]
}
```

The IR uses full SHACL-derived URIs for shapes and properties. A dataset (`IDataset`) that wants the IR obtains it by calling `lower(query)` and translates it into its native query language. (Datasets that forward or execute directly never touch the IR — see [Datasets, target languages, and the IR](#datasets-target-languages-and-the-ir).)

### 4. IR → SPARQL Algebra

For SPARQL-backed stores, the IR is converted into a formal [SPARQL algebra](./documentation/sparql-algebra.md) — a tree of typed nodes aligned with the SPARQL 1.1 specification.

```
SparqlSelectPlan {
  projection: [?a0, ?a0_name]
  algebra: LeftJoin(
    BGP(?a0 rdf:type <Person>),
    BGP(?a0 <name> ?a0_name)       ← wrapped in OPTIONAL
  )
}
```

Properties are wrapped in `LeftJoin` (OPTIONAL) so missing values don't eliminate result rows.

### 5. SPARQL Algebra → SPARQL string

The algebra is a plain data structure — stores can inspect or optimize it before serialization (e.g., rewriting patterns, adding graph clauses, or pruning redundant joins).

The algebra tree is then serialized into a SPARQL query string with automatic PREFIX generation:

```sparql
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <.../Person> .
  OPTIONAL {
    ?a0 <.../name> ?a0_name .
  }
}
```

### 6. Execute and map results

The SPARQL endpoint returns JSON results, which are mapped back into typed result objects:

```
Endpoint returns:                        Mapped to:
┌──────────┬──────────┐                  ┌──────────────────────────────┐
│ a0       │ a0_name  │                  │ { id: ".../p1", name: "Semmy" } │
│ .../p1   │ "Semmy"  │        →         │ { id: ".../p2", name: "Moa"   } │
│ .../p2   │ "Moa"    │                  │ ...                          │
└──────────┴──────────┘                  └──────────────────────────────┘
```

Values are automatically coerced: `xsd:boolean` → `boolean`, `xsd:integer` → `number`, `xsd:dateTime` → `Date`. Nested traversals are grouped and deduplicated into nested result objects.

### The SparqlStore base class

`SparqlStore` handles this entire pipeline. Concrete stores only implement the transport:

```typescript
import { SparqlStore } from '@_linked/core/sparql';

class MyStore extends SparqlStore {
  protected async executeSparqlSelect(sparql: string) {
    // Send SPARQL to your endpoint, return JSON results
  }
  protected async executeSparqlUpdate(sparql: string) {
    // Send SPARQL UPDATE to your endpoint
  }
}
```

See the [SPARQL Algebra Layer docs](./documentation/sparql-algebra.md) for the full type reference, conversion algorithm, and store implementation guide.

## Linked Package Setup

Linked packages expose shapes, utilities, and ontologies through a small `package.ts` file. This makes module exports discoverable across Linked modules and enables linked decorators.

**Minimal `package.ts`**
```typescript
import {linkedPackage} from '@_linked/core/utils/Package';

export const {
  linkedShape,
  linkedUtil,
  linkedOntology,
  registerPackageExport,
  registerPackageModule,
  packageExports,
  getPackageShape,
} = linkedPackage('my-package-name');
```

**Decorators and helpers**
- `@linkedShape`: registers a Shape class and generates SHACL shape metadata
- `@linkedUtil`: exposes utilities to other Linked modules
- `linkedOntology(...)`: registers an ontology and (optionally) its data loader
- `registerPackageExport(...)`: manually export something into the Linked package tree
- `registerPackageModule(...)`: lower-level module registration
- `getPackageShape(...)`: resolve a Shape class by name to avoid circular imports

## Shapes

Linked uses Shape classes to generate SHACL metadata. Paths, target classes, and node kinds are expressed as `NodeReferenceValue` objects: `{id: string}`.

```typescript
import {Shape} from '@_linked/core';
import {ShapeSet} from '@_linked/core/collections/ShapeSet';
import {literalProperty, objectProperty} from '@_linked/core/shapes/SHACL';
import {createNameSpace} from '@_linked/core/utils/NameSpace';
import {linkedShape} from './package';

const ns = createNameSpace('https://example.org/');

// Example ontology references
const ex = {
  Person: ns('Person'),
  name: ns('name'),
  knows: ns('knows'),
  // ... rest of your ontology
};

@linkedShape
export class Person extends Shape {
  static targetClass = ex.Person;

  @literalProperty({path: ex.name, required: true, maxCount: 1})
  declare name: string;

  @objectProperty({path: ex.knows, shape: Person})
  declare knows: ShapeSet<Person>;
}
```

### Using ontology terms

A vocabulary package (`@_linked/schema`, `rdfs`, `owl`, `xsd`, `dcmi`, `dcat`, `org`, `sioc`, or
an app's own ontology package) exports one named term per class and property, generated from its
Turtle by `linked generate-ontology`. Use them like this:

- **Import the module as a namespace.** `schema.Person` reads like the Turtle's `schema:Person`,
  and a bundler keeps only the terms a module uses:

  ```typescript
  // With the imports of the §Shapes example; needs `@_linked/schema` and `@_linked/xsd` installed.
  import * as schema from '@_linked/schema/ontologies/schema';
  import * as xsd from '@_linked/xsd/ontologies/xsd';

  @linkedShape
  export class Event extends Shape {
    static targetClass = schema.Event;

    @literalProperty({path: schema.startDate, datatype: xsd.dateTime, maxCount: 1})
    declare startDate: Date;
  }
  ```

  There is no aggregated object (`import {schema} from …`). A local name that is not an
  identifier follows one rule: `schema:3DModel` is `schema._3DModel`, `schema:yield` is
  `schema.yield_`, `dcterms:ISO639-2` is `dcterms.ISO639_2`. The namespace function and the data
  helpers (`ns`, `dataFiles`, `loadData`, `_ontologyResource`) are in the sibling
  `ontologies/<prefix>.data` module.
- **Prefer the accessor over `{id}`.** `schema.name` is checked by the compiler and found by
  "go to definition"; `{id: 'http://schema.org/name'}` is a string nothing checks.
- **Use `{id}` (or `createNameSpace`) only for a namespace without a module**, such as a
  vocabulary no package mirrors, as in the §Shapes example.

### Owned properties (`contains` / `dependent`)

By default an object property is a plain *reference*: the two nodes exist independently, and
removing the link leaves the referenced node untouched. Two optional flags let you model
**composition** (ownership) instead, so the framework cleans owned nodes up automatically.

**`contains: true` on an object property** — the edge asserts *exclusive ownership* of the
value. Whenever that edge goes away, the owned node is deleted with it:

- `parent.delete()` deletes the owned child (and its owned sub-tree). So do the bulk deletes,
  `DeleteBuilder.from(Parent).all()` and `.where(...)`.
- `update({ownedProp: newValue})` **replaces** the owned node — the old one is deleted, not
  orphaned.
- `update({ownedProp: {remove: [x]}})` deletes `x` itself, not just the link.

Ownership belongs to the property, not to its predicate. A plain property of another shape on
the same predicate (say `ex:avatar` without `contains`) is a reference: replacing it or deleting
its subject never deletes the value, and it is not class-checked. A `contains` property needs a
`shape`; declaring one without it throws when the class is decorated.

```typescript
@linkedShape
export class Person extends Shape {
  static targetClass = ex.Person;

  // Person exclusively owns its avatar image. Replacing or clearing `avatar`,
  // or deleting the Person, deletes the old ImageObject too.
  @objectProperty({path: ex.avatar, shape: ImageObject, maxCount: 1, contains: true})
  declare avatar: ImageObject;
}
```

**Replace versus patch in place.** A plain nested object on a `contains` property is a
*replace*: a new node is created and the old one is deleted. To change the owned node itself,
update it directly:

```typescript
// Replace: creates a new ImageObject, deletes the old one.
await Person.update({avatar: {contentUrl: 'https://cdn.example.org/b.png'}}).for(personId);

// Patch in place: the same ImageObject keeps its id and its other fields.
await ImageObject.update({contentUrl: 'https://cdn.example.org/b.png'}).for(avatarId);

// Re-sending the current id is a no-op: the edge and the node are left as they are.
await Person.update({avatar: {id: avatarId}}).for(personId);
```

The same holds for an array overwrite of a `contains` set: ids you send again are kept, ids you
leave out are deleted. `{id: current, ...fields}` is a nested create with a predefined id, not a
patch: it deletes all of that node's triples and writes the new ones.

**Linking an existing node by `{id}`** is allowed, e.g. upload an image first, then attach it with
`{avatar: {id: uploadedId}}`. The link transfers ownership: the linked node is deleted when it is
replaced, removed, or when the owner is deleted.

Because of that, core checks the class of every id linked into a `contains` property that
declares a `shape`. A link is refused, and nothing is written, when the store already types the
node and none of its types (stored or inferred) is the shape's `targetClass` or the property's
`sh:class`. A subclass instance carries its superclasses' types through the store's inference, so
it is accepted:

```
Cannot link <https://my.app/alice> into the contains property "avatar" of <…/shape/my-pkg/Person>:
it is typed <https://example.org/Person>, but "avatar" only owns instances of <https://schema.org/ImageObject>. …
```

Ids that do not exist yet, or have no `rdf:type`, are allowed, so upload-then-attach works in
either write order. The check runs in `SparqlDataset` (one `SELECT` per mutation that links owned
ids, none otherwise). Plain references are never checked.

Two limits: an id linked while it is untyped, and typed as something else later, is not caught.
Nor is a node typed by another request between the check's `SELECT` and the `UPDATE` that
follows it: the two are separate requests, not one transaction. Raw SPARQL updates bypass the
check altogether. SHACL validation of `sh:class` is the backstop for all three.

**What a delete removes.** Deleting an owner deletes everything it owns (see the recursion
limit below): the values of its `contains` properties (own and inherited), the values *their* shapes own, and so on. A
replace or set-remove does the same below the old value. The walk follows the shapes, not the
predicates: from the owner's shape it follows that shape's `contains` properties to their value
shapes, then those shapes' `contains` properties. When a value is typed with a registered
sub-shape of the declared value shape, the `contains` properties the sub-shape adds are followed
too, but only from nodes of that sub-shape's class (`?img a ex:Photo . ?img ex:thumbnail ?t`,
which the store's inference also matches on the nodes of a subclass of `ex:Photo`).
The class must tell those nodes apart: an added property is not followed through the parent
(core warns once) when the sub-shape has no `targetClass`, shares it with one of its
super-shapes, or shares it (or a subclass of it) with another shape that holds the same predicate
as a plain property (through a simple path). Another shape that merely shares the class, without that predicate,
changes nothing. A copy of a sub-shape that adds nothing of its own, with the same class (a
"profile") or with no `targetClass` at all, is skipped silently: its parent's entry covers it.
When a sub-shape redeclares an inherited `contains` property without `contains`, the inherited
ownership still applies.

Recursion has a limit. A shape that owns its own kind (a list cell owning the next cell through
`rdf:rest`, a comment owning its replies) is followed to any depth (`rdf:rest*`). Any other cycle
(A owns B owns A, or a sub-shape's property leading back into its own kind) is followed hop by
hop, each hop checked against the class that declares it, for at most `MAX_OWNED_RECURSION` (4)
re-entries per path; values deeper than that are left in place, and so is anything behind an
untyped node on such a cycle. `rdf:nil`, the end of every list, is never deleted.

The bulk deletes (`.all()`, `.where(...)`) remove the same subtree for every matched subject; they
do not delete incoming references to the subjects, which a delete by id does. Bulk mutations are
polymorphic, like select and count: `Thing.deleteAll()` or `Thing.update(...).forAll()` matches
`?s a schema:Thing`, so it changes the instances of every subclass of `Thing` too.

Non-owning references to an owned node, through other properties or from other subjects, are
allowed. They are not cleaned up: after the owner is deleted they dangle. The same holds when two
subjects own one node (an `{id}` linked into a second owner, which breaks the single-owner rule
below): deleting either owner deletes the node, and the other owner's edge dangles.

**The single-owner constraint.** An owned node has at most one owner. Shape sync persists this as
one generated SHACL NodeShape per `contains` property (simple paths only). It is written only by
the class that declares the property, at the property shape's IRI plus `.singleOwner`:
`Thing.image` gets one constraint at `Thing`, not one per subclass. It is marked `core:generated
true` and has no `sh:targetClass`, so catalog readers can skip it, and it is never registered in
memory. It counts only instances of the declaring class (subclass instances included, through
the store's inference), so a plain reference through the same predicate from another class is
allowed. For `Thing.image`:

```turtle
<…/shape/my-pkg/Thing/image.singleOwner> a sh:NodeShape ;
    core:generated true ;
    sh:targetObjectsOf schema:image ;
    sh:property <…/Thing/image.singleOwner/owners> .

<…/Thing/image.singleOwner/owners> a sh:PropertyShape ;
    rdfs:label "owners" ;
    sh:path [ sh:inversePath schema:image ] ;
    sh:qualifiedValueShape [ sh:class schema:Thing ] ;
    sh:qualifiedMaxCount 1 .
```

`sh:class` follows `rdf:type/rdfs:subClassOf*`, so with the ontology hierarchy synced an
`ex:Project ⊑ schema:Thing` subject counts as an owner. A declaring shape without `targetClass`
gets no constraint (sync logs it once).

The inverse path is stored as an untyped blank node, as is every complex `sh:path` shape sync
writes (inverse, alternative, sequence, `*`/`+`/`?`): an IRI in `sh:path` is a predicate path to a
SHACL validator. Nothing marks them: `PropertyShape.path` and the path operator slots are
declared `sh:BlankNodeOrIRI`, see [Blank-node values](#blank-node-values-nodekind). Versions before 2.30 wrote IRI-named, typed path nodes (`…/owners/inv`, `…/region/seq/0`). The
next sync writes blank nodes and leaves those behind, unreferenced; re-create the dataset, or
delete them by IRI prefix (`…/owners/inv`, `…/seq/…`), to remove them.

Read a stored path's structure in the same query that finds it (`?ps sh:path ?p .
?p sh:inversePath ?x`): a blank node's label is not stable across queries.

Each step of a path is a prefixed name (`ex:name`) or an absolute IRI (`https://…`, `{id:
'urn:x:name'}`, or `<urn:x:name>` in the string syntax). A string step is written into a query as a
prefixed name only when it is one SPARQL prefixed-name token whose prefix is registered; any other
step is written as `<IRI>`, so `urn:prop:a` stays an IRI. A path read as data (`fromWire`,
`ShapeCatalog.from`, `registerRuntimeShape`) or given to a decorator is checked when it loads: a
step that is neither throws `InvalidPropertyPathError`, naming the step and its property shape.

The declaring shape owns its generated shapes through `core:generatedShape`, a `contains` edge:
`<…/Thing> core:generatedShape <…/Thing/image.singleOwner>`. Syncing a shape is still two
requests: deleting the shape deletes the generated shapes with it (their own triples, property
shapes and their blank path and qualified-shape nodes, never the predicate IRI), and the create writes the current ones nested in
the same request. A removed or renamed accessor therefore loses its constraint, a pruned shape
takes its constraints with it, and a NodeShape the shape does not own is never touched.
`singleOwnerShapeIri`, `singleOwnerProperties` and `buildSingleOwnerConstraints` are exported if
you need to recompute them.

Each constraint counts owners through its own predicate only. A node owned through two different
`contains` predicates (`schema:image` from one subject, `ex:attachments` from another) is not
reported. That needs overlapping value shapes, and the class check already refuses a wrongly
typed link.

> **Not enforced on write.** Core does not check the single-owner rule, or `sh:class` on
> non-owning references, when it writes. The default Fuseki setup does not validate SHACL on
> write either: a dataset exposes only query, update and graph-store services. Run a SHACL
> validator (Jena SHACL, pySHACL, …) against the persisted shapes to enforce them.

**`dependent: true` on a shape** is deprecated and has no effect: every node a `contains` property
reaches is deleted with its owner, whether or not its shape is `dependent`. It is still accepted,
and shape sync still persists it (`core:dependent`).

### Blank-node values (`nodeKind`)

Every node core writes is IRI-named unless the **property** that holds it says otherwise. A
nested create is written as a blank node when its property's `nodeKind` allows blank nodes:

| `nodeKind` of the property | nested value without an id | with an id |
|---|---|---|
| unset, `shacl.IRI` (the `objectProperty` default), `shacl.IRIOrLiteral` | IRI (minted) | IRI |
| `shacl.BlankNodeOrIRI` | blank node | IRI |
| `shacl.BlankNode` | blank node | error |
| `shacl.BlankNodeOrLiteral` | blank node | error |
| `shacl.Literal` | error | error |

```typescript
@linkedShape
export class Place extends Shape {
  static targetClass = ex.Place;

  @objectProperty({path: ex.geo, shape: GeoPoint, maxCount: 1, nodeKind: shacl.BlankNodeOrIRI})
  declare geo: GeoPoint;
}

// <place1> ex:geo _:b0 . _:b0 ex:lat "52.1" .
await Place.create({geo: {lat: '52.1'}}).withId(place1);
```

A blank node is written with its field triples only, without `rdf:type`: its shape is the one the
property declares. Nothing about it travels in DSL-JSON; the side that runs the mutation decides
from its own copy of the shape. Core uses this for SHACL paths: `PropertyShape.path`, the
`PathNode` slots and `PathList.first` / `.rest` are `sh:BlankNodeOrIRI`, so a predicate path (an
`{id}`) stays an IRI and every operator node and list cell becomes a blank node.

A blank value goes with what holds it. Deleting the subject (by id, `.all()`, `.where()`),
replacing or unsetting the property, and deleting or replacing an owned (`contains`) value at any
depth delete the blank value and the blank nodes below it, following only blank-capable properties.
Only blank nodes are deleted: an IRI the structure refers to (`schema:image` in
`[ sh:inversePath schema:image ]`, an entity a list lists) is never touched, nor is a blank node
reached through one. `contains` is not needed for this.

Not supported yet, and refused with an error rather than written wrongly:

- an `update` / `upsert` / `updateWhere` whose new value would be a blank node (its INSERT runs
  once per WHERE solution, so the node would be written several times). Create it with its
  parent, or give it an id under `sh:BlankNodeOrIRI`;
- addressing a blank node by id: linking `{id: '_:b0'}`, `update().for('_:b0')`, deleting
  `{id: '_:b0'}`. Change it through the property that holds it.

A select returns a blank value as its store label (Fuseki: `b0`), valid only within that result.

## Queries: Create, Select, Update, Delete

Queries are expressed with the same Shape classes and compile to a query object that a store executes.
Use this section as a quick start. Detailed query variations are documented in `Query examples` below.

A few quick examples:

**1) Select one field for all matching nodes**
```typescript
const names = await Person.select((p) => p.name);
/* names: {id: string; name: string}[] */
```

**2) Select all decorated fields of nested related nodes**
```typescript
const allFriends = await Person.select((p) => p.knows.selectAll());
/* allFriends: {
  id?: string; 
  knows: {
    id?: string; 
    ...all decorated Person fields...
  }[]
	}[] */
```

**3) Apply a simple mutation**
```typescript
const updated = await Person.update({name: 'Alicia'}).for({id: 'https://my.app/node1'});
/* updated: {id: string} & UpdatePartial<Person> */
```

## Storage configuration

`LinkedStorage` is the routing helper (not an interface). It routes query objects — by their target shape — to a dataset that implements `IDataset`.

```typescript
import {LinkedStorage} from '@_linked/core';
import {InMemoryStore} from '@_linked/rdf-mem-store';

LinkedStorage.setDefaultDataset(new InMemoryStore());
```

You can also route specific shapes to specific stores:

```typescript
LinkedStorage.setDatasetForShapes(new InMemoryStore(), Person);
```

### Config-driven setup: `parseDatasetsConfig` + `loadStores`

For apps that want to keep their storage wiring in JSON rather than code, `@_linked/core` ships two helpers that read a `linked.datasets.json`-style file (see [backlog 016](https://github.com/create-now/docs) for the canonical spec) and instantiate the stores per alias.

```ts
// @_linked/core/utils/parseDatasetsConfig — pure parser, browser-safe
parseDatasetsConfig(raw: unknown, env?: Record<string, string | undefined>): DatasetsConfig
```

Validates a config of the shape `{ datasets: { <alias>: { store: <npm-path>, config: { ... } } } }`, resolves `${VAR}` / `${VAR:-default}` placeholders in string leaves against `env`, strips `_*` comment keys, and throws on malformed input. Returns a typed `DatasetsConfig`.

```ts
// @_linked/core/utils/loadStores — async, backend-only
loadStores<T>(config: DatasetsConfig): Promise<Record<string, T>>
```

Dynamically imports each alias's `store` path and instantiates the resolved class with `new StoreClass(entry.config)`. Returns alias → store. The graph targets are not part of a store's config: they are one global setting (see [Ontology and shape graphs](#ontology-and-shape-graphs)); an entry whose config still sets `ontologyGraph` / `shapeGraph` gets a warning. Convention: the last segment of the `store` path is the named export to use (with `default` as a fallback). **Async + uses runtime dynamic `import()`** — works in Node where module specifiers resolve at runtime. Frontends can't use this (webpack can't bundle `import(variableString)`); frontend code instead imports each store class statically and constructs per alias by hand.

**Host loader.** When `globalThis[Symbol.for('@_linked/core:importModule')]` is a function `(specifier: string) => Promise<unknown>`, `loadStores` imports each store through it instead of `import()`, passing the `store` specifier unchanged; it is read on every call. `linked start` (dev) sets it so a store comes from the same copy of its package as the app's own imports under Vite's SSR runner. Nothing else needs to set it.

A typical backend setup looks like:

```ts
import rawConfig from './linked.datasets.json' assert { type: 'json' };
import { parseDatasetsConfig } from '@_linked/core/utils/parseDatasetsConfig';
import { loadStores } from '@_linked/core/utils/loadStores';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';

const config = parseDatasetsConfig(rawConfig, process.env);
const stores = await loadStores(config);

LinkedStorage.setDefaultDataset(stores.appData);
// or per-shape:
// LinkedStorage.setDatasetForShapes(stores.appData, [Person, BlogPost]);
```

The file holds what changes per deployment (stores, endpoints, credentials). Graph routing is not
part of it: the app routes shapes in code, e.g.
`LinkedStorage.setDatasetForShapes(stores.appData, [BlogPost], {graph: 'own'})` (see
`docs/architecture/ontologies.md`, Graph routing). An alias with a `graphs` key gets a warning
from `loadStores` and routes nothing.

Each store class must accept a single config-object argument (`new StoreClass(config)`). `@_linked/fuseki`'s `FusekiStore` and `@_linked/server`'s `BackendAPIStore` both follow this contract.

## File storage

`LinkedStorage` routes *quads*; `LinkedFileStorage` routes *files*. Files are addressed by **purpose** — a short string naming what the files are for (`uploads`, `appAssets`, …) — so an app can send release bundles to a CDN bucket and user uploads to another store without any caller knowing which.

```ts
import {LinkedFileStorage, FileStorePurposes} from '@_linked/core';
import {S3FileStore} from '@_linked/s3';

LinkedFileStorage.setDefaultStore(new S3FileStore({/* … */}));           // fallback for every purpose
LinkedFileStorage.setStore(FileStorePurposes.appAssets, new S3FileStore({/* cdn */}));

await LinkedFileStorage.getStore(FileStorePurposes.appAssets).saveFile('/app.js', bytes);
LinkedFileStorage.accessURLFor(FileStorePurposes.appAssets); // → https://cdn.example.com
```

### Resolution rule

`getStore(purpose)` resolves in one order, and there is no fourth case:

1. **configured** — a store was passed to `setStore(purpose, store)` → that store;
2. **registered but not configured** → the default store, with a one-time `console.debug` line saying the purpose has no dedicated store (the normal case for a single-store app; it throws instead if no default store is set);
3. **not registered** → throws, listing the known purposes. A typo like `'appAsset'` must not silently write release bundles into the uploads store.

`uploads` is an ordinary purpose with no special case: `setDefaultStore` configures *no* purpose, so `uploads` reaches the default store through the fallback in step 2, and `setStore('uploads', other)` wins whether it is called before or after `setDefaultStore`.

| Method | Meaning |
| --- | --- |
| `registerPurpose(purpose, {description?})` | Declare a purpose without configuring a store. |
| `setStore(purpose, store)` | Configure (and register) the store; calls `store.init()`. |
| `getStore(purpose)` | Resolve per the rule above. A **live reference** — call it per operation if config can change. |
| `hasStore(purpose)` | Whether a store was *explicitly configured*. Ignores the fallback, so it is `false` while `getStore` still works. Never use it as a guard before `getStore`. |
| `listPurposes()` | `{purpose, description?, configured}` for every declared purpose. |
| `accessURLFor(purpose)` | The `accessURL` of the resolved store. |
| `getDefaultStore()` / `setDefaultStore(store)` | The fallback store. `getDefaultDataset`/`setDefaultDataset` are `@deprecated` aliases that forward, kept until the next major. |

### Introducing a purpose from a package

Export the constant and register it **in the same module**, so importing the constant *is* the registration and load order resolves itself:

```ts
// @_linked/captures/purposes.ts
import {LinkedFileStorage} from '@_linked/core';

export const CapturesPurpose = 'captures';
LinkedFileStorage.registerPurpose(CapturesPurpose, {description: '3D capture artifacts.'});
```

A consumer that imports `CapturesPurpose` can call `getStore(CapturesPurpose)` immediately; an app that never splits it out simply gets the default store. Core ships only `FileStorePurposes.uploads` and `FileStorePurposes.appAssets` — a new purpose belongs in the package that owns the concept.

### Saving files: `SaveFileOptions`

```ts
await store.saveFile('/app.js', bytes, {
  mimeType: 'application/javascript',
  cacheControl: 'public, max-age=31536000, immutable',
  metadata: {release: '1.2.3'},
  preservePath: true, // keep a generated release key exactly as supplied
  preventDuplicates: true, // rename instead of overwriting when the path is taken
});

// Backwards compatible: a string third argument is read as the positional mimeType.
await store.saveFile('/photo.webp', bytes, 'image/webp', true);
```

`options.preventDuplicates` wins over the positional fourth argument. Implementations should start with `normalizeSaveFileOptions(options, preventDuplicates)`, which collapses both forms into one object.

Set `preservePath: true` only for generated object keys whose paths are already part of an external contract, such as
a release manifest. A store must either keep that key verbatim or reject it; it must not silently sanitise or rename
the key. Filesystem-backed stores must reject absolute and traversal paths before writing. Ordinary user uploads should
leave this option unset and retain the store's normal filename hygiene.

> **There is no core-wide `preventDuplicates` default.** When a caller does not specify one it stays `undefined` all the way to the store, and **each store applies its own**: `LocalFileStore` adds a random suffix, `S3FileStore` overwrites. Pass it explicitly whenever the behaviour matters — never assume a default.

### Optional `statFile`

```ts
const stat = await store.statFile?.('/app.js'); // FileStat | null | undefined
if (!stat) {
  // Store cannot report metadata, or the file is absent — skip verification.
} else if (stat.sha256) {
  // Only a real content hash verifies. `etag` is not one on S3.
}
```

`statFile` is optional by design: a store without it still publishes. A caller must treat a missing method (`undefined`) or a missing `sha256` as "cannot verify" and continue, rather than failing the upload or falling back to `etag`.

## Automatic data validation

SHACL shapes are ideal for data validation. Linked generates SHACL shapes from your TypeScript Shape classes, which you can sync to your store for schema-level validation. When your store enforces those shapes at runtime, you get both schema validation and runtime enforcement for extra safety.

## Schema-Parameterized Query DSL

The query DSL is schema-parameterized: you define your own SHACL shapes, and Linked exposes a type-safe, object-oriented query API for those shapes.

### Query feature overview (core)

- Basic selection (literals, objects, dates, booleans)
- Target a specific subject by `{id}` or instance
- Multiple paths and mixed results
- Nested paths (deep selection)
- Sub-queries on object/set properties
- Filtering with `where(...)` and `equals(...)`
- `and(...)` / `or(...)` combinations
- Set filtering with `some(...)` / `every(...)` (and implicit `some`)
- Outer `where(...)` chaining
- Counting: `.count()` for how many instances match, `.size()` for a property's value count
- Custom result formats (object mapping)
- Computed values — derive new fields with arithmetic, string, date, and comparison methods
- Expression-based WHERE filters (`p.name.strlen().gt(5)`)
- Standalone expressions with `Expr` — timestamps, conditionals, null coalescing
- Type casting with `.as(Shape)`
- MINUS exclusion (by shape, property, condition, multi-property, nested path)
- Sorting, limiting, and `.one()`
- Query context variables
- Preloading (`preloadFor`) for component-like queries
- Create / Update / Delete mutations (including bulk and conditional)
- Expression-based updates (`p => ({age: p.age.plus(1)})`)
- Dynamic query building with `SelectBuilder` (alias `QueryBuilder`)
- Composable field sets with `FieldSet`
- Mutation builders (`CreateBuilder`, `UpdateBuilder`, `DeleteBuilder`)
- DSL-JSON serialization (`toJSON` / `fromJSON`) — the standard wire format
- Query and FieldSet JSON serialization / deserialization

### Query examples

Result types are inferred from your Shape definitions and the selected paths. Examples below show abbreviated result shapes.

#### Basic selection
```typescript
/* names: {id: string; name: string}[] */
const names = await Person.select((p) => p.name);

/* friends: {
  id: string; 
  knows: { id: string }[]
}[] */
const friends = await Person.select((p) => p.knows);

const dates = await Person.select((p) => [p.birthDate, p.name]);
const flags = await Person.select((p) => p.isRealPerson);
```

#### Target a specific subject
```typescript
/* Result: {id: string; name: string} */
const one = await Person.select((p) => p.name).for({id: 'https://my.app/node1'});
const missing = await Person.select((p) => p.name).for({id: 'https://my.app/missing'}); // null
```

#### Multiple paths + nested paths
```typescript
/* Result: Array<{id: string; name: string; knows: Array<{id: string}>; bestFriend: {id: string; name: string}}> */
const mixed = await Person.select((p) => [p.name, p.knows, p.bestFriend.name]);
const deep = await Person.select((p) => p.knows.bestFriend.name);
```

#### Sub-queries
```typescript
const detailed = await Person.select((p) =>
  p.knows.select((f) => f.name),
);

const allPeople = await Person.selectAll();

const detailedAll = await Person.select((p) =>
  p.knows.selectAll(),
);
```

#### Where + equals
```typescript
const filtered = await Person.select().where((p) => p.name.equals('Semmy'));
const byRef = await Person.select().where((p) =>
  p.bestFriend.equals({id: 'https://my.app/node3'}),
);
```

#### And / Or
```typescript
const andQuery = await Person.select((p) =>
  p.knows.where((f) =>
    f.name.equals('Moa').and(f.hobby.equals('Jogging')),
  ),
);
const orQuery = await Person.select((p) =>
  p.knows.where((f) =>
    f.name.equals('Jinx').or(f.hobby.equals('Jogging')),
  ),
);
```

#### Set filtering (some/every)
```typescript
const implicitSome = await Person.select().where((p) =>
  p.knows.name.equals('Moa'),
);
const explicitSome = await Person.select().where((p) =>
  p.knows.some((f) => f.name.equals('Moa')),
);
const every = await Person.select().where((p) =>
  p.knows.every((f) => f.name.equals('Moa').or(f.name.equals('Jinx'))),
);
```

#### Outer where chaining
```typescript
const outer = await Person.select((p) => p.knows).where((p) =>
  p.name.equals('Semmy'),
);
```

#### Counting

Two different questions, two different queries.

`.count()` answers **how many instances match** — one number for the whole match set. It respects
`where` and `minus`, and ignores `limit`/`offset`, so a paged table can ask for its total row count
beside the page it is showing:

```typescript
/* Result: number */
const total = await Person.count();
const matching = await Person.select().where((p) => p.name.equals('Semmy')).count();

// Lowers to: SELECT (COUNT(DISTINCT ?a0) AS ?count) WHERE { ?a0 a Person ; name ?n . FILTER(…) }
```

`.size()` answers **how many values a property has**, per row:

```typescript
/* Result: Array<{id: string; knows: number}> */
const perPerson = await Person.select((p) => p.knows.size());
```

A count resolves to a real number and **rejects on failure** — it never reports an unreachable store
as `0`. `.toCount()` gives you the count query itself, for a router that forwards
(`builder.toCount().toJSON()`) rather than executes.

#### Triples reads (no shape)

Two reads answer triples rather than rows, for data no shape describes (a draft graph, an import's
staging graph, a node of unknown type):

```typescript
import {DraftGraph, TriplesBuilder} from '@_linked/core';
import {rdf} from '@_linked/core/ontologies/rdf';

// Every triple of one graph, registered or not. Routed like DraftGraph's graph queries, so it
// reads where DraftGraph.replaceContent(graph, body) writes.
const draft = await DraftGraph.readContent(graph).limit(1001);

// One subject's triples (as a subject), under any type or none: in these graphs, or where a
// shapeless ask of it looks (the default graph, or every graph the store's routing knows).
const staged = await TriplesBuilder.forNode({id: instanceId}).from(importGraph).exec(dataset);
const types = staged.filter((t) => t.predicate.id === rdf.type.id).map((t) => t.object);
```

Each answer is a `Triple[]`: `{subject, predicate, object, graph?}`. An IRI is `{id}`, a blank node
`{id: '_:label'}` (the label holds within that answer only), and a literal `{value, datatype,
language?}` with its lexical form and its datatype as `{id}` (`xsd:string` for a plain literal,
`rdf:langString` for a tagged one), so a read writes back unchanged. `graph` is the named graph
the triple was read in, absent for the default graph. `.limit(n)` bounds a read; no order is
implied. `.from()` takes what select's `.from()` takes, portable names included. A read with
neither a subject nor a graph is refused.

A triples read is plain data (`toTriplesQuery()`, `parseTriplesQuery()` at a wire boundary) sent to
the optional `IDataset.triplesQuery`. `SparqlDataset` answers it with one `SELECT`; a dataset
without the method is refused. `LinkedStorage` sends a graph read where its record class's graph
queries go, and a subject read (no shape, no routing key) to every dataset it knows, joining the
answers up to the limit, as it asks a shapeless ask. A router forwards it as a read.

#### Custom result formats
```typescript
/* Result: Array<{id: string; nameIsMoa: boolean; numFriends: number}> */
const custom = await Person.select((p) => ({
  nameIsMoa: p.name.equals('Moa'),
  numFriends: p.knows.size(),
}));
```

#### Computed expressions

You can compute derived values directly in your queries — string manipulation, arithmetic, date extraction, and more. Expression methods chain naturally left-to-right.

```typescript
// String length as a computed field
const withLen = await Person.select((p) => ({
  name: p.name,
  nameLen: p.name.strlen(),
}));

// Arithmetic chaining (left-to-right, no hidden precedence)
const withAge = await Person.select((p) => ({
  name: p.name,
  ageInMonths: p.age.times(12),
  agePlusTen: p.age.plus(10).times(2),  // (age + 10) * 2
}));

// String manipulation
const upper = await Person.select((p) => ({
  shout: p.name.ucase(),
  greeting: p.name.concat(' says hello'),
}));

// Date extraction
const birthYear = await Person.select((p) => ({
  year: p.birthDate.year(),
}));
```

**Expression methods by type:**

| Type | Methods |
|------|---------|
| **Numeric** | `plus`, `minus`, `times`, `divide`, `abs`, `round`, `ceil`, `floor`, `power` |
| **String** | `concat`, `contains`, `startsWith`, `endsWith`, `substr`, `before`, `after`, `replace`, `ucase`, `lcase`, `strlen`, `encodeForUri`, `matches` |
| **Date** | `year`, `month`, `day`, `hours`, `minutes`, `seconds`, `timezone`, `tz` |
| **Boolean** | `and`, `or`, `not` |
| **Comparison** | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` |
| **Null-handling** | `isDefined`, `isNotDefined`, `defaultTo` |
| **Type** | `str`, `iri`, `isIri`, `isLiteral`, `isBlank`, `isNumeric`, `lang`, `datatype` |
| **Hash** | `md5`, `sha256`, `sha512` |

#### Expression-based WHERE filters

Expressions can be used in `where()` clauses for computed filtering:

```typescript
// Filter by string length
const longNames = await Person.select((p) => p.name)
  .where((p) => p.name.strlen().gt(5));

// Filter by arithmetic
const young = await Person.select((p) => p.name)
  .where((p) => p.age.plus(10).lt(100));

// Chain expressions with and/or
const filtered = await Person.select((p) => p.name)
  .where((p) => p.name.strlen().gt(3).and(p.age.gt(18)));

// Expression WHERE on nested paths
const deep = await Person.select((p) => p.name)
  .where((p) => p.bestFriend.name.strlen().gt(3));

// Expression WHERE on mutations
await Person.update({status: 'senior'}).where((p) => p.age.plus(10).gt(65));
```

#### `Expr` module

Some expressions don't belong to a specific property — like getting the current timestamp, picking the first non-null value, or conditional logic. Use the `Expr` module for these:

```typescript
import {Expr} from '@_linked/core';

// Current timestamp
const withTimestamp = await Person.update({lastSeen: Expr.now()}).for(entity);

// Conditional expressions
const labeled = await Person.select((p) => ({
  label: Expr.ifThen(p.age.gt(18), 'adult', 'minor'),
}));

// First non-null value
const display = await Person.select((p) => ({
  display: Expr.firstDefined(p.name, p.nickNames, 'Unknown'),
}));
```

#### Query As (type casting to a sub shape)
Cast to a subtype when you know the concrete shape — for example, selecting dog-specific properties from a pets collection:
```typescript
const guards = await Person.select((p) => p.pets.as(Dog).guardDogLevel);
```

#### MINUS (exclusion)
```typescript
// Exclude by shape — all Persons that are NOT also Employees
const nonEmployees = await Person.select((p) => p.name).minus(Employee);

// Exclude by property existence — Persons that do NOT have a hobby
const noHobby = await Person.select((p) => p.name).minus((p) => p.hobby);

// Exclude by multiple properties — Persons missing BOTH hobby AND nickNames
const sparse = await Person.select((p) => p.name).minus((p) => [p.hobby, p.nickNames]);

// Exclude by nested path — Persons whose bestFriend does NOT have a name
const unnamed = await Person.select((p) => p.name).minus((p) => [p.bestFriend.name]);

// Exclude by condition — Persons whose hobby is NOT 'Chess'
const noChess = await Person.select((p) => p.name).minus((p) => p.hobby.equals('Chess'));
```

#### Sorting, limiting, one
```typescript
const sorted = await Person.select((p) => p.name).orderBy((p) => p.name, 'ASC');
const limited = await Person.select((p) => p.name).limit(1);
const single = await Person.select((p) => p.name).one();
```

#### Query context
Query context lets you inject request-scoped values (like the current user) into filters without threading them through every call.

```typescript
setQueryContext('user', {id: 'https://my.app/user1'}, Person);
const ctx = await Person.select((p) => p.name).where((p) =>
  p.bestFriend.equals(getQueryContext('user')),
);
```

#### Preload
Preloading appends another query to the current query so the combined data is loaded in one round-trip. This is helpful when rendering a nested tree of components and loading all data at once.

```typescript
const preloaded = await Person.select((p) => [
  p.hobby,
  p.bestFriend.preloadFor(ChildComponent),
]);
```

#### Create

```typescript
/* Result: {id: string} & UpdatePartial<Person> */
const created = await Person.create({name: 'Alice'});
```
Where UpdatePartial<Shape> reflects the created properties.

#### Update

Update will patch any property that you send as payload and leave the rest untouched. The data to update is required:

```typescript
// Target a specific entity with .for(id)
/* Result: {id: string} & UpdatePartial<Person> */
const updated = await Person.update({name: 'Alicia'}).for({id: 'https://my.app/node1'});
```
Returns:
```json
{
  id:"https://my.app/node1",
  name:"Alicia"
}
```

**Expression-based updates:**

Instead of static values, you can compute new values from existing ones. Pass a callback to reference the entity's current properties:

```typescript
// Increment age by 1
await Person.update((p) => ({age: p.age.plus(1)})).for({id: 'https://my.app/node1'});

// Uppercase a name
await Person.update((p) => ({name: p.name.ucase()})).for({id: 'https://my.app/node1'});

// Reference related entity properties
await Person.update((p) => ({hobby: p.bestFriend.name.ucase()})).for({id: 'https://my.app/node1'});

// Mix literals and expressions
await Person.update((p) => ({name: 'Bob', age: p.age.plus(1)})).for({id: 'https://my.app/node1'});

// Use Expr module values directly in plain objects
await Person.update({lastSeen: Expr.now()}).for({id: 'https://my.app/node1'});
```

The callback is type-safe — `.plus()` only appears on number properties, `.ucase()` only on strings, etc.

**Conditional and bulk updates:**
```typescript
// Update all matching entities
const archived = await Person.update({status: 'archived'}).where(p => p.status.equals('inactive'));

// Update all instances of a shape
await Person.update({verified: true}).forAll();
```

**Updating multi-value properties**
When updating a property that holds multiple values (one that returns an array in the results), you can either overwrite all the values with a new explicit array of values, or delete from/add to the current values.

To overwrite all values:
```typescript
// Overwrite the full set of "knows" values.
const overwriteFriends = await Person.update({
  knows: [{id: 'https://my.app/person2'}],
}).for({id: 'https://my.app/person1'});
```
The result will contain an object with `updatedTo`, to indicate that previous values were overwritten to this new set of values:
```json
{
  id: "https://my.app/person1",
  knows: {
    updatedTo: [{id:"https://my.app/person2"}],
  }
}
```

To make incremental changes to the current set of values you can provide an object with `add` and/or `remove` keys:
```typescript
// Add one value and remove one value without replacing the whole set.
const addRemoveFriends = await Person.update({
  knows: {
    add: [{id: 'https://my.app/person2'}],
    remove: [{id: 'https://my.app/person3'}],
  },
}).for({id: 'https://my.app/person1'});
```
This returns an object with the added and removed items
```json
{
  id: "https://my.app/person1",
  knows: {
    added?: [{id:"https://my.app/person2"},
    removed?: [{id:"https://my.app/person3"}],
  }
}
```


#### Delete

```typescript
// Delete a single node
const deleted = await Person.delete({id: 'https://my.app/node1'});

// Delete multiple nodes
const deleted = await Person.delete([{id: 'https://my.app/node1'}, {id: 'https://my.app/node2'}]);

// Delete all instances of a shape (with their blank-node values)
await Person.deleteAll();

// Conditional delete
await Person.deleteWhere(p => p.status.equals('inactive'));
```


## Extending shapes

Shape classes can extend other shape classes. Subclasses inherit property shapes from their superclasses and may override them.
This example assumes `Person` from the `Shapes` section above.

```typescript
import {literalProperty} from '@_linked/core/shapes/SHACL';
import {linkedShape} from './package';

@linkedShape
export class Employee extends Person {
  static targetClass = ex.Employee;

  // Override inherited "name" with stricter constraints (still maxCount: 1)
  @literalProperty({path: ex.name, required: true, minLength: 2, maxCount: 1})
  declare name: string;

  @literalProperty({path: ex.employeeId, required: true, maxCount: 1})
  declare employeeId: string;
}
```

Override behavior:

- `getUniquePropertyShapes(SomeShape.shape)` returns one property shape per label, with subclass overrides taking precedence.
- Overrides are tighten-only, and a widening throws at registration: `minCount` may not go down,
  `maxCount` may not go up, `nodeKind` may not widen, `datatype` may not change, a value `shape`
  must be the inherited one or a sub-shape of it, `contains` may not be dropped
  (`contains: false`), and the path may not change. A new label whose path an inherited property
  already declares is refused too (redeclare it under the inherited label).
- A narrower `class` needs the class hierarchy, so the shape check (`checkShapeHierarchy`, run by
  `linked build`) reports an override whose `class` is not the inherited class or a subclass of it
  as an `override-not-tightened` error.
- A shape known only as data (registered from a store at runtime) is never refused: every case is
  a warning there, and an `override-not-tightened` warning in the shape check.
- An override that omits `minCount`, `maxCount`, `nodeKind`, `datatype`, `class`, value `shape` or
  `contains` keeps the inherited value.
- `pattern` and the other value constraints are not compared.

## Dynamic Query Building

The DSL (`Person.select(...)`) is ideal when you know shapes at compile time. For apps that need to build queries at runtime — CMS dashboards, configurable reports, API endpoints that accept field selections — use `QueryBuilder` and `FieldSet`.

### SelectBuilder

`SelectBuilder` provides a fluent, chainable API for constructing select queries programmatically. It
accepts a Shape class or a shape IRI string. (`QueryBuilder` is a deprecated alias for `SelectBuilder`
and is used in the examples below; the mutation builders are `CreateBuilder`/`UpdateBuilder`/`DeleteBuilder`.)

```typescript
import {QueryBuilder} from '@_linked/core'; // alias of SelectBuilder

// From a Shape class
const query = QueryBuilder.from(Person)
  .select(p => [p.name, p.knows])
  .where(p => p.name.equals('Semmy'))
  .limit(10);

// From a shape IRI string (when the Shape class isn't available at compile time)
const query = QueryBuilder.from('https://schema.org/Person')
  .select(['name', 'knows'])
  .where(p => p.name.equals('Semmy'));

// SelectBuilder is PromiseLike — await it directly
const results = await query;

// Serialize to DSL-JSON, or lower to the IR without executing
const json = query.toJSON();
const ir = lower(query);   // `lower` is a free import from '@_linked/core'
```

**Target specific entities:**
```typescript
// Single entity — result is unwrapped (not an array)
const person = await QueryBuilder.from(Person)
  .for({id: 'https://my.app/person1'})
  .select(p => p.name);

// Multiple entities
const people = await QueryBuilder.from(Person)
  .forAll([{id: 'https://my.app/p1'}, {id: 'https://my.app/p2'}])
  .select(p => p.name);
```

**Sorting, limiting, and single results:**
```typescript
const topFive = await QueryBuilder.from(Person)
  .select(p => p.name)
  .orderBy(p => p.name, 'ASC')
  .limit(5);

const first = await QueryBuilder.from(Person)
  .select(p => p.name)
  .one();
```

**Select with a FieldSet:**
```typescript
const fields = FieldSet.for(Person, ['name', 'knows']);
const results = await QueryBuilder.from(Person).select(fields);
```

### FieldSet — composable field selections

`FieldSet` is an independent, reusable object that describes which fields to select from a shape. Create them, compose them, and feed them into queries.

**Creating a FieldSet:**
```typescript
import {FieldSet} from '@_linked/core';

// From a Shape class with string field names
const fs = FieldSet.for(Person, ['name', 'knows']);

// From a Shape class with a type-safe callback
const fs = FieldSet.for(Person, p => [p.name, p.knows]);

// From a shape IRI string (when you only have the shape's IRI)
const fs = FieldSet.for('https://schema.org/Person', ['name', 'knows']);

// Select all decorated properties
const allFields = FieldSet.all(Person);

// Select all properties with depth (includes nested shapes)
const deep = FieldSet.all(Person, {depth: 2});
```

**Nested fields:**
```typescript
// Dot-separated paths for nested properties
const fs = FieldSet.for(Person, ['name', 'knows.name']);

// Object form for nested sub-selections
const fs = FieldSet.for(Person, [{knows: ['name', 'hobby']}]);
```

**Composing FieldSets:**
```typescript
const base = FieldSet.for(Person, ['name']);

// Add fields
const extended = base.add(['knows', 'birthDate']);

// Remove fields
const minimal = extended.remove(['birthDate']);

// Pick specific fields
const picked = extended.pick(['name', 'knows']);

// Merge multiple FieldSets
const merged = FieldSet.merge([fieldSet1, fieldSet2]);
```

**Inspecting a FieldSet:**
```typescript
const fs = FieldSet.for(Person, ['name', 'knows']);
fs.labels();  // ['name', 'knows']
fs.paths();   // [PropertyPath, PropertyPath]
```

**Use cases:**

```typescript
// Dynamically selected fields from a UI
const fields = FieldSet.for(Person, userSelectedFields);
const results = await QueryBuilder.from(Person).select(fields);

// API gateway: accept fields as query parameters
const fields = FieldSet.for(Person, req.query.fields.split(','));
const results = await QueryBuilder.from(Person).select(fields);

// Component composition: merge field sets from child components
const merged = FieldSet.merge([headerFields, sidebarFields, contentFields]);
const results = await QueryBuilder.from(Person).select(merged);

// Progressive loading: start minimal, add detail on demand
const summary = FieldSet.for(Person, ['name']);
const detail = summary.add(['email', 'knows', 'birthDate']);
```

### Mutation Builders

The mutation builders are the programmatic equivalent of `Person.create(...)`, `Person.update(...)`, and `Person.delete(...)`. They accept Shape classes or shape IRI strings.

```typescript
import {CreateBuilder, UpdateBuilder, DeleteBuilder} from '@_linked/core';

// Create — equivalent to Person.create({name: 'Alice'})
const created = await CreateBuilder.from(Person)
  .set({name: 'Alice'})
  .withId('https://my.app/alice');

// Update — equivalent to Person.update({name: 'Alicia'}).for({id: '...'})
const updated = await UpdateBuilder.from(Person)
  .for({id: 'https://my.app/alice'})
  .set({name: 'Alicia'});

// Delete by ID — equivalent to Person.delete({id: '...'})
const deleted = await DeleteBuilder.from(Person, {id: 'https://my.app/alice'});

// Delete all — equivalent to Person.deleteAll()
await DeleteBuilder.from(Person).all();

// Conditional update — equivalent to Person.update({...}).where(fn)
await UpdateBuilder.from(Person).set({verified: true}).forAll();

// All builders are PromiseLike — await them to run, toJSON() for the wire form,
// or lower() (a free function) for the IR
import {lower} from '@_linked/core';
const ir = lower(CreateBuilder.from(Person).set({name: 'Alice'}));
```

### Shape catalogs — queries against shapes you do not register

The shape registry holds one definition per IRI. A host serving several projects (or branches)
that share shape IRIs with different properties resolves each query against a `ShapeCatalog`
instead:

```typescript
import {ShapeCatalog, withShapeCatalog, fromJSON} from '@_linked/core';

const branch = ShapeCatalog.from(nodeShapeWires, {name: 'project-1#main'}); // immutable
const query = withShapeCatalog(branch, () =>
  SelectBuilder.from('https://example.org/shape/Person').select(['name']),
);
await query; // lowers and compiles against `branch`, though the scope has closed

const received = fromJSON(json, {catalog: branch}); // the wire never carries a catalog
```

A builder keeps the catalog it was made in (`catalogOf(query)`), through clones, `exists()`,
`count()`, lowering, compile and live queries. Inside a scope every registry read sees the
catalog's shapes plus core's built-ins (always from code, though `syncShapes` writes them
into every dataset); a class the catalog does not hold keeps resolving
globally. See [runtime instances](./docs/architecture/runtime-instances.md#shape-catalogs).

### DSL-JSON — the standard query format

Every Linked query — select **and** every mutation — has one canonical, language-neutral form:
**DSL-JSON**. `query.toJSON()` serializes any query to a compact, lossless JSON object;
`fromJSON(json)` rehydrates it back into a live query you can run, inspect, or re-serialize. This is
the format to send over HTTP, cache, queue, persist in a query-editor UI, or implement on a non-JS
backend. See the full **[DSL-JSON specification](./documentation/dsl-json.md)**.

```typescript
import {fromJSON} from '@_linked/core';

// Any query → JSON (outbound)
const json = Person.select(p => [p.name, p.knows])
  .where(p => p.name.equals('Semmy'))
  .toJSON();

// JSON → live query → run it (inbound). `fromJSON` detects the kind (select/create/update/delete).
const results = await fromJSON(json).exec();
```

Every envelope carries a wire version (`v`) and the target shape. A select:

```json
{
  "v": "1.0",
  "shape": "https://schema.org/Person",
  "fields": [{ "path": "name" }, { "path": "hobby" }],
  "limit": 10
}
```

A create:

```json
{
  "v": "1.0",
  "op": "create",
  "shape": "https://schema.org/Person",
  "data": {
    "shape": "https://schema.org/Person",
    "fields": [
      { "prop": "name",  "value": { "kind": "lit", "value": "Alice" } },
      { "prop": "hobby", "value": { "kind": "lit", "value": "Chess" } }
    ]
  }
}
```

An update targeting one node, and a delete by id:

```json
{ "v": "1.0", "op": "update", "shape": "https://schema.org/Person", "mode": "for",
  "targetId": "https://my.app/alice",
  "data": { "shape": "https://schema.org/Person",
            "fields": [{ "prop": "hobby", "value": { "kind": "lit", "value": "Go" } }] } }
```
```json
{ "v": "1.0", "op": "delete", "shape": "https://schema.org/Person", "mode": "ids",
  "ids": ["https://my.app/alice"] }
```

A query can also reference the current **context** (e.g. the signed-in user) without resolving it
yet — it travels as a `{$ctx}` marker and is resolved wherever the query is finally run:

```json
{ "v": "1.0", "shape": "https://schema.org/Person",
  "fields": [{ "path": "name" }], "subject": { "$ctx": "user" }, "singleResult": true }
```

`FieldSet` serializes the same way (`FieldSet.for(Person, ['name','knows']).toJSON()` /
`FieldSet.fromJSON(json)`).

## Live queries

A live query keeps its result current: subscribe once, and whenever something changes that the query
can have read — a local mutation, a change reported by a dataset's feed, or one you publish yourself —
it fetches again and notifies its listeners. The store is framework-free and lives in core; UI
bindings such as `@_linked/react` sit on top of it. Full guide: **[documentation/live-queries.md](./documentation/live-queries.md)**.

```typescript
const live = Team.select((t) => [t.name, t.members.size()]).for({id: teamId}).live();
const first = await live;                       // first data; the handle stays live
live.subscribe((state) => render(state.data));  // every later result
live.close();

Team.select().toCount().live((s) => setTotal(s.data)); // listener shorthand; counts and asks go live too

await Team.update({members: {add: [{id: personId}]}}).for({id: teamId});
// → every live query that reads this team's members refetches; unrelated ones do not.
```

- `queryDependencies(query)` and `mutationEffects(mutation, result?)` describe, in predicate IRIs, what a
  query reads and what a mutation writes; the store matches the two (by node id where it can, template-wide
  where it must, scoped by shape).
- `subscribeQueryDispatch(listener)` observes every query that runs through the dispatch, `exec(target)` included.
- A dataset can report changes made elsewhere through the optional `IDataset.subscribeChanges(listener)`;
  `publishChange(event)` does the same from application code; `invalidate(Shape | {id} | query)` is the manual lever.

## Shared state and error brands

A framework module can be evaluated twice in one process (under `linked start`, once by Vite's SSR
module runner and once by Node) or twice in a browser. Two conventions make that second copy harmless:

- **Module state lives on `globalThis`.** A module-level value that more than one caller reads or writes
  (a registry, a configured singleton, a static that callers assign) is kept with `sharedState`, under
  `Symbol.for('<pkg>:<name>')`, so every copy reads and writes the same container:

  ```ts
  import {sharedState} from '@_linked/core';
  const state = sharedState('@_linked/my-pkg', 'Mailer.state', () => ({provider: null as Provider | null}));
  export function setProvider(p: Provider) { state.provider = p; }
  ```

- **Errors are matched by brand, not `instanceof`.** A framework error class is branded once with
  `brandLinkedError(Cls, '<pkg>', '<ClassName>')`, and code that catches an error from another package
  checks it with `isLinkedError(err, Cls)`. That matches an instance thrown by any copy of the defining
  module, and a subclass instance against its base.

  ```ts
  export class StoreError extends Error {}
  brandLinkedError(StoreError, '@_linked/my-pkg', 'StoreError');
  // elsewhere
  if (isLinkedError(err, StoreError)) { /* … */ }
  ```

- **Class checks on another package's values use `isLinkedInstance`.** `value instanceof Shape` is
  false for a value another copy of core made. `isLinkedInstance(value, Cls)` also matches it, for
  any class branded with `brandLinkedClass(Cls, '<pkg>', '<ClassName>')`, and falls back to
  `instanceof` for one that is not. Core brands `Shape`, `ShapeSet`, `CoreSet`, the query builders
  (`QueryBuilder`/`SelectBuilder`, `CreateBuilder`, `UpdateBuilder`, `DeleteBuilder`, `AskBuilder`,
  `CountBuilder`), `PendingQueryContext`, `FieldSet`, `PropertyPath`, `ExpressionNode`,
  `ExistsCondition` and the query-proxy classes. Pass `Sub.prototype` to ask whether `Sub` extends
  `Cls`.

  ```ts
  import {isLinkedInstance, Shape} from '@_linked/core';
  if (isLinkedInstance(input, Shape)) return input.id;
  ```

Core's own module state (query contexts and their listeners, `LinkedFileStorage`'s stores,
`LinkedErrorLogging`'s logger, `Prefix`, the default page limit, ontology registrations, package
publish roots, node-shape callbacks and catalog adapters) is kept with `sharedState`, so every copy
sees the same values.

The full convention, including what stays per copy and how React contexts are handled, is in
[shared state and error brands](https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md).

## TODO

- Allow `preloadFor` to accept another query (not just a component).
- Make and expose functions for auto syncing shapes to the graph.

## Datasets, target languages, and the IR

A **dataset** (`IDataset`) receives the live query and decides what to do with it. `LinkedStorage`
routes each query to a dataset by its target shape. A dataset can:

- **execute it directly** against an in-memory graph,
- **forward it** as [DSL-JSON](./documentation/dsl-json.md) (`query.toJSON()`) to another service, or
- **lower it to an algebra** for a query engine, via the free `lower(query)` function.

**SPARQL is built in.** This package ships a `SparqlStore` base class (`@_linked/core/sparql`) — extend
it for any SPARQL endpoint. Internally it calls `lower(query)` to obtain a normalized
**[Intermediate Representation (IR)](./documentation/intermediate-representation.md)** and compiles that
to SPARQL.

The **IR is an internal lowering target, not the contract** — DSL-JSON is. It is a shape-resolved,
normalized algebra, which makes it a convenient thing to compile *from*: a backend for another target
language (SQL, a graph API, …) can consume the IR as-is, or just use it as a reference and lower
DSL-JSON to its own algebra directly. The IR is reached only through `lower()`, and the query
builders/serialization carry no dependency on it — so a client that never lowers (e.g. a frontend that
only builds and forwards queries) tree-shakes the entire IR + SPARQL pipeline out of its bundle. The IR
types are available from `@_linked/core/queries/IntermediateRepresentation`; see the
[IR docs](./documentation/intermediate-representation.md) for the type reference and the dataset
implementer guide.

**Store packages:**

- `SparqlStore` base class — included in `@_linked/core/sparql`, extend it for any SPARQL endpoint
- `@_linked/rdf-mem-store` — in-memory RDF store

## Running the tests

`npm test` runs the unit tests and the typecheck. The live Fuseki tests (`[fuseki]` blocks) run
only against a store the environment names, with no default:

```bash
export FUSEKI_BASE_URL=http://localhost:3321   # a free port, for a Fuseki of your own
export FUSEKI_ADMIN_PASSWORD=admin
REQUIRE_FUSEKI=1 npm test
```

- Without `FUSEKI_BASE_URL` and `FUSEKI_ADMIN_PASSWORD` no Fuseki is contacted: the live tests are
  reported as skipped, and a run under `CI` or `REQUIRE_FUSEKI=1` fails, naming the variables.
- When the URL is unreachable, global setup starts the inferring image
  (`ghcr.io/linked-fw/fuseki`, `LINKED_FUSEKI_IMAGE` for another) with Docker on its port, and
  stops it after the run. A reachable store must infer `rdf:type` through `rdfs:subClassOf`.
- The tests create datasets named `linked-core-test-*`, and setup and teardown delete those and
  nothing else. Two runs on one store would delete each other's: give each concurrent run its own
  store (port).
- A store global setup starts runs under the compose project `linked-core-test-<port>`
  (`LINKED_CORE_TEST_COMPOSE_PROJECT` for another name).
- Never point the variables at a store another project uses. `npm run test:fuseki` runs only the
  live tests; CI runs `npm run test:ci`, which sets them for the runner and refuses to run
  elsewhere.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
