/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Where the ontology and shape syncs write when they follow the storage routing, and what they
 * would write.
 *
 * - {@link graphSyncTargets}: per package, the datasets of its shape graph and of its ontology
 *   graph, and the datasets of the app's single-owner shape graph. A package's graphs go to every
 *   dataset any of its shapes route to, plus the dataset(s) the shapes describing them are routed
 *   to (`sh:NodeShape` / `sh:PropertyShape` for shape graphs, the ontology term shapes for
 *   ontology graphs). An ontology graph also goes wherever a shape targeting one of its classes
 *   routes, so an ontology-only package follows the shapes that use it. The app's graph goes to
 *   the datasets of the shapes declaring `contains` properties, plus the shape shapes' datasets.
 *   An app without pins gets the default dataset everywhere.
 * - {@link syncShapeGraphsRouted} / {@link syncOntologiesRouted}: the per-dataset syncs
 *   (`syncShapeGraphs(ds)`, `syncOntologies(ds)`) once per target dataset with that dataset's
 *   packages, from one read of the packages, then the prune of the package graphs routing no
 *   longer sends to a dataset (only in the default dataset; elsewhere they are reported).
 * - {@link graphContent}: the text and hash each package graph and the app graph would get in the
 *   `'package'` mode, writing nothing (a host that writes the graphs itself reads them).
 *
 * Server only (the ontology readers load `n3`).
 *
 * @module @_linked/core/shapes/syncTargets
 */
import type {IDataset} from '../interfaces/IDataset.js';
import {LinkedStorage} from '../utils/LinkedStorage.js';
import {assertNoActiveCatalog, getAllShapeClasses} from '../utils/ShapeClass.js';
import {getGraphTargets} from '../utils/graphTargets.js';
import {isGraphQueryError} from '../queries/graphQuery.js';
import {OntologyGraph, ShapesGraph} from './NamedGraph.js';
import {buildSingleOwnerConstraints} from './singleOwnerConstraint.js';
import {packageShapes, packageShapesTurtle, packagesWithShapes, singleOwnerShapesTurtle} from './shapesToTurtle.js';
import {
  readShapesRecords,
  shapeGraphHash,
  SHAPES_SOURCE,
  syncShapeGraphs,
  type SyncShapeGraphsOptions,
  type SyncShapeGraphsResult,
} from './syncShapeGraphs.js';
import {
  ontologyGraphHash,
  packageSources,
  readOntologyRecords,
  syncParsedOntologies,
  type SyncOntologiesOptions,
  type SyncOntologiesResult,
} from '../ontology/syncOntologies.js';
import {readPackageOntologies, registrationsByPackage, setHierarchyFromPackages} from '../ontology/registryData.js';
import {nTriplesFromTurtle} from '../ontology/hierarchy.js';

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';

/** The classes of the shape shapes: what the shape sync writes. */
export const SHAPE_SHAPE_CLASSES: readonly string[] = [`${SH}NodeShape`, `${SH}PropertyShape`];

/**
 * The classes of the ontology term shapes (the class and property shapes core, `@_linked/rdfs`
 * and `@_linked/owl` register): what the ontology sync writes and the hierarchy reads.
 */
export const ONTOLOGY_TERM_CLASSES: readonly string[] = [
  `${RDFS}Class`,
  `${OWL}Class`,
  `${OWL}Restriction`,
  `${RDF}Property`,
  `${OWL}ObjectProperty`,
  `${OWL}DatatypeProperty`,
  `${OWL}AnnotationProperty`,
];

/**
 * A dataset as a log line tells it apart: its store class, and its `id` when it has one, else the
 * dataset name a SPARQL store keeps from its endpoint (`FusekiStore`'s `dataset`).
 */
export function datasetLabel(dataset: IDataset): string {
  const {id, dataset: name} = dataset as {id?: unknown; dataset?: unknown};
  const store = dataset?.constructor?.name || 'unknown';
  const label = typeof id === 'string' && id ? id : typeof name === 'string' && name ? name : undefined;
  return label ? `${store} "${label}"` : store;
}

/**
 * The class the instances of `shapeClass` carry: the `targetClass` of the shape itself or, when
 * it declares none of its own, of the nearest super-shape that does.
 */
export function targetClassOf(shapeClass: Function): string | undefined {
  for (
    let current: unknown = shapeClass;
    typeof current === 'function' && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    if (!Object.prototype.hasOwnProperty.call(current, 'targetClass')) continue;
    const id = (current as {targetClass?: {id?: unknown}}).targetClass?.id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/** Where each graph goes; see {@link graphSyncTargets}. Every list is in {@link GraphSyncTargets.datasets} order. */
export interface GraphSyncTargets {
  /** Per package with registered shapes: the datasets of its shape graph. */
  shapes: Map<string, IDataset[]>;
  /** Per package with ontology data: the datasets of its ontology graph. */
  ontologies: Map<string, IDataset[]>;
  /** The datasets of the app's single-owner shape graph. */
  appShapes: IDataset[];
  /** Every dataset the router knows (`LinkedStorage.getDatasets()`): the default one first, then in pin order. */
  datasets: IDataset[];
}

/**
 * The datasets each package's shape and ontology graphs and the app's shape graph go to, from the
 * routing as it stands (see the module doc). Empty without a default dataset. Reads the
 * registered shapes, so it runs outside any shape catalog.
 */
export function graphSyncTargets(): GraphSyncTargets {
  assertNoActiveCatalog();
  const defaultDataset = LinkedStorage.getDefaultDataset();
  const datasets = [...LinkedStorage.getDatasets()];
  const empty: GraphSyncTargets = {shapes: new Map(), ontologies: new Map(), appShapes: [], datasets};
  if (!defaultDataset) return empty;

  const classes = getAllShapeClasses();
  const datasetOf = (shapeClass: Function): IDataset =>
    LinkedStorage.getDatasetForShapeClass(shapeClass) ?? defaultDataset;
  const inOrder = (set: Set<IDataset>): IDataset[] => datasets.filter((ds) => set.has(ds));
  const union = (...sets: Iterable<IDataset>[]): Set<IDataset> => {
    const out = new Set<IDataset>();
    for (const set of sets) for (const ds of set) out.add(ds);
    return out;
  };

  /** The datasets of the shapes whose instances carry one of `watched`; the default one when none is registered. */
  const describedBy = (watched: readonly string[]): Set<IDataset> => {
    const out = new Set<IDataset>();
    const set = new Set(watched);
    for (const shapeClass of classes.values()) {
      const target = targetClassOf(shapeClass);
      if (target && set.has(target)) out.add(datasetOf(shapeClass));
    }
    return out.size ? out : new Set([defaultDataset]);
  };
  const shapeShapes = describedBy(SHAPE_SHAPE_CLASSES);
  const termShapes = describedBy(ONTOLOGY_TERM_CLASSES);

  /** The datasets of a package's own shapes. */
  const ownDatasets = new Map<string, Set<IDataset>>();
  const shapes = new Map<string, IDataset[]>();
  for (const name of packagesWithShapes()) {
    const own = new Set<IDataset>();
    for (const shape of packageShapes(name)) {
      const shapeClass = classes.get(shape.id);
      if (shapeClass) own.add(datasetOf(shapeClass));
    }
    ownDatasets.set(name, own);
    shapes.set(name, inOrder(union(own, shapeShapes)));
  }

  const ontologies = new Map<string, IDataset[]>();
  for (const [name, registrations] of registrationsByPackage()) {
    const withData = registrations.filter((r) => typeof r.load === 'function');
    if (!withData.length) continue;
    const namespaces = withData.map((r) => r.ns('').id).filter((ns): ns is string => typeof ns === 'string' && !!ns);
    const using = new Set<IDataset>();
    for (const shapeClass of classes.values()) {
      const target = targetClassOf(shapeClass);
      if (target && namespaces.some((ns) => target.startsWith(ns))) using.add(datasetOf(shapeClass));
    }
    ontologies.set(name, inOrder(union(ownDatasets.get(name) ?? [], using, termShapes)));
  }

  const owners = new Set<IDataset>();
  for (const name of packagesWithShapes()) {
    for (const shape of packageShapes(name)) {
      const shapeClass = classes.get(shape.id);
      if (shapeClass && buildSingleOwnerConstraints(shape, shape.id).length) owners.add(datasetOf(shapeClass));
    }
  }
  return {shapes, ontologies, appShapes: inOrder(union(owners, shapeShapes)), datasets};
}

/** One graph's content as the `'package'`-mode sync writes and records it. */
export interface GraphContentPart {
  graph: string;
  mediaType: 'text/turtle' | 'application/n-triples';
  /** The body the sync writes, byte for byte. */
  text: string;
  /** The `core:contentHash` the sync records (`shapeGraphHash(text)`, `ontologyGraphHash(raw texts)`). */
  hash: string;
  /** The record's `dcterms:source`. */
  sources: string[];
}

export interface GraphContents {
  /** Per package asked for (or, without `packages`, every one with shapes or ontology data), sorted. */
  packages: Array<{name: string; shapes?: GraphContentPart; ontology?: GraphContentPart}>;
  /** The app's single-owner shape graph; `null` when there are no such shapes. Absent without `appShapes`. */
  appGraph?: GraphContentPart | null;
  /** Packages with shapes but no Turtle (`turtleFor` and the generator gave none). */
  withoutTurtle: string[];
  /** Packages whose ontology data could not be read or parsed. */
  unreadable: string[];
}

export interface GraphContentOptions {
  /** Only these packages (npm names). The app graph always covers every registered package. */
  packages?: string[];
  /** A package's `shapes.ttl` bytes, as for `syncShapeGraphs`; `undefined` generates them. */
  turtleFor?: SyncShapeGraphsOptions['turtleFor'];
  /** The app's own shape graph IRI; without it `appGraph` is left out. */
  appShapes?: {graph: string};
}

/**
 * What the `'package'`-mode syncs would write for each package and for the app's graph, writing
 * nothing and reading no store: the shape graph's Turtle and {@link shapeGraphHash}, the ontology
 * graph's N-Triples (`nTriplesFromTurtle` of the package's data files) and
 * {@link ontologyGraphHash} of the raw texts, and each record's sources. Runs outside any shape
 * catalog.
 */
export async function graphContent(options: GraphContentOptions = {}): Promise<GraphContents> {
  assertNoActiveCatalog();
  const only = options.packages ? new Set(options.packages) : undefined;
  const withShapes = packagesWithShapes();
  const {packages: parsed, skipped: unreadable} = await readPackageOntologies(
    options.packages ? {packages: options.packages} : undefined,
  );
  const names = options.packages
    ? [...new Set(options.packages)]
    : [...new Set([...withShapes, ...parsed.keys(), ...unreadable])];
  const out: GraphContents = {packages: [], withoutTurtle: [], unreadable: [...unreadable].sort()};
  for (const name of names.sort()) {
    const entry: GraphContents['packages'][number] = {name};
    if (withShapes.includes(name)) {
      const text = (await options.turtleFor?.(name)) ?? packageShapesTurtle(name);
      if (text === undefined) out.withoutTurtle.push(name);
      else {
        entry.shapes = {
          graph: ShapesGraph.iriFor(name),
          mediaType: 'text/turtle',
          text,
          hash: shapeGraphHash(text),
          sources: [SHAPES_SOURCE],
        };
      }
    }
    const data = parsed.get(name);
    if (data) {
      entry.ontology = {
        graph: OntologyGraph.iriFor(name),
        mediaType: 'application/n-triples',
        text: await nTriplesFromTurtle(data.texts, data.sources),
        hash: ontologyGraphHash(data.texts),
        sources: packageSources(name),
      };
    }
    if (!only || only.has(name)) out.packages.push(entry);
  }
  if (options.appShapes) {
    const text = singleOwnerShapesTurtle(withShapes.flatMap((name) => packageShapes(name)));
    out.appGraph =
      text === undefined
        ? null
        : {graph: options.appShapes.graph, mediaType: 'text/turtle', text, hash: shapeGraphHash(text), sources: []};
  }
  return out;
}

/** A package graph the routed prune dropped, or found where routing no longer sends it. */
export interface RoutedGraph {
  dataset: string;
  package: string;
  graph: string;
}

/** What a routed sync did. */
export interface RoutedSyncResult<R> {
  /** Each target dataset and the per-dataset sync's result there, in dataset order. */
  targets: Array<{dataset: string; result: R}>;
  /** Package graphs dropped from the default dataset, which routing no longer sends there. */
  pruned: RoutedGraph[];
  /** Package graphs in another dataset that routing no longer sends there: left as they are, reported. */
  leftovers: RoutedGraph[];
  /** Datasets whose sync or prune failed, with the error; the others went on. */
  failed: Array<{dataset: string; error: string}>;
}

export interface RoutedSyncOptions {
  /** Drop the package graphs routing no longer sends to the default dataset (default true; `'package'` mode only). */
  prune?: boolean;
  /** The targets to use; default {@link graphSyncTargets}(). */
  targets?: GraphSyncTargets;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The shape graph sync, following the routing: `syncShapeGraphs(ds)` once per target dataset with
 * the packages whose shape graph goes there (and the app graph where it goes), then the prune.
 * Every target gets the same text for a package (each package's Turtle is read or generated
 * once). A dataset that gets every package is synced with no package subset, exactly as
 * `syncShapeGraphs(ds, options)` alone would (`orphanScope` included). A dataset that fails is
 * reported in `failed`; the others are still synced.
 */
export async function syncShapeGraphsRouted(
  options: SyncShapeGraphsOptions & RoutedSyncOptions = {},
): Promise<RoutedSyncResult<SyncShapeGraphsResult>> {
  assertNoActiveCatalog();
  const {prune = true, targets: given, ...syncOptions} = options;
  const targets = given ?? graphSyncTargets();
  const all = packagesWithShapes();
  const only = syncOptions.packages ? new Set(syncOptions.packages) : undefined;
  const texts = new Map<string, Promise<string | undefined>>();
  const turtleFor = (name: string): Promise<string | undefined> => {
    let text = texts.get(name);
    if (!text) {
      text = Promise.resolve(syncOptions.turtleFor?.(name)).then((t) => t ?? packageShapesTurtle(name));
      texts.set(name, text);
    }
    return text;
  };

  const result: RoutedSyncResult<SyncShapeGraphsResult> = {targets: [], pruned: [], leftovers: [], failed: []};
  const failed = new Set<IDataset>();
  for (const ds of targets.datasets) {
    const members = all.filter((name) => targets.shapes.get(name)?.includes(ds));
    const app = targets.appShapes.includes(ds);
    if (!members.length && !app) continue;
    const packages = only ? members.filter((name) => only.has(name)) : members.length === all.length ? undefined : members;
    try {
      const run = await syncShapeGraphs(ds, {
        ...syncOptions,
        ...(packages ? {packages} : {packages: undefined}),
        turtleFor,
        appShapes: app ? syncOptions.appShapes : undefined,
      });
      result.targets.push({dataset: datasetLabel(ds), result: run});
    } catch (error) {
      failed.add(ds);
      result.failed.push({dataset: datasetLabel(ds), error: errorText(error)});
    }
  }

  if (prune && getGraphTargets().shapeGraph === 'package') {
    await pruneRouted(result, failed, targets, {
      kind: 'shape',
      registered: new Set(all),
      only,
      targetsOf: (name) => targets.shapes.get(name) ?? [],
      graphOf: (name) => ShapesGraph.iriFor(name),
      read: readShapesRecords,
      drop: (graph, ds) => ShapesGraph.delete(graph).exec(ds),
    });
  }
  return result;
}

/** The datasets the default-mode warning was given for (once per dataset and process). */
const warnedDefaultMode = new WeakSet<object>();

/**
 * The ontology sync, following the routing: the packages' data is read once and the in-memory
 * hierarchy set from every package, then the per-dataset sync runs once per target dataset with
 * the packages whose ontology graph goes there, then the prune. In the shared and `'default'`
 * modes a dataset's members are its packages. A dataset that gets every package is synced
 * exactly as `syncOntologies(ds, options)` alone would. A dataset that fails is reported in
 * `failed`; the others are still synced.
 *
 * The `'default'` mode keeps one combined state per dataset and sweeps only the namespaces of its
 * members, so the terms of a package routed away from a dataset stay in its default graph: the
 * run warns once per dataset that does not get every package.
 */
export async function syncOntologiesRouted(
  options: SyncOntologiesOptions & RoutedSyncOptions = {},
): Promise<RoutedSyncResult<SyncOntologiesResult>> {
  assertNoActiveCatalog();
  const {prune = true, targets: given, ...syncOptions} = options;
  const data = await readPackageOntologies();
  setHierarchyFromPackages(data.packages);
  const targets = given ?? graphSyncTargets();
  const all = [...data.packages.keys(), ...data.skipped];
  const only = syncOptions.packages ? new Set(syncOptions.packages) : undefined;
  const mode = getGraphTargets().ontologyGraph;

  const result: RoutedSyncResult<SyncOntologiesResult> = {targets: [], pruned: [], leftovers: [], failed: []};
  const failed = new Set<IDataset>();
  for (const ds of targets.datasets) {
    const members = new Set(all.filter((name) => targets.ontologies.get(name)?.includes(ds)));
    if (!members.size) continue;
    const subset =
      members.size === all.length
        ? data
        : {
            packages: new Map([...data.packages].filter(([name]) => members.has(name))),
            skipped: data.skipped.filter((name) => members.has(name)),
          };
    if (mode === 'default' && subset !== data && !warnedDefaultMode.has(ds)) {
      warnedDefaultMode.add(ds);
      const away = all.filter((name) => !members.has(name)).sort();
      console.warn(
        `[syncOntologies] ontologyGraph is 'default', and routing sends the ontologies of ` +
          `${away.join(', ')} elsewhere than ${datasetLabel(ds)}. The 'default' mode sweeps only the ` +
          'namespaces of the packages it syncs, so terms an earlier sync wrote there for them stay in ' +
          "its default graph. Clear them by hand, or use 'package' (see \"Ontology and shape graphs\" " +
          "in @_linked/core's README).",
      );
    }
    try {
      const run = await syncParsedOntologies(ds, syncOptions, subset);
      result.targets.push({dataset: datasetLabel(ds), result: run});
    } catch (error) {
      failed.add(ds);
      result.failed.push({dataset: datasetLabel(ds), error: errorText(error)});
    }
  }

  if (prune && mode === 'package') {
    await pruneRouted(result, failed, targets, {
      kind: 'ontology',
      registered: new Set(all),
      only,
      targetsOf: (name) => targets.ontologies.get(name) ?? [],
      graphOf: (name) => OntologyGraph.iriFor(name),
      read: readOntologyRecords,
      drop: (graph, ds) => OntologyGraph.delete(graph).exec(ds),
    });
  }
  return result;
}

/**
 * The routed prune: in every dataset the router knows (one registry read each), the package-mode
 * graph of a package of this run whose graph routing no longer sends there. Dropped in the default
 * dataset; in another one left as it is and reported in `leftovers`, with one warning, since a
 * store several apps share may hold another app's copy there. Never a shared graph, an app's own
 * graph or a graph of a package this process does not register (that is `orphanScope`'s).
 */
async function pruneRouted(
  result: RoutedSyncResult<unknown>,
  failed: Set<IDataset>,
  targets: GraphSyncTargets,
  how: {
    kind: 'shape' | 'ontology';
    registered: Set<string>;
    only?: Set<string>;
    targetsOf: (name: string) => IDataset[];
    graphOf: (name: string) => string;
    read: (ds: IDataset) => Promise<Map<string, {package?: string; packageHashes: string[]}>>;
    drop: (graph: string, ds: IDataset) => Promise<unknown>;
  },
): Promise<void> {
  const defaultDataset = LinkedStorage.getDefaultDataset();
  const leftovers: RoutedGraph[] = [];
  for (const ds of targets.datasets) {
    if (failed.has(ds)) continue;
    if (typeof (ds as Partial<IDataset>).graphQuery !== 'function') continue; // holds no named graphs
    try {
      const records = await how.read(ds);
      for (const [graph, record] of [...records].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const name = record.package;
        if (!name || record.packageHashes.length || graph !== how.graphOf(name)) continue;
        if (!how.registered.has(name) || (how.only && !how.only.has(name))) continue;
        if (how.targetsOf(name).includes(ds)) continue;
        const entry = {dataset: datasetLabel(ds), package: name, graph};
        if (ds === defaultDataset) {
          await how.drop(graph, ds);
          result.pruned.push(entry);
        } else {
          leftovers.push(entry);
        }
      }
    } catch (error) {
      if (isGraphQueryError(error, 'unsupported-query-kind')) continue;
      result.failed.push({dataset: datasetLabel(ds), error: errorText(error)});
    }
  }
  result.leftovers.push(...leftovers);
  if (leftovers.length) {
    console.warn(
      `[sync] Routing no longer sends these ${how.kind} graphs to the dataset that holds them, and ` +
        `the sync drops such graphs only in the default dataset: ` +
        leftovers.map((l) => `<${l.graph}> (${l.package}) in ${l.dataset}`).join('; ') +
        '. Drop them by hand once no other app reads them there.',
    );
  }
}
