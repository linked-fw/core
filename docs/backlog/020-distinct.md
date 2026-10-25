---
summary: Expose explicit .distinct() control in the query DSL
packages: [core]
---

# Distinct — Ideation

## Context

DISTINCT is already fully implemented in the SPARQL layers and is auto-applied. The question is whether to expose explicit control.

### What exists today

**Current behavior** — `irToAlgebra.ts` (line 515):
```typescript
distinct: !hasAggregates ? true : undefined,
```
- **All non-aggregate SELECT queries automatically get DISTINCT**
- When aggregates are present, DISTINCT is omitted (GROUP BY handles uniqueness)
- No user control — you cannot opt out of DISTINCT or opt in for aggregate queries

**SPARQL algebra** — `SparqlAlgebra.ts` (lines 174–185):
```typescript
type SparqlSelectPlan = { ...; distinct?: boolean; };
```

**Serialization** — `algebraToString.ts` (lines 272–273):
```typescript
const distinctStr = plan.distinct ? 'DISTINCT ' : '';
const selectLine = `SELECT ${distinctStr}${projectionParts.join(' ')}`;
```

**Aggregate DISTINCT** — `SparqlAggregateExpr` has a `distinct?: boolean` field (line 141).
Serialization supports `COUNT(DISTINCT ?x)` — tested in `sparql-serialization.test.ts` lines 1026–1052.

**IR layer** — `IRSelectQuery` (lines 18–31) has **no** `distinct` field. It's inferred at the algebra layer.

### How other libraries do it

**SQLAlchemy:**
```python
select(User.name).distinct()
```

**Drizzle:**
```typescript
db.selectDistinct({ name: users.name }).from(users)
db.selectDistinctOn([users.name], { name: users.name, age: users.age }).from(users)
```

**Prisma:**
```typescript
prisma.user.findMany({ distinct: ['name'] })  // field-level distinct
```

## Goals

- Allow users to explicitly control DISTINCT behavior
- Support `COUNT(DISTINCT ...)` in aggregate expressions
- Keep current auto-DISTINCT as sensible default

## Open Questions

- [ ] Should `.distinct()` be a query-level toggle, or should the auto-DISTINCT default be kept with an opt-out (`.noDistinct()`)?
- [ ] Should we support field-level distinct (Prisma-style `distinct: ['name']`), or only query-level `SELECT DISTINCT`?
- [ ] Should `.countDistinct()` be added as a separate method alongside `.size()`, or should `.size({ distinct: true })` be the API?
- [ ] Should the IR get an explicit `distinct` field, or should it remain algebra-level only?

## Decisions

| # | Decision | Chosen | Rationale |
|---|----------|--------|-----------|

## Notes

- This is a small change — the SPARQL layers already support everything
- Most users probably won't need to think about DISTINCT since auto-DISTINCT is sensible for RDF (where graph traversal naturally produces duplicates from optional patterns)
- `DISTINCT ON` (PostgreSQL-specific) has no SPARQL equivalent — skip for now
- `COUNT(DISTINCT ...)` would be useful alongside the aggregations work (backlog 006)
- Risk: removing auto-DISTINCT could surprise users with duplicate results. Recommend keeping auto-DISTINCT as default
