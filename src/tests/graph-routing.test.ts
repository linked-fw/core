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
import {Dog, Employee, Person, Pet} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {countToSparql, selectToSparql} from '../sparql/irToAlgebra';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlCompileOptions, SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {NamedGraph} from '../shapes/NamedGraph';
import {GRAlbum, GRPanorama, GRPhoto} from '../test-helpers/graph-routing-fixtures';
import {CreateBuilder} from '../queries/CreateBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {fromJSON} from '../queries/fromJSON';
import {isGraphQueryError} from '../queries/graphQuery';
import {mutationEffects, queryDependencies, type MutationEffects, type QueryDependencies} from '../queries/queryDependencies';
import {effectsHash, normalizeChange} from '../live/changes';
import {readsWrittenGraph, selectInstances, type LiveIndexes} from '../live/matcher';
import type {Instance, Template} from '../live/LiveQueryStore';
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
const G_PETS = 'https://acme.example/data/graph/pets';
const P = 'https://example.org/props/';
const T = 'https://example.org/types/';

/** Jena's names for the portable default and union graphs, as `FusekiStore` maps them. */
const jena = (iri: string) =>
  iri === graphs.default ? 'urn:x-arq:DefaultGraph' : iri === graphs.union ? 'urn:x-arq:UnionGraph' : null;

/** Compile options with the routing of a fresh dataset routed by `shapeGraphs`. */
function routed(shapeGraphs: Record<string, string>, options: SparqlOptions = {mapGraphName: jena}): SparqlCompileOptions {
  const ds = fakeDataset();
  setShapeGraphs(ds, shapeGraphs);
  return {...options, routing: graphRoutingFor(ds)};
}

/** A SPARQL store that records what it is sent and answers empty results. */
class CaptureStore extends SparqlDataset {
  selects: string[] = [];
  updates: string[] = [];
  namedGraphUris: string[][] = [];
  constructor(options?: SparqlOptions, private readonly sendsNamedGraphs = false) {
    super(options);
  }
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    this.selects.push(sparql);
    if (sparql.includes('COUNT(')) {
      return {
        head: {vars: ['count']},
        results: {bindings: [{count: {type: 'literal', value: '0', datatype: 'http://www.w3.org/2001/XMLSchema#integer'}}]},
      };
    }
    if (/^(PREFIX[^\n]*\n)*ASK/m.test(sparql) && !sparql.includes('SELECT')) return {head: {}, boolean: false};
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
  protected override executeSparqlSelectWithNamedGraphs(sparql: string, namedGraphs: string[]) {
    if (!this.sendsNamedGraphs) return super.executeSparqlSelectWithNamedGraphs(sparql, namedGraphs);
    this.namedGraphUris.push(namedGraphs);
    return this.executeSparqlSelect(sparql);
  }
  last(): string {
    return this.selects[this.selects.length - 1];
  }
}

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

describe('routed reads: golden SPARQL per form', () => {
  const personAndFriend = () => Person.select((p) => [p.name, p.bestFriend.name]);

  test('no routes, or routes that miss every subject: the query is unchanged', () => {
    const plain = selectToSparql(lower(personAndFriend()));
    expect(selectToSparql(lower(personAndFriend()), {mapGraphName: jena})).toBe(plain);
    expect(selectToSparql(lower(personAndFriend()), routed({[Pet.shape.id]: G_PETS}))).toBe(plain);
  });

  test('every subject in one graph: GRAPH <g> around the whole pattern, no FROM NAMED', () => {
    expect(selectToSparql(lower(personAndFriend()), routed({[Person.shape.id]: G_PEOPLE}))).toBe(
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name ?a1_name ?a1
WHERE {
  GRAPH <${G_PEOPLE}> {
    ?a0 rdf:type <${T}Person> .
    OPTIONAL {
      ?a0 <${P}bestFriend> ?a1 .
      OPTIONAL {
        ?a1 <${P}name> ?a1_name .
      }
    }
    OPTIONAL {
      ?a0 <${P}name> ?a0_name .
    }
  }
}`,
    );
  });

  test('a sub-shape in another graph: FROM NAMED both, one GRAPH ?g block per subject', () => {
    expect(
      selectToSparql(lower(personAndFriend()), routed({[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF})),
    ).toBe(
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name ?a1_name ?a1
FROM NAMED <${G_PEOPLE}>
FROM NAMED <${G_STAFF}>
WHERE {
  GRAPH ?g_a0 {
    ?a0 rdf:type <${T}Person> .
  }
  OPTIONAL {
    GRAPH ?g_a0 {
      ?a0 <${P}bestFriend> ?a1 .
    }
    OPTIONAL {
      GRAPH ?g_a1 {
        ?a1 <${P}name> ?a1_name .
      }
    }
  }
  OPTIONAL {
    GRAPH ?g_a0 {
      ?a0 <${P}name> ?a0_name .
    }
  }
}`,
    );
  });

  test('subjects in different graphs: a fixed GRAPH <g> per one-graph subject under FROM NAMED', () => {
    const sparql = selectToSparql(
      lower(Person.select((p) => [p.name, p.pets.bestFriend])),
      routed({[Person.shape.id]: G_PEOPLE, [Pet.shape.id]: G_PETS}),
    );
    expect(sparql).toContain(`FROM NAMED <${G_PEOPLE}>\nFROM NAMED <${G_PETS}>`);
    expect(sparql).toContain(`GRAPH <${G_PEOPLE}> {\n    ?a0 rdf:type <${T}Person> .`);
    expect(sparql).toContain(`GRAPH <${G_PETS}> {\n        ?a1 <${P}bestFriend> ?a1_bestFriend .`);
    expect(sparql).not.toContain('VALUES');
  });

  test('a type-checked subject whose set is narrower than the others: VALUES, written once', () => {
    // Every subject reads the whole union: no VALUES.
    expect(
      selectToSparql(lower(Person.select((p) => p.name)), routed({[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF})),
    ).not.toContain('VALUES');
    // Person reads people + staff, its pets the pets graph: the root's set is narrower than the
    // union, and it carries a type check.
    const join = selectToSparql(
      lower(Person.select((p) => [p.name, p.pets.bestFriend])),
      routed({[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF, [Pet.shape.id]: G_PETS}),
    );
    expect(join).toContain(`FROM NAMED <${G_PEOPLE}>\nFROM NAMED <${G_PETS}>\nFROM NAMED <${G_STAFF}>`);
    expect(join.match(/VALUES \?g_a0/g)).toHaveLength(1);
    expect(join).toContain(`VALUES ?g_a0 { <${G_PEOPLE}> <${G_STAFF}> }\n  GRAPH ?g_a0 {`);
    // The pets subject has one graph: fixed, no VALUES.
    expect(join).toContain(`GRAPH <${G_PETS}> {`);
  });

  test('the default graph with named graphs: no FROM NAMED, VALUES with the store name, plain triples for default-only subjects', () => {
    const sparql = selectToSparql(
      lower(Person.select((p) => [p.name, p.pets.bestFriend])),
      routed({[Employee.shape.id]: G_STAFF}),
    );
    expect(sparql).not.toContain('FROM NAMED');
    expect(sparql).toContain(`VALUES ?g_a0 { <urn:x-arq:DefaultGraph> <${G_STAFF}> }\n  GRAPH ?g_a0 {`);
    // Pet is unrouted: plain triples, the store's default graph.
    expect(sparql).toContain(`OPTIONAL {\n      ?a1 <${P}bestFriend> ?a1_bestFriend .\n    }`);
  });

  test('the default graph with named graphs needs a store name for it', () => {
    expect(() =>
      selectToSparql(lower(Person.select((p) => p.name)), routed({[Employee.shape.id]: G_STAFF}, {})),
    ).toThrow(/mapGraphName/);
  });

  test('count and ask carry the routed scope', async () => {
    const options = routed({[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF});
    const count = countToSparql(lower(Person.select((p) => p.name).where((p) => p.bestFriend.name.equals('x')).toCount()), options);
    expect(count).toContain(`FROM NAMED <${G_PEOPLE}>`);
    expect(count).toContain('GRAPH ?g_a1 {');
    const store = new CaptureStore({mapGraphName: jena});
    setShapeGraphs(store, {[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF});
    await Person.select().where((p) => p.name.equals('x')).exists(store);
    expect(store.last()).toMatch(/^ASK\nFROM NAMED/m);
  });

  test('.from() overrides routing; the graph-record shapes keep their graph', () => {
    const options = routed({[Person.shape.id]: G_PEOPLE});
    const sparql = selectToSparql(lower(personAndFriend().from(G_PETS)), options);
    expect(sparql).toContain(`GRAPH <${G_PETS}> {`);
    expect(sparql).not.toContain(G_PEOPLE);
    expect(selectToSparql(lower(NamedGraph.select((g) => g.contentHash)), options)).toContain(
      `GRAPH <${graphs.registry}> {`,
    );
  });
});

describe('routed reads through the store', () => {
  test('a store reads with its own routes; .from(graphs.default) reads the default graph only', async () => {
    const store = new CaptureStore({mapGraphName: jena});
    await Person.select((p) => p.name).exec(store);
    const unrouted = store.last();
    setShapeGraphs(store, {[Person.shape.id]: G_PEOPLE});
    await Person.select((p) => p.name).exec(store);
    expect(store.last()).toContain(`GRAPH <${G_PEOPLE}> {`);
    await Person.select((p) => p.name).from(graphs.default).exec(store);
    expect(store.last()).toBe(unrouted);
    await Person.select().toCount().exec(store);
    expect(store.last()).toContain(`GRAPH <${G_PEOPLE}> {`);
  });

  test('a shapeless ask under routing looks in every routed graph and the default graph', async () => {
    const store = new CaptureStore({mapGraphName: jena});
    setShapeGraphs(store, {[Person.shape.id]: G_PEOPLE, [Pet.shape.id]: G_PETS});
    const {AskBuilder} = await import('../queries/AskBuilder');
    await AskBuilder.forNode('https://e.org/x').exec(store);
    expect(store.last()).toContain(
      `VALUES ?g_s0 { <urn:x-arq:DefaultGraph> <${G_PEOPLE}> <${G_PETS}> }`,
    );
  });

  test('namedGraphUriParameter: the set goes to the transport, not into the query text', async () => {
    const store = new CaptureStore({mapGraphName: jena, namedGraphUriParameter: true}, true);
    setShapeGraphs(store, {[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF});
    await Person.select((p) => p.name).exec(store);
    expect(store.last()).not.toContain('FROM NAMED');
    expect(store.last()).toContain('GRAPH ?g_a0 {');
    expect(store.namedGraphUris).toEqual([[G_PEOPLE, G_STAFF]]);
    // A one-graph read needs no dataset: sent as usual.
    setShapeGraphs(store, {[Employee.shape.id]: G_PEOPLE});
    await Person.select((p) => p.name).exec(store);
    expect(store.namedGraphUris).toHaveLength(1);
  });

  test('namedGraphUriParameter on a transport that does not send them is refused, never read unrestricted', async () => {
    const store = new CaptureStore({mapGraphName: jena, namedGraphUriParameter: true});
    setShapeGraphs(store, {[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF});
    await expect(Person.select((p) => p.name).exec(store)).rejects.toThrow(/named-graph-uri/);
    expect(store.selects).toEqual([]);
  });
});

describe('routed writes', () => {
  const G_ALBUMS = 'https://acme.example/data/graph/albums';
  const G_PANORAMAS = 'https://acme.example/data/graph/panoramas';
  const ALBUM = 'https://acme.example/data/album/1';

  /** A store with albums (and their owned photos) routed to the albums graph, panoramas elsewhere. */
  const routedStore = () => {
    const store = new CaptureStore({mapGraphName: jena});
    setShapeGraphs(store, {[GRAlbum.shape.id]: G_ALBUMS, [GRPanorama.shape.id]: G_PANORAMAS});
    return store;
  };
  const lastUpdate = (store: CaptureStore) => store.updates[store.updates.length - 1];

  test('create, update, upsert and every delete write in the routed graph', async () => {
    const store = routedStore();
    await GRAlbum.create({title: 'A'}).exec(store);
    expect(lastUpdate(store)).toMatch(new RegExp(`^INSERT DATA \\{\\n  GRAPH <${G_ALBUMS}> \\{`, 'm'));
    await GRAlbum.update({title: 'B'}).for({id: ALBUM}).exec(store);
    expect(lastUpdate(store)).toMatch(new RegExp(`^WITH <${G_ALBUMS}>\\nDELETE`, 'm'));
    await GRAlbum.upsert({title: 'C'}).for({id: ALBUM}).exec(store);
    expect(lastUpdate(store)).toContain(`WITH <${G_ALBUMS}>`);
    await UpdateBuilder.from(GRAlbum).set({title: 'D'}).forAll().exec(store);
    expect(lastUpdate(store)).toContain(`WITH <${G_ALBUMS}>`);
    await GRAlbum.delete({id: ALBUM}).exec(store);
    expect(lastUpdate(store)).toContain(`WITH <${G_ALBUMS}>`);
    await DeleteBuilder.from(GRAlbum).all().exec(store);
    expect(lastUpdate(store)).toContain(`WITH <${G_ALBUMS}>`);
    await DeleteBuilder.from(GRAlbum).where((a) => a.title.equals('x')).exec(store);
    expect(lastUpdate(store)).toContain(`WITH <${G_ALBUMS}>`);
  });

  test('an unrouted shape, and a store without routes, write the default graph exactly as before', async () => {
    const plain = new CaptureStore({mapGraphName: jena});
    const store = routedStore();
    for (const s of [plain, store]) await Person.update({name: 'x'}).for({id: ALBUM}).exec(s);
    expect(lastUpdate(store)).toBe(lastUpdate(plain));
    expect(lastUpdate(store)).not.toContain('WITH');
    expect(lastUpdate(store)).not.toContain('GRAPH');
  });

  test('a sub-shape without a route writes its super-shape graph; a routed one its own', async () => {
    const store = new CaptureStore({mapGraphName: jena});
    setShapeGraphs(store, {[GRPhoto.shape.id]: G_ALBUMS, [GRPanorama.shape.id]: G_PANORAMAS});
    await GRPanorama.create({caption: 'wide'}).exec(store);
    expect(lastUpdate(store)).toContain(`GRAPH <${G_PANORAMAS}> {`);
    setShapeGraphs(store, {[GRPanorama.shape.id]: graphs.default});
    await GRPanorama.create({caption: 'wide'}).exec(store);
    expect(lastUpdate(store)).toContain(`GRAPH <${G_ALBUMS}> {`);
  });

  test('a nested (owned) create goes into the owner graph; the owned-link check reads that graph', async () => {
    const store = routedStore();
    await GRAlbum.create({title: 'A', cover: {caption: 'front'}}).exec(store);
    const insert = lastUpdate(store);
    expect(insert.match(/GRAPH </g)).toHaveLength(1);
    expect(insert).toContain(`${GR('caption')}> "front"`);
    await GRAlbum.update({cover: {id: 'https://acme.example/data/photo/9'}}).for({id: ALBUM}).exec(store);
    const check = store.selects.find((q) => q.startsWith('SELECT ?id ?type'));
    expect(check).toBe(
      `SELECT ?id ?type WHERE { VALUES ?id { <https://acme.example/data/photo/9> } GRAPH <${G_ALBUMS}> { ?id <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?type } }`,
    );
  });

  test('.into() a graph the routing allows for the shape (its read set)', async () => {
    const store = new CaptureStore({mapGraphName: jena});
    setShapeGraphs(store, {[GRPhoto.shape.id]: G_ALBUMS, [GRPanorama.shape.id]: G_PANORAMAS});
    // A photo's routed reads cover its own graph and its sub-shape's.
    await GRPhoto.create({caption: 'x'}).into(G_PANORAMAS).exec(store);
    expect(lastUpdate(store)).toContain(`GRAPH <${G_PANORAMAS}> {`);
    await GRPhoto.update({caption: 'y'}).for({id: ALBUM}).into(G_PANORAMAS).exec(store);
    expect(lastUpdate(store)).toContain(`WITH <${G_PANORAMAS}>`);
    await GRPhoto.delete({id: ALBUM}).into(G_ALBUMS).exec(store);
    expect(lastUpdate(store)).toContain(`WITH <${G_ALBUMS}>`);
    // Kept through later fluent calls.
    await CreateBuilder.from(GRPhoto).into(G_PANORAMAS).set({caption: 'z'}).exec(store);
    expect(lastUpdate(store)).toContain(`GRAPH <${G_PANORAMAS}> {`);
  });

  test('.into() a graph the routing forbids, a portable name, the registry or a store name is refused before any write', async () => {
    const store = routedStore();
    const refusal = async (p: Promise<unknown>, code: string) => {
      const err = await p.then(
        () => undefined,
        (e: unknown) => e,
      );
      const cause = (err as {cause?: unknown})?.cause ?? err;
      expect(isGraphQueryError(cause, code as never)).toBe(true);
    };
    await refusal(GRAlbum.create({title: 'x'}).into(G_PANORAMAS).exec(store), 'graph-not-routed');
    await refusal(Person.create({name: 'x'}).into(G_ALBUMS).exec(store), 'graph-not-routed');
    await refusal(GRAlbum.create({title: 'x'}).into(graphs.allOntologies).exec(store), 'graph-name-read-only');
    await refusal(GRAlbum.create({title: 'x'}).into(graphs.registry).exec(store), 'graph-name-read-only');
    await refusal(GRAlbum.create({title: 'x'}).into('urn:x-arq:UnionGraph').exec(store), 'graph-name-read-only');
    expect(store.updates).toEqual([]);
    // The default graph is allowed where the shape reads it.
    await Person.create({name: 'x'}).into(graphs.default).exec(store);
    expect(lastUpdate(store)).not.toContain('GRAPH');
  });

  test('DSL-JSON never carries a write graph; a received one is ignored and the receiver routes', async () => {
    const builder = GRAlbum.update({title: 'x'}).for({id: ALBUM}).into(G_PANORAMAS);
    const json = builder.toJSON();
    expect(JSON.stringify(json)).not.toContain(G_PANORAMAS);
    expect(JSON.stringify(GRAlbum.create({title: 'x'}).into(G_PANORAMAS).toJSON())).not.toContain(G_PANORAMAS);
    expect(JSON.stringify(GRAlbum.delete({id: ALBUM}).into(G_PANORAMAS).toJSON())).not.toContain(G_PANORAMAS);
    const forged = {...json, graph: G_PANORAMAS, into: G_PANORAMAS};
    const store = routedStore();
    await (fromJSON(forged as never) as UpdateBuilder).exec(store);
    expect(lastUpdate(store)).toContain(`WITH <${G_ALBUMS}>`);
    expect(lastUpdate(store)).not.toContain(G_PANORAMAS);
  });
});

function GR(local: string): string {
  return `https://example.org/graph-routing/${local}`;
}

describe('live queries carry graphs', () => {
  const G_ALBUMS = 'https://acme.example/data/graph/albums';
  const G_PANORAMAS = 'https://acme.example/data/graph/panoramas';
  const pinned: Function[] = [];
  afterEach(() => {
    for (const shape of pinned.splice(0)) LinkedStorage.unsetDatasetForShape(shape);
  });
  const routeAlbums = () => {
    const ds = fakeDataset();
    pinned.push(GRAlbum, GRPhoto);
    LinkedStorage.setDatasetForShapes(ds, [GRAlbum], {graph: G_ALBUMS});
    LinkedStorage.setDatasetForShapes(ds, [GRPhoto]);
    setShapeGraphs(ds, {[GRPanorama.shape.id]: G_PANORAMAS});
    return ds;
  };

  test('dependencies: the .from() names, else the routed read sets of every shape read, else unknown', () => {
    expect(queryDependencies(GRAlbum.select((a) => a.title)).graphs).toBeUndefined();
    expect([...queryDependencies(GRAlbum.select((a) => a.title).from([G_PANORAMAS, graphs.default])).graphs!]).toEqual([
      G_PANORAMAS,
      graphs.default,
    ]);
    routeAlbums();
    expect([...queryDependencies(GRAlbum.select((a) => a.title)).graphs!]).toEqual([G_ALBUMS]);
    expect([...queryDependencies(GRAlbum.select((a) => a.cover.caption)).graphs!].sort()).toEqual(
      [G_ALBUMS, G_PANORAMAS, graphs.default].sort(),
    );
  });

  test('effects: the .into() graph, else the routed graph, else unknown', () => {
    expect(mutationEffects(GRAlbum.create({title: 'x'})).graph).toBeUndefined();
    expect(mutationEffects(GRAlbum.create({title: 'x'}).into(G_ALBUMS)).graph).toBe(G_ALBUMS);
    routeAlbums();
    expect(mutationEffects(GRAlbum.update({title: 'x'}).for({id: 'https://e.org/a'})).graph).toBe(G_ALBUMS);
    expect(mutationEffects(GRPanorama.delete({id: 'https://e.org/p'})).graph).toBe(G_PANORAMAS);
    expect(mutationEffects(GRPhoto.create({caption: 'x'})).graph).toBe(graphs.default);
  });

  test('the graph survives JSON transport and is part of the fold hash', () => {
    const e: MutationEffects = {op: 'create', shape: GRAlbum.shape.id, props: new Set(['p']), ids: new Set(['i']), membership: new Set(), graph: G_ALBUMS};
    const revived = normalizeChange({effects: JSON.parse(JSON.stringify({...e, props: [...e.props], ids: [...e.ids!], membership: []}))});
    expect(revived.graph).toBe(G_ALBUMS);
    expect(effectsHash(e)).not.toBe(effectsHash({...e, graph: G_PANORAMAS}));
    expect(effectsHash(e)).not.toBe(effectsHash({...e, graph: undefined}));
  });

  test('readsWrittenGraph: unknown on either side or a store-resolved name reads any graph', () => {
    expect(readsWrittenGraph(undefined, G_ALBUMS)).toBe(true);
    expect(readsWrittenGraph(new Set([G_ALBUMS]), undefined)).toBe(true);
    expect(readsWrittenGraph(new Set([G_ALBUMS]), G_ALBUMS)).toBe(true);
    expect(readsWrittenGraph(new Set([G_ALBUMS]), G_PANORAMAS)).toBe(false);
    expect(readsWrittenGraph(new Set([graphs.allShapes]), G_PANORAMAS)).toBe(true);
  });

  test('the matcher skips a template that does not read the written graph', () => {
    const template = (graphsRead?: string[]): Template => {
      const t = {key: String(graphsRead), kind: 'select', reactive: true, pinned: false, json: {}, instances: new Map()} as unknown as Template;
      const inst = {key: 'i', template: t, params: {}, ids: new Set(['https://e.org/a'])} as unknown as Instance;
      (t as unknown as {instances: Map<string, Instance>}).instances.set('i', inst);
      return t;
    };
    const albums = template([G_ALBUMS]);
    const panoramas = template([G_PANORAMAS]);
    const unknown = template(undefined);
    const deps = (t: Template): QueryDependencies => ({
      narrow: new Set(['title']),
      filter: new Set(),
      hidden: new Set(),
      shapes: new Set([GRAlbum.shape.id]),
      unbound: true,
      ...(t === unknown ? {} : {graphs: new Set(t === albums ? [G_ALBUMS] : [G_PANORAMAS])}),
    });
    const all = [albums, panoramas, unknown];
    const index: LiveIndexes = {
      templatesByProp: new Map([['title', new Set(all)]]),
      templatesByShape: new Map([[GRAlbum.shape.id, new Set(all)]]),
      instancesById: new Map([['https://e.org/a', new Set(all.map((t) => [...(t as unknown as {instances: Map<string, Instance>}).instances.values()][0]))]]),
      depsOf: deps,
    };
    const hit = (e: MutationEffects) => [...selectInstances(index, e)].map((i) => i.template);
    const update: MutationEffects = {op: 'update', shape: GRAlbum.shape.id, props: new Set(['title']), ids: new Set(['https://e.org/a']), membership: new Set(), graph: G_ALBUMS};
    expect(new Set(hit(update))).toEqual(new Set([albums, unknown]));
    const create: MutationEffects = {op: 'create', shape: GRAlbum.shape.id, props: new Set(['title']), ids: new Set(), membership: new Set([GRAlbum.shape.id]), graph: G_PANORAMAS};
    expect(new Set(hit(create))).toEqual(new Set([panoramas, unknown]));
    const anywhere: MutationEffects = {...update, graph: undefined};
    expect(hit(anywhere)).toHaveLength(3);
  });
});
