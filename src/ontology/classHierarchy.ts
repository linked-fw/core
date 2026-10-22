/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The class hierarchy in memory: a synchronous answer to "which classes is C a subclass of" and
 * "which classes are subclasses of C", for code that cannot wait for the store.
 *
 * Two sources, unioned:
 * - **the shape tree**, always: a shape targeting C that extends a shape targeting D gives
 *   `C ⊑ D`. Shapes are registered in every runtime, so a browser has these edges too.
 * - **the ontology data**, once set: the `rdfs:subClassOf` triples of every registered package,
 *   parsed on the server by `loadOntologyHierarchy` (`@_linked/core/ontology/hierarchy`), which
 *   the ontology sync, the shape check and the app's boot call.
 *
 * The shape check requires every shape edge to be stated in the ontology data, so on a server the
 * union is the ontology closure; in a browser it is the shape tree's.
 *
 * Browser-safe: no parser, no I/O.
 *
 * @module @_linked/core/ontology/classHierarchy
 */

import type {HierarchyTriple} from './hierarchy.js';
import {getAllNodeShapes, getSuperShapes, getTargetClassId} from '../utils/ShapeClass.js';
import {RegistryCache} from '../utils/registryCache.js';
import {sharedState} from '../utils/sharedState.js';

/** The ontology triples last set, shared by every copy of core in the process. */
const ontologyState = sharedState('@_linked/core', 'classHierarchy', () => ({
  triples: [] as HierarchyTriple[],
  version: 0,
}));

interface Closure {
  ontologyVersion: number;
  /** class → direct superclasses */
  up: Map<string, Set<string>>;
  /** class → direct subclasses */
  down: Map<string, Set<string>>;
  /** memoized reflexive, transitive walks */
  supers: Map<string, ReadonlySet<string>>;
  subs: Map<string, ReadonlySet<string>>;
}

const addEdge = (closure: Closure, sub: string, sup: string) => {
  if (sub === sup) return;
  let ups = closure.up.get(sub);
  if (!ups) closure.up.set(sub, (ups = new Set()));
  ups.add(sup);
  let downs = closure.down.get(sup);
  if (!downs) closure.down.set(sup, (downs = new Set()));
  downs.add(sub);
};

const buildClosure = (): Closure => {
  const closure: Closure = {
    ontologyVersion: ontologyState.version,
    up: new Map(),
    down: new Map(),
    supers: new Map(),
    subs: new Map(),
  };
  for (const shape of getAllNodeShapes().values()) {
    const cls = getTargetClassId(shape);
    if (!cls) continue;
    const parent = getSuperShapes(shape)[0];
    const parentCls = parent ? getTargetClassId(parent) : undefined;
    if (parentCls) addEdge(closure, cls, parentCls);
  }
  for (const {s, o} of ontologyState.triples ?? []) addEdge(closure, s, o);
  return closure;
};

/** One closure per shape-registry version (and per catalog), rebuilt when the ontology triples change. */
const closureCache = new RegistryCache<'closure', Closure>();

const currentClosure = (): Closure => {
  const map = closureCache.get();
  let closure = map.get('closure');
  if (!closure || closure.ontologyVersion !== ontologyState.version) {
    closure = buildClosure();
    map.set('closure', closure);
  }
  return closure;
};

const walk = (start: string, edges: Map<string, Set<string>>): ReadonlySet<string> => {
  const reached = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const next = stack.pop()!;
    for (const neighbour of edges.get(next) ?? []) {
      if (reached.has(neighbour)) continue;
      reached.add(neighbour);
      stack.push(neighbour);
    }
  }
  return reached;
};

/**
 * Replace the ontology triples of the in-memory hierarchy (the union of every registered
 * package's `rdfs:subClassOf` triples). The shape tree's edges stay. Called by
 * `loadOntologyHierarchy`; a caller with its own triples (a test, a browser that fetched them)
 * may call it directly.
 */
export function setOntologyHierarchy(triples: HierarchyTriple[]): void {
  ontologyState.triples = triples.map(({s, o}) => ({s, o}));
  ontologyState.version = (ontologyState.version ?? 0) + 1;
}

/**
 * A number that changes whenever the ontology triples are set. A cache derived from the closure
 * (the owned walk's) keys on it together with the shape registry's version.
 *
 * @internal
 */
export function ontologyHierarchyVersion(): number {
  return ontologyState.version ?? 0;
}

/**
 * `iri` and every class it is a subclass of, transitively, through the shape tree and the
 * ontology triples set. An unknown IRI gives `{iri}`.
 */
export function superClassesOf(iri: string): ReadonlySet<string> {
  const closure = currentClosure();
  let found = closure.supers.get(iri);
  if (!found) closure.supers.set(iri, (found = walk(iri, closure.up)));
  return found;
}

/**
 * `iri` and every class that is a subclass of it, transitively, through the shape tree and the
 * ontology triples set. An unknown IRI gives `{iri}`.
 */
export function subClassesOf(iri: string): ReadonlySet<string> {
  const closure = currentClosure();
  let found = closure.subs.get(iri);
  if (!found) closure.subs.set(iri, (found = walk(iri, closure.down)));
  return found;
}
