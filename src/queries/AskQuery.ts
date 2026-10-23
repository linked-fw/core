/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The ask query — "does any solution exist?", answered with a boolean.
 *
 * An ask carries a **pattern and nothing else**: no projection, no sorting, no
 * pagination. Those shape or window a *solution sequence*, and an ask has no
 * solution sequence to shape — so rather than being ignored or guarded against,
 * they are simply not expressible here.
 *
 * `.exists()` is the first question asked this way; it is a shortcut for the
 * general form, not a special case of select.
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
 * The live, closed (read-only) ask query — the object an `IDataset` receives.
 *
 * `shape` is **optional**. Absent means no `rdf:type` constraint at all: "does a
 * node with this IRI exist", independent of any shape. A dataset reads
 * `toJSON()` to forward the query, or `lower()` to get canonical IR.
 */
export interface AskQuery {
  readonly __queryKind: 'ask';
  /** The shape whose instances are asked about; absent for a shapeless ask. */
  readonly shape?: NodeShapeData;
  toJSON(): AskQueryJSON;
  toRawInput(): RawAskInput;
}

/** Pre-lowering input, as the builder hands it to `lower()`. */
export type RawAskInput = {
  /** `.for(null)` — no subject to ask about. Lowering rejects it; see `lowerAsk`. */
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
 * The DSL-JSON wire form of an ask query.
 *
 * Carries `op: 'ask'` — the same discriminator mutation envelopes use, so
 * `fromJSON` routes on it and an older peer rejects an unknown op loudly rather
 * than reinterpreting the envelope as a select.
 *
 * Every field is pattern-bearing. There is deliberately no `fields`, `limit`,
 * `offset`, `sortBy` or `one`: a receiver has nothing to validate or ignore.
 *
 * ```json
 * {"v": "1.1", "op": "ask",
 *  "shape": "https://linked.cm/shape/core/Person",
 *  "subject": "linked://tmp/entities/p1"}
 *
 * {"v": "1.1", "op": "ask", "subject": "https://example.org/thing"}
 * ```
 *
 * The second has no `shape` — that absence *is* the shapeless discriminator.
 */
export type AskQueryJSON = {
  v?: string;
  op: 'ask';
  /** Omitted for a shapeless ask (no `rdf:type` constraint). */
  shape?: string;
  /** A node id, or a `{@ctx: name}` reference resolved at lowering. */
  subject?: string | ContextRefJSON;
  subjects?: string[];
  where?: WherePathJSON;
  minusEntries?: RawMinusEntryJSON[];
  /** `.for(null)` — no subject to ask about; the answer is `false` without querying. */
  nullSubject?: boolean;
  /** `.from()`: the graphs the read is restricted to, as absolute IRIs (portable names included). */
  graphs?: string[];
};
