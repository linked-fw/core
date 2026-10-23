/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Graph routing: the per-dataset routes, the datasets config's `graphs` key, routed reads (one
 * golden query per form), routed writes, `.into()`, and the graphs live queries carry.
 */
import {afterEach, describe, expect, test} from '@jest/globals';
import {Employee, Person} from '../test-helpers/query-fixtures';
import {LinkedStorage} from '../utils/LinkedStorage';
import {
  getShapeGraphs,
  graphRoutingFor,
  setShapeGraphs,
  unsetShapeGraph,
} from '../utils/graphRouting';
import {parseDatasetsConfig} from '../utils/parseDatasetsConfig';
import {loadStores} from '../utils/loadStores';
import {graphs} from '../ontologies/graphs';
import type {IDataset} from '../interfaces/IDataset';

import '../ontologies/rdf';
import '../ontologies/xsd';

const G_PEOPLE = 'https://acme.example/data/graph/people';
const G_STAFF = 'https://acme.example/data/graph/staff';

/** A dataset object to key routes by; routing never calls it. */
const fakeDataset = (): IDataset => ({}) as unknown as IDataset;

describe('routes', () => {
  test('a dataset without routes has no routing', () => {
    expect(graphRoutingFor(fakeDataset())).toBeUndefined();
    expect(graphRoutingFor(undefined)).toBeUndefined();
  });

  test('a shape reads its own graph and its sub-shapes graphs; unrouted shapes live in the default graph', () => {
    const ds = fakeDataset();
    setShapeGraphs(ds, {[Employee.shape.id]: G_STAFF});
    const routing = graphRoutingFor(ds)!;
    expect(routing.graphForShape(Employee.shape.id)).toBe(G_STAFF);
    expect(routing.graphForShape(Person.shape.id)).toBe(graphs.default);
    expect(routing.readGraphsForShape(Person.shape.id)).toEqual([graphs.default, G_STAFF]);
    expect(routing.readGraphsForShape(Employee.shape.id)).toEqual([G_STAFF]);
  });

  test('an unrouted sub-shape inherits its super-shape graph', () => {
    const ds = fakeDataset();
    setShapeGraphs(ds, {[Person.shape.id]: G_PEOPLE});
    const routing = graphRoutingFor(ds)!;
    expect(routing.graphForShape(Employee.shape.id)).toBe(G_PEOPLE);
    expect(routing.readGraphsForShape(Person.shape.id)).toEqual([G_PEOPLE]);
  });

  test('routes are per dataset; a route to graphs.default removes it; unset drops it', () => {
    const a = fakeDataset();
    const b = fakeDataset();
    setShapeGraphs(a, {[Person.shape.id]: G_PEOPLE});
    expect(getShapeGraphs(a)).toEqual({[Person.shape.id]: G_PEOPLE});
    expect(getShapeGraphs(b)).toEqual({});
    setShapeGraphs(a, {[Person.shape.id]: graphs.default});
    expect(graphRoutingFor(a)).toBeUndefined();
    setShapeGraphs(a, {[Person.shape.id]: G_PEOPLE});
    unsetShapeGraph(Person.shape.id, a);
    expect(getShapeGraphs(a)).toEqual({});
  });

  test('a route must name a graph IRI, never a portable name or the registry', () => {
    const ds = fakeDataset();
    expect(() => setShapeGraphs(ds, {[Person.shape.id]: 'people'})).toThrow(/absolute graph IRI/);
    expect(() => setShapeGraphs(ds, {[Person.shape.id]: graphs.allOntologies})).toThrow(/portable/);
    expect(() => setShapeGraphs(ds, {[Person.shape.id]: graphs.registry})).toThrow(/portable/);
    expect(() => setShapeGraphs(ds, {'not an iri': G_PEOPLE})).toThrow(/shape IRI/);
    expect(getShapeGraphs(ds)).toEqual({});
  });
});

describe('LinkedStorage.setDatasetForShapes', () => {
  const pinned: Function[] = [];
  afterEach(() => {
    for (const shape of pinned.splice(0)) LinkedStorage.unsetDatasetForShape(shape);
  });

  test('{graph} pins the shapes to the dataset and routes them to the graph', () => {
    const ds = fakeDataset();
    pinned.push(Person, Employee);
    LinkedStorage.setDatasetForShapes(ds, [Person], {graph: G_PEOPLE});
    LinkedStorage.setDatasetForShapes(ds, [Employee], {graph: G_STAFF});
    expect(LinkedStorage.getDatasetForShapeClass(Person)).toBe(ds);
    expect(LinkedStorage.getDatasetForShapeClass(Employee)).toBe(ds);
    expect(getShapeGraphs(ds)).toEqual({[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF});
  });

  test('the variadic form and an array without a graph pin in the default graph', () => {
    const ds = fakeDataset();
    pinned.push(Person, Employee);
    LinkedStorage.setDatasetForShapes(ds, Person);
    LinkedStorage.setDatasetForShapes(ds, [Employee]);
    expect(LinkedStorage.getDatasetForShapeClass(Person)).toBe(ds);
    expect(LinkedStorage.getDatasetForShapeClass(Employee)).toBe(ds);
    expect(getShapeGraphs(ds)).toEqual({});
  });

  test('unsetDatasetForShape drops the graph route with the pin', () => {
    const ds = fakeDataset();
    LinkedStorage.setDatasetForShapes(ds, [Person], {graph: G_PEOPLE});
    LinkedStorage.unsetDatasetForShape(Person);
    expect(getShapeGraphs(ds)).toEqual({});
  });
});

describe('the datasets config graphs key', () => {
  test('parsed, checked and registered for the store loadStores builds', async () => {
    const config = parseDatasetsConfig(
      {
        datasets: {
          appData: {
            store: '@_linked/example/shapes/RoutedStore',
            config: {},
            graphs: {[Person.shape.id]: '${DATA_ROOT}/graph/people'},
          },
        },
      },
      {DATA_ROOT: 'https://acme.example/data'},
    );
    expect(config.datasets.appData.graphs).toEqual({[Person.shape.id]: G_PEOPLE});
    class RoutedStore {
      constructor(readonly config: unknown) {}
    }
    const globals = globalThis as Record<symbol, unknown>;
    const IMPORT_MODULE = Symbol.for('@_linked/core:importModule');
    globals[IMPORT_MODULE] = async () => ({RoutedStore});
    try {
      const stores = await loadStores(config);
      expect(stores.appData).toBeInstanceOf(RoutedStore);
      expect(getShapeGraphs(stores.appData as object)).toEqual({[Person.shape.id]: G_PEOPLE});
    } finally {
      delete globals[IMPORT_MODULE];
    }
  });

  test('a malformed graphs key is refused', () => {
    const entry = (graphsKey: unknown) => ({datasets: {a: {store: 'x', graphs: graphsKey}}});
    expect(() => parseDatasetsConfig(entry([G_PEOPLE]))).toThrow(/"graphs" must be an object/);
    expect(() => parseDatasetsConfig(entry({[Person.shape.id]: 'people'}))).toThrow(/graph IRIs/);
    expect(() => parseDatasetsConfig(entry({person: G_PEOPLE}))).toThrow(/graph IRIs/);
  });
});
