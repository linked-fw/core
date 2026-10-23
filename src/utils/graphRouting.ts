/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Graph routing: which named graph of a dataset holds the instances of a shape.
 *
 * Storage rules pick the graph, per app, the way they pick the dataset (`LinkedStorage`): a route
 * maps a shape IRI to one graph IRI of one dataset, so ordinary code never names a graph. Routes
 * come from `LinkedStorage.setDatasetForShapes(dataset, shapes, {graph})`, from the datasets
 * config's per-alias `graphs` key (`loadStores`), or from {@link setShapeGraphs} directly (a
 * composite dataset registers them on the store it forwards to). A shape without a route, and
 * without a routed super-shape, lives in the default graph, as before routing existed.
 *
 * - **A shape's graph** (where its instances are written): its own route, else its nearest routed
 *   super-shape's, else the default graph.
 * - **Its read set**: its graph plus the graph of every registered sub-shape, because a select of a
 *   shape returns the instances of its sub-shapes too.
 *
 * The default graph appears in a set as `graphs.default`. The table lives on the shared global and
 * is keyed by the dataset object and the shape IRI (never a class object): a module can evaluate
 * twice in a process, and a shape's IRI is the identity every copy agrees on.
 */
import type {IDataset} from '../interfaces/IDataset.js';
import {graphs, PORTABLE_GRAPH_NAMES} from '../ontologies/graphs.js';
import {getSubShapes, getSuperShapes} from './ShapeClass.js';

const routingGlobal: any = typeof globalThis !== 'undefined' ? globalThis : ({} as any);

/** Dataset → (shape IRI → graph IRI). */
const routes: WeakMap<object, Map<string, string>> = (routingGlobal.__linkedGraphRouting ??=
  new WeakMap<object, Map<string, string>>());

/** Absolute IRI with a scheme and none of the characters that end an IRIREF. */
const IRI_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]*$/;

function checkRoute(shape: string, graph: string): void {
  if (typeof shape !== 'string' || !IRI_PATTERN.test(shape)) {
    throw new Error(`A graph route needs a shape IRI; got ${JSON.stringify(shape)}.`);
  }
  if (typeof graph !== 'string' || !IRI_PATTERN.test(graph)) {
    throw new Error(
      `The graph route of <${shape}> must name an absolute graph IRI; got ${JSON.stringify(graph)}.`,
    );
  }
  if (PORTABLE_GRAPH_NAMES.has(graph) && graph !== graphs.default) {
    throw new Error(
      `<${graph}> is a portable graph name a store resolves at read time; a route names the one ` +
        `graph a shape's instances are written to (route <${shape}> to a graph IRI, or leave it ` +
        `out for the default graph).`,
    );
  }
}

/**
 * Route shapes of `dataset` to graphs: `{<shape IRI>: <graph IRI>}`. Adds to (and overrides) the
 * dataset's existing routes. A route to `graphs.default` removes the shape's route.
 */
export function setShapeGraphs(dataset: IDataset | object, shapeGraphs: Record<string, string>): void {
  const entries = Object.entries(shapeGraphs ?? {});
  for (const [shape, graph] of entries) checkRoute(shape, graph);
  let table = routes.get(dataset);
  if (!table) {
    table = new Map();
    routes.set(dataset, table);
  }
  for (const [shape, graph] of entries) {
    if (graph === graphs.default) table.delete(shape);
    else table.set(shape, graph);
  }
}

/** The routes of `dataset` (shape IRI → graph IRI), a copy; empty when it has none. */
export function getShapeGraphs(dataset: IDataset | object): Record<string, string> {
  return Object.fromEntries(routes.get(dataset) ?? []);
}

/** Drop the graph route of `shape` in `dataset`. */
export function unsetShapeGraph(shape: string, dataset: IDataset | object): void {
  routes.get(dataset)?.delete(shape);
}

/** The graph routing of one dataset, as the SPARQL compiler and the live-query matcher read it. */
export interface ShapeGraphRouting {
  /** The graph a shape's instances are written to (`graphs.default` when unrouted). */
  graphForShape(shapeId: string): string;
  /**
   * The graphs a read of the shape covers: its graph and every registered sub-shape's, without
   * duplicates, sorted (`graphs.default` first when present), so the query text is stable.
   */
  readGraphsForShape(shapeId: string): string[];
  /** Every graph the routing names, and the default graph: where a node of unknown shape may be. */
  allGraphs(): string[];
}

/**
 * The routing of `dataset`, or `undefined` when it has no routes (its reads and writes are then
 * exactly what they were before routing: everything in the default graph).
 */
export function graphRoutingFor(dataset: IDataset | object | undefined): ShapeGraphRouting | undefined {
  if (!dataset) return undefined;
  const table = routes.get(dataset);
  if (!table || table.size === 0) return undefined;
  const graphForShape = (shapeId: string): string => {
    const own = table.get(shapeId);
    if (own) return own;
    for (const parent of getSuperShapes(shapeId)) {
      const inherited = table.get(parent.id);
      if (inherited) return inherited;
    }
    return graphs.default;
  };
  return {
    graphForShape,
    readGraphsForShape(shapeId: string): string[] {
      const set = new Set<string>([graphForShape(shapeId)]);
      for (const sub of getSubShapes(shapeId)) set.add(graphForShape(sub.id));
      return sortGraphSet(set);
    },
    allGraphs(): string[] {
      return sortGraphSet([graphs.default, ...table.values()]);
    },
  };
}

/** A graph set in its stable order: `graphs.default` first, then the named graphs sorted. */
export function sortGraphSet(set: Iterable<string>): string[] {
  const all = [...new Set(set)];
  const named = all.filter((g) => g !== graphs.default).sort();
  return all.includes(graphs.default) ? [graphs.default, ...named] : named;
}
