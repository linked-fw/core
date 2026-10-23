/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The count query — "how many instances match?", answered with a number.
 *
 * A count carries a **pattern and nothing else**: no projection, no sorting, no
 * pagination. Those shape or window a *solution sequence*, and the number a count
 * answers is a property of the whole match set, not of a page of it — so rather
 * than being ignored or guarded against, they are simply not expressible here.
 *
 * This is the sibling of {@link AskQuery}: same idea, `number` instead of
 * `boolean`. `SelectBuilder.count()` is the first question asked this way.
 */
import type {NodeShapeData} from '../shapes/SHACL.js';
import type {WherePath} from './SelectQuery.js';
import type {RawMinusEntry} from './IRDesugar.js';
import type {NodeReferenceValue} from './QueryFactory.js';
import type {PendingQueryContext} from './QueryContext.js';
import type {ContextRefJSON} from './ContextRef.js';
import type {
  WherePathJSON,
  RawMinusEntryJSON,
} from './QueryBuilderSerialization.js';

/**
 * The live, closed (read-only) count query — the object an `IDataset` receives.
 *
 * `shape` is **required**, unlike an ask's. A shapeless count would count every
 * node in the store; there is no useful reading of that, so the type does not
 * permit it.
 */
export interface CountQuery {
  readonly __queryKind: 'count';
  /** The shape whose matching instances are counted. Also the routing key. */
  readonly shape: NodeShapeData;
  toJSON(): CountQueryJSON;
  toRawInput(): RawCountInput;
}

/** Pre-lowering input, as the builder hands it to `lower()`. */
export type RawCountInput = {
  /**
   * `.for(null)` — no subject to count. Lowering rejects it; `exec()` answers `0`
   * before dispatching. See `lowerCount`.
   */
  nullSubject?: boolean;
  shape?: {shape?: {id?: string}; id?: string};
  subject?: NodeReferenceValue | PendingQueryContext;
  subjects?: NodeReferenceValue[];
  where?: WherePath;
  minusEntries?: RawMinusEntry[];
  /** `.from()`: the graphs the read is restricted to. */
  graphs?: string[];
};

/**
 * The DSL-JSON wire form of a count query.
 *
 * Carries `op: 'count'` — the same discriminator ask and mutation envelopes use, so
 * `fromJSON` routes on it and an older peer rejects an unknown op loudly rather
 * than reinterpreting the envelope as a select (which would answer with *rows*,
 * windowed by nothing, where the caller expected a total).
 *
 * Every field is pattern-bearing. There is deliberately no `fields`, `limit`,
 * `offset`, `sortBy` or `one`: a receiver has nothing to validate or ignore.
 *
 * ```json
 * {"v": "1.1", "op": "count",
 *  "shape": "https://linked.cm/shape/core/Person",
 *  "where": {"name": "Semmy"}}
 * ```
 */
export type CountQueryJSON = {
  v?: string;
  op: 'count';
  /** Required — see {@link CountQuery.shape}. */
  shape: string;
  /** A node id, or a `{@ctx: name}` reference resolved at lowering. */
  subject?: string | ContextRefJSON;
  subjects?: string[];
  where?: WherePathJSON;
  minusEntries?: RawMinusEntryJSON[];
  /** `.for(null)` — no subject to count; the answer is `0` without querying. */
  nullSubject?: boolean;
  /** `.from()`: the graphs the read is restricted to, as absolute IRIs (portable names included). */
  graphs?: string[];
};
