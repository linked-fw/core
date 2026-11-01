/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The shapeless delete, `Shape.delete(ids)` on the base class: the builder and its refusals, the
 * IR, DSL-JSON 1.3, the SPARQL a store sends (every named graph and the default graph),
 * `supports`, `LinkedStorage`'s fan-out and the live effects.
 */
import {afterEach, describe, expect, jest, test} from '@jest/globals';
import {Person} from '../test-helpers/query-fixtures';
import {Shape} from '../shapes/Shape';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {lower} from '../queries/lower';
import {lowerMutationJSON} from '../queries/lowerMutationJSON';
import {fromJSON} from '../queries/fromJSON';
import {WIRE_VERSION} from '../queries/wireVersion';
import {mutationEffects} from '../queries/queryDependencies';
import {LiveQueryStore} from '../live/LiveQueryStore';
import {ShapeCatalog} from '../utils/ShapeCatalog';
import {toWire} from '../shapes/nodeShapeWire';
import {SparqlDataset} from '../sparql/SparqlDataset';
import {deleteShapelessToSparql} from '../sparql/irToAlgebra';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {setShapeGraphs} from '../utils/graphRouting';
import {LinkedStorage} from '../utils/LinkedStorage';
import {resetFanOutNotices} from '../utils/fanOutNotice';
import {graphs} from '../ontologies/graphs';
import type {IDataset} from '../interfaces/IDataset';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery';

const G_PEOPLE = 'https://acme.example/data/graph/people';
const A = 'https://acme.example/data/a';
const B = 'https://acme.example/data/b';

const jena = (iri: string) =>
  iri === graphs.default ? 'urn:x-arq:DefaultGraph' : iri === graphs.union ? 'urn:x-arq:UnionGraph' : null;

/** A SPARQL store that records its updates. */
class CaptureStore extends SparqlDataset {
  updates: string[] = [];
  constructor(options: SparqlOptions = {mapGraphName: jena}) {
    super(options);
  }
  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

/** A store routing Person to G_PEOPLE. */
function routedStore(): CaptureStore {
  const store = new CaptureStore();
  setShapeGraphs(store, {[Person.shape.id]: G_PEOPLE});
  return store;
}

const oneLine = (sparql: string) => sparql.replace(/\s+/g, ' ').trim();

describe('the builder', () => {
  test('Shape.delete(ids) on the base class is shapeless; a subclass stays typed', () => {
    const shapeless = Shape.delete([{id: A}, B]);
    expect(shapeless.isShapeless).toBe(true);
    expect(shapeless.shape).toBeUndefined();
    expect(shapeless.requiredFeatures()).toEqual(['shapelessDelete']);
    const typed: DeleteBuilder<Person> = Person.delete({id: A});
    expect(typed.isShapeless).toBe(false);
    expect(typed.shape?.id).toBe(Person.shape.id);
    expect(typed.requiredFeatures()).toEqual([]);
  });

  test('lowers to delete_shapeless with its ids; keepIncoming rides along', () => {
    expect(lower(Shape.delete([{id: A}, B]))).toEqual({kind: 'delete_shapeless', ids: [{id: A}, {id: B}]});
    expect(lower(Shape.delete(A)._keepingIncoming())).toEqual({kind: 'delete_shapeless', ids: [{id: A}], keepIncoming: true});
  });

  test('refuses where, all, into, no ids and ids that are not absolute IRIs', () => {
    expect(() => Shape.delete([])).toThrow(/at least one id/);
    expect(() => (Shape.delete(A) as DeleteBuilder<any>).where(() => true as any)).toThrow(/shapeless/);
    expect(() => (Shape.delete(A) as DeleteBuilder<any>).all()).toThrow(/shapeless/);
    expect(() => Shape.delete(A).into(G_PEOPLE)).toThrow(/shapeless/);
    expect(() => lower(Shape.delete({id: 'not an iri'}))).toThrow(/absolute IRIs/);
    expect(() => lower(Shape.delete({id: '_:b0'}))).toThrow(/absolute IRIs/);
  });
});

describe('DSL-JSON', () => {
  test('1.3: mode shapeless, no shape; round-trips through fromJSON and lowerMutationJSON', () => {
    const json = Shape.delete([A, {id: B}])._keepingIncoming().toJSON();
    expect(json).toEqual({v: WIRE_VERSION, op: 'delete', mode: 'shapeless', ids: [A, B], keepIncoming: true});
    const back = fromJSON(json) as DeleteBuilder;
    expect(back.isShapeless).toBe(true);
    expect(lower(back)).toEqual(lower(Shape.delete([A, B])._keepingIncoming()));
    expect(lowerMutationJSON(json)).toEqual(lower(back));
  });

  test('a reader refuses a shape on it, no ids, a non-IRI, and keepIncoming when told to', () => {
    const base = {v: '1.3', op: 'delete', mode: 'shapeless'} as const;
    expect(() => DeleteBuilder.fromJSON({...base, ids: [A], shape: Person.shape.id} as any)).toThrow(/names no shape/);
    expect(() => lowerMutationJSON({...base, ids: [A], shape: Person.shape.id} as any)).toThrow(/names no shape/);
    expect(() => DeleteBuilder.fromJSON({...base, ids: []})).toThrow(/non-empty/);
    expect(() => lowerMutationJSON({...base, ids: ['a b']})).toThrow(/absolute IRIs/);
    expect(() => DeleteBuilder.fromJSON({...base, ids: [A], keepIncoming: true}, {refuseKeepIncoming: true})).toThrow(/refused/);
  });
});

describe('SPARQL', () => {
  test('every graph: own triples and incoming links in each named graph and in the default graph', async () => {
    const store = routedStore();
    const answer = await Shape.delete([A, B]).exec(store);
    expect(answer).toEqual({deleted: [{id: A}, {id: B}], count: 2});
    expect(store.updates).toHaveLength(1);
    const sparql = oneLine(store.updates[0]);
    expect(sparql).toContain('VALUES ?x_del {');
    expect(sparql).toContain(`<${A}> <${B}>`);
    // The default graph: no GRAPH around it, its own variables.
    expect(sparql).toMatch(/DELETE \{ \?x_del \?pd_del \?od_del \. \?sd_del \?p2d_del \?x_del \. GRAPH \?g_del \{ \?x_del \?p_del \?o_del \. \?s_del \?p2_del \?x_del \. \} \}/);
    expect(sparql).toMatch(/\{ \?x_del \?pd_del \?od_del \. \} UNION \{ \?sd_del \?p2d_del \?x_del \. \}/);
    // Every named graph: GRAPH ?g_del is not bound by VALUES.
    expect(sparql).toMatch(/GRAPH \?g_del \{ \{ \?x_del \?p_del \?o_del \. \} UNION \{ \?s_del \?p2_del \?x_del \. \} \}/);
    expect(sparql).not.toContain('VALUES ?g_del');
    // Structure stays: the registry and the graphs it records as shapes or ontology graphs.
    expect(sparql).toContain(`FILTER(?g_del NOT IN (<${graphs.registry}>))`);
    expect(sparql).toContain(
      `FILTER(NOT EXISTS { VALUES ?structure_del { core:ShapesGraph core:OntologyGraph } GRAPH <${graphs.registry}> { ?g_del rdf:type ?structure_del . } })`,
    );
    expect(sparql).not.toContain(G_PEOPLE);
    expect(sparql).not.toContain('urn:x-arq');
  });

  test('keepIncoming deletes only the subjects own triples, in every graph', async () => {
    const store = routedStore();
    await Shape.delete(A)._keepingIncoming().exec(store);
    const sparql = oneLine(store.updates[0]);
    expect(sparql).not.toContain('?s_del');
    expect(sparql).not.toContain('?sd_del');
    expect(sparql).toContain('?x_del ?pd_del ?od_del');
    expect(sparql).toContain('GRAPH ?g_del { ?x_del ?p_del ?o_del . }');
  });

  test('a store without routing deletes the same way, and so does one with no name for the default graph', async () => {
    for (const store of [new CaptureStore(), new CaptureStore({})]) {
      await Shape.delete(A).exec(store);
      expect(oneLine(store.updates[0])).toBe(oneLine(deleteShapelessToSparql({kind: 'delete_shapeless', ids: [{id: A}]})));
    }
  });
});

describe('supports and LinkedStorage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetFanOutNotices();
  });

  /** A dataset that answers deletes and may declare features. */
  const stub = (supports?: readonly string[]) => {
    const seen: DeleteQuery[] = [];
    const dataset = {
      ...(supports ? {supports} : {}),
      selectQuery: async () => [],
      createQuery: async () => ({}),
      updateQuery: async () => ({}),
      deleteQuery: async (q: DeleteQuery): Promise<DeleteResponse> => {
        seen.push(q);
        return {deleted: [{id: A}], count: 1};
      },
    } as unknown as IDataset;
    return {dataset, seen};
  };

  test('a target that does not declare shapelessDelete is refused before it is sent', async () => {
    const {dataset, seen} = stub();
    await expect(Shape.delete(A).exec(dataset)).rejects.toThrow(/shapelessDelete/);
    expect(seen).toEqual([]);
    const typed = stub();
    await Person.delete(A).exec(typed.dataset);
    expect(typed.seen).toHaveLength(1);
  });

  test('LinkedStorage sends it to its one dataset, and refuses it when it knows several', async () => {
    const one = stub(['shapelessDelete']);
    LinkedStorage.setDefaultDataset(one.dataset);
    expect(await Shape.delete(A)).toEqual({deleted: [{id: A}], count: 1});
    expect(one.seen).toHaveLength(1);

    const two = stub(['shapelessDelete']);
    LinkedStorage.setDatasetForShapes(two.dataset, [Person]);
    try {
      await expect(Shape.delete(A).exec()).rejects.toThrow(/Name the dataset/);
      expect(one.seen).toHaveLength(1);
      expect(two.seen).toEqual([]);
    } finally {
      LinkedStorage.unsetDatasetForShape(Person);
    }

    const old = stub();
    LinkedStorage.setDefaultDataset(old.dataset);
    await expect(Shape.delete(A).exec()).rejects.toThrow(/shapelessDelete/);
    expect(old.seen).toEqual([]);
  });
});

describe('live effects', () => {
  test('the ids, and every shape as membership (any instance or link may be gone)', () => {
    const effects = mutationEffects(Shape.delete([A, B]));
    expect(effects.op).toBe('delete');
    expect(effects.shape).toBe('');
    expect([...(effects.ids ?? [])]).toEqual([A, B]);
    expect(effects.membership.has(Person.shape.id)).toBe(true);
  });

  test("effects sent as data reach each catalog with that catalog's shapes as membership", () => {
    const store = new LiveQueryStore();
    const catalog = ShapeCatalog.from([toWire(Person.shape)], {name: 'shapeless-live'});
    (store as any)._catalogTemplates.set(catalog, 1);
    const effects = {op: 'delete' as const, shape: '', props: new Set<string>(), ids: new Set([A]), membership: new Set<string>()};
    const decoded: Array<[ShapeCatalog | undefined, any]> = (store as any)._decodePerCatalog({effects});
    const inCatalog = decoded.find(([c]) => c === catalog);
    expect(inCatalog?.[1].membership.has(Person.shape.id)).toBe(true);
  });
});
