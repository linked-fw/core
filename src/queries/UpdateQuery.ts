import type {AddId} from './QueryFactory.js';
import type {
  IRUpdateMutation,
  IRUpdateWhereMutation,
  IRUpsertMutation,
} from './IntermediateRepresentation.js';
import type {NodeShapeData} from '../shapes/SHACL.js';
import type {UpdateMutationJSON, UpsertMutationJSON} from './MutationSerialization.js';
import type {UpdateLowerSpec} from './mutationLowerSpec.js';

/**
 * The closed, read-only update query a dataset receives (implemented by
 * `UpdateBuilder`). The IR is `IRUpdateQuery`, produced by `lower(query)` — the
 * IR construction lives in the IR tier, not here, so this module stays IR-free.
 */
export interface UpdateQuery {
  readonly __queryKind: 'update';
  /** The store transaction this query runs in (`LinkedStorage.begin()`); absent outside one. */
  readonly txId?: string;
  readonly shape: NodeShapeData;
  toJSON(): UpdateMutationJSON | UpsertMutationJSON;
  /** @internal IR-free lowering spec consumed by `lower()`. */
  _lowerSpec(): UpdateLowerSpec;
}

/** The lowered IR for an update mutation (what `lower()` produces). */
export type IRUpdateQuery =
  | IRUpdateMutation
  | IRUpdateWhereMutation
  | IRUpsertMutation;
