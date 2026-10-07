/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {fromJSON} from '../queries/fromJSON.js';
import {mutationEffects, type MutationEffects} from '../queries/queryDependencies.js';
import type {MutationJSON} from '../queries/MutationSerialization.js';

/**
 * A change in the data, from any source, in one of two forms:
 *
 * - `{mutation, result?}` — the mutation's DSL-JSON (what a server already has
 *   when it executed it) and, if known, the result it produced. The receiving
 *   runtime computes the effects itself with `mutationEffects`.
 * - `{effects}` — precomputed {@link MutationEffects}, for producers that
 *   already know what changed.
 *
 * Both are plain data, so they cross a serialization boundary unchanged. Local
 * mutations, dataset change feeds (`IDataset.subscribeChanges`) and
 * `publishChange()` all speak this type.
 */
export type ChangeEvent =
  | {effects: MutationEffects}
  | {mutation: MutationJSON; result?: unknown};

export function normalizeChange(event: ChangeEvent): MutationEffects {
  if ('effects' in event) return reviveEffects(event.effects);
  const builder = fromJSON(event.mutation as any) as any;
  return mutationEffects(builder, event.result);
}

/** Accept effects whose sets arrived as arrays (e.g. after JSON transport). */
function reviveEffects(e: MutationEffects): MutationEffects {
  const toSet = (v: unknown): Set<string> => (v instanceof Set ? v : new Set(Array.isArray(v) ? (v as string[]) : []));
  return {
    op: e.op,
    shape: e.shape,
    props: toSet(e.props),
    ids: e.ids === undefined ? undefined : toSet(e.ids),
    membership: toSet(e.membership),
  };
}

/** A stable fingerprint of an effects object, used to fold a local change and its remote echo into one. */
export function effectsHash(e: MutationEffects): string {
  const sorted = (s: Set<string>) => [...s].sort().join(',');
  return `${e.op}|${e.shape}|${sorted(e.props)}|${e.ids ? sorted(e.ids) : '*'}|${sorted(e.membership)}`;
}
