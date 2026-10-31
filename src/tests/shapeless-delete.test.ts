/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The shapeless delete, `Shape.delete(ids)` on the base class: the builder and its refusals, the
 * IR, DSL-JSON 1.3, the SPARQL a routed store sends (its named graphs only, never the default
 * graph), the server-side narrowings, `supports`, `LinkedStorage`'s fan-out and the live effects.
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
import {SparqlDataset} from '../sparql/SparqlDataset';
import {deleteShapelessToSparql} from '../sparql/irToAlgebra';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {setShapeGraphs} from '../utils/graphRouting';
import {LinkedStorage} from '../utils/LinkedStorage';
import {resetFanOutNotices} from '../utils/fanOutNotice';
import {isGraphQueryError} from '../queries/graphQuery';
import {graphs} from '../ontologies/graphs';
import type {IDataset} from '../interfaces/IDataset';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery';

const G_PEOPLE = 'https://acme.example/data/graph/people';
const G_PETS = 'https://acme.example/data/graph/pets';
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

  test('lowers to delete_shapeless with its ids; keepIncoming and the server-side scope ride along', () => {
    expect(lower(Shape.delete([{id: A}, B]))).toMatchObject({kind: 'delete_shapeless', ids: [{id: A}, {id: B}]});
    const ir = lower(Shape.delete(A)._keepingIncoming()._inGraphs([G_PEOPLE])._includingDefaultGraph());
    expect(ir).toMatchObject({kind: 'delete_shapeless', keepIncoming: true, graphs: [G_PEOPLE], includeDefaultGraph: true});
  });

  test('refuses where, all, into, no ids and ids that are not absolute IRIs', () => {
    expect(() => Shape.delete([])).toThrow(/at least one id/);
    expect(() => (Shape.delete(A) as DeleteBuilder<any>).where(() => true as any)).toThrow(/shapeless/);
    expect(() => (Shape.delete(A) as DeleteBuilder<any>).all()).toThrow(/shapeless/);
    expect(() => Shape.delete(A).into(G_PEOPLE)).toThrow(/shapeless/);
    expect(() => lower(Shape.delete({id: 'not an iri'}))).toThrow(/absolute IRIs/);
    expect(() => lower(Shape.delete({id: '_:b0'}))).toThrow(/absolute IRIs/);
    expect(() => Person.delete(A)._inGraphs([G_PEOPLE])).toThrow(/shapeless delete only/);
    expect(() => Person.delete(A)._includingDefaultGraph()).toThrow(/shapeless delete only/);
  });
});

describe('DSL-JSON', () => {
  test('1.3: mode shapeless, no shape; round-trips through fromJSON and lowerMutationJSON', () => {
    const json = Shape.delete([A, {id: B}])._keepingIncoming().toJSON();
    expect(WIRE_VERSION).toBe('1.3');
    expect(json).toEqual({v: '1.3', op: 'delete', mode: 'shapeless', ids: [A, B], keepIncoming: true});
    const back = fromJSON(json) as DeleteBuilder;
    expect(back.isShapeless).toBe(true);
    expect(lower(back)).toEqual(lower(Shape.delete([A, B])._keepingIncoming()));
    expect(lowerMutationJSON(json)).toEqual(lower(back));
  });

  test('the server-side scope is never serialized', () => {
    expect(() => Shape.delete(A)._inGraphs([G_PEOPLE]).toJSON()).toThrow(/server-side only/);
    expect(() => Shape.delete(A)._includingDefaultGraph().toJSON()).toThrow(/server-side only/);
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

describe('SPARQL on a routed store', () => {
  test('one routed graph: own triples and incoming links, never the default graph', async () => {
    const store = routedStore();
    const answer = await Shape.delete([A, B]).exec(store);
    expect(answer).toEqual({deleted: [{id: A}, {id: B}], count: 2});
    expect(store.updates).toHaveLength(1);
    const sparql = oneLine(store.updates[0]);
    expect(sparql).toContain('VALUES ?x_del {');
    expect(sparql).toContain(`<${A}> <${B}>`);
    expect(sparql).toContain(`VALUES ?g_del { <${G_PEOPLE}> }`);
    expect(sparql).toContain('GRAPH ?g_del { ?x_del ?p_del ?o_del . ?s_del ?p2_del ?x_del . }');
    expect(sparql).toMatch(/\{ \?x_del \?p_del \?o_del \. \} UNION \{ \?s_del \?p2_del \?x_del \. \}/);
    expect(sparql).not.toContain('DefaultGraph');
  });

  test('keepIncoming deletes only the subjects own triples', async () => {
    const store = routedStore();
    await Shape.delete(A)._keepingIncoming().exec(store);
    const sparql = oneLine(store.updates[0]);
    expect(sparql).not.toContain('?s_del');
    expect(sparql).not.toContain('UNION');
  });

  test('_includingDefaultGraph adds the store name of the default graph', async () => {
    const store = routedStore();
    await Shape.delete(A)._includingDefaultGraph().exec(store);
    expect(oneLine(store.updates[0])).toContain(`VALUES ?g_del { <urn:x-arq:DefaultGraph> <${G_PEOPLE}> }`);
  });

  test('_inGraphs narrows to routed graphs; any other graph is refused before anything is sent', async () => {
    const store = routedStore();
    await Shape.delete(A)._inGraphs([G_PEOPLE]).exec(store);
    expect(oneLine(store.updates[0])).toContain(`VALUES ?g_del { <${G_PEOPLE}> }`);
    for (const graph of [G_PETS, graphs.default, graphs.union]) {
      const err = await Shape.delete(A)._inGraphs([graph]).exec(store).catch((e) => e);
      expect(isGraphQueryError(err) && err.code).toBe('graph-not-routed');
    }
    expect(store.updates).toHaveLength(1);
  });

  test('a store without routing refuses: it would delete nowhere', async () => {
    const store = new CaptureStore();
    const err = await Shape.delete(A).exec(store).catch((e) => e);
    expect(isGraphQueryError(err) && err.code).toBe('graph-not-routed');
    expect(store.updates).toEqual([]);
  });

  test('the compiler refuses an IR without graphs, and the default graph on a store without a name for it', () => {
    expect(() => deleteShapelessToSparql({kind: 'delete_shapeless', ids: [{id: A}]})).toThrow(/needs the graphs/);
    expect(() =>
      deleteShapelessToSparql({kind: 'delete_shapeless', ids: [{id: A}], graphs: [graphs.default]}),
    ).toThrow(/mapGraphName/);
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

  test('LinkedStorage sends it to every dataset, checks them all first, and notices the fan-out', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const one = stub(['shapelessDelete']);
    const two = stub(['shapelessDelete']);
    LinkedStorage.setDefaultDataset(one.dataset);
    LinkedStorage.setDatasetForShapes(two.dataset, [Person]);
    try {
      const answer = await Shape.delete(A);
      expect(answer).toEqual({deleted: [{id: A}], count: 1});
      expect(one.seen).toHaveLength(1);
      expect(two.seen).toHaveLength(1);
      expect(warn.mock.calls.some(([m]) => String(m).includes('A shapeless delete'))).toBe(true);

      const old = stub();
      LinkedStorage.setDatasetForShapes(old.dataset, [Person]);
      const fresh = stub(['shapelessDelete']);
      LinkedStorage.setDefaultDataset(fresh.dataset);
      await expect(Shape.delete(A).exec()).rejects.toThrow(/shapelessDelete/);
      expect(fresh.seen).toEqual([]);
    } finally {
      LinkedStorage.unsetDatasetForShape(Person);
    }
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
});
