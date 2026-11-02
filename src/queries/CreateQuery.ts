import type {AddId} from './QueryFactory.js';
import type {IRCreateMutation} from './IntermediateRepresentation.js';
import type {NodeShapeData} from '../shapes/SHACL.js';
import type {CreateMutationJSON} from './MutationSerialization.js';
import type {CreateLowerSpec} from './mutationLowerSpec.js';

/**
 * The closed, read-only create query a dataset receives (implemented by
 * `CreateBuilder`). The IR is `IRCreateQuery`, produced by `lower(query)` — the
 * IR construction lives in the IR tier, not here, so this module stays IR-free.
 */
export interface CreateQuery {
  readonly __queryKind: 'create';
  /** The store transaction this query runs in (`LinkedStorage.begin()`); absent outside one. */
  readonly txId?: string;
  readonly shape: NodeShapeData;
  toJSON(): CreateMutationJSON;
  /** @internal IR-free lowering spec consumed by `lower()`. */
  _lowerSpec(): CreateLowerSpec;
}

/** The lowered IR for a create mutation (what `lower()` produces). */
export type IRCreateQuery = IRCreateMutation;

export type CreateResponse<U> = AddId<U, true>;
