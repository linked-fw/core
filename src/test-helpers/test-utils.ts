import {tmpEntityBase} from './query-fixtures';
import {captureQuery} from './query-capture-store';
import type {GraphQuery} from '../queries/IntermediateRepresentation';
import type {SparqlJsonResults} from '../sparql/resultMapping';
import {unsupportedGraphQuery} from '../queries/graphQuery';

/**
 * Create an entity reference with the given suffix.
 * Shared across all test files to avoid duplication.
 */
export const entity = (suffix: string) => ({id: `${tmpEntityBase}${suffix}`});

/**
 * Capture the built IR from the existing DSL path.
 * Shared across test files that compare DSL IR with builder IR.
 */
export const captureDslIR = async (runner: () => Promise<unknown>) => {
  return captureQuery(runner);
};

/**
 * Recursively strip `undefined` values from an object tree.
 * Used to normalize IR objects for deep-equality comparison,
 * since the DSL and builder paths may differ in which keys they omit vs set to undefined.
 */
export const sanitize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce(
      (acc, [key, child]) => {
        if (child !== undefined) acc[key] = sanitize(child);
        return acc;
      },
      {} as Record<string, unknown>,
    );
  }
  return value;
};

/**
 * The `IDataset` methods a test double does not exercise. Spread it first into a double
 * (`{...unusedDatasetMethods, selectQuery, askQuery}`) so the double's own methods win: the
 * mutation methods reject, and `graphQuery` refuses like a dataset without graph support.
 */
export const unusedDatasetMethods = {
  updateQuery: async (): Promise<never> => {
    throw new Error('updateQuery is not used by this test double');
  },
  createQuery: async (): Promise<never> => {
    throw new Error('createQuery is not used by this test double');
  },
  deleteQuery: async (): Promise<never> => {
    throw new Error('deleteQuery is not used by this test double');
  },
  graphQuery: async (query: GraphQuery): Promise<never> => {
    throw unsupportedGraphQuery(query);
  },
};

/**
 * A stub SPARQL transport's answer to the read a `graph_create` sends after its update (see
 * `graphCreateOutcomeQuery`), or `undefined` for any other query: the create wrote its record
 * unless the graph was registered or held triples.
 */
export function graphCreateOutcomeAnswer(
  sparql: string,
  state: {registered: boolean; populated?: boolean},
): SparqlJsonResults | undefined {
  if (!sparql.startsWith('SELECT ?claimed ?registered ?populated')) return undefined;
  const b = (value: boolean) => ({type: 'literal' as const, value: String(value)});
  const populated = state.populated ?? false;
  return {
    head: {vars: ['claimed', 'registered', 'populated']},
    results: {
      bindings: [
        {claimed: b(!state.registered && !populated), registered: b(state.registered), populated: b(populated)},
      ],
    },
  };
}

/**
 * A stub store's answer to the ontology sync's inference probe (`hierarchyProbe.ts`): for an ask
 * about one of the probe's instances, whether a store that infers as `inference` finds it;
 * `undefined` for any other query.
 */
export function inferenceProbeAnswer(
  query: {toJSON?: () => unknown},
  inference: 'named-graphs' | 'default-graph' | 'none',
): boolean | undefined {
  const json = JSON.stringify(query?.toJSON?.() ?? null);
  if (/inferenceProbe\/[a-z0-9]+\/named"/.test(json)) return inference === 'named-graphs';
  if (/inferenceProbe\/[a-z0-9]+\/default"/.test(json)) return inference !== 'none';
  return undefined;
}

/** Whether a graph query is the inference probe's (its temporary graph). */
export const isInferenceProbeGraph = (graph: string): boolean =>
  graph.includes('/graph/import/linked-inference-probe-');
