---
summary: >
  `Shape.upsert()` — one round-trip write that creates or replaces. Userland is currently
  hand-rolling it out of `exists()` + a branch, which is two round-trips, a race between them, and
  a boolean that can be got wrong. It has already been got wrong in production.
status: Done — implemented, see docs/plans/002-shape-upsert.md
---

# 038 — `Shape.upsert()`

> **Implemented.** `Shape.upsert(values).for({id})` — see `docs/plans/002-shape-upsert.md`.
> The design questions below were answered as: replace named properties (not whole node); one
> request, since `update`'s WHERE is already a bare OPTIONAL and only the `rdf:type` triple was
> missing; `upsert`; and no created-vs-updated return value, because knowing would cost the read
> the single round-trip exists to avoid.

## The shape of the problem

Core offers `create` and `update` and nothing between them. They are not interchangeable:

| | Lowers to | Effect on an existing node |
|---|---|---|
| `create` | `INSERT DATA` | **adds** triples; old ones stay |
| `update` | `DELETE { … } INSERT { … }` | replaces the properties it names |

So a caller that does not know whether a node exists cannot pick one safely, and every such caller
writes the same branch:

```ts
if (await exists(Shape, id)) await Shape.update(values).for({id});
else                        await Shape.create({__id: id, ...values});
```

That is an upsert, assembled in userland, and it has three defects the caller inherits:

1. **Two round-trips** where the store can do one.
2. **A gap between them.** Nothing stops the node appearing or vanishing between the check and the
   write. Neither branch is correct across that gap.
3. **A boolean in the middle that can be wrong** — and if it is wrong in the `false` direction, the
   failure is silent: `INSERT DATA` over an existing node duplicates single-valued properties
   rather than erroring.

## Why this is not hypothetical

Create Now's `LinkedDocumentRepository` has carried exactly that branch across six save paths
(`SourceDocument`, `DocumentFolder`, `DocumentTag`, `ExtractionRun`, `ProjectionRun`,
`ReviewDecision`), with the existence check written as:

```ts
async function exists(shape: any, id: string): Promise<boolean> {
  return Boolean(await shape.select().where((item: any) => item.equals({id})).one().catch(() => null));
}
```

The `.catch(() => null)` turns **any** failure into `false` — into "does not exist" — into
`create`. A parse error, an unreachable store and a genuinely absent node are indistinguishable.
CN observed this returning `false` unconditionally in a running backend, so every re-save took the
`create` branch, and nobody noticed because the wrong branch is silent.

[#206](https://github.com/linked-fw/core/pull/206) adds `Shape.exists()` / `SelectBuilder.exists()`
so the check itself is correct and cannot swallow errors. **That fixes the ingredient, not the
recipe.** The two round-trips, the race and the branch all remain in userland, in every consumer
that needs them.

## What to build

`Shape.upsert(values)` — a single mutation that creates the node if absent and replaces the named
properties if present, in one request.

Design questions for its ideation, not settled here:

- **Semantics.** Replace only the named properties (an `update` that tolerates absence), or replace
  the whole node? The former is what CN's branch approximates; the latter is a different, sharper
  promise.
- **Is one request reachable?** `DELETE { … } INSERT { … } WHERE { … }` with an `OPTIONAL` pattern
  already expresses "replace if present, insert otherwise" in a single SPARQL update. If the
  existing mutation algebra can carry it, this may be much less work than it appears — see how
  `update` lowers in `irToAlgebra`.
- **Naming.** `upsert` is the common term; `save` reads more like the domain. Whichever is chosen
  should not read as a synonym for `create`.
- **Return value.** Does the caller learn whether it created or updated? Some will want to know;
  making it a boolean return reintroduces a boolean, so consider a discriminated result instead.

## Relationship to `exists()`

`exists()` stands on its own — "does anything match?" is a real question independent of writing.
This item is not a replacement for it. But if the *only* caller of `exists()` in a codebase is the
branch above, that codebase wanted `upsert` and settled for the ingredient.

**Trigger:** whenever a second consumer writes the create-or-update branch, or when CN migrates
`LinkedDocumentRepository` onto `exists()` and the branch survives the migration — which is the
signal that the branch, not the check, was the problem.
