/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Current DSL-JSON wire-format version, stamped onto every `toJSON` envelope as `v`. */
export const WIRE_VERSION = '1.2';

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
