import type {SelectQuery} from '../queries/SelectQuery.js';
import type {AskQuery} from '../queries/AskQuery.js';
import type {CountQuery} from '../queries/CountQuery.js';
import type {TriplesQuery, TriplesTermsQuery} from '../queries/triplesQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery.js';
import type {
  CreateResult,
  UpdateResult,
  GraphQuery,
  GraphResult,
} from '../queries/IntermediateRepresentation.js';
import type {ReadQuery, ReadResult} from '../queries/readQuery.js';
import type {ChangeEvent} from '../live/changes.js';
import type {DefaultGraphTermsReplace} from '../queries/defaultGraphTerms.js';
import type {QueryFeature} from '../queries/queryFeatures.js';

/**
 * Universal dataset interface. Every dataset in the Linked framework accepts
 * Linked Queries as input. The implementing class decides how to handle them —
 * compiling to SPARQL for Fuseki, forwarding as-is to a Host Agent API, etc.
 *
 * Each method receives the live, closed (read-only) query object — the builder
 * viewed through its `*Query` interface — and returns the result. A store reads
 * `query.toJSON()` to forward it, or `lower(query)` to get canonical IR. The
 * calling layer (LinkedStorage via queryDispatch) threads the precise DSL-level
 * TypeScript result type back to the caller.
 */
export interface IDataset {
  /**
   * Prepares the store to be used.
   */
  init?(): Promise<any>;

  /**
   * The data root this dataset's data lives under (`DATA_ROOT`): ids it mints and graph routes
   * stated as `'own'` or `dataGraph()` resolve under it (see `utils/graphRouting.ts`). Optional;
   * without it (or when it returns `undefined`) the process's `DATA_ROOT` is used.
   */
  dataRoot?(): string | undefined;

  /**
   * Answer a read — every query that answers without changing anything, told apart by its kind
   * (`readKindOf(query)`: `__queryKind` of a live query, `kind` of a plain-data read; see
   * `queries/readQuery.ts`):
   *
   * - **`select`** ({@link SelectQuery}) → `SelectResult`. The baseline: every dataset answers it.
   * - **`count`** ({@link CountQuery}) → a finite, non-negative integer. Also baseline. A count is
   *   a select with an aggregate projection (`SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { … }`),
   *   so a store branches on the lowered IR: `lower(query).kind === 'count'` (see
   *   `SparqlDataset`). There is deliberately **no path in this package that rewrites a count as
   *   a row query** and measures the array: that would hide an unbounded read behind a call that
   *   looks cheap. Reporting an unreachable store as `0` renders an empty table that is
   *   indistinguishable from real data; the dispatch refuses anything but an integer.
   * - **`ask`** ({@link AskQuery}) → a real boolean, sent only to a dataset that declares `'ask'`
   *   in {@link supports}. A SPARQL-backed store emits `ASK WHERE { … }`. A dataset without it is
   *   still asked: the dispatch (`resolveRead`) sends the same pattern as a select with `LIMIT 1`
   *   and answers `true` when a row comes back; a **shapeless** ask (no shape, so no select to
   *   write) is refused on such a dataset. `query.shape` is optional: absent means no `rdf:type`
   *   constraint at all ("does a node with this IRI exist"), `ASK { <iri> ?p ?o }`.
   * - **`triples`** ({@link TriplesQuery}) → `Triple[]`, sent only to a dataset that declares
   *   `'triples'`: every triple of a graph (`NamedGraph.readContent(g)`), one subject's triples
   *   (`TriplesBuilder.forNode({id})`), the triples that point at a node (`toNode({id})`) or those
   *   of one predicate (`withPredicate({id})`), shapeless, optionally `.from(graphs)`. Terms come
   *   back as core's values: IRIs as `{id}`, literals as `{value, datatype, language?}`. A read that
   *   fixes the predicate or the object also needs `'triplesPattern'`.
   * - **`triples_terms`** ({@link TriplesTermsQuery}) → `string[]`, sent only to a dataset that
   *   declares `'triplesTerms'` and `'triplesPattern'`: the IRIs of the read's list (`objects` or
   *   `predicates`, from `toNode([…])` / `withPredicate([…])` then `.whichExist()`) that some triple
   *   of the read has in that position, in its graphs or, for a list of objects without them,
   *   where a node read looks. The dispatch keeps only the list's own.
   *
   * A kind a dataset does not declare is refused before it is sent (`resolveRead`), so a dataset
   * handed one anyway may reject it. A router forwards a read to the dataset that holds the data
   * (never to a writable fork it would have to create), through `resolveRead`. A shapeless read
   * (a shapeless ask, a node read, a terms read) means "anywhere I can reach", not "in my default
   * store".
   *
   * Must reject on failure: an unreachable store is never an empty answer, `false` or `0`.
   */
  readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>>;
  /**
   * The query features beyond the baseline this dataset answers (`'groupBy'`, `'min'`, `'max'`,
   * `'ask'`, `'triples'`, `'triplesTerms'`, …; see `queries/queryFeatures.ts`). A query that uses a
   * feature the dataset does not list is **refused before it is sent** (`resolveRead`,
   * `assertQuerySupported`), because a store that ignored, say, the grouping would still answer
   * rows, and they would look like a real answer. The one exception is `'ask'`: an ask to a
   * dataset without it is answered as a select (see {@link readQuery}).
   *
   * Optional. Absent = the baseline only: a dataset written before features existed keeps
   * answering everything it answered before, and fails loudly on anything new. `SparqlDataset`
   * lists every feature. A router lists what it forwards and checks each target itself.
   *
   * `'transactions'` declares that the dataset holds transactions: it implements
   * {@link beginTransaction}, {@link commit} and {@link rollback}, and answers every query that
   * carries a `txId` inside that transaction. A query with a `txId` is refused before it is sent
   * to a dataset that does not declare it.
   */
  readonly supports?: readonly QueryFeature[];
  /**
   * Open a transaction and answer its id (only with `'transactions'` in {@link supports}).
   * `LinkedStorage.begin()` calls it when the first query of a transaction is routed here.
   *
   * The store holds the transaction: every later query carrying that `txId` (`query.txId`, and
   * `txId` in its DSL-JSON) is answered inside it — its writes applied there, its reads seeing
   * them — and resolves once that is done. Nothing of it is visible outside before
   * {@link commit}.
   *
   * **Expiry.** The store rolls back a transaction left idle for longer than a timeout of its own
   * choosing (`InMemoryDataset`: 30 seconds since its last query), so an abandoned one never holds
   * anything for good. A query or commit with an expired or unknown txId rejects.
   */
  beginTransaction?(): Promise<string>;
  /**
   * Apply the transaction's writes, all of them or none, and end it. Rejects when the
   * transaction is unknown or expired, or cannot be applied (the store then rolls it back).
   */
  commit?(txId: string): Promise<void>;
  /** Drop the transaction's writes and end it. An unknown or expired txId is a no-op. */
  rollback?(txId: string): Promise<void>;
  /**
   * Receives update AND upsert mutations — `lower(query)` yields `kind: 'update'`,
   * `'update_where'` or `'upsert'`. An implementation that does not handle `'upsert'`
   * should throw rather than fall through to the update path: an upsert lowered as a
   * plain update writes an untyped node and reports success.
   *
   * Required. A read-only dataset implements it by throwing.
   */
  updateQuery(query: UpdateQuery): Promise<UpdateResult>;
  /** Required. A read-only dataset implements it by throwing. */
  createQuery(query: CreateQuery): Promise<CreateResult>;
  /** Required. A read-only dataset implements it by throwing. */
  deleteQuery(query: DeleteQuery): Promise<DeleteResponse>;
  /**
   * Run a whole-graph operation and keep the graph's registry record in step with it, in one
   * transaction: `graph_create`, `graph_replace`, `graph_patch`, `graph_drop` (see
   * {@link GraphQuery}). The graph statics on `NamedGraph` and its subclasses build these. A
   * graph query is a write, not a read: routers fork for it and report it as a write, and a
   * transaction refuses it.
   *
   * **Required.** A dataset without graph support implements it by throwing
   * `GraphQueryError('unsupported-query-kind')` (`unsupportedGraphQuery(query)`), and callers
   * that can fall back (the ontology sync) check for that code. Because a dataset class built
   * against an older core has no such method, core's callers guard at runtime
   * (`resolveGraphQuery`) and treat a missing method as the same refusal.
   *
   * Refusals a graph-capable store makes, all `GraphQueryError`s: `graph-name-read-only` (a
   * portable graph name or the registry itself), `graph-not-registered` (replace or patch of a
   * graph with no record), `graph-exists` (create of a registered graph).
   */
  graphQuery(query: GraphQuery): Promise<GraphResult>;

  /**
   * Replace terms in the default graph in one update (see {@link DefaultGraphTermsReplace}): the
   * ontology sync's `'default'` mode. Optional; that mode refuses a store without it.
   */
  replaceDefaultGraphTerms?(request: DefaultGraphTermsReplace): Promise<void>;

  /**
   * Optional change feed. A dataset that learns about changes made elsewhere
   * (another client, a server-side job) reports them here as
   * {@link ChangeEvent}s — the mutation's DSL-JSON plus its result, or
   * precomputed effects — and the live-query store refetches whatever those
   * changes can have touched. Returns the unsubscribe function.
   */
  subscribeChanges?(listener: (event: ChangeEvent) => void): () => void;
  /**
   * When `true`, a local mutation routed to this dataset does not trigger
   * refetches by itself; the store waits for the dataset's own change event
   * (the server's confirmation). Only meaningful with `subscribeChanges`.
   */
  readonly authoritativeChanges?: boolean;
}
