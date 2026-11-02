/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * A query sent inside a store transaction carries the transaction's id (see
 * `utils/Transaction.ts`): as `query.txId` for a store that receives the live query, and as
 * `txId` in its DSL-JSON for one that forwards it (`RemoteDataset` sends `toJSON()`), from
 * DSL-JSON 1.5 on.
 *
 * The query the store receives is a **transaction view** of the caller's query: an object whose
 * prototype is the query itself, with its own `txId` and a `toJSON()` that adds it. Every method,
 * getter, brand and the captured catalog are the query's own, and the caller's query is never
 * changed (it can still run outside the transaction).
 */

/** The JSON key of a query's transaction id. */
export const TX_ID_KEY = 'txId';

/** A query that may run inside a transaction. */
type Queryish = object & {toJSON(): unknown};

/** The view of `query` that runs inside the transaction `txId`. */
export function inTransaction<Q extends Queryish>(query: Q, txId: string): Q {
  if (typeof txId !== 'string' || !txId) {
    throw new Error('A transaction id must be a non-empty string.');
  }
  const own = txIdOf(query);
  if (own !== undefined) {
    if (own === txId) return query;
    throw new Error(
      `This query already runs in transaction "${own}"; it cannot be sent in "${txId}" as well.`,
    );
  }
  return Object.create(query, {
    txId: {value: txId, enumerable: false},
    toJSON: {
      value: () => ({...(query.toJSON() as object), [TX_ID_KEY]: txId}),
      enumerable: false,
    },
  }) as Q;
}

/** The transaction id a query runs in, or undefined outside any transaction. */
export function txIdOf(query: unknown): string | undefined {
  const txId = (query as {txId?: unknown} | null | undefined)?.txId;
  return typeof txId === 'string' && txId ? txId : undefined;
}

/**
 * Read the `txId` of a DSL-JSON envelope: absent → undefined; anything but a non-empty string
 * is refused.
 */
export function parseTxId(json: unknown): string | undefined {
  if (!json || typeof json !== 'object' || !(TX_ID_KEY in json)) return undefined;
  const txId = (json as Record<string, unknown>)[TX_ID_KEY];
  if (txId === undefined) return undefined;
  if (typeof txId !== 'string' || !txId) {
    throw new Error('DSL-JSON "txId" must be a non-empty string.');
  }
  return txId;
}

/**
 * Refuse an envelope with a `txId` in a builder's own `fromJSON`: only `fromJSON()` (the
 * package's inbound boundary) returns the transaction view, and dropping the id would run the
 * query outside its transaction.
 */
export function refuseTxIdIn(json: unknown, builder: string): void {
  if (parseTxId(json) === undefined) return;
  throw new Error(
    `${builder}.fromJSON(): this envelope runs in a transaction ("txId"), which ${builder}.fromJSON ` +
      'would drop. Decode it with fromJSON() from @_linked/core.',
  );
}

/** The envelope without its `txId`, and the id (for `fromJSON()` to decode, then wrap). */
export function splitTxId<J extends object>(json: J): {json: J; txId?: string} {
  const txId = parseTxId(json);
  if (txId === undefined) return {json};
  const {[TX_ID_KEY]: _txId, ...rest} = json as Record<string, unknown>;
  return {json: rest as J, txId};
}
