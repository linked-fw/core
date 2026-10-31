# Intermediate Representation (IR)

IR stands for **Intermediate Representation**.

> **The IR is not the Linked query contract — [DSL-JSON](./dsl-json.md) is.**
>
> DSL-JSON is the standardized, language-neutral structure for a Linked query (what crosses
> boundaries and what you implement against). The IR is an *internal* algebra that the core lowers
> a query into on the way to **SPARQL** — the one target language that ships in this package. It is
> shape-resolved and normalized, which makes it a convenient thing to compile *from*: a backend for
> another target language (SQL, a graph API, …) can consume the IR as-is, or simply take it as a
> reference/inspiration and lower DSL-JSON to its own algebra directly. Either way, the IR is an
> implementation detail of a store, reached only through the free `lower(query)` function — never
> something a query author or the wire format depends on.

This document describes that IR structure, for anyone implementing or studying the SPARQL lowering
(or building their own).

## Design goals

- A normalized, shape-resolved algebra that the SPARQL layer (and other target-language compilers, if
  they choose) can consume.
- Deterministic structure for golden fixtures.
- Preserve DSL behavior while normalizing output shape.

## Canonical invariants

1. Every node has a `kind` discriminator.
2. Shape/property references are plain ID strings.
3. Select projection is a flat list of `{alias, expression}`.
4. Quantifiers are normalized (`some` -> `exists_expr`, `every` -> `not_expr(exists_expr(not_expr(...)))`).
5. Mutation kinds are explicit (`create`, `update`, `delete`).

## Pipeline architecture

The IR is produced by a three-stage pipeline, invoked by `buildSelectQuery()`:

```
RawSelectInput → Desugar → Canonicalize → Lower → SelectQuery
```

| Stage | File | Input | Output |
|---|---|---|---|
| **Desugar** | `IRDesugar.ts` | `RawSelectInput` (factory state) | `DesugaredSelectQuery` — selection paths, sub-selects, custom objects, where clauses in DSL-close form |
| **Canonicalize** | `IRCanonicalize.ts` | `DesugaredSelectQuery` | `CanonicalDesugaredSelectQuery` — quantifier rewrites (`some` → `exists`, `every` → `not exists(not …)`), boolean flattening, operator normalization |
| **Lower** | `IRLower.ts` | `CanonicalDesugaredSelectQuery` | `SelectQuery` (`IRSelectQuery`) — full AST with `IRShapeScanPattern` root, `IRTraversePattern` graph patterns, `IRExpression` trees for projection/where/orderBy |

Projection building (`IRProjection.ts`) and alias scoping (`IRAliasScope.ts`) are invoked by the lowering pass.

Select IR is produced by `buildSelectQuery()`; mutation IR by the `buildCanonical*MutationIR` functions in `IRMutation.ts`. Both are reached only through the free **`lower(query)`** function — there is no public `build()` method, and the builders/serialization carry no dependency on the IR pipeline (so a client that never lowers tree-shakes it away entirely).

```ts
import {lower} from '@_linked/core';
const ir = lower(query);   // builder (or closed *Query) → IR; the SPARQL store calls this internally
```

Intermediate types (`DesugaredSelectQuery`, `CanonicalDesugaredSelectQuery`, `RawSelectInput`, etc.) are internal to the pipeline. The lowered IR types are `IRSelectQuery`, `IRCreateMutation`, `IRUpdateMutation`, `IRUpsertMutation`, `IRDeleteMutation` (exported from `@_linked/core/queries/IntermediateRepresentation`). Note: `SelectQuery`/`CreateQuery`/`UpdateQuery`/`DeleteQuery` are the **closed, read-only query interfaces a dataset receives** (the live query) — *not* the IR; `lower()` turns one into the corresponding `IR*` type.

## Select query IR

The `SelectQuery` type (exported from `SelectQuery.ts`, aliased as `IRSelectQuery` in `IntermediateRepresentation.ts`):

```ts
type SelectQuery = {
  kind: 'select';
  root: IRShapeScanPattern;       // shape scan entry point
  patterns: IRGraphPattern[];     // traversal patterns (joins, optional, etc.)
  projection: IRProjectionItem[]; // what to return
  where?: IRExpression;           // filter expression
  orderBy?: IROrderByItem[];      // sort specification
  limit?: number;
  offset?: number;
  subjectId?: string;             // target a specific node
  singleResult?: boolean;         // true if .one() or specific subject
  resultMap?: IRResultMapEntry[]; // maps projection aliases to result keys
};
```

### Basic selection

DSL: `Person.select((p) => p.name)`

```ts
{
  kind: 'select',
  root: {kind: 'shape_scan', shape: 'shape:Person', alias: 'a0'},
  patterns: [],
  projection: [
    {
      alias: 'a1',
      expression: {kind: 'property_expr', sourceAlias: 'a0', property: 'prop:name'}
    }
  ],
  resultMap: [{key: 'prop:name', alias: 'a1'}],
  singleResult: false
}
```

### Nested path selection

DSL: `Person.select((p) => p.friends.friends.name)`

```ts
{
  kind: 'select',
  root: {kind: 'shape_scan', shape: 'shape:Person', alias: 'a0'},
  patterns: [
    {kind: 'traverse', from: 'a0', to: 'a1', property: 'prop:friends'},
    {kind: 'traverse', from: 'a1', to: 'a2', property: 'prop:friends'}
  ],
  projection: [
    {
      alias: 'a1',
      expression: {kind: 'property_expr', sourceAlias: 'a2', property: 'prop:name'}
    }
  ],
  singleResult: false
}
```

### Where (equality filter)

DSL: `Person.select().where((p) => p.name.equals('Semmy'))`

```ts
{
  kind: 'select',
  root: {kind: 'shape_scan', shape: 'shape:Person', alias: 'a0'},
  patterns: [],
  projection: [],
  where: {
    kind: 'binary_expr',
    operator: '=',
    left: {kind: 'property_expr', sourceAlias: 'a0', property: 'prop:name'},
    right: {kind: 'literal_expr', value: 'Semmy'}
  },
  singleResult: false
}
```

### Where (exists — normalized `some`)

DSL: `Person.select().where((p) => p.friends.some((f) => f.name.equals('Moa')))`

```ts
{
  kind: 'select',
  root: {kind: 'shape_scan', shape: 'shape:Person', alias: 'a0'},
  patterns: [],
  projection: [],
  where: {
    kind: 'exists_expr',
    pattern: {kind: 'traverse', from: 'a0', to: 'a1', property: 'prop:friends'},
    filter: {
      kind: 'binary_expr',
      operator: '=',
      left: {kind: 'property_expr', sourceAlias: 'a1', property: 'prop:name'},
      right: {kind: 'literal_expr', value: 'Moa'}
    }
  },
  singleResult: false
}
```

### Where (every — normalized to not exists(not ...))

DSL: `Person.select().where((p) => p.friends.every((f) => f.name.equals('Moa')))`

```ts
{
  where: {
    kind: 'not_expr',
    expression: {
      kind: 'exists_expr',
      pattern: {kind: 'traverse', from: 'a0', to: 'a1', property: 'prop:friends'},
      filter: {
        kind: 'not_expr',
        expression: {
          kind: 'binary_expr',
          operator: '=',
          left: {kind: 'property_expr', sourceAlias: 'a1', property: 'prop:name'},
          right: {kind: 'literal_expr', value: 'Moa'}
        }
      }
    }
  }
}
```

### Logical expression (and/or)

DSL: `p.friends.some((f) => f.name.equals('Jinx')).and(p.name.equals('Semmy'))`

```ts
{
  where: {
    kind: 'logical_expr',
    operator: 'and',
    expressions: [
      {kind: 'exists_expr', pattern: {/* traverse */}, filter: {/* binary_expr */}},
      {kind: 'binary_expr', operator: '=', left: {/* property_expr */}, right: {/* literal_expr */}}
    ]
  }
}
```

### Aggregation (count/size)

DSL: `Person.select((p) => p.friends.size())`

```ts
{
  projection: [
    {
      alias: 'a1',
      expression: {
        kind: 'aggregate_expr',
        name: 'count',
        args: [{kind: 'property_expr', sourceAlias: 'a0', property: 'prop:friends'}]
      }
    }
  ]
}
```

A `count` always counts distinct values (`COUNT(DISTINCT …)` in SPARQL): a select that joins two
multi-valued paths yields their cross product, and counting rows would multiply each count by
the other path's size. `min` and `max` are aggregates too (`p.birthDate.max()`).

### Grouped select (`groupBy`)

DSL: `Person.select((p) => ({hobby: p.hobby, n: Expr.count()})).groupBy('hobby').having('n', (n) => n.gt(1))`

```ts
{
  kind: 'select',
  projection: [
    {alias: 'a1', expression: {kind: 'property_expr', sourceAlias: 'a0', property: 'prop:hobby'}},
    {alias: 'a2', expression: {kind: 'aggregate_expr', name: 'count', args: [{kind: 'alias_expr', alias: 'a0'}]}},
  ],
  groupBy: [{kind: 'property_expr', sourceAlias: 'a0', property: 'prop:hobby'}],
  having: {kind: 'binary_expr', operator: '>', left: {kind: 'aggregate_expr', name: 'count', args: [/* a0 */]}, right: {kind: 'literal_expr', value: 1}},
  requires: ['groupBy'],
}
```

With `groupBy` the rows are groups: the root is not projected, each projection item is a key
(its expression is in `groupBy`) or an aggregate, and a row has no `id`. `orderBy` items are the
projection expressions of the fields they name. `requires` lists the features beyond the
baseline the query uses (`'groupBy'`, `'min'`, `'max'`); see the implementer guide.

### Sub-select with custom result object

DSL: `Person.select((p) => p.friends.select((f) => ({name: f.name, hobby: f.hobby})))`

The sub-select's custom keys appear in the `resultMap`:

```ts
{
  patterns: [
    {kind: 'traverse', from: 'a0', to: 'a1', property: 'prop:friends'}
  ],
  projection: [
    {alias: 'a2', expression: {kind: 'property_expr', sourceAlias: 'a1', property: 'prop:name'}},
    {alias: 'a3', expression: {kind: 'property_expr', sourceAlias: 'a1', property: 'prop:hobby'}}
  ],
  resultMap: [
    {key: 'name', alias: 'a2'},
    {key: 'hobby', alias: 'a3'}
  ]
}
```

### Type casting (as)

DSL: `Person.select((p) => p.pets.as(Dog).guardDogLevel)`

Type casting does not produce a separate IR node. The cast changes which properties are accessible at the DSL level, so the IR simply contains a traversal to the cast shape's property:

```ts
{
  patterns: [
    {kind: 'traverse', from: 'a0', to: 'a1', property: 'prop:pets'}
  ],
  projection: [
    {alias: 'a2', expression: {kind: 'property_expr', sourceAlias: 'a1', property: 'prop:guardDogLevel'}}
  ]
}
```

### Sorting

DSL: `Person.select((p) => p.name).sortBy((p) => p.name, 'DESC')`

```ts
{
  orderBy: [
    {
      expression: {kind: 'property_expr', sourceAlias: 'a0', property: 'prop:name'},
      direction: 'DESC'
    }
  ]
}
```

### Subject targeting and singleResult

DSL: `Person.select({id: 'node:1'}, (p) => p.name)`

```ts
{
  subjectId: 'node:1',
  singleResult: true
  // ...projection, root, etc.
}
```

## Graph pattern types

| Kind | Fields | Description |
|---|---|---|
| `shape_scan` | `shape`, `alias` | Entry point — scan all instances of a shape |
| `traverse` | `from`, `to`, `property`, `pathExpr?`, `innerLimit?`, `innerOffset?`, `innerOrderBy?` | Follow a property edge between aliases. `pathExpr` carries a structured property path (sequence/inverse/alt). `innerLimit`/`innerOffset`/`innerOrderBy` request nested-select pagination — lowered to a `subselect` algebra node (single-subject queries only; see sparql-algebra.md) |
| `join` | `patterns[]` | Combine multiple patterns |
| `optional` | `pattern` | Left-outer-join semantics |
| `union` | `branches[]` | OR-union of patterns |
| `exists` | `pattern` | Existence check pattern |

## Expression types

| Kind | Fields | Description |
|---|---|---|
| `literal_expr` | `value` | String, number, boolean, or null literal |
| `property_expr` | `sourceAlias`, `property` | Property access on an aliased node |
| `alias_expr` | `alias` | Reference to an alias |
| `binary_expr` | `operator`, `left`, `right` | Comparison (`=`, `!=`, `>`, `>=`, `<`, `<=`) |
| `logical_expr` | `operator`, `expressions[]` | Boolean combination (`and`, `or`) |
| `not_expr` | `expression` | Boolean negation |
| `exists_expr` | `pattern`, `filter?` | Existential check with optional filter |
| `aggregate_expr` | `name`, `args[]` | Aggregation (`count`, `sum`, `avg`, `min`, `max`) |
| `function_expr` | `name`, `args[]` | Named function call |

## Mutation IR

### Create

DSL: `Person.create({name: 'Alice'})`

```ts
{
  kind: 'create',
  shape: 'shape:Person',
  data: {
    shape: 'shape:Person',
    fields: [
      {property: 'prop:name', value: 'Alice'}
    ]
  }
}
```

Nested creates produce nested `IRNodeData` objects in field values. ID references are `{id: string}` objects.

### Update

DSL: `Person.update({id: 'node:1'}, {name: 'Alicia'})`

```ts
{
  kind: 'update',
  shape: 'shape:Person',
  id: 'node:1',
  data: {
    shape: 'shape:Person',
    fields: [
      {property: 'prop:name', value: 'Alicia'}
    ]
  }
}
```

Set modifications use `{add?: [...], remove?: [...]}` instead of a direct value:

```ts
{
  property: 'prop:friends',
  value: {
    add: [{id: 'node:2'}],
    remove: [{id: 'node:3'}]
  }
}
```

Unsetting a field sets `value: undefined`.

### Delete

DSL: `Person.delete({id: 'node:1'})`

```ts
{
  kind: 'delete',
  shape: 'shape:Person',
  ids: [{id: 'node:1'}]
}
```

## Store (dataset) implementer guide

This section is for developers building a backend — a **dataset** — that executes Linked queries
(SPARQL, SQL, in-memory, a forwarder, …).

### The contract: a dataset receives the *live query*, not IR

A dataset implements `IDataset`. Each method receives the **live, closed (read-only) query object**
(the builder, viewed through its `*Query` interface) — not IR. From there the dataset decides what it
wants:

- call **`lower(query)`** to get the canonical IR (what the built-in SPARQL store does), or
- call **`query.toJSON()`** to forward it as [DSL-JSON](./dsl-json.md) over a wire, or
- read `query.shape` / `query.toRawInput()` and handle it however it likes.

```ts
import type {IDataset} from '@_linked/core/interfaces/IDataset';
import type {SelectQuery} from '@_linked/core/queries/SelectQuery';
import type {CreateQuery} from '@_linked/core/queries/CreateQuery';
import type {UpdateQuery} from '@_linked/core/queries/UpdateQuery';
import type {DeleteQuery, DeleteResponse} from '@_linked/core/queries/DeleteQuery';
import {lower} from '@_linked/core';

interface IDataset {
  init?(): Promise<any>;
  selectQuery(query: SelectQuery): Promise<SelectResult>;
  updateQuery?(query: UpdateQuery): Promise<UpdateResult>;
  createQuery?(query: CreateQuery): Promise<CreateResult>;
  deleteQuery?(query: DeleteQuery): Promise<DeleteResponse>;
}

class MyStore implements IDataset {
  async selectQuery(query: SelectQuery) {
    const ir = lower(query);       // opt into the IR only if you want it
    return this.runMyEngine(ir);
  }
}
```

**Features a dataset declares.** A select can need features beyond the baseline: grouping
(`'groupBy'`) and `'min'`/`'max'`. A dataset lists the ones it answers in `supports`
(`readonly supports?: readonly QueryFeature[]`); a select that needs one the dataset does not
list is refused before it is sent (`assertQuerySupported`, which `exec` and `LinkedStorage`
call), so a dataset written without them fails loudly instead of answering ungrouped rows.
`SparqlDataset` lists all (`ALL_QUERY_FEATURES`). A store that reads the IR finds the same list
in `IRSelectQuery.requires`. A router lists what it forwards and checks each target itself, as
`LinkedStorage` does.

`SelectQuery`/`CreateQuery`/`UpdateQuery`/`DeleteQuery` are the **closed query interfaces** (the live
query). The corresponding lowered IR types are `IRSelectQuery`/`IRCreateMutation`/`IRUpdateMutation`/`IRUpsertMutation`/
`IRDeleteMutation`, which `lower()` returns.

### Imports

The IR types and the store result types are exported from `@_linked/core/queries/IntermediateRepresentation`:

```ts
import type {
  // Lowered IR types (what lower() returns)
  IRSelectQuery,
  IRCreateMutation,
  IRUpdateMutation,
  IRUpsertMutation,
  IRDeleteMutation,
  IRExpression,
  IRGraphPattern,
  IRProjectionItem,
  IRNodeData,
  IRFieldUpdate,
  // Result types your dataset returns
  SelectResult,
  CreateResult,
  UpdateResult,
  ResultRow,
  SetOverwriteResult,
  SetModificationResult,
} from '@_linked/core/queries/IntermediateRepresentation';
```

The calling layer (`LinkedStorage` via `queryDispatch`, routing by `query.shape`) threads the precise
DSL-level TypeScript result type back to the caller — your dataset just produces data that matches the
result types described below.

### Return types

Every result row is an object with an `id` string and dynamic fields. The specific result type depends on the query kind.

#### Select results (`SelectResult`)

A select query returns an array of result rows by default. Each row has the node's `id` and only the fields that were selected:

```ts
// Person.select(p => p.name) → array of rows
[
  {id: 'person:1', name: 'Semmy'},
  {id: 'person:2', name: 'Moa'},
]
```

When `query.singleResult` is `true` (the DSL used `.one()` or targeted a specific subject), return a single row instead of an array:

```ts
// Person.select({id: 'person:1'}, p => p.name) → single row
{id: 'person:1', name: 'Semmy'}
```

If the target node doesn't exist, return `null`.

Fields that exist on the node but have no value are `null`. Fields that weren't selected are not included. Nested objects and arrays of objects are nested `ResultRow` objects:

```ts
// Person.select(p => [p.name, p.friends, p.bestFriend.name])
{
  id: 'person:1',
  name: 'Semmy',
  friends: [{id: 'person:2'}, {id: 'person:3'}],
  bestFriend: {id: 'person:3', name: 'Jinx'}
}
```

Type: `SelectResult = ResultRow[] | ResultRow | null`

#### Create results (`CreateResult`)

A create query always returns a single row with the generated `id` and the created fields:

```ts
// Person.create({name: 'Alice', hobby: 'Hiking'})
{id: 'person:new-1', name: 'Alice', hobby: 'Hiking'}
```

Nested creates produce nested rows with their own ids. Array fields return arrays of rows:

```ts
// Person.create({name: 'Bob', friends: [{name: 'New Friend'}, {id: 'person:1'}]})
{
  id: 'person:new-2',
  name: 'Bob',
  friends: [
    {id: 'person:new-3', name: 'New Friend'},
    {id: 'person:1'}
  ]
}
```

Type: `CreateResult = ResultRow`

#### Update results (`UpdateResult`)

An update query returns a single row with the target node's `id` and **only the fields that were changed**. Fields not included in the update are not returned.

**Simple field update** — the new value:

```ts
// Person.update({id: 'person:1'}, {hobby: 'Gaming'})
{id: 'person:1', hobby: 'Gaming'}
// note: name is NOT returned because it wasn't updated
```

**Set overwrite** (passing an array for a multi-value property) — returns `{updatedTo: ResultRow[]}`:

```ts
// Person.update({id: 'person:1'}, {friends: [{name: 'NewFriend'}]})
{
  id: 'person:1',
  friends: {
    updatedTo: [{id: 'person:new-1', name: 'NewFriend'}]
  }
}
```

**Set add/remove** (passing `{add, remove}`) — returns `{added: ResultRow[], removed: ResultRow[]}`:

```ts
// Person.update({id: 'person:1'}, {friends: {add: {name: 'Friend Added'}, remove: {id: 'person:2'}}})
{
  id: 'person:1',
  friends: {
    added: [{id: 'person:new-1', name: 'Friend Added'}],
    removed: [{id: 'person:2'}]
  }
}
```

**Unset a single-value field** — the field value is `undefined`:

```ts
// Person.update({id: 'person:1'}, {hobby: undefined})
{id: 'person:1', hobby: undefined}
```

**Unset a multi-value field** — the field value is an empty array:

```ts
// Person.update({id: 'person:3'}, {friends: undefined})
{id: 'person:3', friends: []}
```

Type: `UpdateResult = {id: string; [key: string]: UpdateFieldValue}`

Where `UpdateFieldValue` extends `ResultFieldValue` with `SetOverwriteResult` and `SetModificationResult`.

#### Delete results (`DeleteResponse`)

A delete query returns the list of successfully deleted node ids and a count:

```ts
// Person.delete([{id: 'person:1'}, {id: 'person:2'}])
{
  deleted: [{id: 'person:1'}, {id: 'person:2'}],
  count: 2
}
```

Optionally includes `failed` (ids that couldn't be deleted) and `errors` (error messages keyed by id).

Type: `DeleteResponse = {deleted: NodeReferenceValue[]; count: number; failed?: NodeReferenceValue[]; errors?: Record<string, string>}`

### Minimal implementation skeleton

```ts
import type {IDataset} from '@_linked/core/interfaces/IDataset';
import type {SelectQuery} from '@_linked/core/queries/SelectQuery';
import type {CreateQuery} from '@_linked/core/queries/CreateQuery';
import type {UpdateQuery} from '@_linked/core/queries/UpdateQuery';
import type {DeleteQuery, DeleteResponse} from '@_linked/core/queries/DeleteQuery';
import type {SelectResult, CreateResult, UpdateResult} from '@_linked/core/queries/IntermediateRepresentation';
import {lower} from '@_linked/core';

export class MyStore implements IDataset {
  async selectQuery(query: SelectQuery): Promise<SelectResult> {
    const ir = lower(query);  // opt into the IR
    // 1. Read ir.root.shape to identify the target shape
    // 2. Walk ir.patterns to build joins/traversals
    // 3. Compile ir.where into a filter
    // 4. Map ir.projection to output columns
    // 5. Apply ir.orderBy, ir.limit, ir.offset
    // 6. Use ir.resultMap to build the response object
    // 7. If ir.singleResult, return one row; otherwise return an array
  }

  async createQuery(query: CreateQuery): Promise<CreateResult> {
    const ir = lower(query);
    // 1. Read ir.shape for the target shape
    // 2. Walk ir.data.fields to extract property values
    // 3. Handle nested IRNodeData in field values (nested creates)
    // 4. Handle {id: string} references in field values
    // 5. Return the created row with its generated id
  }

  async updateQuery(query: UpdateQuery): Promise<UpdateResult> {
    const ir = lower(query);
    // 1. Read ir.id for the target node
    // 2. Walk ir.data.fields to extract updates
    // 3. Handle IRSetModificationValue ({add, remove}) for set properties
    // 4. Handle undefined values (unset the field)
    // 5. Return the updated row (only changed fields)
  }

  async deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
    const ir = lower(query);
    // 1. Read ir.ids for the nodes to delete
    // 2. Return {deleted: [...], count: N}
  }
}
```

> A dataset that forwards rather than executes locally skips `lower()` entirely: it calls
> `query.toJSON()` and ships the [DSL-JSON](./dsl-json.md). Lowering is opt-in.

### Compiling expressions

The `where` clause and `projection` items contain `IRExpression` trees. Switch on the `kind` discriminator to compile them:

```ts
function compileExpression(expr: IRExpression): string {
  switch (expr.kind) {
    case 'property_expr':
      // Access property expr.property on the node aliased as expr.sourceAlias
      return `${expr.sourceAlias}.${expr.property}`;
    case 'literal_expr':
      // Literal value (string, number, boolean, or null)
      return JSON.stringify(expr.value);
    case 'binary_expr':
      // Comparison: =, !=, >, >=, <, <=
      return `${compileExpression(expr.left)} ${expr.operator} ${compileExpression(expr.right)}`;
    case 'logical_expr':
      // Boolean combination: and, or
      return expr.expressions.map(compileExpression).join(` ${expr.operator} `);
    case 'not_expr':
      return `NOT (${compileExpression(expr.expression)})`;
    case 'exists_expr':
      // Existential subquery with optional filter
      return `EXISTS { ${compilePattern(expr.pattern)}${expr.filter ? ` FILTER ${compileExpression(expr.filter)}` : ''} }`;
    case 'aggregate_expr':
      // count, sum, avg, min, max
      return `${expr.name}(${expr.args.map(compileExpression).join(', ')})`;
    case 'function_expr':
      return `${expr.name}(${expr.args.map(compileExpression).join(', ')})`;
    case 'alias_expr':
      return expr.alias;
  }
}
```

### Compiling graph patterns

The `patterns` array and `root` describe the data shape. Switch on `kind`:

```ts
function compilePattern(pattern: IRGraphPattern): string {
  switch (pattern.kind) {
    case 'shape_scan':
      // Entry point: scan all instances of pattern.shape, bind to pattern.alias
      break;
    case 'traverse':
      // Follow pattern.property from pattern.from to pattern.to
      break;
    case 'join':
      // Combine pattern.patterns (inner join)
      break;
    case 'optional':
      // Left-outer-join: pattern.pattern
      break;
    case 'union':
      // OR-union of pattern.branches
      break;
    case 'exists':
      // Existence check: pattern.pattern
      break;
  }
}
```

### Handling mutation data

Mutation field values (`IRFieldValue`) can be:

| Value | Meaning |
|---|---|
| `string \| number \| boolean \| null` | Literal value |
| `Date` | Date value |
| `{id: string}` | Reference to an existing node |
| `IRNodeData` (has `shape` + `fields`) | Nested create |
| `IRSetModificationValue` (has `add` / `remove`) | Incremental set update |
| `IRFieldValue[]` | Array of values (e.g. overwriting a set) |
| `undefined` | Unset the field |

### Reference implementations

- **`SparqlStore`** (built-in) — abstract base class in `@_linked/core/sparql` that wires the full SPARQL pipeline (IR → algebra → string → execute → map results). Extend it and implement `executeSparqlSelect()` and `executeSparqlUpdate()` to create a concrete SPARQL-backed store. See [sparql-algebra.md](./sparql-algebra.md#implementing-a-sparql-store) for documentation.
- **`@_linked/rdf-mem-store`** — in-memory RDF store

## Extensibility

Adding new capabilities requires only new variants in the type unions — no structural pipeline changes:

- **New operators**: Add to `IRBinaryOperator` and handle in the canonicalize pass.
- **New expression types**: Add to the `IRExpression` union in `IntermediateRepresentation.ts` and emit from the lowering pass.
- **New graph patterns**: Add to the `IRGraphPattern` union.
- **Optimizations**: Can be implemented as additional passes between canonicalize and lower, or as post-lowering rewrites.
