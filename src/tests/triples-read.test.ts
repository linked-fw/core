/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Triples reads: a graph read (`NamedGraph.readContent`) and a subject read
 * (`TriplesBuilder.forNode`) — the builders, the wire check, the SPARQL, the answer's terms, the
 * dispatch and the routing.
 */
import {afterEach, describe, expect, test} from '@jest/globals';
import {TriplesBuilder} from '../queries/TriplesBuilder';
import {isLiteralTerm, parseTriplesQuery, type Triple, type TriplesQuery} from '../queries/triplesQuery';
import {fromJSON} from '../queries/fromJSON';
import {subscribeQueryDispatch, type QueryDispatchEvent} from '../queries/queryDispatch';
import {DraftGraph, NamedGraph, OntologyGraph} from '../shapes/NamedGraph';
import {SparqlDataset} from '../sparql/SparqlDataset';
import {triplesToSparql} from '../sparql/triplesToSparql';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlBinding, SparqlQueryResults} from '../sparql/resultMapping';
import {graphs} from '../ontologies/graphs';
import {rdf} from '../ontologies/rdf';
import {xsd} from '../ontologies/xsd';
import {LinkedStorage} from '../utils/LinkedStorage';
import {setShapeGraphs} from '../utils/graphRouting';
import {invalidateGraphRegistry} from '../utils/graphRegistryCache';
import {Person} from '../test-helpers/query-fixtures';
import type {IDataset} from '../interfaces/IDataset';

const G1 = 'https://example.org/graph/one';
const G2 = 'https://example.org/graph/two';
const S = 'https://example.org/data/s1';
const P = 'https://example.org/ont/p';
const CORE = 'https://linked.cm/ont/core/';
const ONT_A = 'https://linked.cm/pkg/a/graph/ontology';
const ONT_B = 'https://linked.cm/pkg/b/graph/ontology';
const JENA_DEFAULT = 'urn:x-arq:DefaultGraph';
const jena = (iri: string) => (iri === graphs.default ? JENA_DEFAULT : null);

/** A SPARQL store that records its SELECTs and answers each with `rows`. */
class StubStore extends SparqlDataset {
  selects: string[] = [];
  namedGraphs: string[][] = [];
  rows: SparqlBinding[] = [];
  registry: Array<[string, string]> = [
    [ONT_B, `${CORE}OntologyGraph`],
    [ONT_A, `${CORE}OntologyGraph`],
  ];

  constructor(options?: SparqlOptions) {
    super(options);
  }

  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    if (sparql.startsWith('SELECT ?g ?c WHERE')) {
      return {
        head: {vars: ['g', 'c']},
        results: {
          bindings: this.registry.map(([g, c]) => ({g: {type: 'uri', value: g}, c: {type: 'uri', value: c}})),
        },
      };
    }
    this.selects.push(sparql);
    return {head: {vars: []}, results: {bindings: this.rows}};
  }

  protected override async executeSparqlSelectWithNamedGraphs(
    sparql: string,
    namedGraphs: string[],
  ): Promise<SparqlQueryResults> {
    this.namedGraphs.push(namedGraphs);
    return this.executeSparqlSelect(sparql);
  }

  protected async executeSparqlUpdate(): Promise<void> {}

  last(): string {
    return this.selects[this.selects.length - 1];
  }
}

const uri = (value: string) => ({type: 'uri' as const, value});

describe('the builders', () => {
  test('forNode reads one subject; .from() and .limit() return new builders', () => {
    const base = TriplesBuilder.forNode({id: S});
    expect(base.toTriplesQuery()).toEqual({kind: 'triples', subject: S});
    const scoped = base.from([G1, G2, G1]).limit(10);
    expect(scoped.toTriplesQuery()).toEqual({kind: 'triples', subject: S, graphs: [G1, G2], limit: 10});
    expect(base.toTriplesQuery()).toEqual({kind: 'triples', subject: S});
    expect(base.from(G1).toTriplesQuery().graphs).toEqual([G1]);
  });

  test('readContent reads one graph and carries its record class as the routing key', () => {
    expect(DraftGraph.readContent(G1).toTriplesQuery()).toEqual({
      kind: 'triples',
      graphs: [G1],
      recordClass: `${CORE}DraftGraph`,
    });
    expect(NamedGraph.readContent(G1).limit(5).toTriplesQuery()).toEqual({
      kind: 'triples',
      graphs: [G1],
      limit: 5,
      recordClass: 'http://www.w3.org/ns/sparql-service-description#NamedGraph',
    });
  });

  test('refused: a subject that is not an IRI, a blank label, a bad limit, .from() on a graph read', () => {
    expect(() => TriplesBuilder.forNode({id: 'not an iri'})).toThrow(/subject must be an absolute IRI/);
    expect(() => TriplesBuilder.forNode({id: '_:b0'})).toThrow(/subject must be an absolute IRI/);
    expect(() => TriplesBuilder.forNode({id: S}).limit(0)).toThrow(/limit must be a positive integer/);
    expect(() => TriplesBuilder.forNode({id: S}).limit(1.5)).toThrow(/limit must be a positive integer/);
    expect(() => TriplesBuilder.forNode({id: S}).from([])).toThrow(/non-empty list/);
    expect(() => OntologyGraph.readContent(G1).from(G2)).toThrow(/a graph read names its graph/i);
    expect(() => NamedGraph.readContent('relative')).toThrow(/absolute IRI/);
  });
});

describe('the wire form', () => {
  test('a read is its own wire form: parseTriplesQuery keeps the known fields', () => {
    const query = TriplesBuilder.forNode({id: S}).from(graphs.allOntologies).limit(3).toTriplesQuery();
    const back = parseTriplesQuery({...JSON.parse(JSON.stringify(query)), v: '1', extra: true});
    expect(back).toEqual(query);
    expect(parseTriplesQuery(DraftGraph.readContent(G1).toTriplesQuery())).toEqual(
      DraftGraph.readContent(G1).toTriplesQuery(),
    );
  });

  test('refused at the boundary: another kind, a future version, no subject and no graphs', () => {
    expect(() => parseTriplesQuery({kind: 'graph_drop', graph: G1})).toThrow(/kind must be "triples"/);
    expect(() => parseTriplesQuery({kind: 'triples', subject: S, v: '99'})).toThrow();
    expect(() => parseTriplesQuery({kind: 'triples'})).toThrow(/needs a node \(a subject or an object\), graphs or both/);
    expect(() => parseTriplesQuery({kind: 'triples', graphs: G1})).toThrow(/array of graph IRIs/);
    expect(() => parseTriplesQuery([])).toThrow(/expected an object/);
  });

  test('fromJSON points a triples read to IDataset.triplesQuery', () => {
    expect(() => fromJSON({kind: 'triples', subject: S} as any)).toThrow(/parseTriplesQuery/);
  });
});

describe('the SPARQL', () => {
  test('a graph read is the whole graph in GRAPH <g>, with its LIMIT', () => {
    expect(triplesToSparql({kind: 'triples', graphs: [G1], limit: 1001})).toBe(
      `SELECT ?s ?p ?o\nWHERE {\n  GRAPH <${G1}> {\n    ?s ?p ?o .\n  }\n}\nLIMIT 1001`,
    );
  });

  test('a subject read: in one graph, in several (FROM NAMED, a graph variable), in the default graph', () => {
    expect(triplesToSparql({kind: 'triples', subject: S, graphs: [G1]})).toBe(
      `SELECT ?p ?o\nWHERE {\n  GRAPH <${G1}> {\n    <${S}> ?p ?o .\n  }\n}`,
    );
    const many = triplesToSparql({kind: 'triples', subject: S, graphs: [G1, G2]});
    expect(many).toContain('SELECT ?p ?o ?g_s0');
    expect(many).toContain(`FROM NAMED <${G1}>`);
    expect(many).toContain(`FROM NAMED <${G2}>`);
    expect(many).toContain(`GRAPH ?g_s0 {\n    <${S}> ?p ?o .`);
    expect(triplesToSparql({kind: 'triples', subject: S})).toBe(`SELECT ?p ?o\nWHERE {\n  <${S}> ?p ?o .\n}`);
  });

  test('the default graph with named graphs is read through VALUES under the store name for it', () => {
    const sparql = triplesToSparql({kind: 'triples', subject: S, graphs: [graphs.default, G1]}, {mapGraphName: jena});
    expect(sparql).toContain(`VALUES ?g_s0 { <${JENA_DEFAULT}> <${G1}> }`);
    expect(sparql).not.toContain('FROM NAMED');
  });

  test('a portable name only a store resolves is refused by the compiler', () => {
    expect(() => triplesToSparql({kind: 'triples', graphs: [graphs.allOntologies]})).toThrow(/portable graph name/);
  });
});

describe('SparqlDataset.triplesQuery', () => {
  test('answers terms as core values: IRIs and blank nodes as {id}, literals with datatype and language', async () => {
    const store = new StubStore();
    store.rows = [
      {s: uri(S), p: uri(P), o: uri(G2)},
      {s: {type: 'bnode', value: 'b0'}, p: uri(P), o: {type: 'bnode', value: 'b1'}},
      {s: uri(S), p: uri(P), o: {type: 'literal', value: 'plain'}},
      {s: uri(S), p: uri(P), o: {type: 'literal', value: 'hallo', 'xml:lang': 'nl'}},
      {s: uri(S), p: uri(P), o: {type: 'literal', value: '42', datatype: xsd.integer.id}},
    ];
    const triples = await NamedGraph.readContent(G1).exec(store);
    expect(store.last()).toContain(`GRAPH <${G1}>`);
    const graph = {id: G1};
    expect(triples).toEqual([
      {subject: {id: S}, predicate: {id: P}, object: {id: G2}, graph},
      {subject: {id: '_:b0'}, predicate: {id: P}, object: {id: '_:b1'}, graph},
      {subject: {id: S}, predicate: {id: P}, object: {value: 'plain', datatype: {id: xsd.string.id}}, graph},
      {subject: {id: S}, predicate: {id: P}, object: {value: 'hallo', datatype: {id: rdf.langString.id}, language: 'nl'}, graph},
      {subject: {id: S}, predicate: {id: P}, object: {value: '42', datatype: {id: xsd.integer.id}}, graph},
    ]);
    expect(isLiteralTerm(triples[0].object)).toBe(false);
    expect(isLiteralTerm(triples[2].object)).toBe(true);
  });

  test('a subject read takes its subject from the query and each graph from its row', async () => {
    const store = new StubStore({mapGraphName: jena});
    store.rows = [
      {p: uri(P), o: uri(G1), g_s0: uri(G2)},
      {p: uri(P), o: uri(G2), g_s0: uri(JENA_DEFAULT)},
    ];
    const triples = await TriplesBuilder.forNode({id: S}).from([graphs.default, G2]).exec(store);
    expect(triples).toEqual([
      {subject: {id: S}, predicate: {id: P}, object: {id: G1}, graph: {id: G2}},
      {subject: {id: S}, predicate: {id: P}, object: {id: G2}},
    ]);
    store.rows = [{p: uri(P), o: uri(G1)}];
    expect(await TriplesBuilder.forNode({id: S}).exec(store)).toEqual([
      {subject: {id: S}, predicate: {id: P}, object: {id: G1}},
    ]);
    expect(store.last()).toBe(`SELECT ?p ?o\nWHERE {\n  <${S}> ?p ?o .\n}`);
  });

  test('portable names expand from the registry; a set that expands to nothing answers [] without querying', async () => {
    const store = new StubStore();
    invalidateGraphRegistry();
    await TriplesBuilder.forNode({id: S}).from(graphs.allOntologies).exec(store);
    expect(store.last()).toContain(`FROM NAMED <${ONT_A}>`);
    expect(store.last()).toContain(`FROM NAMED <${ONT_B}>`);
    const empty = new StubStore();
    empty.registry = [];
    expect(await TriplesBuilder.forNode({id: S}).from(graphs.allShapes).exec(empty)).toEqual([]);
    expect(empty.selects).toEqual([]);
    // graphs.default alone reads the default graph as a plain pattern, also for a graph read.
    await NamedGraph.readContent(graphs.default).limit(2).exec(store);
    expect(store.last()).toBe('SELECT ?s ?p ?o\nWHERE {\n  ?s ?p ?o .\n}\nLIMIT 2');
  });

  test('a subject read without graphs follows the store routing like a shapeless ask', async () => {
    const store = new StubStore({mapGraphName: jena});
    setShapeGraphs(store, {[Person.shape.id]: G1});
    await TriplesBuilder.forNode({id: S}).exec(store);
    expect(store.last()).toContain(`VALUES ?g_s0 { <${JENA_DEFAULT}> <${G1}> }`);
    // .from() replaces the routing.
    await TriplesBuilder.forNode({id: S}).from(G2).exec(store);
    expect(store.last()).toContain(`GRAPH <${G2}>`);
  });

  test('with namedGraphUriParameter the FROM NAMED set goes to the transport', async () => {
    const store = new StubStore({namedGraphUriParameter: true});
    await TriplesBuilder.forNode({id: S}).from([G1, G2]).exec(store);
    expect(store.namedGraphs).toEqual([[G1, G2]]);
    expect(store.last()).not.toContain('FROM NAMED');
  });

  test('a row without its subject, predicate or object rejects', async () => {
    const store = new StubStore();
    store.rows = [{s: uri(S), p: uri(P)}];
    await expect(NamedGraph.readContent(G1).exec(store)).rejects.toThrow(/without its subject, predicate or object/);
  });
});

describe('the dispatch and the routing', () => {
  const resetStorage = () => {
    LinkedStorage.getShapeToDatasetMap().clear();
  };
  afterEach(resetStorage);

  /** A dataset that answers every triples read with `answer` and records the reads. */
  const fake = (answer: Triple[]): IDataset & {reads: TriplesQuery[]} => {
    const reads: TriplesQuery[] = [];
    return {
      reads,
      selectQuery: async () => [],
      createQuery: async () => ({}) as any,
      updateQuery: async () => ({}) as any,
      deleteQuery: async () => ({deleted: [], count: 0}),
      graphQuery: async () => ({graph: '', changed: false}),
      triplesQuery: async (q: TriplesQuery) => {
        reads.push(q);
        return answer;
      },
    };
  };
  const t = (o: string): Triple => ({subject: {id: S}, predicate: {id: P}, object: {id: o}});

  test('exec(target) is observed; a target without triplesQuery, or a non-array answer, is refused', async () => {
    const events: QueryDispatchEvent[] = [];
    const off = subscribeQueryDispatch((e) => events.push(e));
    const target = fake([t(G1)]);
    expect(await TriplesBuilder.forNode({id: S}).exec(target)).toEqual([t(G1)]);
    off();
    expect(events.map((e) => [e.kind, e.target === target])).toEqual([['triples', true]]);

    const {triplesQuery: _none, ...without} = fake([]);
    await expect(TriplesBuilder.forNode({id: S}).exec(without)).rejects.toThrow(/does not implement IDataset.triplesQuery/);
    const odd = {...fake([]), triplesQuery: async () => null as any};
    await expect(TriplesBuilder.forNode({id: S}).exec(odd)).rejects.toThrow(/must resolve to an array/);
  });

  test('a graph read goes where its record class graph queries go', async () => {
    const main = fake([t(G1)]);
    const drafts = fake([t(G2)]);
    LinkedStorage.setDefaultDataset(main);
    LinkedStorage.setDatasetForShapes(drafts, DraftGraph);
    expect(await DraftGraph.readContent(G1)).toEqual([t(G2)]);
    expect(drafts.reads).toHaveLength(1);
    expect(await OntologyGraph.readContent(G1)).toEqual([t(G1)]);
    expect(main.reads).toHaveLength(1);
  });

  test('a subject read reads every dataset the router knows and joins the answers up to the limit', async () => {
    const main = fake([t(G1)]);
    const other = fake([t(G2), t(S)]);
    LinkedStorage.setDefaultDataset(main);
    LinkedStorage.setDatasetForShapes(other, Person);
    expect(await TriplesBuilder.forNode({id: S})).toEqual([t(G1), t(G2), t(S)]);
    expect(await TriplesBuilder.forNode({id: S}).limit(2)).toEqual([t(G1), t(G2)]);

    const {triplesQuery: _none, ...without} = fake([]);
    LinkedStorage.setDatasetForShapes(without, Person);
    await expect(TriplesBuilder.forNode({id: S})).rejects.toThrow(/does not implement IDataset.triplesQuery/);
  });
});

describe('object reads, predicate reads and exists()', () => {
  const O = 'https://example.org/data/o1';
  const subClassOf = {id: 'http://www.w3.org/2000/01/rdf-schema#subClassOf'};

  test('toNode reads the triples whose object is the node; withPredicate fixes the predicate', () => {
    expect(TriplesBuilder.toNode({id: O}).from(G1).toTriplesQuery()).toEqual({kind: 'triples', object: O, graphs: [G1]});
    expect(TriplesBuilder.withPredicate({id: P}).from([G1, G2]).limit(5).toTriplesQuery()).toEqual({
      kind: 'triples',
      predicate: P,
      graphs: [G1, G2],
      limit: 5,
    });
    expect(TriplesBuilder.toNode({id: O}).withPredicate(subClassOf).toTriplesQuery()).toEqual({
      kind: 'triples',
      object: O,
      predicate: subClassOf.id,
    });
    expect(TriplesBuilder.forNode({id: S}).withPredicate({id: P}).toTriplesQuery()).toEqual({
      kind: 'triples',
      subject: S,
      predicate: P,
    });
    expect(NamedGraph.readContent(G1).withPredicate({id: P}).toTriplesQuery()).toEqual({
      kind: 'triples',
      graphs: [G1],
      predicate: P,
      recordClass: 'http://www.w3.org/ns/sparql-service-description#NamedGraph',
    });
  });

  test('refused: a non-IRI or blank object or predicate; a predicate read without graphs', async () => {
    expect(() => TriplesBuilder.toNode({id: '_:b0'})).toThrow(/object must be an absolute IRI/);
    expect(() => TriplesBuilder.toNode({id: 'nope'})).toThrow(/object must be an absolute IRI/);
    expect(() => TriplesBuilder.withPredicate({id: 'nope'})).toThrow(/predicate must be an absolute IRI/);
    const store = new StubStore();
    await expect(TriplesBuilder.withPredicate({id: P}).exec(store)).rejects.toThrow(/a predicate read needs graphs/);
    await expect(TriplesBuilder.withPredicate({id: P}).exists(store)).rejects.toThrow(/a predicate read needs graphs/);
    expect(store.selects).toEqual([]);
  });

  test('the wire keeps object and predicate, checks them, and refuses a predicate alone', () => {
    const query = TriplesBuilder.toNode({id: O}).withPredicate({id: P}).from(G1).toTriplesQuery();
    expect(parseTriplesQuery({...JSON.parse(JSON.stringify(query)), v: '1.4'})).toEqual(query);
    expect(() => parseTriplesQuery({kind: 'triples', object: '_:b1', graphs: [G1]})).toThrow(/object must be an absolute IRI/);
    expect(() => parseTriplesQuery({kind: 'triples', predicate: 42, graphs: [G1]})).toThrow(/predicate must be an absolute IRI/);
    expect(() => parseTriplesQuery({kind: 'triples', predicate: P})).toThrow(/a predicate read needs graphs/);
    expect(parseTriplesQuery({kind: 'triples', object: O})).toEqual({kind: 'triples', object: O});
    expect(() => parseTriplesQuery({kind: 'triples', subject: S, predicate: P, object: O})).toThrow(/nothing to read/);
  });

  test('the SPARQL: fixed positions are terms, the others are projected', () => {
    expect(triplesToSparql({kind: 'triples', object: O, graphs: [G1]})).toBe(
      `SELECT ?s ?p\nWHERE {\n  GRAPH <${G1}> {\n    ?s ?p <${O}> .\n  }\n}`,
    );
    expect(triplesToSparql({kind: 'triples', predicate: P, graphs: [G1], limit: 1})).toBe(
      `SELECT ?s ?o\nWHERE {\n  GRAPH <${G1}> {\n    ?s <${P}> ?o .\n  }\n}\nLIMIT 1`,
    );
    const many = triplesToSparql({kind: 'triples', predicate: P, graphs: [G1, G2]});
    expect(many).toContain('SELECT ?s ?o ?g_s');
    expect(many).toContain(`FROM NAMED <${G1}>`);
    expect(many).toContain(`GRAPH ?g_s {\n    ?s <${P}> ?o .`);
    expect(triplesToSparql({kind: 'triples', object: O, predicate: P})).toBe(
      `SELECT ?s\nWHERE {\n  ?s <${P}> <${O}> .\n}`,
    );
    const withDefault = triplesToSparql({kind: 'triples', object: O, graphs: [graphs.default, G1]}, {mapGraphName: jena});
    expect(withDefault).toContain(`VALUES ?g_s { <${JENA_DEFAULT}> <${G1}> }`);
    expect(() => triplesToSparql({kind: 'triples', predicate: P})).toThrow(/needs its graphs/);
  });

  test('the answer takes fixed positions from the query and the others from each row', async () => {
    const store = new StubStore({mapGraphName: jena});
    store.rows = [
      {s: uri(S), p: uri(P), g_s: uri(G1)},
      {s: {type: 'bnode', value: 'b2'}, p: uri(subClassOf.id), g_s: uri(JENA_DEFAULT)},
    ];
    expect(await TriplesBuilder.toNode({id: O}).from([graphs.default, G1]).exec(store)).toEqual([
      {subject: {id: S}, predicate: {id: P}, object: {id: O}, graph: {id: G1}},
      {subject: {id: '_:b2'}, predicate: subClassOf, object: {id: O}},
    ]);
    store.rows = [{s: uri(S), o: {type: 'literal', value: 'x'}}];
    expect(await TriplesBuilder.withPredicate({id: P}).from(G2).exec(store)).toEqual([
      {subject: {id: S}, predicate: {id: P}, object: {value: 'x', datatype: {id: xsd.string.id}}, graph: {id: G2}},
    ]);
  });

  test('an object read without graphs follows the store routing like a subject read', async () => {
    const store = new StubStore({mapGraphName: jena});
    setShapeGraphs(store, {[Person.shape.id]: G1});
    await TriplesBuilder.toNode({id: O}).exec(store);
    expect(store.last()).toContain(`VALUES ?g_s { <${JENA_DEFAULT}> <${G1}> }`);
    expect(store.last()).toContain(`?s ?p <${O}>`);
  });

  test('exists() sends the read with LIMIT 1 and answers whether a triple came back', async () => {
    const store = new StubStore();
    store.rows = [];
    expect(await TriplesBuilder.withPredicate({id: P}).from(G1).exists(store)).toBe(false);
    expect(store.last()).toBe(`SELECT ?s ?o\nWHERE {\n  GRAPH <${G1}> {\n    ?s <${P}> ?o .\n  }\n}\nLIMIT 1`);
    store.rows = [{s: uri(S), o: uri(O)}];
    const builder = TriplesBuilder.withPredicate({id: P}).from(G1).limit(10);
    expect(await builder.exists(store)).toBe(true);
    expect(builder.toTriplesQuery().limit).toBe(10);
  });

  test("a dataset that does not declare 'triplesPattern' is refused before it is asked", async () => {
    const reads: TriplesQuery[] = [];
    const old: IDataset = {
      selectQuery: async () => [],
      createQuery: async () => ({}) as any,
      updateQuery: async () => ({}) as any,
      deleteQuery: async () => ({deleted: [], count: 0}),
      graphQuery: async () => ({graph: '', changed: false}),
      triplesQuery: async (q: TriplesQuery) => {
        reads.push(q);
        return [];
      },
    };
    await expect(TriplesBuilder.toNode({id: O}).from(G1).exec(old)).rejects.toThrow(/'triplesPattern'/);
    await expect(TriplesBuilder.withPredicate({id: P}).from(G1).exists(old)).rejects.toThrow(/'triplesPattern'/);
    // A subject read and a graph read are the baseline.
    await TriplesBuilder.forNode({id: S}).from(G1).exec(old);
    await NamedGraph.readContent(G1).exec(old);
    expect(reads).toHaveLength(2);
    expect(await TriplesBuilder.toNode({id: O}).from(G1).exec({...old, supports: ['triplesPattern']})).toEqual([]);
  });

  test('through LinkedStorage: every dataset is checked, and exists() stops at the first that answers', async () => {
    const answering = (answer: Triple[]) => {
      const reads: TriplesQuery[] = [];
      const ds: IDataset & {reads: TriplesQuery[]} = {
        reads,
        supports: ['triplesPattern'],
        selectQuery: async () => [],
        createQuery: async () => ({}) as any,
        updateQuery: async () => ({}) as any,
        deleteQuery: async () => ({deleted: [], count: 0}),
        graphQuery: async () => ({graph: '', changed: false}),
        triplesQuery: async (q: TriplesQuery) => {
          reads.push(q);
          return answer;
        },
      };
      return ds;
    };
    const hit: Triple = {subject: {id: S}, predicate: {id: P}, object: {id: O}};
    const main = answering([hit]);
    const other = answering([hit]);
    LinkedStorage.setDefaultDataset(main);
    LinkedStorage.setDatasetForShapes(other, Person);
    expect(await TriplesBuilder.withPredicate({id: P}).from(G1).exists()).toBe(true);
    expect(main.reads).toEqual([{kind: 'triples', predicate: P, graphs: [G1], limit: 1}]);
    expect(other.reads).toEqual([]);
    const {supports: _s, ...plain} = answering([]);
    LinkedStorage.setDatasetForShapes(plain, Person);
    main.reads.length = 0;
    const lone = answering([]);
    LinkedStorage.setDefaultDataset(lone);
    await expect(TriplesBuilder.toNode({id: O}).from(G1)).rejects.toThrow(/'triplesPattern'/);
    LinkedStorage.getShapeToDatasetMap().clear();
  });
});
