/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Portable graph names: the same IRI in every dataset, under core's package IRI. Import them like
 * ontology terms (`import {graphs} from '@_linked/core/ontologies/graphs'`).
 *
 * - `graphs.default`: the dataset's default graph.
 * - `graphs.union`: every named graph merged (it excludes the default graph on Jena).
 * - `graphs.allOntologies`, `graphs.allShapes`: not physical graphs; a store expands them to the
 *   graphs the registry lists of that kind.
 * - `graphs.registry`: the graph registry, a real named graph holding one record per graph
 *   (SPARQL Service Description plus core terms).
 *
 * Each constant's name matches its IRI, so none clashes with core's own package graphs
 * (`…/graph/ontology`, `…/graph/shapes`). A store maps each name to its own form (Fuseki:
 * `urn:x-arq:DefaultGraph`, `urn:x-arq:UnionGraph`). Writes to any of them are refused
 * (`graph-name-read-only`): the registry is written only as part of a graph query.
 */
const base = 'https://linked.cm/pkg/core/graph/';

export const graphs = {
  default: `${base}default`,
  union: `${base}union`,
  allOntologies: `${base}all-ontologies`,
  allShapes: `${base}all-shapes`,
  registry: `${base}registry`,
} as const;

/** Every portable graph name, for the write refusal. */
export const PORTABLE_GRAPH_NAMES: ReadonlySet<string> = new Set(Object.values(graphs));
