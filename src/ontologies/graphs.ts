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

/**
 * A route to the app's own data graph `{DATA_ROOT}/graph/{slug}`, made by {@link dataGraph}. The
 * store's `DATA_ROOT` is joined when the route is used (see `utils/graphRouting.ts`).
 */
export interface DataGraphRoute {
  readonly dataGraph: string;
}

/**
 * The route that puts a shape's instances in a graph of its own:
 * `{DATA_ROOT}/graph/{package slug}/{shape name}` (see `utils/graphRouting.ts` for the rule).
 */
export const OWN_GRAPH = 'own' as const;

/**
 * What a graph route states: `'own'` (the shape's own graph), `dataGraph('slug')` (a named data
 * graph of the app), or, for advanced use, an absolute graph IRI.
 */
export type GraphRoute = typeof OWN_GRAPH | DataGraphRoute | string;

/** A data graph slug: `/`-separated segments, each lower-case letters and digits joined by `-`. */
export const DATA_GRAPH_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/**
 * Route shapes to the app's data graph `{DATA_ROOT}/graph/{slug}`:
 * `LinkedStorage.setDatasetForShapes(store, [Article, Comment], {graph: dataGraph('articles')})`.
 * The slug is one or more `/`-separated segments, each `^[a-z0-9]+(?:-[a-z0-9]+)*$`
 * (`articles`, `news/archive`); anything else throws rather than being rewritten.
 */
export function dataGraph(slug: string): DataGraphRoute {
  if (typeof slug !== 'string' || !DATA_GRAPH_SLUG.test(slug)) {
    throw new Error(
      `dataGraph() takes a slug of lower-case letters, digits and single hyphens, with "/" ` +
        `between segments (e.g. 'articles', 'news/archive'); got ${JSON.stringify(slug)}.`,
    );
  }
  return Object.freeze({dataGraph: slug});
}

/** Whether `route` was made by {@link dataGraph}. */
export function isDataGraphRoute(route: unknown): route is DataGraphRoute {
  return (
    typeof route === 'object' &&
    route !== null &&
    typeof (route as DataGraphRoute).dataGraph === 'string'
  );
}
