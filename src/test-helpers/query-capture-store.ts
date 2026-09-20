import {setQueryDispatch} from '../queries/queryDispatch';
import {
  buildSelectQueryImpl,
  setBuildSelectQueryHook,
} from '../queries/IRPipeline';
import {lower} from '../queries/lower';

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
  selectQuery: async (query) => {
    const ir = toIR(query);
    _lastQuery = ir;
    // A count rides the select channel, and its answer is a number: `resolveCount`
    // refuses the `[]` a row query returns (which is how it catches a store that ran
    // the pattern as a select instead of counting it).
    return (ir?.kind === 'count' ? 0 : []) as any;
  },
  askQuery: async (query) => {
    _lastQuery = toIR(query);
    return false;
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
