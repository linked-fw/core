/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Where a store keeps the ontology data and the shapes of the registered packages: its two graph
 * targets, `ontologyGraph` and `shapeGraph`. Each is one string:
 *
 * - `'package'` (the default): one named graph per package (`{package IRI}/graph/ontology`,
 *   `{package IRI}/graph/shapes`), each replaced whole when its package changes.
 * - `'default'`: the default graph. The ontology sync replaces every package-owned term there in
 *   one update; the shape sync writes each shape there (`syncShapes`).
 * - an absolute IRI: one shared named graph holding every package's data, rebuilt whole when any
 *   package changes.
 *
 * A store takes them as options (`SparqlOptions.ontologyGraph` / `.shapeGraph`, or
 * {@link IDataset.setGraphTargets}); a host fills them from the environment
 * (`LINKED_ONTOLOGY_GRAPH`, `LINKED_SHAPE_GRAPH`: {@link graphTargetOptionsFromEnv} reads the env
 * map it is given; core never reads `process.env` for them). The syncs write where the targets say
 * and the readers (`graphs.allOntologies`, `graphs.allShapes`) read there. See "Ontology and shape
 * graphs" in core's README.
 *
 * Browser-safe: no I/O.
 *
 * @module @_linked/core/utils/graphTargets
 */
import type {IDataset} from '../interfaces/IDataset.js';
import {PORTABLE_GRAPH_NAMES} from '../ontologies/graphs.js';
import {LinkedStorage} from './LinkedStorage.js';

/** `'package'`, `'default'`, or an absolute graph IRI (see the module doc). */
export type GraphTarget = 'package' | 'default' | (string & {});

/** The two settings as given: each `'package'`, `'default'`, an absolute IRI, or unset. */
export interface GraphTargetOptions {
  ontologyGraph?: string;
  shapeGraph?: string;
}

/** The two settings as a store runs with them. */
export interface GraphTargets {
  ontologyGraph: GraphTarget;
  shapeGraph: GraphTarget;
}

/** The environment variables a host fills the settings from. */
export const GRAPH_TARGET_ENV = {
  ontologyGraph: 'LINKED_ONTOLOGY_GRAPH',
  shapeGraph: 'LINKED_SHAPE_GRAPH',
} as const;

/** Both settings at their default, `'package'`. */
export const DEFAULT_GRAPH_TARGETS: Readonly<GraphTargets> = Object.freeze({
  ontologyGraph: 'package',
  shapeGraph: 'package',
});

/** An absolute IRI: a scheme, a colon, then no character that would break out of `<…>`. */
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\x00-\x20<>"{}|^`\\]+$/;

/** Whether `target` names a shared graph (an IRI), not `'package'` or `'default'`. */
export function isSharedGraphTarget(target: GraphTarget): boolean {
  return target !== 'package' && target !== 'default';
}

/**
 * Check one setting. `undefined` and `''` mean unset (`undefined`); `'package'` and `'default'`
 * are kept; any other string must be an absolute IRI that is not a portable graph name
 * (`graphs.*`, the registry included) and not a store-native name (`urn:x-arq:`). Anything else
 * throws an error naming the setting, the value and `from` (where it came from).
 */
export function parseGraphTarget(
  value: unknown,
  setting: keyof GraphTargetOptions,
  from?: string,
): GraphTarget | undefined {
  if (value === undefined || value === '') return undefined;
  const where = from ? ` (from ${from})` : '';
  const expected =
    `expected 'package' (one graph per package, the default), 'default' (the default graph) ` +
    'or the absolute IRI of one shared graph';
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${setting}${where}: ${expected}; got ${JSON.stringify(value)}.`);
  }
  if (value === 'package' || value === 'default') return value;
  if (!ABSOLUTE_IRI.test(value)) {
    throw new Error(`Invalid ${setting} ${JSON.stringify(value)}${where}: ${expected}.`);
  }
  if (PORTABLE_GRAPH_NAMES.has(value) || value.startsWith('urn:x-arq:')) {
    throw new Error(
      `Invalid ${setting} <${value}>${where}: that name stands for graphs the store resolves ` +
        `itself and cannot be written; name a graph of its own.`,
    );
  }
  return value;
}

/**
 * Check both settings (see {@link parseGraphTarget}) and that they do not name the same shared
 * graph: an ontology graph and a shape graph are different records, each rebuilt whole. Returns
 * the settings that are set.
 */
export function parseGraphTargetOptions(
  options: GraphTargetOptions | undefined,
  from?: {ontologyGraph?: string; shapeGraph?: string},
): Partial<GraphTargets> {
  const out: Partial<GraphTargets> = {};
  const ontologyGraph = parseGraphTarget(options?.ontologyGraph, 'ontologyGraph', from?.ontologyGraph);
  const shapeGraph = parseGraphTarget(options?.shapeGraph, 'shapeGraph', from?.shapeGraph);
  if (ontologyGraph !== undefined) out.ontologyGraph = ontologyGraph;
  if (shapeGraph !== undefined) out.shapeGraph = shapeGraph;
  assertDistinctSharedGraphs({...DEFAULT_GRAPH_TARGETS, ...out});
  return out;
}

/** Throws when both settings name the same shared graph. */
export function assertDistinctSharedGraphs(targets: GraphTargets): void {
  if (isSharedGraphTarget(targets.ontologyGraph) && targets.ontologyGraph === targets.shapeGraph) {
    throw new Error(
      `ontologyGraph and shapeGraph both name <${targets.ontologyGraph}>: the ontology data and ` +
        'the shapes each need a graph of their own (each is rebuilt whole).',
    );
  }
}

/**
 * The settings in `env` (`LINKED_ONTOLOGY_GRAPH`, `LINKED_SHAPE_GRAPH`), checked; a host passes
 * its environment (`graphTargetOptionsFromEnv(process.env)`). Unset and empty variables are left
 * out. Throws on an invalid value, naming the variable.
 */
export function graphTargetOptionsFromEnv(
  env: Record<string, string | undefined>,
): Partial<GraphTargets> {
  return parseGraphTargetOptions(
    {
      ontologyGraph: env[GRAPH_TARGET_ENV.ontologyGraph],
      shapeGraph: env[GRAPH_TARGET_ENV.shapeGraph],
    },
    {
      ontologyGraph: `env ${GRAPH_TARGET_ENV.ontologyGraph}`,
      shapeGraph: `env ${GRAPH_TARGET_ENV.shapeGraph}`,
    },
  );
}

/**
 * The graph targets of `ds` (default: the global router's default dataset): what the store
 * reports (`IDataset.graphTargets`), else both `'package'`.
 */
export function graphTargetsOf(ds?: IDataset): GraphTargets {
  const target = ds ?? (LinkedStorage.getDefaultDataset() as IDataset | undefined);
  const targets = typeof target?.graphTargets === 'function' ? target.graphTargets() : undefined;
  return {
    ontologyGraph: targets?.ontologyGraph ?? 'package',
    shapeGraph: targets?.shapeGraph ?? 'package',
  };
}
