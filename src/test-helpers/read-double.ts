/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {SelectQuery} from '../queries/SelectQuery';
import type {CountQuery} from '../queries/CountQuery';
import type {AskQuery} from '../queries/AskQuery';
import type {TriplesQuery, TriplesTermsQuery} from '../queries/triplesQuery';
import {readKindOf, type ReadQuery, type ReadResult} from '../queries/readQuery';

/** What a test double answers, per kind of read. A kind without a handler is refused. */
export type ReadHandlers = {
  /** A select and a count (`readKindOf` tells them apart). */
  select?: (query: SelectQuery | CountQuery) => unknown;
  ask?: (query: AskQuery) => unknown;
  triples?: (query: TriplesQuery) => unknown;
  terms?: (query: TriplesTermsQuery) => unknown;
};

/**
 * A test double's `readQuery`, from one handler per kind: `{readQuery: readQueryOf({select, ask})}`.
 * A double that answers asks natively also declares `'ask'` in `supports` (else the dispatch sends
 * its asks as selects).
 */
export function readQueryOf(handlers: ReadHandlers) {
  return async <Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>> => {
    const kind = readKindOf(query);
    const handler =
      kind === 'select' || kind === 'count'
        ? handlers.select
        : kind === 'ask'
          ? handlers.ask
          : kind === 'triples'
            ? handlers.triples
            : handlers.terms;
    if (!handler) throw new Error(`This test double does not answer a ${kind} read.`);
    return (await (handler as (query: ReadQuery) => unknown)(query)) as ReadResult<Q>;
  };
}

/** Whether a read is a select or a count (what a double that answers selects overrides). */
export function isSelectRead(query: ReadQuery): query is SelectQuery | CountQuery {
  const kind = readKindOf(query);
  return kind === 'select' || kind === 'count';
}
