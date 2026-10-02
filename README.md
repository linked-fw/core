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

### Owned properties (`contains` / `dependent`)

By default an object property is a plain *reference*: the two nodes exist independently, and
removing the link leaves the referenced node untouched. Two optional flags let you model
**composition** (ownership) instead, so the framework cleans owned nodes up automatically.

**`contains: true` on an object property** — the edge asserts *exclusive ownership* of the
value. Whenever that edge goes away, the owned node is deleted with it:

- `parent.delete()` deletes the owned child (and its owned sub-tree).
- `update({ownedProp: newValue})` **replaces** the owned node — the old one is deleted, not
  orphaned.
- `update({ownedProp: {remove: [x]}})` deletes `x` itself, not just the link.

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

**`dependent: true` on a shape** — marks the shape's *instances* as having no independent
existence, so they are cascade-deleted when reached through a `contains` edge from a parent
being deleted. Use it for structural nodes that are only ever owned (e.g. list cells, path
nodes). It is **not** required for the replace/remove cleanup above — a `contains` edge alone
is sufficient for the immediately-owned node; `dependent` extends the cascade to owned
*descendants* several hops deep.

```typescript
@linkedShape({dependent: true})
export class ListCell extends Shape { /* ... */ }
```

> Rule of thumb: put `contains` on the **property** that owns the value; put `dependent` on the
> **shape** whose instances never stand alone. They are separate mechanisms — `contains` decides
> *what to follow*, `dependent` decides *what may be deleted when reached*.

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

Dynamically imports each alias's `store` path and instantiates the resolved class with `new StoreClass(entry.config)`. Returns alias → store. Convention: the last segment of the `store` path is the named export to use (with `default` as a fallback). **Async + uses runtime dynamic `import()`** — works in Node where module specifiers resolve at runtime. Frontends can't use this (webpack can't bundle `import(variableString)`); frontend code instead imports each store class statically and constructs per alias by hand.

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

// Delete all instances of a shape (with blank node cleanup)
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
- Overrides must be tighten-only for `minCount`, `maxCount`, and `nodeKind` (widening is rejected at registration time).
- If an override omits `minCount`, `maxCount`, or `nodeKind`, inherited values are kept.
- Current scope: compatibility checks for `datatype`, `class`, and `pattern` are not enforced yet.

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

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
