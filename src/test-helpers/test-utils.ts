import {tmpEntityBase} from './query-fixtures';
import {captureQuery} from './query-capture-store';
import type {GraphQuery} from '../queries/IntermediateRepresentation';
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
