# Prefixed URIs in JSON/Object Formats — Ideation

## Context

Currently, users writing shape definitions and queries interact with URIs in two primary ways:

1. **`NodeReferenceValue` objects** — `{id: 'http://xmlns.com/foaf/0.1/knows'}` — verbose but explicit
2. **Ontology module exports** — `import {foaf} from '../ontologies/foaf'; foaf.knows` — ergonomic but requires imports

The `Prefix` registry (`Prefix.ts`) already supports bidirectional conversion. Prefixes are
scoped: each call takes an optional `map` last argument and otherwise uses the app's map in use
(`Prefix.load(map)`):
- `Prefix.toFull('foaf:knows', map?)` → `'http://xmlns.com/foaf/0.1/knows'`; a full IRI is
  returned as is, an unknown prefix throws `UnknownPrefixError`
- `Prefix.toPrefixed('http://...', map?)` → `'foaf:knows'` (for SPARQL rendering)
- `resolveUriOrThrow(str, map?)` and `resolveNodeId(str, map?)` (`NodeReference.ts`) and
  `expandPrefixedName`/`pathRefIri` (`propertyPathSafety.ts`) build on `Prefix.toFull`

The property path system (phases 1–6) already accepts prefixed strings in path expressions: `@literalProperty({path: 'foaf:knows/foaf:name'})`. The parser preserves them as raw strings. But the `{id}` form and `NodeReferenceValue` inputs throughout the codebase don't support prefixed names — they always expect full IRIs.

### Key entry points that accept URIs from users

| Location | Current type | Example |
|----------|-------------|---------|
| `@literalProperty({path})` | `PropertyPathDecoratorInput` | `path: foaf.name` or `path: 'foaf:name/foaf:nick'` |
| `@objectProperty({path, shape, class})` | same + `NodeReferenceValue` | `class: rdf.Class` |
| `static targetClass` | `NodeReferenceValue` | `static targetClass = {id: 'http://...'}` |
| `PropertyShapeConfig.equals/disjoint/hasValue` | `NodeReferenceValue \| string` | `equals: rdf.type` |
| `PropertyShapeConfig.in` | `NodeReferenceValue[]` | `in: [rdf.type, rdf.Property]` |
| `LiteralPropertyShapeConfig.datatype` | `NodeReferenceValue \| string` | `datatype: xsd.integer` |
| `.for(id)` / `.forAll(ids)` | `string \| NodeReferenceValue` | `.for({id: '...'})` |
| `.where(...).equals(val)` | `JSNonNullPrimitive \| NodeReferenceValue` | `.equals({id: '...'})` |

### Relevant code

- `src/utils/Prefix.ts` — prefix registry with `toFull()`, `toPrefixed()`
- `src/utils/NodeReference.ts` — `NodeReferenceValue = {id: string}`, `toNodeReference()`
- `src/shapes/SHACL.ts` — `toPlainNodeRef()`, `createPropertyShape()`
- `src/paths/normalizePropertyPath.ts` — already handles prefixed strings for paths
- `src/paths/PropertyPathExpr.ts` — `PathRef = string | {id: string}`

## Goals

Let users write prefixed names anywhere they currently write full IRIs in decorator configs, shape definitions, and query inputs. For example:

```ts
// Before
static targetClass = {id: 'http://xmlns.com/foaf/0.1/Person'};
@literalProperty({path: {id: 'http://xmlns.com/foaf/0.1/name'}, datatype: {id: 'http://www.w3.org/2001/XMLSchema#string'}})

// After
static targetClass = 'foaf:Person';
@literalProperty({path: 'foaf:name', datatype: 'xsd:string'})
```

## Open Questions

- [ ] 1. Where should prefix resolution happen — at decoration time (eager) or at consumption time (lazy)?
- [ ] 2. Should `NodeReferenceValue` be widened to accept strings, or add a new input type that resolves to `NodeReferenceValue`?
- [ ] 3. How to handle `targetClass` — it's a static class property typed as `NodeReferenceValue`, widening its type has broad implications
- [ ] 4. Should `PathRef` in the PathExpr AST resolve prefixed strings to full IRIs, or continue storing them raw?
- [ ] 5. Error behavior — what happens when a prefixed name references an unregistered prefix?
- [ ] 6. Scope — which input points to include in this change?

## Decisions

| # | Decision | Chosen | Rationale |
|---|----------|--------|-----------|
| 1 | Where should prefix resolution happen? | (C) Enhance `Prefix` singleton — resolve at decoration/normalization time using `Prefix.toFull()` | Core resolution logic stays centralized in `Prefix`. Eager resolution at decoration time means all downstream code sees full IRIs. `toFull` returns a full IRI as is, so it applies to every IRI input. |
| 2 | Should `NodeReferenceValue` be widened? | (B) Keep `NodeReferenceValue` internal, widen only input types | `NodeReferenceInput = NodeReferenceValue \| string` already exists. Resolve prefixed strings to `{id: fullIRI}` at the boundary via `toNodeReference`/`toPlainNodeRef`. Zero changes to internal code. |
| 3 | How to handle `targetClass`? | (C) Widen type, normalize immediately in `@linkedShape` | The `@linkedShape` decorator normalizes `targetClass` to `{id: string}` before storing. All runtime reads see `{id: string}`. |
| 4 | Should `PathRef` in PathExpr AST resolve prefixed strings? | (A) Resolve at normalization time | `normalizePropertyPath` expands every prefixed-name string ref (`expandPrefixedName`, built on `Prefix.toFull()`). AST becomes canonical (all full IRIs). Simplifies every downstream consumer. |
| 5 | Error behavior for unregistered prefixes? | (A) Throw immediately (fail-fast) | `Prefix.toFull()` already throws. Clear error message with the offending prefix. Surfaces errors at shape registration time. |
| 6 | Scope — which input points to include? | (B) Decorators + query API | `.for()` always takes a node ref (unambiguous). `{id: 'prefix:name'}` resolves because `{id}` signals IRI. Bare string `.equals('hello')` remains a literal. |

## Notes

- `Prefix.toFull()` (full IRIs pass through, unknown prefixes throw) already exists — no new method needed on Prefix itself
- `toNodeReference` and `toPlainNodeRef` are the two normalization functions that need prefix resolution added
- The `in` field in PropertyShapeConfig is `NodeReferenceValue[]` — needs widening to `(NodeReferenceValue | string)[]`
- `collectPathUris` currently skips prefixed-name strings — after D4 resolution, all refs are full IRIs, fixing this gap
