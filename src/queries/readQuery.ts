/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The reads of `IDataset.readQuery`: one method for every query that answers without changing
 * anything. Its kind says what the answer is:
 *
 * | kind            | query                 | answer         | feature a dataset declares |
 * |-----------------|-----------------------|----------------|----------------------------|
 * | `select`        | {@link SelectQuery}   | `SelectResult` | none (the baseline)        |
 * | `count`         | {@link CountQuery}    | `number`       | none (the baseline)        |
 * | `ask`           | {@link AskQuery}      | `boolean`      | `ask` (else a select `LIMIT 1`) |
 * | `triples`       | {@link TriplesQuery}  | `Triple[]`     | `triples` (+ `triplesPattern`) |
 * | `triples_terms` | {@link TriplesTermsQuery} | `string[]` | `triplesTerms`, `triplesPattern` |
 *
 * Select, count and ask are live (closed) queries told apart by `__queryKind`; triples and terms
 * reads are plain data told apart by `kind`. They are never told apart by their structure: a
 * select and a count have the same members.
 *
 * A graph query (`graph_create`, `graph_replace`, `graph_patch`, `graph_drop`) is not a read: it
 * writes a graph and its record, and goes to `IDataset.graphQuery`.
 */
import type {SelectQuery} from './SelectQuery.js';
import type {CountQuery} from './CountQuery.js';
import type {AskQuery} from './AskQuery.js';
import type {SelectResult} from './IntermediateRepresentation.js';
import type {QueryFeature} from './queryFeatures.js';
import {isGraphQueryKind} from './graphQuery.js';
import {triplesQueryFeatures, type Triple, type TriplesQuery, type TriplesTermsQuery} from './triplesQuery.js';

/** A query `IDataset.readQuery` answers. */
export type ReadQuery = SelectQuery | CountQuery | AskQuery | TriplesQuery | TriplesTermsQuery;

/** The kind of a read (see the table in this module's doc). */
export type ReadKind = 'select' | 'count' | 'ask' | 'triples' | 'triples_terms';

/** The answer to a read, by its kind. */
export type ReadResult<Q extends ReadQuery> = Q extends {readonly __queryKind: 'count'}
  ? number
  : Q extends {readonly __queryKind: 'ask'}
    ? boolean
    : Q extends {readonly __queryKind: 'select'}
      ? SelectResult
      : Q extends {kind: 'triples_terms'}
        ? string[]
        : Q extends {kind: 'triples'}
          ? Triple[]
          : never;

const LIVE_KINDS = new Set<string>(['select', 'count', 'ask']);
const MUTATION_OPS = new Set<string>(['create', 'update', 'upsert', 'delete']);

/**
 * The kind of a read: `__queryKind` of a live query, else its `kind`. Throws on anything that is
 * not a read: a mutation, a graph query (it goes to `IDataset.graphQuery`), or an object of
 * neither form.
 */
export function readKindOf(query: ReadQuery): ReadKind {
  const live = (query as {__queryKind?: unknown} | null | undefined)?.__queryKind;
  if (typeof live === 'string') {
    if (LIVE_KINDS.has(live)) return live as ReadKind;
    throw new Error(`A ${live} query is a write, not a read: send it with ${live}Query, not readQuery.`);
  }
  return plainReadKind((query as {kind?: unknown} | null | undefined)?.kind, 'readQuery was handed');
}

/**
 * The kind of a read in its wire form: a DSL-JSON envelope (`op`: absent or `select` for a
 * select, `count`, `ask`) or a plain-data read (`kind`: `triples`, `triples_terms`). Throws on a
 * mutation envelope, a graph query, an unknown `op` or `kind`, and anything that is not an object.
 * A receiver calls it before decoding (`fromJSON`, `parseTriplesQuery`, `parseTriplesTermsQuery`).
 */
export function readKindOfJSON(json: unknown): ReadKind {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('A read must be a JSON object (a DSL-JSON envelope or a triples read).');
  }
  const {kind, op} = json as {kind?: unknown; op?: unknown};
  if (kind !== undefined) return plainReadKind(kind, 'The read body has');
  if (op === undefined || op === 'select') return 'select';
  if (op === 'count' || op === 'ask') return op;
  if (typeof op === 'string' && MUTATION_OPS.has(op)) {
    throw new Error(`A DSL-JSON envelope with op "${op}" is a write, not a read.`);
  }
  throw new Error(`Unknown query op ${JSON.stringify(op)} in a read.`);
}

function plainReadKind(kind: unknown, what: string): ReadKind {
  if (kind === 'triples' || kind === 'triples_terms') return kind;
  if (isGraphQueryKind(kind)) {
    throw new Error(
      `"${kind}" is a graph query, which writes a graph: send it with graphQuery, not readQuery.`,
    );
  }
  throw new Error(`${what} no read kind: ${JSON.stringify(kind)} (expected a select, count, ask, triples or terms read).`);
}

/**
 * The query features a read needs (`IDataset.supports`): a select's or count's own (grouping,
 * min/max, from its `requiredFeatures()`), `ask` and the ask's own for an ask, and a triples or
 * terms read's (`triplesQueryFeatures`). An ask on a dataset without `ask` is still answered, as a
 * select `LIMIT 1` (see `resolveRead`); every other feature listed here is refused when missing.
 */
export function readFeaturesOf(query: ReadQuery): QueryFeature[] {
  const kind = readKindOf(query);
  if (kind === 'triples' || kind === 'triples_terms') {
    return triplesQueryFeatures(query as TriplesQuery | TriplesTermsQuery);
  }
  const {requiredFeatures} = query as {requiredFeatures?: () => readonly QueryFeature[]};
  const own = typeof requiredFeatures === 'function' ? [...requiredFeatures.call(query)] : [];
  return kind === 'ask' ? ['ask', ...own] : own;
}
