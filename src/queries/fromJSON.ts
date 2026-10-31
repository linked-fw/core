/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Kind-detecting `fromJSON` — rehydrate any query DSL-JSON back into its builder.
 *
 * Ask, count and mutation envelopes carry an `op` discriminator; select envelopes
 * (`QueryBuilderJSON`) do not. This is the inbound boundary helper: a receiving
 * process turns wire JSON into a live query with `fromJSON(json).exec()` (the
 * existing generic dispatch), no per-op routing needed.
 */
import {SelectBuilder, type QueryBuilderJSON} from './QueryBuilder.js';
import {CreateBuilder} from './CreateBuilder.js';
import {UpdateBuilder} from './UpdateBuilder.js';
import {DeleteBuilder} from './DeleteBuilder.js';
import {AskBuilder} from './AskBuilder.js';
import {CountBuilder} from './CountBuilder.js';
import type {AskQueryJSON} from './AskQuery.js';
import type {CountQueryJSON} from './CountQuery.js';
import type {InboundMutationOptions, MutationJSON} from './MutationSerialization.js';
import {assertWireVersion} from './wireVersion.js';
import {isGraphQueryKind} from './graphQuery.js';
import {getActiveShapeCatalog, withShapeCatalog} from '../utils/ShapeClass.js';
import type {ShapeCatalog} from '../utils/ShapeCatalog.js';

/** Options for {@link fromJSON}. */
export type FromJSONOptions = {
  /**
   * Decode against this catalog — even `undefined`, which means the global registry.
   * Without the key, the active catalog (`withShapeCatalog`) is used. The builder keeps
   * the catalog it was decoded with. The wire never carries a catalog: each side
   * supplies its own.
   */
  catalog?: ShapeCatalog;
} & InboundMutationOptions;

/** Any query in its wire (DSL-JSON) form. */
export type QueryJSON =
  | QueryBuilderJSON
  | AskQueryJSON
  | CountQueryJSON
  | MutationJSON;

export function fromJSON(
  json: QueryJSON,
  options?: FromJSONOptions,
):
  | SelectBuilder
  | AskBuilder
  | CountBuilder
  | CreateBuilder
  | UpdateBuilder
  | DeleteBuilder {
  if (options && 'catalog' in options && options.catalog !== getActiveShapeCatalog()) {
    const {catalog, ...rest} = options;
    return withShapeCatalog(catalog, () => fromJSON(json, rest));
  }
  assertWireVersion((json as {v?: unknown})?.v);
  const kind = (json as unknown as {kind?: unknown})?.kind;
  if (isGraphQueryKind(kind)) {
    // A graph query is plain data, not a builder: it has no `exec()` and goes to
    // `IDataset.graphQuery`, never through the select path below.
    throw new Error(
      `"${kind}" is a graph query, not a query builder envelope: ` +
      'check it with parseGraphQuery() and pass it to IDataset.graphQuery().',
    );
  }
  if (kind === 'triples') {
    // A triples read is plain data too: it goes to `IDataset.triplesQuery`.
    throw new Error(
      '"triples" is a triples read, not a query builder envelope: ' +
      'check it with parseTriplesQuery() and pass it to IDataset.triplesQuery().',
    );
  }
  if (json && typeof json === 'object' && 'op' in json) {
    switch (json.op) {
      case 'select':
        // A select that needs features beyond the baseline (grouping, min/max) carries
        // `op: 'select'`: a build without this arm refuses it instead of answering it
        // without those parts.
        return SelectBuilder.fromJSON(json as QueryBuilderJSON);
      case 'ask':
        return AskBuilder.fromJSON(json as AskQueryJSON);
      case 'count':
        return CountBuilder.fromJSON(json as CountQueryJSON);
      case 'create':
        return CreateBuilder.fromJSON(json);
      case 'update':
      case 'upsert':
        // Both reconstruct an UpdateBuilder; the op selects upsert mode inside.
        return UpdateBuilder.fromJSON(json);
      case 'delete':
        return DeleteBuilder.fromJSON(json, options);
      default:
        // An `op` is present but not one we know — a malformed/corrupted or
        // future-versioned mutation envelope. Fail loud rather than silently
        // reinterpreting it as a select query.
        throw new Error(
          `Unknown query op "${String((json as {op: unknown}).op)}" in DSL-JSON envelope.`,
        );
    }
  }
  return SelectBuilder.fromJSON(json as QueryBuilderJSON);
}
