import type {SelectQuery} from '../queries/SelectQuery.js';
import type {AskQuery} from '../queries/AskQuery.js';
import type {CountQuery} from '../queries/CountQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery.js';
import type {
  SelectResult,
  CreateResult,
  UpdateResult,
} from '../queries/IntermediateRepresentation.js';

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
   * Answer a select query — **and a count query**, which arrives here too.
   *
   * A count is not a query form of its own the way an ask is. An ask is
   * `ASK WHERE { … }`; a count is `SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { … }`
   * — a select with an aggregate projection, over the same transport, answered with
   * the same result-set response. Giving it a method of its own meant every router
   * had to grow an arm for it, and any that did not silently could not count.
   *
   * So a store that wants to answer counts branches on the lowered IR:
   * `lower(query).kind === 'count'` (see {@link CountQuery} and `SparqlDataset`).
   * A store that does not is no worse off than before — it will fail loudly at the
   * dispatch (`resolveCount`), which refuses anything but a non-negative integer.
   * There is deliberately **no path in this package that rewrites a count as a row
   * query** and measures the array: that would hide an unbounded read behind a call
   * that looks cheap.
   *
   * A count must be answered with a real, non-negative integer, and must reject on
   * failure: reporting an unreachable store as `0` renders an empty table that is
   * indistinguishable from real data, which is the failure mode this API was built
   * to remove.
   */
  selectQuery(query: SelectQuery | CountQuery): Promise<SelectResult | number>;
  /**
   * Answer an ask query — a boolean, not a result set.
   *
   * **Required.** An {@link AskQuery} carries a pattern and nothing else: no
   * projection, no sorting, no pagination. A SPARQL-backed store emits
   * `ASK WHERE { … }`; another backend answers it however it can.
   *
   * It is required rather than optional, and this package contains **no path that
   * rewrites an ask as a select**. A store that has no boolean primitive decides
   * for itself how to answer — that decision belongs to the store, and defaulting
   * it here would hide it.
   *
   * `query.shape` is optional: absent means no `rdf:type` constraint at all
   * ("does a node with this IRI exist"), which lowers to `ASK { <iri> ?p ?o }`.
   *
   * Must resolve to a real boolean — a non-boolean is rejected, not coerced,
   * since a truthy value would silently read as "exists". Must reject on
   * failure: reporting an unreachable store as `false` is the failure mode this
   * API was built to remove.
   */
  askQuery(query: AskQuery): Promise<boolean>;
  /**
   * Receives update AND upsert mutations — `lower(query)` yields `kind: 'update'`,
   * `'update_where'` or `'upsert'`. An implementation that does not handle `'upsert'`
   * should throw rather than fall through to the update path: an upsert lowered as a
   * plain update writes an untyped node and reports success.
   */
  updateQuery?(query: UpdateQuery): Promise<UpdateResult>;
  createQuery?(query: CreateQuery): Promise<CreateResult>;
  deleteQuery?(query: DeleteQuery): Promise<DeleteResponse>;
}
