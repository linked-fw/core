import type {IDataset} from '../interfaces/IDataset.js';
import type {SelectQuery} from '../queries/SelectQuery.js';
import type {AskQuery} from '../queries/AskQuery.js';
import type {CountQuery} from '../queries/CountQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery.js';
import type {
  IRSelectQuery,
  IRCountQuery,
  IRAskQuery,
  IRCreateMutation,
  IRUpdateMutation,
  IRUpdateWhereMutation,
  IRUpsertMutation,
  SelectResult,
  CreateResult,
  UpdateResult,
  GraphQuery,
  GraphResult,
} from '../queries/IntermediateRepresentation.js';
import {
  assertGraphWritable,
  GraphQueryError,
  isGraphQueryKind,
  unsupportedGraphQuery,
} from '../queries/graphQuery.js';
import {sd} from '../ontologies/sd.js';
import {getGraphRecordClass, graphContentHash, hasPatchBody} from '../queries/graphRecords.js';
import {
  graphQueryBodies,
  graphQueryToSparql,
  graphRegisteredAsk,
} from './graphQueryToSparql.js';
import type {SparqlQueryResults} from './resultMapping.js';
import {
  selectToSparql,
  askToSparql,
  countToSparql,
  createToSparql,
  updateToSparql,
  upsertToSparql,
  updateWhereToSparql,
  deleteToSparql,
  deleteAllToSparql,
  deleteWhereToSparql,
} from './irToAlgebra.js';
import {
  mapSparqlSelectResult,
  mapSparqlAskResult,
  mapSparqlCountResult,
  mapSparqlCreateResult,
  mapSparqlUpdateResult,
  isSparqlSelectResults,
} from './resultMapping.js';
import {
  generateEntityUri,
  type SparqlCompileOptions,
  type SparqlOptions,
} from './sparqlUtils.js';
import {graphRoutingFor, type ShapeGraphRouting} from '../utils/graphRouting.js';
import {askToAlgebra, countToAlgebra, selectToAlgebra} from './irToAlgebra.js';
import {askPlanToSparql, selectPlanToSparql} from './algebraToString.js';
import type {SparqlAskPlan, SparqlSelectPlan} from './SparqlAlgebra.js';
import {withShapeCatalog} from '../utils/ShapeClass.js';
import {lower} from '../queries/lower.js';
import {attachCatalog, catalogOf} from '../utils/ShapeClass.js';
import {graphs} from '../ontologies/graphs.js';
import {
  expandReadGraphs,
  invalidateGraphRegistry,
  noteGraphQuery,
  readGraphRegistry,
  type GraphRegistryRow,
} from '../utils/graphRegistryCache.js';
import {
  assertOwnedLinkTypes,
  collectOwnedLinks,
  ownedLinkTypesFromResults,
  ownedLinkTypesQuery,
} from './ownedLinkCheck.js';

/**
 * Abstract base class for SPARQL-backed datasets.
 *
 * Handles the full pipeline: IR query → SPARQL string → execute → map results.
 * Subclasses only need to implement the two transport methods:
 * - `executeSparqlSelect` — send a SPARQL SELECT and return JSON results
 * - `executeSparqlUpdate` — send a SPARQL UPDATE (INSERT DATA / DELETE..INSERT / etc.)
 *
 * Example subclass (Fuseki):
 * ```ts
 * class FusekiDataset extends SparqlDataset {
 *   constructor(baseUrl: string, dataset: string) {
 *     super({ dataRoot: 'http://data.example.org' });
 *     this.queryEndpoint = `${baseUrl}/${dataset}/sparql`;
 *     this.updateEndpoint = `${baseUrl}/${dataset}/update`;
 *   }
 *   protected async executeSparqlSelect(sparql: string) {
 *     const res = await fetch(this.queryEndpoint, { ... });
 *     return res.json();
 *   }
 *   protected async executeSparqlUpdate(sparql: string) {
 *     await fetch(this.updateEndpoint, { ... });
 *   }
 * }
 * ```
 */
let nextRegistryKey = 0;

/** An empty SELECT answer, for a read whose graph set expanded to no graph. */
const NO_ROWS = {head: {vars: []}, results: {bindings: []}};

export abstract class SparqlDataset implements IDataset {
  protected options?: SparqlOptions;
  private readonly instanceRegistryKey = `sparql-dataset:${nextRegistryKey++}`;

  constructor(options?: SparqlOptions) {
    this.options = options;
  }

  /**
   * The key this store's graph-registry cache is kept under (see `graphRegistryCache.ts`): one per
   * dataset per process. The default is unique to this instance; a store that knows its dataset's
   * identity (a Fuseki dataset URL, a dataset name CN pushes invalidations for) overrides it, so
   * every instance for that dataset shares one entry.
   */
  protected graphRegistryKey(): string {
    return this.instanceRegistryKey;
  }

  /**
   * Drop the cached graph registry of `dataset` (default: this store's, see `graphRegistryKey`):
   * the next read that expands `graphs.allOntologies` re-reads it. For a process told that another
   * one changed the dataset's graphs; this store's own graph queries update the cache themselves.
   */
  invalidateGraphRegistry(dataset?: string): void {
    invalidateGraphRegistry(dataset ?? this.graphRegistryKey());
  }

  /**
   * The graph routing this store compiles with: the routes registered for this instance (see
   * `utils/graphRouting.ts`), or `undefined` when it has none, in which case every read and write
   * is exactly what it was before graph routing. A store that takes its routes from elsewhere
   * overrides it.
   */
  protected graphRouting(): ShapeGraphRouting | undefined {
    return graphRoutingFor(this);
  }

  /** The compile options of a read: routed unless the read names its graphs (`.from()`). */
  private readOptions(ir: {graphs?: string[]}): SparqlCompileOptions | undefined {
    if (ir.graphs) return this.options;
    const routing = this.graphRouting();
    return routing ? {...this.options, routing} : this.options;
  }

  /**
   * Send a read whose set of named graphs goes to the transport as the protocol's
   * `named-graph-uri` parameters (`SparqlOptions.namedGraphUriParameter`). The default refuses:
   * a transport that dropped the list would let `GRAPH ?g` match in every named graph. A store
   * that sets the option overrides this and sends `namedGraphs` with the query.
   */
  protected executeSparqlSelectWithNamedGraphs(
    _sparql: string,
    _namedGraphs: string[],
  ): Promise<SparqlQueryResults> {
    return Promise.reject(
      new Error(
        'SparqlOptions.namedGraphUriParameter is set, but this store does not send ' +
          'named-graph-uri parameters: override executeSparqlSelectWithNamedGraphs in its ' +
          'transport, or leave the option off (FROM NAMED in the query text).',
      ),
    );
  }

  /**
   * Compile and send a read. With `namedGraphUriParameter`, a plan's `FROM NAMED` set leaves the
   * query text and goes to `executeSparqlSelectWithNamedGraphs`; otherwise the string compilers
   * run exactly as before.
   */
  private async sendRead(
    ir: IRSelectQuery | IRCountQuery | IRAskQuery,
    options: SparqlCompileOptions | undefined,
  ): Promise<SparqlQueryResults> {
    if (!this.options?.namedGraphUriParameter) {
      const sparql =
        ir.kind === 'count'
          ? countToSparql(ir, options)
          : ir.kind === 'ask'
            ? askToSparql(ir, options)
            : selectToSparql(ir, options);
      return this.executeSparqlSelect(sparql);
    }
    const {sparql, namedGraphs} = withShapeCatalog(catalogOf(ir), () => {
      const plan: SparqlSelectPlan | SparqlAskPlan =
        ir.kind === 'count'
          ? countToAlgebra(ir, options)
          : ir.kind === 'ask'
            ? askToAlgebra(ir, options)
            : selectToAlgebra(ir, options);
      const named = plan.dataset?.fromNamed;
      const {dataset: _dataset, ...withoutDataset} = plan;
      const text =
        withoutDataset.type === 'ask'
          ? askPlanToSparql(withoutDataset as SparqlAskPlan, options)
          : selectPlanToSparql(withoutDataset as SparqlSelectPlan, options);
      return {sparql: text, namedGraphs: named};
    });
    return namedGraphs && namedGraphs.length > 0
      ? this.executeSparqlSelectWithNamedGraphs(sparql, namedGraphs)
      : this.executeSparqlSelect(sparql);
  }

  /** Read this dataset's graph registry: every record's graph and class, in one SELECT. */
  protected async loadGraphRegistry(): Promise<GraphRegistryRow[]> {
    const json = await this.executeSparqlSelect(
      `SELECT ?g ?c WHERE { GRAPH <${graphs.registry}> { ?g <${sd.name.id}> ?g ; a ?c } }`,
    );
    if (!isSparqlSelectResults(json)) {
      throw new Error('Expected a SPARQL SELECT result set when reading the graph registry.');
    }
    const rows: GraphRegistryRow[] = [];
    for (const binding of json.results.bindings) {
      const graph = binding.g?.value;
      const recordClass = binding.c?.value;
      if (graph && recordClass) rows.push({graph, recordClass});
    }
    return rows;
  }

  /**
   * Expand a read's `.from()` set before compiling it: portable names through `mapGraphName`,
   * `graphs.allOntologies`/`graphs.allShapes` from the cached registry. Returns the IR to compile
   * (a copy carrying the expanded set), or `null` when the set expanded to no graph and the read
   * matches nothing.
   */
  protected async resolveReadGraphs<T extends IRSelectQuery | IRCountQuery | IRAskQuery>(
    ir: T,
  ): Promise<T | null> {
    if (!ir.graphs) return ir;
    const expanded = await expandReadGraphs(ir.graphs, {
      registry: () => readGraphRegistry(this.graphRegistryKey(), () => this.loadGraphRegistry()),
      mapGraphName: this.options?.mapGraphName,
    });
    if (!('graphs' in expanded)) {
      const {graphs: _named, ...rest} = ir;
      return attachCatalog(rest as T, catalogOf(ir));
    }
    if (expanded.graphs.length === 0) return null;
    return attachCatalog({...ir, graphs: expanded.graphs}, catalogOf(ir));
  }

  /**
   * Send a SPARQL SELECT/ASK/CONSTRUCT query and return the parsed
   * SPARQL JSON Results (application/sparql-results+json).
   *
   * The return type is the union of both response shapes a query endpoint can
   * produce: a SELECT result set (`results.bindings`) or an ASK answer
   * (`boolean`). A subclass may still declare the narrower `SparqlJsonResults` —
   * a return type is covariant, so existing implementations stay valid.
   */
  protected abstract executeSparqlSelect(
    sparql: string,
  ): Promise<SparqlQueryResults>;

  /**
   * Send a SPARQL UPDATE request (INSERT DATA, DELETE/INSERT, etc.).
   * No return value — the update is fire-and-forget at the SPARQL level.
   */
  protected abstract executeSparqlUpdate(sparql: string): Promise<void>;

  /**
   * Answer a select query — **and a count, which is a select.**
   *
   * A count is not a distinct query form the way an ask is. An ask really is
   * `ASK WHERE { … }` and needs its own method; a count is
   * `SELECT (COUNT(DISTINCT ?a0) AS ?count) WHERE { … }` — the same query form, the
   * same transport (`executeSparqlSelect`), the same result-set response, differing
   * only in its projection. `countToAlgebra` says so itself: it builds its plan by
   * calling `selectToAlgebra` and swapping the projection, and yields
   * `{type: 'select'}`.
   *
   * So a count rides this channel rather than a method of its own. That is not
   * tidiness: it is what lets a count reach a store through every router that
   * already forwards a select — `LinkedStorage.selectQuery`, a backend API store —
   * with no per-kind plumbing to add in each of them, and no optional `IDataset`
   * member that a third-party store silently lacks.
   *
   * The branch is on the LOWERED IR, as `updateQuery` and `deleteQuery` branch on
   * theirs: `lower()` is the one place that knows a count from a select, and a
   * rehydrated envelope (`fromJSON`) arrives here as a builder like any other.
   *
   * A count carries only a pattern, so there is nothing to normalise away on that
   * path: no projection, no ordering, and in particular no `LIMIT`/`OFFSET`, which
   * the builder dropped before the query ever reached the IR. Errors reject; a count
   * failure is never reported as `0`.
   */
  selectQuery(query: SelectQuery): Promise<SelectResult>;
  selectQuery(query: CountQuery): Promise<number>;
  async selectQuery(
    query: SelectQuery | CountQuery,
  ): Promise<SelectResult | number> {
    // Cast once for the call rather than lowering in each branch: `lower` is
    // overloaded per query kind and cannot resolve a union, and lowering twice
    // would be the thing this method most needs not to do.
    const lowered = lower(query as SelectQuery) as IRSelectQuery | IRCountQuery;
    const ir = await this.resolveReadGraphs(lowered);
    if (!ir) {
      // The graph set expanded to no graph (no graph of that kind is registered).
      return lowered.kind === 'count' ? 0 : mapSparqlSelectResult(NO_ROWS, lowered);
    }
    // Routing applies to reads that name no graphs: `.from(graphs.default)` reads the default graph.
    const options = this.readOptions(lowered);
    if (ir.kind === 'count') {
      const json = await this.sendRead(ir, options);
      // `mapSparqlCountResult` is strict in the same way the guard below is: it
      // refuses an ASK response, an empty result set and a non-integer binding
      // rather than answering `0`.
      return mapSparqlCountResult(json, ir);
    }
    const json = await this.sendRead(ir, options);
    if (!isSparqlSelectResults(json)) {
      throw new Error(
        'Expected a SPARQL SELECT result set, got an ASK response. The endpoint ' +
        'did not answer the SELECT query that was sent.',
      );
    }
    return mapSparqlSelectResult(json, ir);
  }

  /**
   * Answer an ask query — emitted as `ASK WHERE { … }`.
   *
   * An {@link AskQuery} carries only a pattern, so there is nothing to normalise
   * away here. A query with no shape lowers to `ASK { <iri> ?p ?o }` — existence
   * of the node under any type or none. Errors reject; never reported as `false`.
   */
  async askQuery(query: AskQuery): Promise<boolean> {
    const lowered = lower(query);
    const ir = await this.resolveReadGraphs(lowered);
    if (!ir) return false;
    const json = await this.sendRead(ir, this.readOptions(lowered));
    return mapSparqlAskResult(json);
  }

  /**
   * The mutation IR to compile, with the graph it writes: its `.into()` graph when the routing
   * allows it for the mutation's shape (the shape's routed read set, where the shape's reads find
   * it), else the shape's routed graph; the default graph leaves the IR as it was (no `graph`).
   *
   * Refused: `.into()` a portable graph name or the registry (`graph-name-read-only`), a
   * store-reserved name (`graph-name-read-only`), a graph the routing does not allow for the
   * shape (`graph-not-routed`).
   */
  protected resolveWriteGraph<T extends {shape: string; graph?: string}>(ir: T): T {
    const routing = this.graphRouting();
    const requested = ir.graph;
    let target: string;
    if (requested !== undefined && requested !== graphs.default) {
      assertGraphWritable(requested);
      if (this.isReservedGraphName(requested)) {
        throw new GraphQueryError(
          'graph-name-read-only',
          `<${requested}> is a name this store reserves for its own graphs; it can be read, never written.`,
          requested,
        );
      }
      target = requested;
    } else {
      target = requested ?? routing?.graphForShape(ir.shape) ?? graphs.default;
    }
    if (requested !== undefined) {
      const allowed = routing?.readGraphsForShape(ir.shape) ?? [graphs.default];
      if (!allowed.includes(target)) {
        throw new GraphQueryError(
          'graph-not-routed',
          `.into(<${requested}>): the graph routing of this store does not allow that graph for ` +
            `<${ir.shape}>; it allows ${allowed.map((g) => `<${g}>`).join(', ')}.`,
          requested,
        );
      }
    }
    const {graph: _requested, ...rest} = ir;
    const out = (target === graphs.default ? rest : {...rest, graph: target}) as T;
    return attachCatalog(out, catalogOf(ir));
  }

  async createQuery(query: CreateQuery): Promise<CreateResult> {
    const ir = this.resolveWriteGraph(lower(query));
    const uri = ir.data.id || generateEntityUri(ir.data.shape, this.options);
    ir.data.id = uri;
    await this.checkOwnedLinks(ir);
    const sparql = createToSparql(ir, this.options);
    await this.executeSparqlUpdate(sparql);
    return mapSparqlCreateResult(uri, ir);
  }

  async updateQuery(query: UpdateQuery): Promise<UpdateResult> {
    const ir = this.resolveWriteGraph(lower(query));
    await this.checkOwnedLinks(ir);
    if (ir.kind === 'update_where') {
      const sparql = updateWhereToSparql(ir, this.options);
      await this.executeSparqlUpdate(sparql);
      return {id: ''} as UpdateResult;
    }
    const sparql =
      ir.kind === 'upsert'
        ? upsertToSparql(ir, this.options)
        : updateToSparql(ir, this.options);
    await this.executeSparqlUpdate(sparql);
    return mapSparqlUpdateResult(ir);
  }

  /**
   * Refuse a mutation that links a node of the wrong class into a `contains` property
   * (see `ownedLinkCheck.ts`). An owner deletes what it contains, so a Person linked into
   * an ImageObject slot would be deleted with its owner. Runs before the update is sent, so
   * a refused mutation writes nothing. With no such link no query is sent; otherwise one
   * SELECT covers every linked id, read in the graph the mutation writes.
   */
  protected async checkOwnedLinks(
    ir: IRCreateMutation | IRUpdateMutation | IRUpsertMutation | IRUpdateWhereMutation,
  ): Promise<void> {
    const links = collectOwnedLinks(ir);
    if (links.length === 0) return;
    const json = await this.executeSparqlSelect(
      ownedLinkTypesQuery(
        links.map((link) => link.id),
        ir.graph,
      ),
    );
    assertOwnedLinkTypes(links, ownedLinkTypesFromResults(json));
  }

  async deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
    const ir = this.resolveWriteGraph(lower(query));
    if (ir.kind === 'delete_all') {
      const sparql = deleteAllToSparql(ir, this.options);
      await this.executeSparqlUpdate(sparql);
      return {deleted: [], count: 0};
    }
    if (ir.kind === 'delete_where') {
      const sparql = deleteWhereToSparql(ir, this.options);
      await this.executeSparqlUpdate(sparql);
      return {deleted: [], count: 0};
    }
    const sparql = deleteToSparql(ir, this.options);
    await this.executeSparqlUpdate(sparql);
    return {
      deleted: ir.ids,
      count: ir.ids.length,
    };
  }

  /**
   * Run a graph query as **one SPARQL update** (body and registry record in one request, so one
   * transaction): `graph_create`, `graph_replace`, `graph_patch`, `graph_drop`.
   *
   * Refusals (`GraphQueryError`): a portable graph name or the registry itself
   * (`graph-name-read-only`); create of a registered graph (`graph-exists`); replace or patch of
   * a graph with no record (`graph-not-registered`); any other kind (`unsupported-query-kind`).
   * Whether the graph is registered is read first, with one `ASK` on the registry; the write
   * itself is the single update.
   *
   * Bodies are parsed and re-serialised as N-Triples (see `graphQueryToSparql.ts`). A body is
   * sent inside the update rather than by the Graph Store Protocol: a GSP `PUT` and the record's
   * update would be two transactions.
   */
  /**
   * Whether `iri` names a graph of the store itself, which a graph query never writes. Checked on
   * every graph query before any SPARQL is built. The default refuses Jena's `urn:x-arq:` names
   * (`urn:x-arq:DefaultGraph` is the real default graph; an insert into `urn:x-arq:UnionGraph`
   * creates a real graph). A store with other reserved names overrides it.
   */
  protected isReservedGraphName(iri: string): boolean {
    return iri.startsWith('urn:x-arq:');
  }

  async graphQuery(query: GraphQuery): Promise<GraphResult> {
    if (!isGraphQueryKind(query?.kind)) throw unsupportedGraphQuery(query ?? {});
    assertGraphWritable(query.graph);
    if (this.isReservedGraphName(query.graph)) {
      throw new GraphQueryError(
        'graph-name-read-only',
        `<${query.graph}> is a name this store reserves for its own graphs; it can be read, never written.`,
        query.graph,
      );
    }
    getGraphRecordClass(query.recordClass);
    if (query.kind !== 'graph_drop') {
      // Replace and patch through a record class (OntologyGraph.update(…)) need a record of that
      // class; through NamedGraph any record will do.
      const classCheck =
        query.kind !== 'graph_create' && query.recordClass !== sd.NamedGraph.id
          ? query.recordClass
          : undefined;
      const registered = mapSparqlAskResult(
        await this.executeSparqlSelect(graphRegisteredAsk(query.graph, classCheck)),
      );
      if (query.kind === 'graph_create' && registered) {
        throw new GraphQueryError(
          'graph-exists',
          `<${query.graph}> is already registered; change it with update(), replaceContent() or patchContent().`,
          query.graph,
        );
      }
      if (query.kind !== 'graph_create' && !registered) {
        throw new GraphQueryError(
          'graph-not-registered',
          classCheck
            ? `<${query.graph}> has no record of class <${classCheck}> in the graph registry.`
            : `<${query.graph}> has no record in the graph registry; register it with create() first.`,
          query.graph,
        );
      }
    }
    const modified = new Date().toISOString();
    const sparql = graphQueryToSparql(query, await graphQueryBodies(query), modified);
    if (sparql) await this.executeSparqlUpdate(sparql);
    noteGraphQuery(this.graphRegistryKey(), query);
    const contentHash = graphContentHash(query);
    const changed = query.kind !== 'graph_patch' || hasPatchBody(query);
    return contentHash === undefined
      ? {graph: query.graph, changed}
      : {graph: query.graph, contentHash, modified, changed};
  }

  /**
   * Execute a raw SPARQL query string directly against the dataset.
   * Defaults to SELECT; pass `'update'` for INSERT/DELETE operations.
   */
  async rawQuery(
    sparql: string,
    mode?: 'query' | 'update',
  ): Promise<SparqlQueryResults | void> {
    if (mode === 'update') {
      return this.executeSparqlUpdate(sparql);
    }
    return this.executeSparqlSelect(sparql);
  }
}

// Backwards-compatibility re-export — remove once all consumers are updated.
export {SparqlDataset as SparqlStore};
