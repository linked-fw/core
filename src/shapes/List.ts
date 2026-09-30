/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Registers List (together with the rest of the SHACL metamodel), so importing this module
// on its own is enough to make List resolvable. The class lives in List.class.ts because
// utils/Package.ts needs it by value and cannot import this module's registration path.
import '../utils/Package.js';
import {List} from './List.class.js';
import {rdf} from '../ontologies/rdf.js';

export {List};

/**
 * Node-data for a single cell / the `rdf:nil` terminal. Accepted by the create pipeline.
 */
export type RdfListNodeData =
  | {id: string}
  | {shape: typeof List; first: unknown; rest: RdfListNodeData; __id?: string};

/**
 * Build the nested `List` node-data chain for an ordered `rdf:List`, terminating at `rdf:nil`.
 * Pass `opts.base` to mint deterministic cell ids (`{base}/0`, `{base}/1`, …); otherwise the
 * create pipeline mints ids. The empty list serializes to `rdf:nil`.
 *
 * @example Playlist.create({ tracks: rdfList([t1, t2, t3]) })
 */
export function rdfList<T>(
  items: T[],
  opts?: {base?: string},
): RdfListNodeData {
  const base = opts?.base;
  const build = (i: number): RdfListNodeData => {
    if (i >= items.length) {
      return {id: rdf.nil.id};
    }
    const cell: RdfListNodeData = {
      shape: List,
      first: items[i],
      rest: build(i + 1),
    };
    if (base !== undefined) {
      cell.__id = `${base}/${i}`;
    }
    return cell;
  };
  return build(0);
}
