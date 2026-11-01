/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Current DSL-JSON wire-format version, stamped onto every `toJSON` envelope as `v`.
 *
 * 1.5: `txId` on every query envelope, the store transaction it runs in (see
 * `queries/transactionQuery.ts`).
 * 1.6: the `$type` path segment, a node's `rdf:type` values (`$type()` in the select DSL).
 * 1.7: `sortBy` entries for a computed expression (`{value, direction}`) and a filtered path
 * (`{path: {direction, where, whereIndex}}`); a quantifier as the condition of another
 * (`{"friends.some": {"$type": …}}`).
 */
export const WIRE_VERSION = '1.7';

/**
 * Validate an incoming envelope's `v`. A missing `v` is tolerated (pre-versioned /
 * assumed current). A different MAJOR version is rejected — the structures may differ.
 */
export function assertWireVersion(v: unknown): void {
  if (v === undefined || v === null) return;
  const incomingMajor = String(v).split('.')[0];
  const ourMajor = WIRE_VERSION.split('.')[0];
  if (incomingMajor !== ourMajor) {
    throw new Error(
      `Unsupported DSL-JSON wire version "${v}". This build speaks ${WIRE_VERSION}.`,
    );
  }
}
