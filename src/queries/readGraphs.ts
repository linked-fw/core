/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The graphs a read is restricted to: `.from(graph | graph[])` on select, count and ask builders,
 * the `graphs` field of their DSL-JSON envelopes and of their IR.
 *
 * The names are kept as the caller wrote them, portable names included (`graphs.allOntologies`,
 * `graphs.default`, …): the store expands them (see `SparqlDataset`), because only the store
 * knows its registry and its own names for the default and union graphs.
 */
import {isGraphIri} from './graphQuery.js';

/** What `.from()` accepts: one graph name or several. */
export type ReadGraphsInput = string | readonly string[];

/**
 * Check a `.from()` argument or a JSON `graphs` field and return it as a list: at least one name,
 * each an absolute IRI, duplicates dropped, order kept. `source` names the caller in the error.
 */
export function normalizeReadGraphs(input: unknown, source = '.from()'): string[] {
  const list = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      `${source} takes a graph name or a non-empty list of graph names; got ${JSON.stringify(input)}.`,
    );
  }
  const out: string[] = [];
  for (const name of list) {
    if (!isGraphIri(name)) {
      throw new Error(`${source}: a graph name must be an absolute IRI; got ${JSON.stringify(name)}.`);
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Check the `graphs` field of a DSL-JSON envelope: a non-empty array of absolute IRIs. */
export function parseReadGraphsJSON(value: unknown, envelope: string): string[] {
  const source = `A ${envelope} envelope's \`graphs\``;
  if (!Array.isArray(value)) {
    throw new Error(`${source} must be an array of graph IRIs; got ${JSON.stringify(value)}.`);
  }
  return normalizeReadGraphs(value, source);
}
