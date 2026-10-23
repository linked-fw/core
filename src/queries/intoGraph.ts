/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Refuse to serialize a mutation that names its graph with `.into()`. DSL-JSON never carries a
 * write graph (the receiving store derives it from its routing), so dropping it silently would
 * write a client's mutation into another graph than the one it named.
 */
export function refuseSerializedInto(builder: string, graph: string | undefined): void {
  if (graph === undefined) return;
  throw new Error(
    `${builder}.toJSON(): this mutation names its graph with .into(<${graph}>), which DSL-JSON ` +
      `never carries (the receiving store picks the graph from its routing). Run it on a ` +
      `server-side store, or leave out .into().`,
  );
}
