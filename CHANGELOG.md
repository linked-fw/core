# Changelog

## 2.22.1

### Patch Changes

- [#252](https://github.com/linked-fw/core/pull/252) [`95b169e`](https://github.com/linked-fw/core/commit/95b169ee1221bc4b511d6693ff744076b8cf03cc) Thanks [@flyon](https://github.com/flyon)! - Dataset pins survive duplicate copies of a shape class.

  `LinkedStorage.setDatasetForShapes()` keyed its pins on the class object, which
  is only a usable key while exactly one copy of the declaring module has
  evaluated. In a built app there is not: the backend runs from `lib/`, while
  `linked.backend.storage` is loaded from the app root and imports the app's
  shapes from `src/`. The pin landed on one copy and the query resolved the
  other, so a shape that _was_ pinned fell through to the default dataset.

  For an app whose default is a router, the symptom is remote from the cause:

  ```
  [AppDataRouter] query reached the app-data router with NO active project.
  CN-internal shapes must be pinned to cn-main/cn-ai ...
  ```

  — reporting a missing pin for a shape that is pinned two files away. Dev loads
  both halves from `src`, so this only ever appeared in production.

  `getDatasetForShapeClass()` now falls back to matching on the shape's IRI when
  the class-identity lookup misses. No API change, and unpinning through
  `getShapeToDatasetMap()` keeps working, because the IRI match scans that same
  map rather than a parallel index.

## 2.22.0

### Minor Changes

- [#249](https://github.com/linked-fw/core/pull/249) [`30c4080`](https://github.com/linked-fw/core/commit/30c40800252ca7676d03e4144d1c448282fa2d2c) Thanks [@flyon](https://github.com/flyon)! - A shape can name itself, and a renamed one says so.

  A shape's IRI is `<baseUri>shape/<package>/<name>` and `Server.call` routes on
  it, so the name is persisted data rather than a label. Taking it from
  `constructor.name` couples that data to how the code was compiled — a minifier
  renames the class, and so does an ordinary name collision, because a shape and
  the ontology term it targets deliberately share a name.

  `@linkedShape` now accepts an optional `name`:

  ```ts
  @linkedShape({ name: "BackendAPIStore" })
  export class BackendAPIStore extends Shape {}
  ```

  Optional, defaulting to `constructor.name`, so no existing shape changes.

  Two warnings now fire where the cost is cheap — at registration, rather than as
  a `No provider for …` several layers later:

  - a class name ending in a digit with no explicit name given, which is almost
    always a bundler disambiguating a collision;
  - the existing shape-identity duplication guardrail, which **now also runs in
    production**. It was dev-only on the reasoning that production is minified and
    would false-fire; it does not — full minification produces `za`, which the
    check ignores. What it does catch is `BackendAPIStore2`, which only happens in
    a production build. The warning was suppressed in the one place the bug occurs.

## 2.21.2

### Patch Changes

- [#247](https://github.com/linked-fw/core/pull/247) [`2f9577c`](https://github.com/linked-fw/core/commit/2f9577c57294457668004a3662bccf717102837d) Thanks [@flyon](https://github.com/flyon)! - Compile the whole `src` folder, and let a bare import resolve under Node10.

  The build only emitted what an entry transitively reached, so any module
  nothing imported was never built — and never type-checked, so it rotted
  quietly. `include` now covers `src/**/*` with tests excluded explicitly.

  `typesVersions` maps every specifier through `lib/esm/*`, so a `types` value
  that already carried that prefix had it applied twice and no consumer on
  classic Node10 resolution could `import` the package by its bare name.

## 2.21.1

### Patch Changes

- [#245](https://github.com/linked-fw/core/pull/245) [`aa68aab`](https://github.com/linked-fw/core/commit/aa68aabdd2981eb4f83171bf77c03253b93732b5) Thanks [@flyon](https://github.com/flyon)! - `syncShapes` now writes each property shape's label as `rdfs:label`.

  `buildPropertyShapeData` used `ps.label` only to mint the property-shape IRI and
  never serialized it, so on read-back a label had to be re-derived from the path's
  local part. That is correct only while the two coincide. When they differ —
  `@_linked/org` declares the label `memberships` on the path `org:hasMembership` —
  the catalog reports `hasMembership`, `InstanceProvider` builds its columns from
  those store labels and indexes the query proxy with them, and the proxy resolves
  labels against the _class_, which only knows `memberships`. The guard in
  `SelectQuery` then throws `Person.hasMembership is accessed in a query, but it
does not have a @linkedProperty decorator`.

  Additive and backward compatible. `rdfs:label` is already a framework property
  shape on `Shape`, and both catalog readers already prefer a stored label and fall
  back to the path — so catalogs written before this change keep working, and
  catalogs written after simply stop needing the fallback. No type change:
  `label` is already required on `PropertyShapeData`, and `PropertyShapeWire` is
  defined by subtraction from it.

  Existing stores pick this up on the next sync, since `buildSyncThunk`
  deletes and recreates each shape.

## 2.21.0

### Minor Changes

- [#242](https://github.com/linked-fw/core/pull/242) [`6a57d08`](https://github.com/linked-fw/core/commit/6a57d08659dfb0a37af77ff8024d3c7a9bb23497) Thanks [@flyon](https://github.com/flyon)! - Carry a root `COUNT` over the `selectQuery` channel, and remove `IDataset.countQuery`.

  A count was modelled on an ask and given a method of its own. That was wrong, and it
  made the feature unusable outside a store held directly. An ask really is a distinct
  SPARQL query form (`ASK WHERE { … }`) and earns its own method; a count is
  `SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { … }` — a select with an aggregate
  projection, lowered by `countToAlgebra` calling `selectToAlgebra` and swapping the
  projection, sent over the same transport, answered with the same result-set response.

  Because it had its own method, every router had to grow an arm for it — and
  `LinkedStorage` never did: `setDefaultDataset` registered select/ask/create/update/
  delete, so `.count()` rejected with "does not implement `IDataset.countQuery`" on every
  path that went through the router, which is every path in an application.
  `@_linked/server`'s backend API store could not implement the handler either, having
  no `LinkedStorage.countQuery` to call. Only the tests that held a `SparqlDataset`
  directly passed.

  - `SparqlDataset.selectQuery` now branches on the lowered IR (`kind === 'count'`,
    as `updateQuery` and `deleteQuery` already branch on theirs) and emits the aggregate.
    It is overloaded: a `SelectQuery` answers `SelectResult`, a `CountQuery` answers
    `number`. The select path is untouched, and `countToAlgebra` and the lowering are
    unchanged.
  - `IDataset.selectQuery` and `QueryDispatch.selectQuery` accept
    `SelectQuery | CountQuery` and may answer `SelectResult | number`. Existing
    implementations stay valid with no edit (a narrower parameter and a narrower return
    type both remain assignable), and every router that already forwards a select now
    forwards a count for free — `LinkedStorage` needed no new method at all.
  - **`IDataset.countQuery` and `SparqlDataset.countQuery` are removed.** A caller who
    held a SPARQL store and called `store.countQuery(query)` calls
    `store.selectQuery(query)` with the same query instead. The optional interface
    member could not be usefully implemented by anyone: a store that implemented it was
    never reached, because no router forwarded to it.
  - The count contract is unchanged and still enforced in one place, now at the select
    dispatch in `resolveCount`: the answer must be a finite, non-negative integer, never
    coerced, and a failure always rejects. A store that ignores the count and answers
    with rows is refused by that same check rather than having its array measured — `0`
    is a plausible count, and one that came from a broken query renders an empty table
    indistinguishable from real data.

  Minor rather than major: the only removed surface that ever worked is
  `SparqlDataset.countQuery`, reachable only by a caller holding a SPARQL store
  directly, released one version ago, and replaced by a call with the same argument.
  Nothing that went through `LinkedStorage` can break, because nothing there worked.

## 2.20.2

### Patch Changes

- [#240](https://github.com/linked-fw/core/pull/240) [`7088b4f`](https://github.com/linked-fw/core/commit/7088b4fd0e43bb9a7fd725eee50546355ab3e9b2) Thanks [@flyon](https://github.com/flyon)! - Fix `askToAlgebra` silently dropping a `HAVING`. An `ASK` whose where clause contained an aggregate — `.where(p => p.friends.size().gt(2)).exists()` — lowered to `GROUP BY` + `HAVING`, of which only the pattern was carried over, so the query answered the _unfiltered_ question and returned `true` for any store holding one instance of the shape. It now throws, exactly as `countToAlgebra` already did for the same lowering: answering it needs a nested sub-SELECT carrying `GROUP BY`/`HAVING`, which the algebra cannot express yet (see `docs/backlog/042`).

- [#240](https://github.com/linked-fw/core/pull/240) [`9d2ee33`](https://github.com/linked-fw/core/commit/9d2ee33d451f6d9b99bad0ad8c3114c50f5fa096) Thanks [@flyon](https://github.com/flyon)! - Emit SPARQL aggregate function names in uppercase (`COUNT(DISTINCT ?a0)` instead of `count(DISTINCT ?a0)`), matching every other keyword the emitter produces. The upper-casing happens in `algebraToString`, so it covers `SUM`/`AVG`/`MIN`/`MAX` and any future aggregate, while the IR keeps carrying the plain lowercase name. SPARQL is case-insensitive for function names so query behaviour is unchanged, but the emitted query **text** changes — anything asserting on the exact string of a generated aggregate query needs updating.

## 2.20.1

### Patch Changes

- [#235](https://github.com/linked-fw/core/pull/235) [`19624f7`](https://github.com/linked-fw/core/commit/19624f7bb7b1d83bd99d9797a7da41fe7e09432b) Thanks [@flyon](https://github.com/flyon)! - Point `repository.url` at the linked-fw organisation, so npm provenance verification matches the repository that builds the package.

## 2.20.0

### Minor Changes

- [#230](https://github.com/linked-fw/core/pull/230) [`bf8df0c`](https://github.com/linked-fw/core/commit/bf8df0c043cdb588e4b9f8baf97f87b340f0078b) Thanks [@flyon](https://github.com/flyon)! - Purpose-named file stores, save options and `statFile`.

  - `LinkedFileStorage` gains a purpose registry: `registerPurpose`, `setStore`,
    `getStore`, `hasStore`, `listPurposes` and `accessURLFor`. `getStore(purpose)`
    returns the store configured for that purpose; a purpose that is registered
    but not configured falls back to the default store (noted once with
    `console.debug`); an unregistered
    purpose throws, listing the known purposes, so a typo cannot silently write to
    the wrong store. The well-known purposes `uploads` and `appAssets` are exported
    as `FileStorePurposes` and registered at module load. `uploads` is an ordinary
    purpose: `setDefaultStore` configures no purpose of its own, so `uploads`
    resolves to the default store as a fallback, `hasStore('uploads')` is true only
    after an explicit `setStore('uploads', store)`, and that call has the same
    effect whether it runs before or after `setDefaultStore`.
  - `getDefaultDataset`/`setDefaultDataset` are renamed to
    `getDefaultStore`/`setDefaultStore`. The old names remain as `@deprecated`
    aliases that forward, so no caller has to change; they will be dropped in the
    next major.
  - `IFileStore.saveFile` now takes `SaveFileOptions` (`mimeType`, `cacheControl`,
    `metadata`, `preventDuplicates`) as its third argument, still accepting a
    `string` there as the old positional `mimeType`. `normalizeSaveFileOptions` is
    exported for implementations; it reports `preventDuplicates` as `undefined`
    when the caller did not specify one — there is no core-wide default, so each
    store keeps applying its own (`S3FileStore` overwrites, `LocalFileStore` adds a
    random suffix). `options.preventDuplicates` wins over the positional argument.
    `LinkedFileStorage.saveFile` likewise forwards an unspecified
    `preventDuplicates` as `undefined` rather than `false`, so a
    `saveFile(path, bytes)` call keeps behaving exactly as before.
  - `IFileStore` gains an optional `statFile(filePath): Promise<FileStat | null>`
    for verify-after-upload. Existing implementations stay valid.

## 2.19.1

### Patch Changes

- [#231](https://github.com/linked-fw/core/pull/231) [`58a5b7a`](https://github.com/linked-fw/core/commit/58a5b7af7332584e9f40c16d17e303f18d86962a) Thanks [@flyon](https://github.com/flyon)! - Declare npm as the package manager for this repo and mark `package-lock.json` as a generated file.

## 2.19.0

### Minor Changes

- [#224](https://github.com/linked-cm/core/pull/224) [`ea9971c`](https://github.com/linked-cm/core/commit/ea9971c6201f610102ad7674868602e1aaeb4e1f) Thanks [@flyon](https://github.com/flyon)! - Adds a root-level count to the query DSL: `SelectBuilder.from(shape).where(…).count()` and
  `Shape.count()` resolve to a real `number`, lowering to `SELECT (COUNT(DISTINCT ?s) AS ?count)
WHERE { … }`. Like an ask, a count is its own builder and IR kind, so `limit`/`offset` are dropped at
  the boundary and unrepresentable thereafter — the count of a window is the count of the whole match
  set. `.toCount()` is public so a router can forward the `{op: 'count'}` envelope instead of executing
  it.

  `IDataset.countQuery` is **optional**, so nothing breaks: every store extending `SparqlDataset` gets
  it with no edit. A store or router that does not extend `SparqlDataset` — including any
  `setQueryDispatch({…})` object literal in a consuming package — needs a `countQuery` arm added by
  hand before `.count()` works against it; until then it fails loudly, naming the method.

## 2.18.1

### Patch Changes

- [#220](https://github.com/linked-cm/core/pull/220) [`dc1bdbb`](https://github.com/linked-cm/core/commit/dc1bdbb8e966b57f7b2add7050244a0ae0811fef) Thanks [@flyon](https://github.com/flyon)! - Fix `Class extends value undefined` when registering a runtime shape — `getOrCreateShapeAdapter`
  captured `Shape` at module-evaluation time, which could be before `Shape.js` had finished.

## 2.18.0

### Minor Changes

- [#208](https://github.com/linked-cm/core/pull/208) [`085cfad`](https://github.com/linked-cm/core/commit/085cfadd4ebf0e584da9476a234b6ec47b261b5f) Thanks [@flyon](https://github.com/flyon)! - Ask queries — a first-class query kind whose answer is a boolean — plus two `rdf:type` / `sh:path`
  resolution fixes it surfaced.

  ## Ask queries

  `.exists()` is a shortcut for an ask, not a special case of select. An ask carries a **pattern and
  nothing else** — no projection, sorting or pagination — at every layer: `AskBuilder`, `IRAskQuery`,
  an `op: 'ask'` wire envelope, and `ASK WHERE { … }` in SPARQL.

  ```ts
  await Person.exists({ id }); // ASK { ?a0 a <PersonClass> . FILTER(?a0 = <id>) }
  await Person.select()
    .where((p) => p.name.equals("Semmy"))
    .exists(); // ASK with the filter
  await Shape.exists(uri); // ASK { <uri> ?p ?o }
  ```

  **`Shape.exists(uri)` on the base class asks whether a node exists at all** — no `rdf:type`
  constraint, under any shape or none. (`Shape` is free to mean "anything": the shapes themselves are
  described by `NodeShape` and `PropertyShape`.) A shapeless ask has no shape to route on, so
  `LinkedStorage` asks **every** dataset it knows and ORs the answers, short-circuiting on the first
  `true` — cheap precisely because the answers are booleans. Any router implementing `IDataset`
  inherits that obligation: a shapeless ask means "anywhere I can reach", not "in my default store".

  ### Breaking: `IDataset.askQuery(query: AskQuery): Promise<boolean>` is required

  Every store must implement it; `query.shape` is optional. **No code path in this package rewrites an
  ask as a select** — a store with no boolean primitive decides for itself how to answer, and
  defaulting that here would hide the choice. `askQuery` must resolve to a real boolean (a non-boolean
  is rejected, not coerced, since a truthy value would read as "exists") and must reject on failure.

  ### Wire format `1.1`

  An ask travels as its own envelope, discriminated by `op: 'ask'`:

  ```json
  {"v": "1.1", "op": "ask", "shape": "…/Person", "subject": "…/p1"}
  {"v": "1.1", "op": "ask", "subject": "https://example.org/thing"}
  ```

  Omitting `shape` **is** the shapeless form. There is no `fields`, `limit`, `offset`, `sortBy` or
  `one`, so a receiver has nothing to validate or ignore. `fromJSON` routes `op: 'ask'` to an
  `AskBuilder` and still throws `Unknown query op` on anything unrecognised, so an older peer fails
  loud rather than reinterpreting the envelope as a select. Deploy receivers first.

  New exports: `AskBuilder`, `isAskQuery`, and the `AskQuery` / `AskQueryJSON` / `RawAskInput` /
  `AskSpec` types. `lower()` gains an ask overload returning `IRAskQuery`; `askToAlgebra` /
  `askToSparql` / `askPlanToSparql` / `SparqlAskPlan` / `mapSparqlAskResult` are the SPARQL arm.

  ## Breaking: a shape must declare a `targetClass`

  A query or mutation on a shape with none — on it or on any shape it extends — now throws instead of
  silently typing instances with the shape's own IRI.

  ```ts
  @linkedShape
  class Person extends Shape {
    static targetClass = { id: "https://example.org/Person" }; // required
  }
  ```

  `rdf:type` names the class a node **is**; the shape IRI identifies the SHACL description _of_ that
  class — a different node. Substituting one for the other conflated them, and did so invisibly: read
  and write used the same substitution, so data round-tripped and nothing surfaced the mistake.
  `targetClass` is read off the shape class, so JavaScript static inheritance already walks the
  superclass chain.

  ## A declared `sh:path` is always the predicate

  The resolver skipped any shape or property IRI beginning `linked://tmp/`, substituting the property
  shape's own "shadow" IRI. That skip existed only so this repo's fixtures could assert shape-derived
  predicates; it is gone, along with the `linked://tmp/` special case. Two mutation paths that built
  traversal predicates by hand — bypassing the resolver — now go through it, fixing an expression
  update (`p.bestFriend.name`) that emitted the shadow IRI as a predicate and therefore matched
  nothing.

  ## Migration

  - Declare a `targetClass` on any shape lacking one. Data written under the old behaviour is typed
    with the shape IRI: either set that IRI as the `targetClass`, or retype the nodes.
  - Implement `askQuery` on any `IDataset`.
  - A shape declaring a `linked://tmp/` path gets its declared path as the predicate instead of the
    shadow IRI. No released code minted such IRIs, so this is expected to affect nobody.

- [#214](https://github.com/linked-cm/core/pull/214) [`67e015b`](https://github.com/linked-cm/core/commit/67e015bf7f32dd9cda2a1ad9f5589ead0b8408d3) Thanks [@flyon](https://github.com/flyon)! - One shape metamodel, and inheritance that works for shapes known only as data.

  `NodeShapeData` gains a JSON-safe transport form (`toWire` / `fromWire` in
  `shapes/nodeShapeWire.ts`). It is defined by subtraction from the metamodel — drop the
  circular `parentNodeShape` back-reference, carry `pattern` as its source string and flags
  — so new metamodel fields are carried automatically instead of a hand-maintained subset
  falling behind. `PathExpr` is already a plain discriminated union, so complex SHACL paths
  (sequence, alternative, inverse, the cardinality operators, negated property sets) survive
  a round trip intact rather than collapsing to a single IRI.

  Display vocabulary: `linked_core:displayRank` (a single linear importance rank, lower =
  more important) and `linked_core:displayHidden`, accepted by the property decorators,
  carried on `PropertyShapeData`, registered as meta-shape properties and serialized by
  `syncShapes`. They materialize onto the pure `sh:NodeShape`, so they travel with an
  ejected app.

  Fixes `order` and `group`, which were declared on `PropertyShapeConfig` but never copied
  onto the property shape — a declared `sh:order` was silently dropped and renderers fell
  back to array position.

  `getSuperShapes` is now the single canonical inheritance walk, and `getPropertyShapes`,
  `getPropertyShape` and the class-returning helpers all delegate to it: the prototype chain
  for a class-backed shape (which includes the framework `Shape` root, whose `label` and
  `type` really are inherited), `extends` through the shape registry for a shape with no
  compiled class. Previously the latter case returned only own properties, so a
  project-authored shape silently lost everything it inherited (backlog 040). Since
  `getPropertyShapeByLabel` delegates to `getPropertyShape`, the query proxies are fixed
  too.

  Adds a primary IRI to `NodeShapeData` registry alongside the class registry, so query
  lowering and predicate resolution work for both kinds of shape;
  `registerNodeShape` / `getNodeShape` / `getAllNodeShapes` and the data-based
  `getSuperShapes` / `getSubShapes` / `isSubShapeOf` are exported.
  `SelectBuilder.from(iri)` now resolves a shape that exists only as data.

  Cache invalidation moves from a `setTimeout` plus registry-size comparison to a monotonic
  version counter — the old scheme silently reused a stale cache when a registration and a
  removal coincided, or when a shape was re-registered in place.

  Adds `registerRuntimeShape` / `registerRuntimeShapes`: register a shape that exists only
  as data, taking metadata (`NodeShapeData` or its wire form) rather than a bespoke DTO.
  `registerRuntimeShapes` orders a batch parents-first, because inheritance resolves
  `extends` through the registry and a child registered ahead of its parent would resolve an
  empty chain. Neither shadows a compiled class.

  Query lowering, containment resolution, blank-node deletion and mutation lowering all read
  the shape registry rather than the class registry, so a shape that exists only as data
  lowers to the same SPARQL a compiled one does — with its declared `targetClass` (walking
  `extends` where it is inherited) and its declared `sh:path` as the predicate. `validate()`
  accepts such a shape as registered. The three lowering caches key on the registration
  version instead of the class registry's size, which did not change when a shape was
  re-registered in place.

  The SHACL meta-model's `sh:equals` accessor is relabelled `equalsConstraint`, matching the
  `PropertyShapeData` field (the predicate is unchanged). `equals` is a query-builder method,
  and the query proxy answers a key from its own surface before it looks for a property with
  that label — so a property labelled `equals` returned the DSL method and the field tracer
  failed on a native function. The meta-shape could not read its own constraint. Anything
  looking a constraint up in `getPropertyShapeTerms()` by the label `equals` must now ask for
  `equalsConstraint`.

  Registration now reports the general case: `registerPropertyShape` and
  `registerRuntimeShape` check each label against the query DSL surface
  (`RESERVED_QUERY_DSL_NAMES`) and warn once per shape+label, naming the shape, the property
  and why selecting it will fail. It warns rather than throws — `size`, `id` and `some` are
  legitimate domain property names, such a property still round-trips and is still reachable
  by path through DSL-JSON, and throwing would break existing apps on upgrade.

  The reserved-name warning distinguishes the two proxy surfaces. A name on `QueryShape` is
  always shadowed; a name only on `QueryShapeSet` — `size`, `some`, `every`, `where`, `add`,
  `concat`, `none` — is fine to read directly and only shadowed when the shape is reached
  through a multi-valued property. Both messages now name the existing escape hatch,
  `select(['size'])`, which takes the label as a string and never touches the proxy.

- [#205](https://github.com/linked-cm/core/pull/205) [`48ecb4d`](https://github.com/linked-cm/core/commit/48ecb4dbdc20471bf19a4c4cc9d58ef90f5cd1b1) Thanks [@flyon](https://github.com/flyon)! - Expose the meta-model's SHACL constraint table via `getPropertyShapeTerms()` /
  `getPropertyShapeTerm(label)`, so an alternative serializer can look up each constraint's
  predicate, datatype and node kind rather than hard-coding its own copy.

  Purely additive — `buildPropertyShapeData` is unchanged. Create Now's code→RDF shape sync uses
  this to emit the full SHACL constraint set (pattern, `sh:in`, ranges, lengths, class) instead of
  the five it previously enumerated by hand.

- [#206](https://github.com/linked-cm/core/pull/206) [`a4989a8`](https://github.com/linked-cm/core/commit/a4989a80e3619500238f6c1a8f60cc482458b99a) Thanks [@flyon](https://github.com/flyon)! - Add a boolean existence check to the query API: `Shape.exists(id)` and a terminal
  `.exists()` on the select builder.

  ```ts
  if (await SourceDocument.exists({ id })) {
    await SourceDocument.update(values).for({ id });
  } else {
    await SourceDocument.create({ id, ...values });
  }

  // or, for "does anything match?"
  await Person.select()
    .where((p) => p.name.equals("Semmy"))
    .exists();
  ```

  Until now "does this node exist?" had no direct expression. The natural workaround —
  `select().where(…).one()` — resolves to a row or `null`, so callers wrap it in a
  `.catch(() => null)` and convert; that swallow makes an unreachable store
  indistinguishable from a missing node, silently turning every
  `exists ? update : create` into an unconditional `create`.

  `.exists()` returns a real `Promise<boolean>` and never catches: a store, transport or
  lowering failure rejects, including an unresolved query-context reference in a where
  clause (which `exec()` still reports as `null`, unchanged).

  It also normalises the query to its cheapest correct form first. Dropped: the projection,
  preloads, sorting and pagination — none of them can change whether a _match_ exists, and
  honouring `offset` while dropping the projection could actively flip the answer, since
  `OFFSET` skips rows of a solution sequence whose cardinality depends on the projection.
  Kept: filters, `minus` entries and the subject. So
  `Person.select(p => p.name).orderBy(…).offset(10).exists()` costs and answers exactly the same
  as a bare `Person.exists({id})`.

  See the ask-query entry in this release for what that normalised query becomes on the wire and in
  SPARQL: `.exists()` is a shortcut for an ask query, which is its own query kind with its own
  `IDataset.askQuery` method.

- [#212](https://github.com/linked-cm/core/pull/212) [`44936de`](https://github.com/linked-cm/core/commit/44936ded51a0f84a9d9369c452b407c7f2ae2bb5) Thanks [@flyon](https://github.com/flyon)! - `Shape.upsert()` — create-or-replace against a known id, in one request.

  ```ts
  await SourceDocument.upsert({ filename, checksum }).for({ id });
  ```

  It replaces the branch callers otherwise hand-roll:

  ```ts
  if (await S.exists({ id })) await S.update(values).for({ id });
  else await S.create({ id, ...values });
  ```

  which costs two round-trips, races between them, and — if the existence check is wrong in the
  `false` direction — silently takes `create`, where `INSERT DATA` duplicates single-valued
  properties instead of erroring.

  **Semantics**

  - Replaces **only the properties named**; others on an existing node are untouched. It is not a
    whole-node replace.
  - Always asserts the node's type. `update().for({id})` does not — an update against an absent id
    writes its properties onto an untyped node that shape-scoped selects cannot find. That single
    triple is the entire difference between the two: `update`'s `WHERE` is a bare `OPTIONAL`, so it
    already matches when the node is missing.
  - Returns what `update` returns. It deliberately does not report whether it created or replaced —
    knowing that needs the extra read the single round-trip exists to avoid.
  - `.where()` and `.forAll()` throw: an upsert targets one known id.
  - Expression-valued fields throw. An expression reads the node's current value, which does not
    exist when upsert creates it, and SPARQL would silently drop the triple.

  **Wire format** — a new `op: "upsert"` envelope (`mode` is always `"for"`), documented in
  `documentation/dsl-json.md`. It is a distinct `op` rather than a new `mode` on `update` so that a
  consumer which does not understand it fails loudly instead of falling through to an
  update-every-instance.

  **IR** — a new `IRUpsertMutation` kind, with `upsertToAlgebra` / `upsertToSparql` alongside the
  update equivalents.

### Patch Changes

- [#207](https://github.com/linked-cm/core/pull/207) [`02a32e2`](https://github.com/linked-cm/core/commit/02a32e2bd3483e601b1761ea950e3771ff1c419b) Thanks [@flyon](https://github.com/flyon)! - Never emit a prefixed name whose local part is not a legal SPARQL `PN_LOCAL`.

  `Prefix.toPrefixed()` guarded only against `/`, so when a registered namespace was a proper
  string prefix of an IRI's own namespace the compaction produced names like
  `create-now:access#PolicyRegistry`. `#` is not in `PN_LOCAL`: the tokenizer ends the name at
  `create-now:access` and reads the rest of the line as a **comment**, eating the triple
  terminator and yielding a query the store rejects — with a parse error pointing at the
  _following_ line, which is why this was hard to attribute.

  The local part is now validated against a conservative `PN_LOCAL` allowlist and falls back to
  `<full-iri>` when it does not fit. `collectPrefixes` asks `toPrefixed` rather than
  re-implementing the rule, so the `PREFIX` block and the terms can never disagree.

- [#213](https://github.com/linked-cm/core/pull/213) [`46bc8de`](https://github.com/linked-cm/core/commit/46bc8def877ea741c62baa0e39bf49cec5855176) Thanks [@flyon](https://github.com/flyon)! - Read result bindings under the same sanitized variable name they were written with.

  `algebraToString` sanitizes a projection into a legal SPARQL variable — only letters, digits
  and underscore survive — while `resultMapping` derived the name it reads back without doing
  the same. A property named by a person ("Volume share", "Avg. basket") was therefore emitted
  as `?a0_Volume_share` and looked up as `a0_Volume share`, matching no binding: the value came
  back `null` with no error, for every multi-word property, on every query. Single-word names
  were unaffected, which made it look like missing data rather than a naming mismatch.

- [#189](https://github.com/linked-cm/core/pull/189) [`70a6d33`](https://github.com/linked-cm/core/commit/70a6d33e01f7eaab0e01cc7b59b2bc4c54118655) Thanks [@carlenmy](https://github.com/carlenmy)! - Register `PropertyShape.defaultValue` as a queryable property.

  `sh:defaultValue` was read from config and emitted by `PropertyShape.getResult()`,
  and the published `ShapeDetails` type declares it — but the property was never
  registered in the meta-model, so any query referencing `defaultValue` threw
  before executing. Adds the missing `sh:defaultValue` ontology term and its
  `createPropertyShape` registration, mirroring the existing generic `hasValue`
  registration (literal or IRI, `maxCount: 1`).

- [#209](https://github.com/linked-cm/core/pull/209) [`0eb6b3c`](https://github.com/linked-cm/core/commit/0eb6b3ce841d895734f2c94602f25d412b9fef25) Thanks [@flyon](https://github.com/flyon)! - Fix `update(expr).where(…)` writing one value per node in the store when the expression traverses a
  relation.

  ```ts
  Person.update((p) => ({ hobby: p.bestFriend.name.ucase() })).where((p) =>
    p.name.equals("Moa")
  );
  ```

  The traversal's leaf property was emitted as an `OPTIONAL` _beside_ the traversal edge rather than
  inside it, and before it:

  ```sparql
  OPTIONAL { ?__trav_0__ <…/name> ?__trav_0___name . }   # subject var not yet bound
  OPTIONAL { ?a0 <…/bestFriend> ?__trav_0__ . }
  ```

  The first `OPTIONAL` introduces `?__trav_0__` and so shares no variable with anything to its left —
  a left join with no join condition, i.e. a cartesian product over every node in the store carrying
  that predicate. The second cannot repair it: the variable is already bound, and `OPTIONAL` never
  removes rows. Every resulting row then reached the `INSERT`, so a single-valued property was written
  once per named node, with values taken from unrelated nodes.

  The leaf is now nested inside the edge's `OPTIONAL`, which is what `.for(id)` already emitted for the
  identical expression — the two mutation paths disagreed.

  Only `update()` with a **computed expression that traverses a relation** _and_ a `.where()` clause is
  affected. Plain `update().where()`, and any `update().for(id)`, were already correct.

## 2.17.0

### Minor Changes

- [#198](https://github.com/linked-cm/core/pull/198) [`4a3f607`](https://github.com/linked-cm/core/commit/4a3f6070089396cc596a01703dcfc8939fcb69f0) Thanks [@flyon](https://github.com/flyon)! - Add `canonicalPathKey(expr)` — a stable, prefix-independent identity for a property path.

  A `PathExpr` needs a scalar form whenever it is used as an identity: keying a map of properties, comparing two paths, or naming a property across a process boundary. `pathExprToSparql` cannot serve that purpose — it renders for humans and for queries, shortening IRIs via `formatUri`, so the same path serialises differently depending on which prefixes happen to be registered in the current process.

  ```ts
  import { canonicalPathKey } from "@_linked/core/paths/pathExprToSparql";

  canonicalPathKey("https://schema.org/name"); // 'https://schema.org/name'
  canonicalPathKey({ id: "https://schema.org/name" }); // 'https://schema.org/name' — same key
  canonicalPathKey({ seq: [a, b] }); // '<a>/<b>'
  canonicalPathKey({ inv: a }); // '^<a>'
  ```

  Absolute IRIs, always, never prefixed, so a catalog written in one process matches the same catalog read in another. A **simple** path returns the bare predicate IRI, so single-predicate property identities are unchanged and only complex paths gain a new spelling. Note it is an _identity_, not a round-trippable path: a bare IRI is not valid property-path syntax, so a simple key cannot be fed back to `parsePropertyPath` (complex keys can).

  **Fixes:** `normalizePropertyPath` threw on any bare absolute IRI. `'https://schema.org/name'` contains `/`, so it matched the path-operator test and was handed to the path parser, which then failed on the `//` in the scheme. This was invisible for as long as paths arrived as `NamedNode`s or prefixed names from decorators, and appears the moment a plain IRI string is used — which is every simple property in a shape catalog. A hierarchical IRI is now distinguished from a prefixed-name sequence, so `'ex:a/ex:b'` still parses as a sequence and `'<a>/<b>'` still parses as an expression.

  `PropertyShapeConfig.path` now documents all four accepted forms, including that an ontology term is passed **directly** (`documents.confidence`) and never via `.id` — which would unwrap it back to the bare string.

- [#199](https://github.com/linked-cm/core/pull/199) [`ec22ee1`](https://github.com/linked-cm/core/commit/ec22ee170eed4c9dfb2366b6fcd73d800ec16525) Thanks [@flyon](https://github.com/flyon)! - `syncShapes` can scope its orphan sweep to the namespaces it owns.

  The sweep previously pruned every store-only shape it found. In a **multi-writer** dataset — an app-data store written by more than one package — that means one writer's sync deletes shapes another writer legitimately owns.

  ```ts
  await syncShapes(shapes, { orphanScope: "ownedNamespaces" });
  ```

  - `'all'` _(default, unchanged)_ — prune every store-only shape. Correct when the sync is the sole writer.
  - `'ownedNamespaces'` — only prune shapes in namespaces this sync owns.
  - `'none'` — never prune.

  Additive: omit the option and behaviour is exactly as before.

- [#201](https://github.com/linked-cm/core/pull/201) [`fe7ed7d`](https://github.com/linked-cm/core/commit/fe7ed7de71c0fc95727c5f8e7bcdce97dc19bdf3) Thanks [@flyon](https://github.com/flyon)! - `xsd:time` properties take a pattern-checked **string**, written as a typed literal.

  **Breaking for `xsd:time` only:** a `Date` on an `xsd:time` property is now rejected. `xsd:date` and `xsd:dateTime` are unchanged and still take a `Date` and only a `Date`.

  A time of day is not an instant. Using `Date` for one means inventing a date to carry it: the date half is meaningless, is discarded during serialisation anyway, and makes two identical clock times recorded on different days compare unequal. JavaScript has no time-only type — `Temporal.PlainTime` is the right answer and is not yet available — so the lexical form is the honest representation.

  ```ts
  @literalProperty({path: schedule.startsAt, datatype: xsd.time, maxCount: 1})
  get startsAt(): string { return ''; }

  Appointment.create({startsAt: '14:30:00'});
  // <…> <…#startsAt> "14:30:00"^^xsd:time .
  ```

  Accepted: `HH:MM:SS`, optional milliseconds, optional `Z` or `±HH:MM` offset — `'14:30:00'`, `'14:30:00.250'`, `'14:30:00Z'`, `'14:30:00.250+02:00'`. Ranges are enforced _by the pattern_ (hours `00-23`, minutes and seconds `00-59`), so `'25:00:00'` is rejected rather than written as a malformed literal that no engine will match — a failure that otherwise surfaces as "the data is simply missing". The optional timezone is accepted because it is valid `xsd:time`; rejecting `'14:30:00Z'` would make the check stricter than the datatype it validates.

  **The serialisation half matters as much as the validation.** Mutation literals are typed from the _JavaScript_ type when they reach SPARQL, so a plain string would be written as a plain literal and silently stop matching the property it was meant to fill. A string on an `xsd:time` property is now typed from the **declared** datatype instead.

  That behaviour is driven by an explicit allow-list rather than "type every string from whatever is declared". A string reaching a numeric or boolean property is a mistake `assertValid` rejects; typing it from the declaration would instead write a plausible-looking `"abc"^^xsd:integer` and hide the error in the data. Only datatypes for which a string is a valid lexical form belong in the list.

### Patch Changes

- [#200](https://github.com/linked-cm/core/pull/200) [`0fc0fcf`](https://github.com/linked-cm/core/commit/0fc0fcf988e07624ae13acc4540c63975ed89a5a) Thanks [@flyon](https://github.com/flyon)! - Temporarily relax the `new Shape()` constructor guard.

  The guard added in the shape-instantiation work rejects `new SomeShape()` outright, on the principle that shapes are metadata rather than data. That principle stands — but several framework classes legitimately `extends Shape` and are constructed as runtime service objects (`LinkedServer`, `BackendAPIStore`, `LocalFileStore`, `LincdAPI`, `LincdWebApp`), and the guard crashes a consuming backend at boot.

  The constructor returns to its pre-guard behaviour: it accepts an optional node reference and sets `id`, mirroring `createShapeTarget`. `validate()` / `assertValid()` from the same release are **untouched** — only the constructor throw is deferred.

  This is a deliberate, temporary relaxation, kept as one revertible commit. Re-enable the guard once those classes move to composition or a non-`Shape` base.

## 2.16.1

### Patch Changes

- [#194](https://github.com/linked-cm/core/pull/194) [`2cef8f7`](https://github.com/linked-cm/core/commit/2cef8f79d8bf63680951892132fe753092241323) Thanks [@flyon](https://github.com/flyon)! - `validate()` no longer passes silently when it cannot resolve a shape.

  Neither inheritance nor nesting is carried inside a `NodeShapeData`: a subclass's `propertyShapes` holds only its own, and a property's `valueShape` is a bare `{id}`. The validator resolves both through the shape registry by id — so a caller holding only decorator-generated shape objects can validate with those alone, and `validate(Slide, data)` and `validate(Slide.shape, data)` return the same report. Passing a shape class remains supported; it was never required.

  When such a lookup fails — a shape object whose id was never registered, e.g. one deserialized in a process where the shape definitions were never loaded — the result used to be a false clean bill of health. A shape whose id was unregistered lost its inherited property shapes, so required inherited properties went unchecked _and_ any that were supplied were reported as undeclared keys; an unresolvable nested value was skipped entirely, letting a node report `conforms: true` on the strength of a branch that was never looked at.

  Both now produce an `sh:NodeConstraintComponent` violation naming the shape that could not be resolved:

  ```
  Cannot validate the value of 'author': its shape '…/Author' is not registered.
  Cannot validate the value of 'anything': the property declares no shape for its values.
  Add a 'shape' to its @objectProperty decorator, or give the value a 'shape' key.
  ```

  The second case also catches something that previously passed validation and then threw during normalization: a plain object supplied to a property that declares no shape for its values.

## 2.16.0

### Minor Changes

- [#188](https://github.com/linked-cm/core/pull/188) [`a05a59b`](https://github.com/linked-cm/core/commit/a05a59b78d95e857079aba9c1b43e2be2d8043b1) Thanks [@flyon](https://github.com/flyon)! - **New: `validate(shape, data)`** — SHACL-aligned validation of a plain object against a shape, returning every violation at once instead of throwing on the first.

  New root exports: `validate`, `assertValid`, `ShapeValidationError`, and the types `ValidationReport`, `ValidationResult`, `ValidationMode`, `ValidateOptions`, `ValidatableShape`.

  ```ts
  import { validate } from "@_linked/core";

  const report = validate(Slide, extractedFromDocument);
  report.conforms; // false
  report.results[0];
  // {
  //   sourceConstraintComponent: {id: 'http://www.w3.org/ns/shacl#MinCountConstraintComponent'},
  //   resultSeverity: {id: 'http://www.w3.org/ns/shacl#Violation'},
  //   resultMessage: "Property 'title' requires at least 1 value(s), but none were provided.",
  //   resultPath: {id: '…/props/title'},
  //   propertyPath: 'title',
  // }
  ```

  No builder, no store round-trip. Pass `{mode: 'partial'}` to check only the values provided (an update) rather than the whole node (a create), and `{maxDepth}` to bound descent into nested creates. `assertValid()` is the throwing form; `ShapeValidationError.report` carries the same report.

  Each result is one `sh:ValidationResult` under SHACL's own property names, with IRI-valued fields as `{id}` node references — so a report can be persisted by an ordinary create query against shape classes for `sh:ValidationReport` / `sh:ValidationResult`, with no transform step.

  **Constraints now enforced on writes** that were previously parsed and serialized but never checked: `sh:datatype`, `sh:minInclusive` / `sh:maxInclusive` / `sh:minExclusive` / `sh:maxExclusive`, `sh:minLength` / `sh:maxLength`, `sh:pattern`, and `sh:in`. These check the value in hand, so they apply to creates, updates, and the values inside a `{add: […]}` set modification.

  **Mutations arriving as DSL-JSON are validated too.** `lowerMutationJSON` previously checked only that each property existed on the shape, so an inbound mutation was held to a weaker standard than a locally-built one. It now runs the same validator, `complete` for creates and `partial` for updates.

  **Behavioural changes to review before upgrading:**

  - `Shape.create(data).toJSON()` now throws when a required (`minCount >= 1`) property is missing. Previously only `lower()` and `exec()` did — `toJSON()`, `lower()` and `exec()` now reject identical input.
  - Required properties of _nested_ creates are now checked; previously unchecked at any level.
  - A failing mutation reports every violation rather than the first. Individual messages are unchanged; the aggregated `Missing required fields for 'X': a, b` message is replaced by one result per property.
  - A mistyped literal is now rejected: `{age: '42'}` on an `xsd:integer` property throws. This is a correctness fix — mutation literals are typed from the JavaScript value when they reach SPARQL, so that string was being written as an untyped literal.
  - Properties declared `xsd:date`, `xsd:dateTime` or `xsd:time` accept a JavaScript `Date` and nothing else; a lexical string is now a violation.
  - The serializer honours the declared `sh:datatype` for temporal and numeric literals. One `Date` becomes `"2020-06-15"^^xsd:date` on an `xsd:date` property and a full timestamp on an `xsd:dateTime` one; a property declared `xsd:long` or `xsd:decimal` now emits that datatype instead of the `xsd:integer` / `xsd:double` inferred from the value. Neither the IR nor the wire format changed.

  See `docs/reports/027-shape-validation-report.md` for the full mapping tables, design decisions, and known limitations.

## 2.15.1

### Patch Changes

- [#182](https://github.com/linked-cm/core/pull/182) [`f3f2c4a`](https://github.com/linked-cm/core/commit/f3f2c4adccad155ebd0736ec9f3f09341cf226c2) Thanks [@abdipramana](https://github.com/abdipramana)! - Preserve child property keys when lowering nested array selections. Queries such as `Action.select(action => ({image: action.image.select(image => [image.contentUrl])}))` now map the nested value to `image.contentUrl` instead of incorrectly returning it as `image.image`.

- [#183](https://github.com/linked-cm/core/pull/183) [`81c7b56`](https://github.com/linked-cm/core/commit/81c7b56d0e2ac4678eda33883c82d7ef5b2d47ee) Thanks [@abdipramana](https://github.com/abdipramana)! - Preserve concrete nested shapes when serializing polymorphic `preloadFor()` queries. A preload such as `person.pets.as(Dog).preloadFor(DogCard)` now records the `Dog` shape IRI on the wire, allowing fields defined only on `Dog` to resolve correctly after client-server deserialization.

## 2.15.0

### Minor Changes

- [#177](https://github.com/linked-cm/core/pull/177) [`e5373fd`](https://github.com/linked-cm/core/commit/e5373fdae5824eea9750d11fc16ae4ff2d537c55) Thanks [@flyon](https://github.com/flyon)! - Shapes are now metadata-only: `Shape` subclasses can no longer be instantiated, and SHACL metadata is exposed as plain objects.

  **Behavioral change — `new SomeShape()` throws.** Constructing any `Shape` subclass now throws a clear error steering you to the DSL (`Shape.select(...)`, `.create(...)`, `.update(...)`, `.delete(...)`). Shapes never carried live data — their decorated getters only returned typing stubs — so this turns a silent footgun into a loud error. All querying and mutation continues to go through the DSL exactly as before.

  **Metadata is plain objects.** `SomeShape.shape` and each property shape are now plain `NodeShapeData` / `PropertyShapeData` objects (importable as types from `@_linked/core`), not class instances. The former `NodeShape` / `PropertyShape` instance methods are now free functions, exported from the package:

  ```ts
  import {
    getPropertyShapes, // (nodeShape, includeSuperClasses?) => PropertyShapeData[]
    getUniquePropertyShapes, // (nodeShape) => PropertyShapeData[]
    getPropertyShape, // (nodeShape, label, checkSubShapes?) => PropertyShapeData | undefined
    addPropertyShape, // (nodeShape, propertyShape) => void
    nodeShapeEquals, // (a, b) => boolean
  } from "@_linked/core";

  // before: Person.shape.getUniquePropertyShapes()
  // now:    getUniquePropertyShapes(Person.shape)
  ```

  If you read shape metadata via the old instance methods, switch to these free functions; if you only use the query DSL, no change is needed.

  **Deprecations (scheduled for removal):** `Shape.getSetOf`, `Shape.mapPropertyShapes`, `propertyShapeToResult`, and the `PropertyShapeResult` type. Read the plain `PropertyShapeData` fields directly instead of the result projection.

  **`SparqlDataset` no longer extends `Shape`.** A SPARQL-backed dataset is a live store, not a metadata shape; it never used any `Shape` member. This has no effect on constructing or using datasets/stores.

## 2.14.4

### Patch Changes

- [#174](https://github.com/linked-cm/core/pull/174) [`55fcf97`](https://github.com/linked-cm/core/commit/55fcf97ec97ff03fce08a9ae0ff0d62bb896c5a2) Thanks [@flyon](https://github.com/flyon)! - Dev-only warning when a shape registers under a numerically-suffixed URI (e.g. `.../Person2`) with the same `targetClass` as its base — the signature of a bundler emitting more than one copy of a framework package, which silently breaks cross-runtime shape lookup. Surfaces a build-config regression loudly instead of a no-op at query-forward time.

## 2.14.3

### Patch Changes

- [#169](https://github.com/linked-cm/core/pull/169) [`806dbec`](https://github.com/linked-cm/core/commit/806dbec8aab355a636dc41dc91fa7ef8b703c5bc) Thanks [@flyon](https://github.com/flyon)! - docs: surface the owned-properties cleanup in the README overview — the "Full CRUD Operations" feature bullet now notes automatic cleanup of owned (`contains`) values on replace/remove/delete and links to the "Owned properties (`contains` / `dependent`)" section.

## 2.14.2

### Patch Changes

- [#164](https://github.com/linked-cm/core/pull/164) [`17bfb35`](https://github.com/linked-cm/core/commit/17bfb35049aff5e3482ea54cbcc074639476adbe) Thanks [@flyon](https://github.com/flyon)! - docs: document **owned properties** in the README — a new "Owned properties (`contains` / `dependent`)" section under Shapes explaining exclusive-ownership object properties (`contains: true`) and the automatic cascade cleanup on update-replace, set-remove, and parent-delete, and how the property-level `contains` flag differs from the shape-level `dependent` flag. No code change.

## 2.14.1

### Patch Changes

- [#158](https://github.com/linked-cm/core/pull/158) [`eec6f34`](https://github.com/linked-cm/core/commit/eec6f34f8b73b2740efa8f61dce110bd5ea4ff04) Thanks [@flyon](https://github.com/flyon)! - Fix: a DSL `update()` that replaces, unsets, or set-removes a `contains` (owned) object property now deletes the previously-owned node's own triples instead of leaving it as an orphan in the graph. Previously only the one-hop edge was unlinked (and dependent-typed _descendants_ cascaded), so e.g. replacing a `contains`-owned `ImageObject` via `Workspace.update({image: {contentUrl}})` accumulated stale `ImageObject` nodes.

  The cleanup is driven by the property's `contains` flag (exclusive ownership) and does **not** require the owned child shape to be marked `dependent`. It is safe when there is no prior value (the owning edge is bound in-query, so a missing old value is a no-op).

  New internal export `buildOwnedSelfDelete` in `src/sparql/irToAlgebra.ts` (mirrors `buildOwnedCascade`) for lowering/testing.

## 2.14.0

### Minor Changes

- [#155](https://github.com/linked-cm/core/pull/155) [`c6978a0`](https://github.com/linked-cm/core/commit/c6978a0b88037cf9e3446c91d551b6aa8a6d87b6) Thanks [@flyon](https://github.com/flyon)! - DSL: a shapeless IRI-valued object property (an `@objectProperty` / SHACL property with no value shape and a non-Literal node kind, e.g. `sh:path`) now projects the value's node reference `{id}` in a `.select()` instead of throwing "No shape set for objectProperty". Mirrors how a `shape: Shape` object property (e.g. `sh:targetClass`) already resolves — lets the DSL read raw IRI predicates back out of a store (e.g. reading a SHACL shape catalog). Polymorphic values (rdf:List / PathNode) resolve to their node ref; full structural projection is the `byShape` follow-up (backlog 031).

## 2.13.1

### Patch Changes

- [#152](https://github.com/linked-cm/core/pull/152) [`213467d`](https://github.com/linked-cm/core/commit/213467d07c3e586f0d48336065318a71a9402e73) Thanks [@flyon](https://github.com/flyon)! - Remove the `development` export condition (pointed at `src`, which isn't shipped to npm). Monorepo dev resolves workspace source via the cli Vite plugin; standalone resolves `import → lib`. No consumer-visible change.

## 2.13.0

### Minor Changes

- [#149](https://github.com/linked-cm/core/pull/149) [`a875dc5`](https://github.com/linked-cm/core/commit/a875dc536bc0100063a865c31f8a9e3d87a38aa4) Thanks [@flyon](https://github.com/flyon)! - ESM-only — drops the CommonJS build (`type: module`, no `require` export condition, no `lib/cjs`); global-backed query dispatch shared across duplicate module copies; ESM-safe dir resolution; root `types` field fix.

## 2.12.0

### Minor Changes

- [#144](https://github.com/linked-cm/core/pull/144) [`6dafbc7`](https://github.com/linked-cm/core/commit/6dafbc7c801c3b89bc35a8b3a4922693f28aab51) Thanks [@flyon](https://github.com/flyon)! - Repo-wide analysis follow-through (reports 021–024): leanness, security hardening, and functional-gap fixes. Highlights users should know about:

  **New query capabilities**

  - Membership: `.oneOf([...])` / `.notOneOf([...])` on any query property → SPARQL `IN` / `NOT IN` (empty list constant-folds to match-nothing / match-everything). Works in `.where()` and inside `.some()`/`.every()`.
  - Set size comparisons: `.size().gt(n)` (and `gte`/`lt`/`lte`/`neq`) → `HAVING(count(…) <op> n)`, not just `.equals()`.
  - Multi-key sort now honors a per-path direction: `sortBy: [{name:'ASC'}, {age:'DESC'}]` no longer collapses to the first direction.

  **New exports**

  - `Shape` and `LinkedStorage` are now exported from the package root; the SPARQL layer is reachable at `@_linked/core/sparql`.

  **SHACL**

  - `minInclusive`/`maxInclusive`/`minExclusive`/`maxExclusive`/`minLength`/`maxLength`/`pattern` on a property now serialize into the synced shape (previously declared but silently dropped).

  **Correctness fixes (previously silent-wrong or crashing)**

  - SPARQL operator precedence: nested arithmetic like `a.plus(b).times(c)` now parenthesizes correctly (was emitted as `?a + ?b * ?c`).
  - Mutation input: a computed value in `create` now throws a clear error instead of silently dropping the field; a `null` mutation value no longer crashes; `{add:[…], name:'x'}` no longer silently discards `name`.
  - Nested-select pagination (`.friends.select(...).limit(5)`) now survives DSL-JSON round-trips instead of returning the unbounded set.

  **DSL-JSON wire format** (canonical/interop format — see `documentation/dsl-json.md`)

  - Reconciled with its spec and made more LLM-authorable: relation-keyed projection is the single canonical form; word-operator aliases (`equals`/`gt`/…) are accepted alongside symbols; the seven system value-tags are now `@`-sigiled (`@id`, `@ctx`, `@date`, `@list`, `@add`/`@remove`, `@unset`, `@path`) so a property may be named `date`/`id`/`path`/… without collision. No released consumer persists the old format.

  **Action needed / behavior changes**

  - **`Expr` module trimmed** — the property-first delegators (`Expr.plus`, `Expr.eq`, `Expr.regex`, `Expr.bound`, `Expr.ucase`, …) were removed. Use the fluent form instead: `p.age.plus(1)`, `p.name.matches(/^A/)`, `p.name.isDefined()`, `p.hobby.oneOf([…])`. `Expr` keeps only the non-property-first ops: `now`, `ifThen`, `firstDefined`, `concat`, `not`.
  - **Louder errors** — accessing an undecorated property inside a query callback now throws (it previously warned and returned a garbage constant); `setQueryContext` with an unmaterializable value throws instead of silently no-op'ing; `create`/`update` now reject cardinality (`minCount`/`maxCount`) and literal-vs-relation kind violations at build time.

  **Security** — closed both critical SPARQL-injection vectors (unvalidated IRIs in `formatUri`, unescaped function/aggregate names), plus variable sanitization, a decode recursion-depth cap (DoS), and prototype hygiene on inbound JSON.

  **Leanness** — removed ~1000 lines of dead code, dropped an unused runtime dependency, stopped publishing test-helpers in the package artifact, and fixed a `NodeShape.type` predicate that was clobbered to `sh:description`.

## 2.11.1

### Patch Changes

- [#140](https://github.com/linked-cm/core/pull/140) [`3aeaa0a`](https://github.com/linked-cm/core/commit/3aeaa0a6e86a3012fb33dfa6f29397b5bd312c5d) Thanks [@flyon](https://github.com/flyon)! - Fix the package root `types` field, which pointed to a nonexistent `./index.d.ts`. It now points to `./lib/esm/index.d.ts` (the real declarations, matching the `exports` map). Consumers using the legacy `moduleResolution: "node"` (which reads the root `types` fallback rather than the `exports` map) can now resolve `@_linked/core`'s types for the root import; subpath imports already resolved via `typesVersions`.

## 2.11.0

### Minor Changes

- [#134](https://github.com/linked-cm/core/pull/134) [`e2de396`](https://github.com/linked-cm/core/commit/e2de3963f126afd24d41424abf02ecf03e127233) Thanks [@flyon](https://github.com/flyon)! - Add `exec(target?: IDataset)` to the four query builders (`SelectBuilder`, `CreateBuilder`, `UpdateBuilder`, `DeleteBuilder`) for targeted query execution against an explicit dataset.

  ```ts
  // Run against one specific store/router instead of the global default; the global router is untouched.
  await Person.select((p) => p.name).exec(someStore);
  await NodeShape.create(data).withId(iri).exec(branchStore);
  ```

  - Passing a `target` (a store, or a router — a router _is_ an `IDataset`) runs the query on that dataset only. Omitting it is unchanged (global dispatch), and `await`ing a builder (the PromiseLike path) always stays global — only an explicit `.exec(target)` overrides.
  - `selectQuery` is required on `IDataset`; the mutation methods are optional, so a mutation `exec(target)` **rejects** with a clear message if the target can't perform the op. All `exec` methods are now `async`, so failures (unsupported target, missing global dispatch) surface as rejected promises rather than synchronous throws.

  `syncShape(target, ds?)` and `syncShapes(ds?)` now accept an optional dataset that threads through to every `.exec(ds)`. For `syncShapes`, `ds` is a plan-time parameter feeding both the orphan-detection read and the delete/create thunks, so orphans are computed against the same store they're pruned from; the returned thunks stay nullary.

  ```ts
  const { store } = await getBranchMetadataStore(projectId, branch);
  await syncShape(Person, store)(); // materialize Person's sh:NodeShape into a per-branch store
  ```

  No routing/config/`LinkedStorage` changes — purely an execution-target override on the builder. See `docs/reports/021-targeted-query-execution.md`.

## 2.10.2

### Patch Changes

- [#130](https://github.com/linked-cm/core/pull/130) [`d1d435f`](https://github.com/linked-cm/core/commit/d1d435f85e93091ee795c363465c95b9760615ac) Thanks [@flyon](https://github.com/flyon)! - Fixed 9 correctness bugs in query lowering and result mapping (nested sub-select filters, `.one()` truncation, `isNotDefined`/`defaultTo`/`Expr.ifThen` in `.where()`, nested aggregates, expression-over-traversal projections and updates). Most previously returned silently wrong results rather than errors. No public API changes — see `docs/reports/020-linked-query-test-coverage.md` for details.

## 2.10.1

### Patch Changes

- [#122](https://github.com/linked-cm/core/pull/122) [`9fa981e`](https://github.com/linked-cm/core/commit/9fa981e508950c6d470c78a9ee3a938cd776e3c5) Thanks [@flyon](https://github.com/flyon)! - DSL-JSON is now a compact, **IR-free wire grammar**. `query.toJSON()` no longer embeds
  `IRExpression` in where-clauses or `{kind:…}` value tags in mutations — the wire reads like the DSL,
  and `fromJSON()` rehydrates it losslessly (`lower(fromJSON(query.toJSON())) ≡ lower(query)`).

  (Pre-adoption, so this ships as a patch despite the wire-shape change — there are no published
  consumers of the old format to protect.)

  **Where-clauses** are path-keyed conditions with an S-expr fallback:

  ```jsonc
  { "where": { "name": "Alice", "age": { ">": 18 } } }        // implicit equals + implicit AND
  { "where": { "friends.some": { "name": "Moa" } } }          // quantifiers: some / every / none
  { "where": ["<", ["+", ["STRLEN", {"path":"name"}], 10], 100] }  // computed → S-expr array
  ```

  Values follow one grammar: a bare scalar is a literal; `{id}` a node ref; `{$ctx}` / `{$ctx,path}` a
  query-context reference; `{date}`, `{list}`, `{unset}`, `{add,remove}` the tagged kinds; a computed
  value is an S-expr.

  **Projections** use bare dotted-string leaves (`"name"`, `"friends.friends.name"`), `{as, value}` for
  computed fields, scoped relation filters, and inline `as(<ShapeLabel>)` casts.

  **Mutations** carry path-keyed node data:

  ```jsonc
  {
    "op": "create",
    "shape": "…/Person",
    "data": {
      "name": "Alice",
      "bestFriend": { "name": "Bestie" },
      "friends": { "list": [{ "id": "…" }] }
    }
  }
  ```

  with reserved `__id` (a fixed/predefined id) and `__shape` (the concrete shape, emitted only for a
  subclass instance under a superclass-typed relation).

  **Envelope:** `sortBy` is now an ordered array of `{path: direction}` (element order = precedence);
  `.one()` serializes as `one` (was `singleResult`); the deprecated `orderDirection` is gone.

  **Breaking / behavioral notes**

  - The wire shape of `query.toJSON()` changed across the board; anything that read the old
    IR-embedding / `{shape,fields}` / `{kind:…}` forms must move to the new grammar.
  - The exported types `MutationValueJSON` and `MutationNodeDataJSON` changed shape accordingly.
  - `and`, `or`, and `not` are now **reserved property labels** (they are boolean combinators in a
    where-clause and have no key-position escape) — declaring a property with one of those names throws
    at shape registration.

  See the full [DSL-JSON specification](./documentation/dsl-json.md). Deferred edge items are tracked
  in `docs/backlog/002-dsl-json-open-items.md`.

## 2.10.0

### Minor Changes

- [#114](https://github.com/linked-cm/core/pull/114) [`30dd8d4`](https://github.com/linked-cm/core/commit/30dd8d47a990836dce2c078d07e50258b7a1c659) Thanks [@flyon](https://github.com/flyon)! - Flip the query contract: datasets receive the live query, DSL-JSON is the wire format, and the IR becomes an opt-in store detail behind a free `lower()`.

  **Breaking changes** (the package is pre-adoption, so this ships as a minor rather than a major — there are no published consumers to protect yet)

  - **`build()` is removed** from all builders. Use the free `lower(query)` function to produce IR:
    ```ts
    import { lower } from "@_linked/core";
    const ir = lower(query); // select or any mutation
    ```
  - **`IDataset` methods now receive the live (closed) query object, not IR.** A dataset opts into the IR by calling `lower(query)`, or forwards the query as DSL-JSON via `query.toJSON()`:
    ```ts
    class MyStore implements IDataset {
      async selectQuery(query: SelectQuery) {
        return run(lower(query));
      }
    }
    ```
  - **`SelectQuery`/`CreateQuery`/`UpdateQuery`/`DeleteQuery` are now closed read-only interfaces** (the live query), not aliases of the IR. The IR types are `IRSelectQuery` / `IRCreateMutation` / `IRUpdateMutation` / `IRDeleteMutation`.
  - **`QueryBuilder` is renamed to `SelectBuilder`** (a deprecated `QueryBuilder` alias is still exported).

  **New: DSL-JSON, the standardized wire format**

  Every query — select and every mutation — serializes losslessly to a compact, versioned JSON structure and rehydrates anywhere:

  ```ts
  import { fromJSON } from "@_linked/core";
  const json = query.toJSON(); // builder → DSL-JSON (carries a wire version `v` and the shape)
  await fromJSON(json).exec(); // DSL-JSON → live query → run (kind-detected by `op`)
  ```

  See the new [DSL-JSON specification](./documentation/dsl-json.md) for the envelope shapes, value encodings, and versioning.

  **New: `{$ctx}` query-context references**

  A query can reference the current context (e.g. the signed-in user) without resolving it yet — it travels on the wire as `{$ctx: "user"}` and is resolved at lowering time, whether the context is set or unset when the query is built. Works for the select subject, update target, mutation field values, delete ids, and where-clause args:

  ```ts
  Person.select((p) => p.name).for(getQueryContext("user")); // subject: {$ctx:"user"}
  Person.delete(getQueryContext("user")); // delete-by-context (no .for() needed)
  Person.update({ hobby: "x" }).for(getQueryContext("user"));
  ```

  Mutations throw `UnresolvedContextError` if the context isn't set at lowering; selects resolve to `null`. `subscribeQueryContext(fn)` is exported as the reactivity primitive for re-running queries when a context lands.

  **New / changed exports**

  `lower`, `fromJSON`, `lowerMutationJSON`, `encodeNodeData`, `decodeNodeData`, `subscribeQueryContext`, `UnresolvedContextError`, `encodeContextRef`, `isContextRefJSON`, `resolveContextId`, `CONTEXT_REF_KEY`, and the types `ContextRefJSON` / `DeleteId` / `IRSelectQuery` / `IR*Mutation`.

  **Tree-shaking**

  The IR pipeline (and the SPARQL layer) is reachable only through `lower()`. A client that builds, serializes, and forwards queries but never lowers them tree-shakes the entire IR + SPARQL pipeline out of its bundle. `package.json` now declares `sideEffects` accordingly.

## 2.9.0

### Minor Changes

- [#109](https://github.com/linked-cm/core/pull/109) [`1ed833d`](https://github.com/linked-cm/core/commit/1ed833d4a655e2202fbe2087456f6a95012c0152) Thanks [@flyon](https://github.com/flyon)! - Add `syncShape(target)` — a scoped, single-shape counterpart to `syncShapes()`.

  Materializes **one** code-registered NodeShape into the store (delete → recreate, so the delete
  cascade-cleans the old property-shape / list / path subtrees and the create rebuilds them) and does
  **not** run the store-wide orphan sweep, so other shapes in the store are untouched. Useful when an
  app/package wants to bind a single reused shape into a dataset without reconciling (or pruning) the
  whole shape set.

  ```ts
  import { syncShape } from "@_linked/core";

  await syncShape(Person)(); // by shape class
  await syncShape(Person.shape.id)(); // or by NodeShape IRI
  // composes with itself / syncShapes (each returns one unexecuted thunk):
  await Promise.all(
    [syncShape(Person), syncShape(Address)].map((run) => run())
  );
  ```

  Accepts a shape class or its NodeShape IRI string; throws for framework/meta shapes and
  unregistered IRIs. The per-shape sync thunk is now rebuilt fresh on each invocation, so a thunk
  can be safely re-run (idempotent). See `docs/reports/016-shacl-rdf-serialization.md`.

## 2.8.0

### Minor Changes

- [#91](https://github.com/linked-cm/core/pull/91) [`46b519e`](https://github.com/linked-cm/core/commit/46b519eae3abf9a243f2f04acb04e338635b2e6a) Thanks [@flyon](https://github.com/flyon)! - Development-mode source resolution and an instance-count diagnostic.

  - **Conditional `development` exports.** `package.json` now declares a `development` export condition resolving to `./src/*.ts` (and `./src/index.ts` for the root). Vite's browser-side resolver picks the TypeScript source in dev mode, enabling HMR-on-source for `@_linked/core` from a consuming app. Production resolution (`import` → `lib/esm`, `require` → `lib/cjs`, `types`) is unchanged.
  - **`LinkedStorage.getLoadedInstanceCount(): number`** — new public static method reporting how many `@_linked/core` instances are registered on the global tree (a diagnostic for the Vite-SSR-vs-Node-resolver dual-load split).

- [#91](https://github.com/linked-cm/core/pull/91) [`46b519e`](https://github.com/linked-cm/core/commit/46b519eae3abf9a243f2f04acb04e338635b2e6a) Thanks [@flyon](https://github.com/flyon)! - Shape, package, and framework-vocabulary IRIs now use the canonical `linked.cm` namespace, with a configurable per-package publish root.

  **New scheme (arch-aligned):**

  - Shape IRIs: `https://linked.cm/shape/{packageSlug}/{ShapeName}` (PascalCase shape name; previously `https://data.lincd.org/module/{sanitized}/shape/{lowercased}`).
  - Package IRIs: `https://linked.cm/pkg/{packageSlug}` (previously `…/module/{name}`).
  - Framework vocabulary: `https://linked.cm/ont/linked-core/` (prefix `linked_core`; previously `https://purl.org/on/lincd/`, prefix `lincd`). The `Module` term is renamed to `Package`.

  **New / changed public API:**

  - `linkedPackage(name, { baseUri? })` — packages declare where they publish. `baseUri` defaults to `https://linked.cm/` (first-party); CN injects a workspace-scoped root (`{workspaceSlug}.id.create.now`) for private packages. The IRI slug is the package **basename** with the npm scope dropped (`@_linked/core` → `core`, `@linked.cm/blog` → `blog`); there is no separate slug param. Slugs must be globally unique within the publish root — the registry enforces this and reserves the first-party (`@_linked`) names.
  - New exports `LINKED_DATA_ROOT`, `getPackageUri()`, `setPackagePublishConfig()`, `packageNameToSlug()` (replaces the removed `LINCD_DATA_ROOT`).
  - The framework ontology export is now `coreOntology` (was `lincd`).

  **Breaking:** generated shape/package/term IRIs change. Consumers that hardcoded `data.lincd.org` IRIs, imported `LINCD_DATA_ROOT`, or used the `lincd` ontology export must update. Stored data keyed on the old IRIs needs migration.

- [#97](https://github.com/linked-cm/core/pull/97) [`7c2fea9`](https://github.com/linked-cm/core/commit/7c2fea984e53115b7a85dbe4ced2ca18a2b94f4f) Thanks [@flyon](https://github.com/flyon)! - Serialize code-defined SHACL shapes into the store and keep them in sync.

  **New exports**

  - `syncShapes(): Promise<Array<() => Promise<void>>>` — materializes every code-registered
    (non-framework) `NodeShape` into the store as SHACL data. Returns built-but-unexecuted thunks so the
    caller controls execution/batching; each thunk runs `delete → recreate` for one shape (cascade-cleaning
    its old property shapes / list / path subtrees), plus orphan-delete thunks for shapes removed from code.
    ```ts
    import { syncShapes } from "@_linked/core";
    await Promise.all((await syncShapes()).map((run) => run()));
    ```
  - `rdfList(items, {base?})` — builds an ordered `rdf:List` (nested `List` node-data) for use in any
    create/update, so ordered collections (and `sh:in`) round-trip instead of becoming unordered sets:
    ```ts
    Playlist.create({ tracks: rdfList([t1, t2, t3]) });
    ```
  - `serializePathToNodeData(pathExpr, baseIri)` — translates a `PathExpr` to `sh:path` node-data
    (predicate IRI / `rdf:List` sequence / `PathNode` for inverse·alternative·cardinality).
  - `PathNode` shape (`linked:PathNode`) — operator node for complex property paths.

  **New composition flags (delete/update cascade)**

  - `@objectProperty({ …, contains: true })` marks a property as owning its value(s); `@linkedShape({
dependent: true })` marks a shape whose instances may be cascade-deleted when reached through a
    `contains` edge. Deleting or replacing a `contains` property now removes the whole owned subtree
    (e.g. an `rdf:List` spine or a `sh:path` operator tree), while shared predicate/value IRIs and
    `rdf:nil` are preserved.
  - `@linkedShape({ closed: true, ignoredProperties: [...] })` now persist as `sh:closed` /
    `sh:ignoredProperties`.

  **New SHACL/ontology terms:** `sh:equals`, `sh:disjoint`, `sh:hasValue`, `sh:order`, `sh:group`,
  `sh:closed`, `sh:ignoredProperties`; `linked_core:contains`, `linked_core:dependent`, `linked_core:PathNode`.

  **Potentially breaking:** the `List` shape was rewritten to a pure `rdf:List` cell shape — its former
  in-memory helpers (`fromItems`, `getContents`, `addItem(s)`, `isEmpty`, `items`) were removed. Use
  `rdfList()` to build lists. `List` had no RDF-backed consumers, so most users are unaffected.

  See `docs/reports/016-shacl-rdf-serialization.md` for the full design, cascade mechanics, and test coverage.

- [#91](https://github.com/linked-cm/core/pull/91) [`46b519e`](https://github.com/linked-cm/core/commit/46b519eae3abf9a243f2f04acb04e338635b2e6a) Thanks [@flyon](https://github.com/flyon)! - SPARQL generation: structured property paths on named properties, and inner pagination for nested selects.

  **Structured `sh:path` on named properties now resolve correctly.** A query that references a named property whose SHACL `sh:path` is structured (a sequence `[a, b]`, an inverse `^p`, or an alternative `a|b`) previously collapsed to a shadow IRI and matched nothing. It now emits the correct SPARQL property-path predicate. Simple single-predicate properties are unaffected (output unchanged).

  **Nested selects can now bound a related collection with `.limit()` / `.offset()` / `.orderBy()`** — when the outer query targets a single subject:

  ```ts
  // Up to 2 friends, ordered, for one person
  Person.select((p) =>
    p.friends
      .select((f) => f.name)
      .orderBy((f) => f.name)
      .limit(2)
  ).for({ id });
  ```

  This emits a real SPARQL sub-`SELECT … ORDER BY … LIMIT … OFFSET …` that bounds the collection per parent. `orderBy` accepts a proxy callback (`f => f.name`) or a property-name string and defaults to ascending.

  Notes:

  - Per-group pagination across **multiple** parents is not supported and now throws a clear error instead of silently applying a global limit. The same applies to `.limit()` on a deeper (grandchild) collection, and to `.limit()` called directly on a traversal without `.select(...)`.
  - Queries with no inner pagination are emitted exactly as before.

### Patch Changes

- [#91](https://github.com/linked-cm/core/pull/91) [`46b519e`](https://github.com/linked-cm/core/commit/46b519eae3abf9a243f2f04acb04e338635b2e6a) Thanks [@flyon](https://github.com/flyon)! - `initTree()` is now idempotent: if `global.lincd` already exists (which
  happens structurally under Vite SSR — Vite resolves `@_linked/core/utils/Package`
  from `src/`, and any `/* @vite-ignore */` dynamic import via Node's resolver
  gets it from `lib/esm/`), the function attaches to the existing registry
  instead of throwing or warning.

  Previous behavior used a `_lincdMultiWarned` one-shot flag that logged a
  warning on the second initialization. This was framed as "interim" but
  was actually the correct semantic for the Vite-SSR-vs-Node-resolver split.
  The new code expresses the same behavior as the explicit design rather
  than as a workaround.

  No API change. Existing consumers see the same `lincd` global tree they
  saw before. Apps that previously saw "Multiple versions of Linked are
  loaded — accepted during HMR/Vite interim" in their dev log will no
  longer see that line.

  Context: see create-now plan-011 report (docs/reports/009-legacy-lincd-eradication.md).

- [#96](https://github.com/linked-cm/core/pull/96) [`3114383`](https://github.com/linked-cm/core/commit/3114383563fc9d1c8a4ae11356792a8595f6027a) Thanks [@flyon](https://github.com/flyon)! - Lower multi-valued projected traversals into OPTIONAL (left-join) subtrees.

  Report 014 fixed projection-only **singular** object traversals (`maxCount <= 1`)
  to use nested `OPTIONAL` so a parent with a missing nested object is preserved.
  That gate is now lifted: **multi-valued** projected traversals (e.g. a
  `ShapeSet` like `knows`/`friends`/`pets`, with no `maxCount`) are lowered the
  same way.

  A query such as `Person.select(p => [p.givenName, p.knows.select(k => [k.givenName])])`
  now returns every person — those with no `knows` get `knows: []` — instead of
  inner-joining the parent away. The result grouper already collects multiple
  child bindings into an array, so no mapping changes were needed.

  Filtered (`.where(...)`) and otherwise-required traversals keep their existing
  semantics, and paginated nested selects (inner `LIMIT`/`OFFSET`) are still
  emitted as sub-SELECTs.

## 2.7.0

### Minor Changes

- [#93](https://github.com/linked-cm/core/pull/93) [`89b3f55`](https://github.com/linked-cm/core/commit/89b3f5503329d88d0e6d9fe0a2a1418e06a58252) Thanks [@flyon](https://github.com/flyon)! - Development-mode source resolution and an instance-count diagnostic.

  - **Conditional `development` exports.** `package.json` now declares a `development` export condition resolving to `./src/*.ts` (and `./src/index.ts` for the root). Vite's browser-side resolver picks the TypeScript source in dev mode, enabling HMR-on-source for `@_linked/core` from a consuming app. Production resolution (`import` → `lib/esm`, `require` → `lib/cjs`, `types`) is unchanged.
  - **`LinkedStorage.getLoadedInstanceCount(): number`** — new public static method reporting how many `@_linked/core` instances are registered on the global tree (a diagnostic for the Vite-SSR-vs-Node-resolver dual-load split).

- [#93](https://github.com/linked-cm/core/pull/93) [`89b3f55`](https://github.com/linked-cm/core/commit/89b3f5503329d88d0e6d9fe0a2a1418e06a58252) Thanks [@flyon](https://github.com/flyon)! - Shape, package, and framework-vocabulary IRIs now use the canonical `linked.cm` namespace, with a configurable per-package publish root.

  **New scheme (arch-aligned):**

  - Shape IRIs: `https://linked.cm/shape/{packageSlug}/{ShapeName}` (PascalCase shape name; previously `https://data.lincd.org/module/{sanitized}/shape/{lowercased}`).
  - Package IRIs: `https://linked.cm/pkg/{packageSlug}` (previously `…/module/{name}`).
  - Framework vocabulary: `https://linked.cm/ont/linked-core/` (prefix `linked_core`; previously `https://purl.org/on/lincd/`, prefix `lincd`). The `Module` term is renamed to `Package`.

  **New / changed public API:**

  - `linkedPackage(name, { baseUri? })` — packages declare where they publish. `baseUri` defaults to `https://linked.cm/` (first-party); CN injects a workspace-scoped root (`{workspaceSlug}.id.create.now`) for private packages. The IRI slug is the package **basename** with the npm scope dropped (`@_linked/core` → `core`, `@linked.cm/blog` → `blog`); there is no separate slug param. Slugs must be globally unique within the publish root — the registry enforces this and reserves the first-party (`@_linked`) names.
  - New exports `LINKED_DATA_ROOT`, `getPackageUri()`, `setPackagePublishConfig()`, `packageNameToSlug()` (replaces the removed `LINCD_DATA_ROOT`).
  - The framework ontology export is now `coreOntology` (was `lincd`).

  **Breaking:** generated shape/package/term IRIs change. Consumers that hardcoded `data.lincd.org` IRIs, imported `LINCD_DATA_ROOT`, or used the `lincd` ontology export must update. Stored data keyed on the old IRIs needs migration.

- [#93](https://github.com/linked-cm/core/pull/93) [`89b3f55`](https://github.com/linked-cm/core/commit/89b3f5503329d88d0e6d9fe0a2a1418e06a58252) Thanks [@flyon](https://github.com/flyon)! - SPARQL generation: structured property paths on named properties, and inner pagination for nested selects.

  **Structured `sh:path` on named properties now resolve correctly.** A query that references a named property whose SHACL `sh:path` is structured (a sequence `[a, b]`, an inverse `^p`, or an alternative `a|b`) previously collapsed to a shadow IRI and matched nothing. It now emits the correct SPARQL property-path predicate. Simple single-predicate properties are unaffected (output unchanged).

  **Nested selects can now bound a related collection with `.limit()` / `.offset()` / `.orderBy()`** — when the outer query targets a single subject:

  ```ts
  // Up to 2 friends, ordered, for one person
  Person.select((p) =>
    p.friends
      .select((f) => f.name)
      .orderBy((f) => f.name)
      .limit(2)
  ).for({ id });
  ```

  This emits a real SPARQL sub-`SELECT … ORDER BY … LIMIT … OFFSET …` that bounds the collection per parent. `orderBy` accepts a proxy callback (`f => f.name`) or a property-name string and defaults to ascending.

  Notes:

  - Per-group pagination across **multiple** parents is not supported and now throws a clear error instead of silently applying a global limit. The same applies to `.limit()` on a deeper (grandchild) collection, and to `.limit()` called directly on a traversal without `.select(...)`.
  - Queries with no inner pagination are emitted exactly as before.

### Patch Changes

- [#93](https://github.com/linked-cm/core/pull/93) [`89b3f55`](https://github.com/linked-cm/core/commit/89b3f5503329d88d0e6d9fe0a2a1418e06a58252) Thanks [@flyon](https://github.com/flyon)! - `initTree()` is now idempotent: if `global.lincd` already exists (which
  happens structurally under Vite SSR — Vite resolves `@_linked/core/utils/Package`
  from `src/`, and any `/* @vite-ignore */` dynamic import via Node's resolver
  gets it from `lib/esm/`), the function attaches to the existing registry
  instead of throwing or warning.

  Previous behavior used a `_lincdMultiWarned` one-shot flag that logged a
  warning on the second initialization. This was framed as "interim" but
  was actually the correct semantic for the Vite-SSR-vs-Node-resolver split.
  The new code expresses the same behavior as the explicit design rather
  than as a workaround.

  No API change. Existing consumers see the same `lincd` global tree they
  saw before. Apps that previously saw "Multiple versions of Linked are
  loaded — accepted during HMR/Vite interim" in their dev log will no
  longer see that line.

  Context: see create-now plan-011 report (docs/reports/009-legacy-lincd-eradication.md).

## 2.6.0

### Minor Changes

- [#80](https://github.com/linked-cm/core/pull/80) [`439d1a3`](https://github.com/linked-cm/core/commit/439d1a3ac0a5754a191876ca6dfe50905829a5fd) Thanks [@flyon](https://github.com/flyon)! - Storage refactor (`parseDatasetsConfig` + `loadStores`) and dataset-terminology renames.

  **New: `parseDatasetsConfig`.** Reads `linked.<side>.datasets.json` in the new shape `{ datasets: { <alias>: { store: "<npm-path>", config: {...} } } }`, resolves `${VAR}` placeholders against the runtime environment, and returns a typed config object. Replaces the old shape that pre-baked store classes.

  **New: `loadStores` (BE async dispatcher).** Given the parsed config, dynamically imports each alias's `store` package by its npm path and instantiates with the alias's `config`. Lives in its own file (`utils/loadStores.ts`) so frontend bundles can import `parseDatasetsConfig` without webpack flagging the dynamic import as a critical dependency. Frontend code hardcodes the per-alias store mapping; only backend uses `loadStores`.

  **Breaking: `buildStoresFromConfig` removed.** Replaced by the `parseDatasetsConfig` + `loadStores` pair. Migration: split your call into the parse + load steps; the parsed config can be re-used by frontend code (which then imports stores statically).

  **Breaking: dataset-terminology renames.** Continuing the IQuadStore → IDataset rename from 2.5.0 to public API surfaces:

  ```ts
  // before
  LinkedStorage.setDefaultStore(store);
  LinkedStorage.setStoreForShapes(store, [Shape1, Shape2]);
  import { SparqlStore } from "@_linked/core/datasets/SparqlStore";

  // after
  LinkedStorage.setDefaultDataset(dataset);
  LinkedStorage.setDatasetForShapes(dataset, [Shape1, Shape2]);
  import { SparqlDataset } from "@_linked/core/datasets/SparqlDataset";
  ```

  The class is the same; the public name now reflects the "every store is a dataset" model.

  **Fix: mutation-side URI resolution.** Companion to PR #77 — apply the same URI fidelity fix on the SPARQL mutation path (was previously only on the read path).

  **Fix: projected optional traversals.** SPARQL execution preserves projection through optional triple patterns.

  **Fix: SHACL malformed inherited property shapes guarded.** No longer throws on malformed inheritance chains; emits a warning instead.

  **Internal: harden `selectQuery` + asset helpers.** Better error messages on invalid input. Test helper `findComposeFile` updated to find docker-compose test files in additional paths.

### Patch Changes

- [#82](https://github.com/linked-cm/core/pull/82) [`e340be8`](https://github.com/linked-cm/core/commit/e340be8c104ba709df5d14d0f3b3ed4c7f7decbd) Thanks [@flyon](https://github.com/flyon)! - CI: remove `publishConfig.provenance: true`. npm registry rejects publishes with provenance when trusted-publishing isn't configured for the package. Aligns with the other `@_linked/*` packages, which publish without provenance.

- [#87](https://github.com/linked-cm/core/pull/87) [`c7089bf`](https://github.com/linked-cm/core/commit/c7089bf06c4d1f027acef311631bbcb5deb1aa5e) Thanks [@flyon](https://github.com/flyon)! - CI: switch to OIDC trusted publishing.

  Publishes from this repo's `publish.yml` workflow now authenticate via GitHub Actions OIDC, signed against the trusted-publisher entry on npm for `@_linked/core`. No `NPM_AUTH_TOKEN` is used. Each published tarball carries provenance attestation.

  The npm-side package settings should pair this with `mfa=publish` + Trusted Publisher entry: `linked-cm/core` repo + `publish.yml` workflow. Token-based publishes (including from leaked GH secrets) are then blocked entirely; only this specific workflow can publish.

## 2.5.0

### Minor Changes

- [#70](https://github.com/linked-cm/core/pull/70) [`43a38fb`](https://github.com/linked-cm/core/commit/43a38fb9aaf41dd3f73dd05ea540d02ba300f9fb) Thanks [@flyon](https://github.com/flyon)! - Rename `IQuadStore` → `IDataset`

  The universal dataset interface is now exported as `IDataset`. This better reflects its role: every dataset in the Linked framework accepts Linked Queries as input, and the implementing class decides how to handle them (compile to SPARQL, forward to a Host Agent API, translate to SQL, etc.).

  **Migration:** replace all imports of `IQuadStore` with `IDataset`:

  ```ts
  // before
  import type { IQuadStore } from "@_linked/core/interfaces/IQuadStore";
  // after
  import type { IDataset } from "@_linked/core/interfaces/IDataset";
  ```

  Classes that previously `implements IQuadStore` should now `implements IDataset`. The interface contract is unchanged — `init`, `selectQuery`, `updateQuery`, `createQuery`, `deleteQuery`.

### Patch Changes

- [#70](https://github.com/linked-cm/core/pull/70) [`e39f5fc`](https://github.com/linked-cm/core/commit/e39f5fc177648bef4100242abf4b15c3380b89cc) Thanks [@flyon](https://github.com/flyon)! - `linkedShape`: store un-sanitized `packageName` on each shape constructor during registration. Consumers like `LincdServerProxy.parseShape` can now route backend calls using the real module specifier (e.g. `@_linked/server`) rather than extracting from the URI — the URI form is lossy (`URI.sanitize` strips `@` and `/` to `-`), so round-tripping the sanitized form as a module specifier fails module resolution.

## 2.4.1

### Patch Changes

- [#60](https://github.com/Semantu/linked/pull/60) [`ec239d3`](https://github.com/Semantu/linked/commit/ec239d301d38580b3e58eee1227090dd5f831c2a) Thanks [@flyon](https://github.com/flyon)! - Fix QueryBuilder.toJSON() to serialize where, orderBy, minus, and preload clauses that were previously silently dropped during JSON round-trips

- [#64](https://github.com/Semantu/linked/pull/64) [`a8d9ad9`](https://github.com/Semantu/linked/commit/a8d9ad955579418388649b524b4bb30ce2654d67) Thanks [@flyon](https://github.com/flyon)! - Refine SPARQL select lowering so top-level null-rejecting filters emit required triples instead of redundant `OPTIONAL` bindings. Queries like `Person.select().where((p) => p.name.equals('Semmy'))` now lower to a required `?a0 <name> ?a0_name` triple, while cases that still need nullable behavior such as `p.name.equals('Jinx').or(p.hobby.equals('Jogging'))` remain optional.

  This change does not add new DSL APIs, but it does change the generated SPARQL shape for some outer `where()` clauses to better match hand-written intent. Inline traversal `.where(...)`, `EXISTS` filters, and aggregate `HAVING` paths keep their previous behavior.

  See `documentation/sparql-algebra.md` for the updated lowering rules and examples.

## 2.4.0

### Minor Changes

- [#53](https://github.com/Semantu/linked/pull/53) [`44da872`](https://github.com/Semantu/linked/commit/44da87295524226f430fdfb6cdf98e686d591913) Thanks [@flyon](https://github.com/flyon)! - ### New: `.none()` collection quantifier

  Added `.none()` on `QueryShapeSet` for filtering where no elements match a condition:

  ```typescript
  // "People who have NO friends that play chess"
  Person.select((p) => p.name).where((p) =>
    p.friends.none((f) => f.hobby.equals("Chess"))
  );
  ```

  Generates `FILTER(NOT EXISTS { ... })` in SPARQL. Equivalent to `.some(fn).not()`.

  ### Changed: `.equals()` now returns `ExpressionNode` (was `Evaluation`)

  `.equals()` on query proxies now returns `ExpressionNode` instead of `Evaluation`, enabling `.not()` chaining:

  ```typescript
  // Now works — .equals() chains with .not()
  .where(p => p.name.equals('Alice').not())
  .where(p => Expr.not(p.name.equals('Alice')))
  ```

  ### Changed: `.some()` / `.every()` now return `ExistsCondition` (was `SetEvaluation`)

  `.some()` and `.every()` on collections now return `ExistsCondition` which supports `.not()`:

  ```typescript
  .where(p => p.friends.some(f => f.name.equals('Alice')).not()) // same as .none()
  ```

  ### Breaking: `Evaluation` class removed

  The `Evaluation` class and related types (`SetEvaluation`, `WhereMethods`, `WhereEvaluationPath`) have been removed. Code that imported or depended on these types must migrate to `ExpressionNode` / `ExistsCondition`. The `WhereClause` type now accepts `ExpressionNode | ExistsCondition | callback`.

  ### New exports

  - `ExistsCondition` — from `@_linked/core/expressions/ExpressionNode`
  - `isExistsCondition()` — type guard for ExistsCondition

## 2.3.0

### Minor Changes

- [#47](https://github.com/Semantu/linked/pull/47) [`4917894`](https://github.com/Semantu/linked/commit/49178946a0a5fc95c71c69a430da6602e561c5f2) Thanks [@flyon](https://github.com/flyon)! - Fix maxCount-aware result mapping for single-value and multi-value properties

  **Single-value properties** (`maxCount: 1`, e.g. `bestFriend`) now return a single `ResultRow` (or `null` when absent) instead of `ResultRow[]` when accessed via traversal queries like `Person.select(p => p.bestFriend.name)`.

  **Multi-value object properties** (e.g. `friends`, without `maxCount`) now correctly return `ResultRow[]` arrays when selected via flat projections like `Person.select(p => p.friends)`. Previously, only the first entity reference was returned.

  **Multi-value literal properties** (e.g. `nickNames: string[]`) now correctly return typed arrays (e.g. `string[]`). Previously, values were silently dropped and an empty array was returned.

  **Behavioral changes:**

  - If your code accesses single-value traversal results as arrays (e.g. `result.bestFriend[0]`), update to access the value directly (`result.bestFriend`).
  - If your code expects multi-value flat select results as single objects (e.g. `result.friends.id`), update to handle arrays (`result.friends[0].id`).

  The `maxCount` metadata from `PropertyShape` is now propagated through the full IR pipeline (`IRTraversePattern.maxCount`, `IRPropertyExpression.maxCount`) and used during SPARQL result mapping.

## 2.2.3

### Patch Changes

- [#42](https://github.com/Semantu/linked/pull/42) [`1b4d114`](https://github.com/Semantu/linked/commit/1b4d114f22aec4e984b744733dbab603df8b282d) Thanks [@flyon](https://github.com/flyon)! - Add `PendingQueryContext` for lazy query context resolution. `getQueryContext()` now returns a live reference with a lazy `.id` getter instead of `null` when the context hasn't been set yet. `QueryBuilder.for()` accepts `PendingQueryContext` and `null`. New `hasPendingContext()` method. `setQueryContext(name, null)` now properly clears the entry. Test Fuseki port changed to 3939; `globalSetup`/`globalTeardown` added for reliable Fuseki auto-start.

## 2.2.2

### Patch Changes

- [#40](https://github.com/Semantu/linked/pull/40) [`4688fdd`](https://github.com/Semantu/linked/commit/4688fdd3edb949ddca50886d51549aa543a99033) Thanks [@flyon](https://github.com/flyon)! - ### Bug fixes

  - **`MutationQuery.convertNodeDescription()`** no longer mutates the caller's input object. Previously, `delete obj.id` / `delete obj.__id` operated directly on the passed-in object, causing shared references to lose their `id` across sequential creates.
  - **`SparqlStore.createQuery()`** now respects a pre-set `data.id` from `__id` instead of always generating a new URI via `generateEntityUri()`. Entities created with custom identity (e.g. webID) are now stored under the correct URI.

  ### Test infrastructure

  - Jest config simplified: `roots` + single `testMatch` pattern prevents duplicate test runs.
  - Fuseki integration tests now call `ensureFuseki()` to auto-start Docker when Fuseki isn't running.
  - Parallel test safety: `afterAll` clears data instead of deleting the shared dataset.
  - Added regression tests for both fixes (unit + Fuseki integration).

## 2.2.1

### Patch Changes

- [#37](https://github.com/Semantu/linked/pull/37) [`0a3adc1`](https://github.com/Semantu/linked/commit/0a3adc1b9c47d9101da6d5c8b09e44531e2e396f) Thanks [@flyon](https://github.com/flyon)! - Fix SPARQL generation for `.where()` filters with OR conditions and `.every()`/`.some()` quantifiers.
  Tightened assertions across multiple integration tests.

## 2.2.0

### Patch Changes

- [#34](https://github.com/Semantu/linked/pull/34) [`e2ae4a2`](https://github.com/Semantu/linked/commit/e2ae4a28e5be28716e1634ca81d9c379a291cbc6) Thanks [@flyon](https://github.com/flyon)! - ### SHACL property path support

  Property decorators now accept full SPARQL property path syntax:

  ```ts
  @literalProperty({path: 'foaf:knows/foaf:name'})        // sequence
  @literalProperty({path: '<http://ex.org/a>|<http://ex.org/b>'})  // alternative
  @literalProperty({path: '^foaf:knows'})                  // inverse
  @literalProperty({path: 'foaf:knows*'})                  // zeroOrMore
  ```

  New exports from `src/paths/`:

  - `PathExpr`, `PathRef` — AST types for property paths
  - `parsePropertyPath(input): PathExpr` — parser for SPARQL property path strings
  - `normalizePropertyPath(input): PathExpr` — normalizes any input form to canonical AST
  - `pathExprToSparql(expr): string` — renders PathExpr to SPARQL syntax
  - `serializePathToSHACL(expr): SHACLPathResult` — serializes to SHACL RDF triples

  `PropertyShape.path` is now typed as `PathExpr` (was opaque). Complex paths flow through the full IR pipeline and emit correct SPARQL property path syntax in generated queries.

  ### Strict prefix resolution in query API

  `QueryBuilder.for()` and `.forAll()` now throw on unregistered prefixes instead of silently passing through. New export:

  - `resolveUriOrThrow(str): string` — strict prefix resolution (throws on unknown prefix)

  ### SHACL constraint field fixes

  - `hasValue` and `in` config fields now correctly handle literal values (`string`, `number`, `boolean`) — previously all values were wrapped as IRI nodes
  - `lessThan` and `lessThanOrEquals` config fields are now wired into `createPropertyShape` and exposed via `getResult()`
  - New `PropertyShapeResult` interface provides typed access to `getResult()` output

## 2.1.0

### Minor Changes

- [#31](https://github.com/Semantu/linked/pull/31) [`eb88865`](https://github.com/Semantu/linked/commit/eb8886564f2c9663805c4308a834ca615f9a1dab) Thanks [@flyon](https://github.com/flyon)! - Properties in `select()` and `update()` now support expressions — you can compute values dynamically instead of just reading or writing raw fields.

  ### What's new

  - **Computed fields in queries** — chain expression methods on properties to derive new values: string manipulation (`.strlen()`, `.ucase()`, `.concat()`), arithmetic (`.plus()`, `.times()`, `.abs()`), date extraction (`.year()`, `.month()`, `.hours()`), and comparisons (`.gt()`, `.eq()`, `.contains()`).

    ```typescript
    await Person.select((p) => ({
      name: p.name,
      nameLen: p.name.strlen(),
      ageInMonths: p.age.times(12),
    }));
    ```

  - **Expression-based WHERE filters** — filter using computed conditions, not just equality checks. Works on queries, updates, and deletes.

    ```typescript
    await Person.select((p) => p.name).where((p) => p.name.strlen().gt(5));
    await Person.update({ verified: true }).where((p) => p.age.gte(18));
    ```

  - **Computed updates** — when updating data, calculate new values based on existing ones instead of providing static values. Pass a callback to `update()` to reference current field values.

    ```typescript
    await Person.update((p) => ({ age: p.age.plus(1) })).for(entity);
    await Person.update((p) => ({
      label: p.firstName.concat(" ").concat(p.lastName),
    })).for(entity);
    ```

  - **`Expr` module** — for expressions that don't start from a property, like the current timestamp, conditional logic, or coalescing nulls.

    ```typescript
    await Person.update({ lastSeen: Expr.now() }).for(entity);
    await Person.select((p) => ({
      displayName: Expr.firstDefined(p.nickname, p.name),
    }));
    ```

  Update expression callbacks are fully typed — `.plus()` only appears on number properties, `.strlen()` only on strings, etc.

  ### New exports

  `ExpressionNode`, `Expr`, `ExpressionInput`, `PropertyRefMap`, `ExpressionUpdateProxy<S>`, `ExpressionUpdateResult<S>`, and per-type method interfaces (`NumericExpressionMethods`, `StringExpressionMethods`, `DateExpressionMethods`, `BooleanExpressionMethods`, `BaseExpressionMethods`).

  See the [README](./README.md#computed-expressions) for the full method reference and more examples.

## 2.0.1

### Patch Changes

- [#27](https://github.com/Semantu/linked/pull/27) [`d3c1e91`](https://github.com/Semantu/linked/commit/d3c1e918b2a63240ddbf3cb550ec43fa1e019c35) Thanks [@flyon](https://github.com/flyon)! - Add MINUS support on QueryBuilder with multiple call styles:

  - `.minus(Shape)` — exclude by shape type
  - `.minus(p => p.prop.equals(val))` — exclude by condition
  - `.minus(p => p.prop)` — exclude by property existence
  - `.minus(p => [p.prop1, p.nested.prop2])` — exclude by multi-property existence with nested path support

  Add bulk delete operations:

  - `Shape.deleteAll()` / `DeleteBuilder.from(Shape).all()` — delete all instances with schema-aware blank node cleanup
  - `Shape.deleteWhere(fn)` / `DeleteBuilder.from(Shape).where(fn)` — conditional delete

  Add conditional update operations:

  - `.update(data).where(fn)` — update matching instances
  - `.update(data).forAll()` — update all instances

  API cleanup:

  - Deprecate `sortBy()` in favor of `orderBy()`
  - Remove `DeleteBuilder.for()` — use `DeleteBuilder.from(shape, ids)` instead
  - Require `data` parameter in `Shape.update(data)`

## 2.0.0

### Major Changes

- [#23](https://github.com/Semantu/linked/pull/23) [`d2d1eca`](https://github.com/Semantu/linked/commit/d2d1eca3517af11f39348dc83ba5e60703ef86d2) Thanks [@flyon](https://github.com/flyon)! - ## Breaking Changes

  ### `Shape.select()` and `Shape.update()` no longer accept an ID as the first argument

  Use `.for(id)` to target a specific entity instead.

  **Select:**

  ```typescript
  // Before
  const result = await Person.select({ id: "..." }, (p) => p.name);

  // After
  const result = await Person.select((p) => p.name).for({ id: "..." });
  ```

  `.for(id)` unwraps the result type from array to single object, matching the old single-subject overload behavior.

  **Update:**

  ```typescript
  // Before
  const result = await Person.update({ id: "..." }, { name: "Alice" });

  // After
  const result = await Person.update({ name: "Alice" }).for({ id: "..." });
  ```

  `Shape.selectAll(id)` also no longer accepts an id — use `Person.selectAll().for(id)`.

  ### `ShapeType` renamed to `ShapeConstructor`

  The type alias for concrete Shape subclass constructors has been renamed. Update any imports or references:

  ```typescript
  // Before
  import type { ShapeType } from "@_linked/core/shapes/Shape";

  // After
  import type { ShapeConstructor } from "@_linked/core/shapes/Shape";
  ```

  ### `QueryString`, `QueryNumber`, `QueryBoolean`, `QueryDate` classes removed

  These have been consolidated into a single generic `QueryPrimitive<T>` class. If you were using `instanceof` checks against these classes, use `instanceof QueryPrimitive` instead and check the value's type.

  ### Internal IR types removed

  The following types and functions have been removed from `SelectQuery`. These were internal pipeline types — if you were using them for custom store integrations, the replacement is `FieldSetEntry[]` (available from `FieldSet`):

  - Types: `SelectPath`, `QueryPath`, `CustomQueryObject`, `SubQueryPaths`, `ComponentQueryPath`
  - Functions: `fieldSetToSelectPath()`, `entryToQueryPath()`
  - Methods: `QueryBuilder.getQueryPaths()`, `BoundComponent.getComponentQueryPaths()`
  - `RawSelectInput.select` field renamed to `RawSelectInput.entries` (type changed from `SelectPath` to `FieldSetEntry[]`)

  ### `getPackageShape()` return type is now nullable

  Returns `ShapeConstructor | undefined` instead of `typeof Shape`. Code that didn't null-check the return value will now get TypeScript errors.

  ## New Features

  ### `.for(id)` and `.forAll(ids)` chaining

  Consistent API for targeting entities across select and update operations:

  ```typescript
  // Single entity (result is unwrapped, not an array)
  await Person.select((p) => p.name).for({ id: "..." });
  await Person.select((p) => p.name).for("https://...");

  // Multiple specific entities
  await QueryBuilder.from(Person)
    .select((p) => p.name)
    .forAll([{ id: "..." }, { id: "..." }]);

  // All instances (default — no .for() needed)
  await Person.select((p) => p.name);
  ```

  ### Dynamic Query Building with `QueryBuilder` and `FieldSet`

  Build queries programmatically at runtime — for CMS dashboards, API endpoints, configurable reports. See the [Dynamic Query Building](./README.md#dynamic-query-building) section in the README for full documentation and examples.

  Key capabilities:

  - `QueryBuilder.from(Person)` or `QueryBuilder.from('https://schema.org/Person')` — fluent, chainable, immutable query construction
  - `FieldSet.for(Person, ['name', 'knows'])` — composable field selections with `.add()`, `.remove()`, `.pick()`, `FieldSet.merge()`
  - `FieldSet.all(Person, {depth: 2})` — select all decorated properties with optional depth
  - JSON serialization: `query.toJSON()` / `QueryBuilder.fromJSON(json)` and `fieldSet.toJSON()` / `FieldSet.fromJSON(json)`
  - All builders are `PromiseLike` — `await` them directly or call `.build()` to inspect the IR

  ### Mutation Builders

  `CreateBuilder`, `UpdateBuilder`, and `DeleteBuilder` provide the programmatic equivalent of `Person.create()`, `Person.update()`, and `Person.delete()`, accepting Shape classes or shape IRI strings. See the [Mutation Builders](./README.md#mutation-builders) section in the README.

  ### `PropertyPath` exported

  The `PropertyPath` value object is now a public export — a type-safe representation of a sequence of property traversals through a shape graph.

  ```typescript
  import { PropertyPath, walkPropertyPath } from "@_linked/core";
  ```

  ### `ShapeConstructor<S>` type

  New concrete constructor type for Shape subclasses. Eliminates ~30 `as any` casts across the codebase and provides better type safety at runtime boundaries (builder `.from()` methods, Shape static methods).

## 1.3.0

### Minor Changes

- [#20](https://github.com/Semantu/linked/pull/20) [`33e9fb0`](https://github.com/Semantu/linked/commit/33e9fb0205343eca8c84723cbabc3f3342e40be5) Thanks [@flyon](https://github.com/flyon)! - **Breaking:** `QueryParser` has been removed. If you imported `QueryParser` directly, replace with `getQueryDispatch()` from `@_linked/core/queries/queryDispatch`. The Shape DSL (`Shape.select()`, `.create()`, `.update()`, `.delete()`) and `SelectQuery.exec()` are unchanged.

  **New:** `getQueryDispatch()` and `setQueryDispatch()` are now exported, allowing custom query dispatch implementations (e.g. for testing or alternative storage backends) without subclassing `LinkedStorage`.

## 1.2.1

### Patch Changes

- [#17](https://github.com/Semantu/linked/pull/17) [`0654780`](https://github.com/Semantu/linked/commit/06547807a7bae56e992eba73263f83e092b7788b) Thanks [@flyon](https://github.com/flyon)! - Preserve nested array sub-select branches in canonical IR so `build()` emits complete traversals, projection fields, and `resultMap` entries for nested selections.

  This fixes cases where nested branches present in `toRawInput().select` were dropped during desugar/lowering (for example nested `friends.select([name, hobby])` branches under another sub-select).

  Also adds regression coverage for desugar preservation, IR lowering completeness, and updated SPARQL golden output for nested query fixtures.

## 1.2.0

### Minor Changes

- [#9](https://github.com/Semantu/linked/pull/9) [`381067b`](https://github.com/Semantu/linked/commit/381067b0fbc25f4a0446c5f8cc0eec57ddded466) Thanks [@flyon](https://github.com/flyon)! - Replaced internal query representation with a canonical backend-agnostic IR AST. `SelectQuery`, `CreateQuery`, `UpdateQuery`, and `DeleteQuery` are now typed IR objects with `kind` discriminators, compact shape/property ID references, and expression trees — replacing the previous ad-hoc nested arrays. The public Shape DSL is unchanged; what changed is what `IQuadStore` implementations receive. Store result types (`ResultRow`, `SelectResult`, `CreateResult`, `UpdateResult`) are now exported. All factories expose `build()` as the primary method. See `documentation/intermediate-representation.md` for the full IR reference and migration guidance.

- [#14](https://github.com/Semantu/linked/pull/14) [`b65e156`](https://github.com/Semantu/linked/commit/b65e15688ac173478e58e1dbb9f26dbaf5fc5a37) Thanks [@flyon](https://github.com/flyon)! - Add SPARQL conversion layer — compiles Linked IR queries into executable SPARQL and maps results back to typed DSL objects.

  **New exports from `@_linked/core/sparql`:**

  - **`SparqlStore`** — abstract base class for SPARQL-backed stores. Extend it and implement two methods to connect any SPARQL 1.1 endpoint:

    ```ts
    import { SparqlStore } from "@_linked/core/sparql";

    class MyStore extends SparqlStore {
      protected async executeSparqlSelect(
        sparql: string
      ): Promise<SparqlJsonResults> {
        /* ... */
      }
      protected async executeSparqlUpdate(sparql: string): Promise<void> {
        /* ... */
      }
    }
    ```

  - **IR → SPARQL string** convenience functions (full pipeline in one call):

    - `selectToSparql(query, options?)` — SelectQuery → SPARQL string
    - `createToSparql(query, options?)` — CreateQuery → SPARQL string
    - `updateToSparql(query, options?)` — UpdateQuery → SPARQL string
    - `deleteToSparql(query, options?)` — DeleteQuery → SPARQL string

  - **IR → SPARQL algebra** (for stores that want to inspect/optimize the algebra before serialization):

    - `selectToAlgebra(query, options?)` — returns `SparqlSelectPlan`
    - `createToAlgebra(query, options?)` — returns `SparqlInsertDataPlan`
    - `updateToAlgebra(query, options?)` — returns `SparqlDeleteInsertPlan`
    - `deleteToAlgebra(query, options?)` — returns `SparqlDeleteInsertPlan`

  - **Algebra → SPARQL string** serialization:

    - `selectPlanToSparql(plan, options?)`, `insertDataPlanToSparql(plan, options?)`, `deleteInsertPlanToSparql(plan, options?)`, `deleteWherePlanToSparql(plan, options?)`
    - `serializeAlgebraNode(node)`, `serializeExpression(expr)`, `serializeTerm(term)`

  - **Result mapping** (SPARQL JSON results → typed DSL objects):

    - `mapSparqlSelectResult(json, query)` — handles flat/nested/aggregated results with XSD type coercion
    - `mapSparqlCreateResult(uri, query)` — echoes created fields with generated URI
    - `mapSparqlUpdateResult(query)` — echoes updated fields

  - **All algebra types** re-exported: `SparqlTerm`, `SparqlTriple`, `SparqlAlgebraNode`, `SparqlExpression`, `SparqlSelectPlan`, `SparqlInsertDataPlan`, `SparqlDeleteInsertPlan`, `SparqlDeleteWherePlan`, `SparqlPlan`, `SparqlOptions`, etc.

  **Bug fixes included:**

  - Fixed `isNodeReference()` in MutationQuery.ts — nested creates with predefined IDs (e.g., `{id: '...', name: 'Bestie'}`) now correctly insert entity data instead of only creating the link.

  See [SPARQL Algebra Layer docs](./documentation/sparql-algebra.md) for the full type reference, conversion rules, and store implementation guide.

## 1.1.0

### Minor Changes

- [#4](https://github.com/Semantu/linked/pull/4) [`c35e686`](https://github.com/Semantu/linked/commit/c35e6861600d7aa8683b4b288fc4d1dc74c4aff2) Thanks [@flyon](https://github.com/flyon)! - - Added `Shape.selectAll()` plus nested `selectAll()` support on sub-queries.
  - Added inherited property deduplication via `NodeShape.getUniquePropertyShapes()` so subclass overrides win by label and are selected once.
  - Improved `selectAll()` type inference (including nested queries) and excluded base `Shape` keys from inferred results.
  - Added registration-time override guards: `minCount` cannot be lowered, `maxCount` cannot be increased, and `nodeKind` cannot be widened.
  - Fixed `createPropertyShape` to preserve explicit `minCount: 0` / `maxCount: 0`.
  - Expanded tests and README documentation for `selectAll`, CRUD return types, and multi-value update semantics.

## 1.0.0

### Major Changes

This is a rebranding + extraction release. It moves the core query/shape system into `@_linked/core` and removes RDF models and React-specific code.

Key changes:

- **New package name:** import from `@_linked/core` instead of `lincd`.
- **Node references everywhere:** use `NodeReferenceValue = {id: string}` everywhere. `NamedNode` does not exist in this package.
  - **Before (LINCD.js):**
    ```typescript
    import { NamedNode } from "lincd/models";
    const name = NamedNode.getOrCreate("https://schema.org/name");
    ```
  - **After (`@_linked/core`):**
    ```typescript
    import { createNameSpace } from "@_linked/core/utils/NameSpace";
    const schema = createNameSpace("https://schema.org/");
    const name = schema("name"); // {id: 'https://schema.org/name'}
    ```
- **Decorator paths:** property decorators now require `NodeReferenceValue` paths (no strings, no `NamedNode`).
  - **Before:**
    ```typescript
    @literalProperty({path: foaf.name})
    ```
  - **After:**
    ```typescript
    const name = schema('name');
    @literalProperty({path: name})
    ```
- **Target class and node kinds:** `targetClass`, `datatype`, `nodeKind`, etc. now take `NodeReferenceValue`.
  - **Before:**
    ```typescript
    static targetClass = foaf.Person; // NamedNode
    ```
  - **After:**
    ```typescript
    static targetClass = schema('Person'); // {id: string}
    ```
- **Query context:** context values are `NodeReferenceValue` (or QResults) instead of RDF nodes.
  - **Before:**
    ```typescript
    setQueryContext("user", NamedNode.getOrCreate(userId), Person);
    ```
  - **After:**
    ```typescript
    setQueryContext("user", { id: userId }, Person);
    ```
- **No RDF models in core:** `NamedNode`, `Literal`, `BlankNode`, `Quad`, `Graph`, and all RDF collections are not available in `@_linked/core`. Use a store package (e.g. `@_linked/rdf-mem-store`) if you need RDF models or quad-level access.
- **Shape instances:** shape classes no longer carry RDF nodes or instance graph APIs. Decorated accessors register SHACL metadata but do not implement runtime get/set behavior.
- **Query tracing:** query tracing is proxy-based (no `TestNode`/`TraceShape`).
- **SHACL metadata:** node/property shapes are plain JS objects (`QResult`), not RDF triples.
- **Package registration:** `linkedPackage` now stores package metadata as plain JS (`PackageMetadata`) and keeps legacy URI ids for compatibility.
- **Storage routing:** `LinkedStorage` routes queries to an `IQuadStore` implementation (e.g. `@_linked/rdf-mem-store`).
- **Imports updated:** ontology namespaces now return `NodeReferenceValue` objects, and decorators require `NodeReferenceValue` paths.
