import {setQueryDispatch} from '../queries/queryDispatch';
import {
  buildSelectQueryImpl,
  setBuildSelectQueryHook,
} from '../queries/IRPipeline';
import {lower} from '../queries/lower';
import {ALL_QUERY_FEATURES} from '../queries/queryFeatures';
import {readKindOf, type ReadQuery, type ReadResult} from '../queries/readQuery';

// Datasets now receive the live (closed) query; tests expect the lowered IR, so
// lower() what we capture. Passing an already-IR object through is tolerated.
const toIR = (query: any) =>
  query && typeof query.__queryKind === 'string' ? lower(query) : query;

/**
 * Test utility that intercepts the query dispatch and captures
 * the built IR query for inspection by test assertions.
 *
 * - `captureQuery` captures the built IR (post-pipeline) — use for
 *   full-pipeline and mutation tests.
 * - `captureRawQuery` captures the raw pipeline input (pre-pipeline)
 *   — use for tests that feed intermediate pipeline stages.
 */
let _lastQuery: any;
let _lastRawInput: any;

// Intercept buildSelectQuery to capture the pre-pipeline raw input. Uses the
// IRPipeline hook rather than jest.spyOn because ESM module namespaces are
// frozen and cannot be reassigned by spyOn.
setBuildSelectQueryHook((raw: any) => {
  _lastRawInput = raw;
  return buildSelectQueryImpl(raw);
});

setQueryDispatch({
  readQuery: async <Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>> => {
    const ir = toIR(query);
    _lastQuery = ir;
    // A count's answer is a number: `resolveRead` refuses the `[]` a row query returns
    // (which is how it catches a store that ran the pattern as a select instead of
    // counting it). An ask answers false.
    const kind = readKindOf(query);
    return (kind === 'count' ? 0 : kind === 'ask' ? false : []) as ReadResult<Q>;
  },
  createQuery: async (query) => {
    _lastQuery = toIR(query);
    return {} as any;
  },
  updateQuery: async (query) => {
    _lastQuery = toIR(query);
    return {} as any;
  },
  deleteQuery: async (query) => {
    _lastQuery = toIR(query);
    return {deleted: [], count: 0};
  },
  // Captures every query, grouped ones included.
  supports: ALL_QUERY_FEATURES,
});

/**
 * Execute a query-producing callback and return the built IR
 * (the same object that would reach ILinkedDataset).
 */
export const captureQuery = async (
  runner: () => Promise<unknown>,
) => {
  _lastQuery = undefined;
  await runner();
  return _lastQuery;
};

/**
 * Execute a query-producing callback and return the raw pipeline
 * input (RawSelectInput) — the state before the IR build pipeline runs.
 * Only works for select queries.
 */
export const captureRawQuery = async (
  runner: () => Promise<unknown>,
) => {
  _lastRawInput = undefined;
  await runner();
  return _lastRawInput;
};
