---
summary: Fixed a DSL `update()` orphan bug — replacing/unsetting (or set-removing) a `contains`-owned object property now deletes the old owned node's own triples via a new `contains`-driven, `dependent`-independent `buildOwnedSelfDelete`, with the owning edge re-asserted in-group for unbound-safety. Verified by unit + live-Fuseki tests.
---

# 025 — update-replace of a `contains` property no longer orphans the old node

Source backlog (now removed): `docs/backlog/032-update-replace-contains-cascade.md`.
Origin: plan-011 T9.3 (WorkspaceProvider image write → DSL).

## Problem

A DSL `update()` that REPLACES a `contains` (owned) object property left the previous owned
node's own triples in the graph — an orphan. E.g.:

```ts
await Workspace.update({image: {contentUrl: 'a'}}).for({id: ws}); // ImageObject#1
await Workspace.update({image: {contentUrl: 'b'}}).for({id: ws}); // ImageObject#2
// ws schema:image → ImageObject#2 (read is correct), but ImageObject#1 remains as an orphan.
```

Read-correctness was fine (the link follows the current value); only graph cleanliness
suffered — orphan `ImageObject` nodes accumulated across image changes.

### Root cause

`irToAlgebra.processUpdateFields` (the non-set-modification replace path) DELETEd the one-hop
edge `<subject> <prop> ?old` and called `buildOwnedCascade(old)` — which (a) is a no-op unless
some shape is `dependent`, and (b) only deletes nodes reached *from* the root via `contains`
edges (descendants), never the root's own triples. So the immediate replaced node was never
removed. The set-remove path (`update({prop: {remove: [x]}})`) had the identical latent orphan.

## Solution — `contains`-driven self-delete (backlog Option 1)

Drive the cleanup off `contains` (exclusive ownership via the edge), **not** off the shape-level
`dependent` flag. `ImageObject` stays non-`dependent`; `Thing.image` stays `contains: true`.

New exported helper in `src/sparql/irToAlgebra.ts`:

```ts
export function buildOwnedSelfDelete(
  subjectTerm: SparqlTerm,
  propertyTerm: SparqlTerm,
  oldTerm: SparqlTerm,
  varPrefix: string,
): {deletePatterns: SparqlTriple[]; whereOptionals: SparqlAlgebraNode[]}
```

It emits:
- **DELETE** `{ oldTerm ?<prefix>sp ?<prefix>so }` — the old node's own one-hop triples.
- **WHERE** `OPTIONAL { subjectTerm propertyTerm oldTerm . oldTerm ?sp ?so }` — one BGP.

### Key design decisions (with rationale)

- **`contains`, not `dependent`.** A `contains` edge already asserts exclusive ownership of the
  child — sufficient and correct signal for "when this edge is replaced/removed, delete the old
  child." `dependent` is a *separate* mechanism (reference-counted GC of a shape reachable many
  ways) and would not fix this anyway (the cascade roots at the old value and follows edges
  *from* it, never the node itself). Kept the two concepts separate.
- **Owning edge re-asserted INSIDE the WHERE group (the correctness crux).** `?old` is bound by
  `subjectTerm propertyTerm oldTerm` within the same BGP. If no old value exists, the group
  matches nothing and the DELETE is a no-op — avoiding the catastrophic alternative where a bare
  `{ ?old ?p ?o }` optional with an unbound `?old` matches (and deletes) the entire graph. When
  `oldTerm` is a concrete IRI (set-remove), the same guard just confirms the ownership link
  still holds before wiping the node.
- **Applied to both removal paths.** Replace/unset/array-overwrite loop AND the set-remove
  branch, for one consistent rule and no twin bug. Self-delete runs *before* `buildOwnedCascade`
  so the immediate node and its descendants are both handled and compose without double-count.
- **Helper mirrors `buildOwnedCascade`'s `{deletePatterns, whereOptionals}` contract**, so it
  drops into the existing `deletePatterns` / `cascadeOptionals` wiring in `updateToAlgebra` with
  zero changes there.

### Files changed

| File | Responsibility / change |
|---|---|
| `src/sparql/irToAlgebra.ts` | Added exported `buildOwnedSelfDelete`. Retyped `containsOldVars: string[]` → `Array<{oldVar; propertyTerm}>` (loop needs the predicate for the guard edge). Wired self-delete into the replace cascade loop and the set-remove branch. Updated the section comment. No changes to `buildOwnedCascade`, `collectContainment`, `updateToAlgebra`, or the delete path. |
| `src/tests/shacl-cascade.test.ts` | Added non-`dependent` `TPlainCell` (owned) / `TCard` (owner, `holds`/`cells` `contains`) shapes; 3 unit tests + 1 live-Fuseki E2E. |
| `docs/backlog/032-*.md` | Removed (consumed). |

## Generated SPARQL (replace of a non-dependent `contains` child)

```
DELETE {
  <card1> <holds> ?old_holds .
  ?old_holds ?uc0_sp ?uc0_so .          # <- self-delete: old node's own triples
  ... (buildOwnedCascade descendant wildcards, no-op for a leaf) ...
}
INSERT { <card1> <holds> <newplain> . }
WHERE {
  OPTIONAL { <card1> <holds> ?old_holds . }
  OPTIONAL { <card1> <holds> ?old_holds . ?old_holds ?uc0_sp ?uc0_so . }  # <- edge-bound
  ... (cascade optionals) ...
}
```

## Test coverage

`src/tests/shacl-cascade.test.ts` — 9/9 green:
- Existing cascade tests (delete cascade, non-contains safety, List/PathNode dependent types,
  set-remove subtree cascade, replace subtree cascade) — unchanged, still pass.
- **replace of a non-dependent contains child deletes the old node's own triples** — asserts the
  old-var wildcard in DELETE and the edge re-asserted in the WHERE group.
- **buildOwnedSelfDelete algebra shape** — 1 delete pattern, 1 WHERE BGP with edge-guard +
  wildcard (edge-bound safety), wildcard subject matches the delete pattern.
- **set-remove of a non-dependent contains child** — the removed IRI's own triples wildcard-
  deleted, link confirmed in WHERE.
- **live Fuseki E2E (backlog repro)** — create→replace→replace; each prior owned node drops to
  **0 triples**; current link resolves; **zero orphan** `TPlainCell` remain. Skips gracefully if
  Fuseki is down.

Regression sweep clean: mutation golden/algebra/parity/serialization/negative → 110/110; live
fuseki suites pass in isolation (90/90, 84/84) and serialized together (`--runInBand` → 174/174).

## Known limitations / deferred work

- **Repo-root integration test (out of packages/core scope).**
  `tests/integration/workspace-image-dsl.spec.ts` still asserts the pre-fix orphan count
  (`== 2`, codifying old behavior). Once packages/core is rebuilt and the host app consumes it, that
  assertion must be flipped to the fixed count or it will go red. Sanctioned follow-up.
- **Nested owned subtree under a non-`dependent` contained node.** The self-delete is one-hop; a
  `contains` child that is itself non-`dependent` and owns further `contains` children would only
  have its immediate node removed (grandchildren orphan unless `dependent`, which
  `buildOwnedCascade` still catches). Latent — `ImageObject` is a leaf. A general fix would make
  `buildOwnedCascade` follow `(contains)*` for `contains`-owned nodes (backlog Option 2).
- **Live-Fuseki parallelism.** Fuseki-touching suites share one in-memory `DATASET_NAME`;
  running them in parallel jest workers causes dataset contention (pre-existing). This change
  adds a third such suite. Consider per-suite datasets or `--runInBand` for `*fuseki*`/cascade
  suites in CI.

## Public API

- New export: `buildOwnedSelfDelete(subjectTerm, propertyTerm, oldTerm, varPrefix)` from
  `src/sparql/irToAlgebra.ts` (mirrors `buildOwnedCascade`). Primarily an internal lowering
  helper; exported for unit testing, consistent with `buildOwnedCascade`.

No behavioral change to any existing public method signature; the fix is transparent to DSL
callers (`update()` now cleans up owned nodes it previously orphaned).
