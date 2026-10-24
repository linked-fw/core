/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Where the ontology data and the shapes of the registered packages live: the two graph targets,
 * `ontologyGraph` and `shapeGraph`. Each is one string:
 *
 * - `'package'` (the default): one named graph per package (`{package IRI}/graph/ontology`,
 *   `{package IRI}/graph/shapes`), each replaced whole when its package changes.
 * - `'default'`: the default graph. The ontology sync replaces every package-owned term there in
 *   one update; the shape sync writes each shape there (`syncShapes`).
 * - an absolute IRI: one shared named graph holding every package's data, rebuilt whole when any
 *   package changes.
 *
 * They are one global setting of the process, not of a store: the host sets them once at boot
 * ({@link setGraphTargets}), before its stores load and before the syncs run. `@_linked/server`
 * sets them from `LINKED_ONTOLOGY_GRAPH` / `LINKED_SHAPE_GRAPH` ({@link graphTargetOptionsFromEnv}
 * reads the env map it is given; core never reads `process.env` for them). Unset, both are
 * `'package'`. The syncs write where they say, and every store's readers (`graphs.allOntologies`,
 * `graphs.allShapes`) read there. A frontend whose queries go through the backend sets nothing: it
 * sends those portable names, and the backend's store expands them (a store used directly in a
 * browser follows the browser's own setting). See "Ontology and shape graphs" in core's README.
 *
 * The state lives on `globalThis` (`sharedState`), so every copy of core in a process sees one
 * setting. Browser-safe: no I/O.
 *
 * @module @_linked/core/utils/graphTargets
 */
import {PORTABLE_GRAPH_NAMES} from '../ontologies/graphs.js';
import {sharedState} from './sharedState.js';

/** `'package'`, `'default'`, or an absolute graph IRI (see the module doc). */
export type GraphTarget = 'package' | 'default' | (string & {});

/** The two settings as given: each `'package'`, `'default'`, an absolute IRI, or unset. */
export interface GraphTargetOptions {
  ontologyGraph?: string;
  shapeGraph?: string;
}

/** The two settings as the process runs with them. */
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
  if (/\/pkg\/[^/]+\/graph\/(?:ontology|shapes)$/.test(value)) {
    throw new Error(
      `Invalid ${setting} <${value}>${where}: that is the name of a package's own graph in the ` +
        "'package' mode; name a shared graph of its own.",
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

const targetState = sharedState('@_linked/core', 'graphTargets', () => ({
  targets: {...DEFAULT_GRAPH_TARGETS} as GraphTargets,
}));

/**
 * Set the process's graph targets, checked ({@link parseGraphTargetOptions}: an invalid value, or
 * one shared graph for both, throws and leaves the setting as it was). Each call replaces both: a
 * setting left out (or `''`) is `'package'`. The host calls it once at boot, before its stores load
 * and before the ontology and shape syncs; `setGraphTargets({})` restores the default.
 */
export function setGraphTargets(options: GraphTargetOptions = {}): void {
  targetState.targets = {...DEFAULT_GRAPH_TARGETS, ...parseGraphTargetOptions(options)};
}

/**
 * The process's graph targets (see {@link setGraphTargets}); both `'package'` when nothing was set.
 * The syncs and every store's readers use these.
 */
export function getGraphTargets(): GraphTargets {
  // A container an older copy created may lack the field.
  return {...DEFAULT_GRAPH_TARGETS, ...targetState.targets};
}
