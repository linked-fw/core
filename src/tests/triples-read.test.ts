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
import {
  isLiteralTerm,
  parseTriplesQuery,
  parseTriplesTermsQuery,
  type Triple,
  type TriplesQuery,
  type TriplesTermsQuery,
} from '../queries/triplesQuery';
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
import {readQueryOf} from '../test-helpers/read-double';
import type {QueryFeature} from '../queries/queryFeatures';

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

  test('fromJSON points a triples read to IDataset.readQuery', () => {
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

describe('SparqlDataset: triples reads', () => {
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
      supports: ['triples'] as QueryFeature[],
      readQuery: readQueryOf({
        select: async () => [],
        triples: async (q: TriplesQuery) => {
          reads.push(q);
          return answer;
        },
      }),
      createQuery: async () => ({}) as any,
      updateQuery: async () => ({}) as any,
      deleteQuery: async () => ({deleted: [], count: 0}),
      graphQuery: async () => ({graph: '', changed: false}),
    };
  };
  const t = (o: string): Triple => ({subject: {id: S}, predicate: {id: P}, object: {id: o}});

  test("exec(target) is observed; a target without 'triples', or a non-array answer, is refused", async () => {
    const events: QueryDispatchEvent[] = [];
    const off = subscribeQueryDispatch((e) => events.push(e));
    const target = fake([t(G1)]);
    expect(await TriplesBuilder.forNode({id: S}).exec(target)).toEqual([t(G1)]);
    off();
    expect(events.map((e) => [e.kind, e.target === target])).toEqual([['triples', true]]);

    const without = {...fake([]), supports: []};
    await expect(TriplesBuilder.forNode({id: S}).exec(without)).rejects.toThrow(/does not declare 'triples'/);
    const odd = {...fake([]), readQuery: readQueryOf({triples: async () => null})};
    await expect(TriplesBuilder.forNode({id: S}).exec(odd)).rejects.toThrow(/must be answered with an array of triples/);
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

    const without = {...fake([]), supports: []};
    LinkedStorage.setDatasetForShapes(without, Person);
    await expect(TriplesBuilder.forNode({id: S})).rejects.toThrow(/does not declare 'triples'/);
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
    // A missing node or predicate is refused at build time, never read as a whole graph.
    expect(() => TriplesBuilder.forNode({id: undefined as any}).from(G1)).toThrow(/subject must be an absolute IRI/);
    expect(() => TriplesBuilder.toNode(undefined as any)).toThrow(/object must be an absolute IRI/);
    expect(() => TriplesBuilder.withPredicate({id: P}).from(G1).withPredicate({id: undefined as any})).toThrow(
      /predicate must be an absolute IRI/,
    );
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
      supports: ['triples'],
      readQuery: readQueryOf({
        select: async () => [],
        triples: async (q: TriplesQuery) => {
          reads.push(q);
          return [];
        },
      }),
      createQuery: async () => ({}) as any,
      updateQuery: async () => ({}) as any,
      deleteQuery: async () => ({deleted: [], count: 0}),
      graphQuery: async () => ({graph: '', changed: false}),
    };
    await expect(TriplesBuilder.toNode({id: O}).from(G1).exec(old)).rejects.toThrow(/'triplesPattern'/);
    await expect(TriplesBuilder.withPredicate({id: P}).from(G1).exists(old)).rejects.toThrow(/'triplesPattern'/);
    // A subject read and a graph read need only 'triples'.
    await TriplesBuilder.forNode({id: S}).from(G1).exec(old);
    await NamedGraph.readContent(G1).exec(old);
    expect(reads).toHaveLength(2);
    expect(await TriplesBuilder.toNode({id: O}).from(G1).exec({...old, supports: ['triples', 'triplesPattern']})).toEqual([]);
  });

  test('through LinkedStorage: every dataset is checked, and exists() stops at the first that answers', async () => {
    const answering = (answer: Triple[]) => {
      const reads: TriplesQuery[] = [];
      const ds: IDataset & {reads: TriplesQuery[]} = {
        reads,
        supports: ['triples', 'triplesPattern'],
        readQuery: readQueryOf({
          select: async () => [],
          triples: async (q: TriplesQuery) => {
            reads.push(q);
            return answer;
          },
        }),
        createQuery: async () => ({}) as any,
        updateQuery: async () => ({}) as any,
        deleteQuery: async () => ({deleted: [], count: 0}),
        graphQuery: async () => ({graph: '', changed: false}),
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
    const plain = {...answering([]), supports: ['triples'] as QueryFeature[]};
    LinkedStorage.setDatasetForShapes(plain, Person);
    main.reads.length = 0;
    const lone = answering([]);
    LinkedStorage.setDefaultDataset(lone);
    await expect(TriplesBuilder.toNode({id: O}).from(G1)).rejects.toThrow(/'triplesPattern'/);
    LinkedStorage.getShapeToDatasetMap().clear();
  });

  test('through LinkedStorage: a dataset that cannot answer is refused whatever its place in the order', async () => {
    const hit: Triple = {subject: {id: S}, predicate: {id: P}, object: {id: O}};
    const reads: TriplesQuery[] = [];
    const base = {
      readQuery: async () => [] as never,
      createQuery: async () => ({}) as any,
      updateQuery: async () => ({}) as any,
      deleteQuery: async () => ({deleted: [], count: 0}),
      graphQuery: async () => ({graph: '', changed: false}),
    };
    const answering: IDataset = {
      ...base,
      supports: ['triples', 'triplesPattern'],
      readQuery: readQueryOf({
        triples: async (q: TriplesQuery) => {
          reads.push(q);
          return [hit];
        },
      }),
    };
    // The first dataset answers enough for the limit, so the read never reaches the second.
    LinkedStorage.setDefaultDataset(answering);
    LinkedStorage.setDatasetForShapes({...answering, supports: ['triples']}, Person);
    await expect(TriplesBuilder.withPredicate({id: P}).from(G1).exists()).rejects.toThrow(/'triplesPattern'/);
    LinkedStorage.setDatasetForShapes(base as IDataset, Person);
    await expect(TriplesBuilder.forNode({id: S}).from(G1).limit(1).exec()).rejects.toThrow(
      /does not declare 'triples'/,
    );
    expect(reads).toEqual([]);
    LinkedStorage.getShapeToDatasetMap().clear();
  });
});

describe('terms reads: toNode([…]), withPredicate([…]) and whichExist()', () => {
  const A = 'https://example.org/ont/A';
  const B = 'https://example.org/ont/B';
  const Q = 'https://example.org/ont/q';
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  afterEach(() => LinkedStorage.getShapeToDatasetMap().clear());

  test('the builders: a list in one position, each term once; one list per read', () => {
    expect(TriplesBuilder.toNode([{id: A}, {id: B}, {id: A}]).withPredicate(rdf.type).from(G1).toTriplesTermsQuery()).toEqual({
      kind: 'triples_terms',
      objects: [A, B],
      predicate: rdf.type.id,
      graphs: [G1],
    });
    expect(TriplesBuilder.withPredicate([{id: P}, {id: Q}]).from(G1).toTriplesTermsQuery()).toEqual({
      kind: 'triples_terms',
      predicates: [P, Q],
      graphs: [G1],
    });
    // A later withPredicate replaces the earlier one, list or term.
    expect(TriplesBuilder.withPredicate([{id: P}]).withPredicate({id: Q}).from(G1).toTriplesQuery()).toEqual({
      kind: 'triples',
      predicate: Q,
      graphs: [G1],
    });
    expect(() => TriplesBuilder.toNode([{id: A}]).withPredicate([{id: P}])).toThrow(/one position/);
    expect(() => TriplesBuilder.toNode([{id: A}, {id: '_:b0'}])).toThrow(/object must be an absolute IRI/);
    expect(() => TriplesBuilder.withPredicate([{id: 'p'}])).toThrow(/predicate must be an absolute IRI/);
    expect(() => TriplesBuilder.withPredicate([{id: P}]).toTriplesTermsQuery()).toThrow(/predicate read needs graphs/);
    expect(() => TriplesBuilder.forNode({id: S}).withPredicate([{id: P}]).toTriplesTermsQuery()).not.toThrow();
    // A terms read is not a triples read, and the reverse.
    expect(() => TriplesBuilder.toNode([{id: A}]).from(G1).toTriplesQuery()).toThrow(/whichExist/);
    expect(() => TriplesBuilder.toNode({id: A}).from(G1).toTriplesTermsQuery()).toThrow(/build the read with a list/);
  });

  test('the wire: parseTriplesTermsQuery keeps the lists and checks them; a triples read has none', () => {
    const json = {v: '1.10', kind: 'triples_terms', objects: [A, B], predicate: rdf.type.id, graphs: [G1], limit: 3};
    expect(parseTriplesTermsQuery(JSON.parse(JSON.stringify(json)))).toEqual({
      kind: 'triples_terms',
      objects: [A, B],
      predicate: rdf.type.id,
      graphs: [G1],
    });
    const parse = (fields: Record<string, unknown>) => () => parseTriplesTermsQuery({kind: 'triples_terms', ...fields});
    expect(parse({objects: A, graphs: [G1]})).toThrow(/objects must be an array/);
    expect(parse({objects: [A], object: B})).toThrow(/object and objects/);
    expect(parse({predicates: [P], predicate: Q, graphs: [G1]})).toThrow(/predicate and predicates/);
    expect(parse({predicates: [P]})).toThrow(/needs graphs/);
    expect(parse({subject: S, predicates: [P], object: A})).toThrow(/all fixed/);
    expect(parse({objects: [A], graphs: [G1], recordClass: `${CORE}DraftGraph`})).toThrow(/no recordClass/);
    expect(parse({object: A, graphs: [G1]})).toThrow(/lists none/);
    expect(() => parseTriplesTermsQuery({kind: 'triples', objects: [A]})).toThrow(/kind must be "triples_terms"/);
    // A terms read sent as a triples read (DSL-JSON 1.9) is refused.
    expect(() => parseTriplesQuery({kind: 'triples', objects: [A], graphs: [G1]})).toThrow(/kind "triples_terms"/);
    expect(() => parseTriplesQuery({kind: 'triples', predicates: [P], graphs: [G1]})).toThrow(/kind "triples_terms"/);
    expect(() => fromJSON({kind: 'triples_terms', objects: [A]} as any)).toThrow(/parseTriplesTermsQuery/);
  });

  test('the SPARQL: VALUES ?t over the list, the pattern under FILTER EXISTS, SELECT DISTINCT ?t', async () => {
    const store = new StubStore({mapGraphName: jena});
    store.rows = [{t: uri(B)}, {t: uri('https://example.org/ont/not-asked')}];
    expect(await TriplesBuilder.toNode([{id: A}, {id: B}]).withPredicate(rdf.type).from(G1).whichExist(store)).toEqual(
      new Set([B]),
    );
    expect(store.last()).toBe(
      `PREFIX rdf: <${RDF}>\nSELECT DISTINCT ?t\nWHERE {\n  VALUES ?t { <${A}> <${B}> }\n  FILTER(EXISTS {\n    GRAPH <${G1}> {\n      ?s rdf:type ?t .\n    }\n  })\n}`,
    );
    await TriplesBuilder.withPredicate([{id: P}, {id: Q}]).from([G1, G2]).whichExist(store);
    expect(store.last()).toBe(
      `SELECT DISTINCT ?t\nFROM NAMED <${G1}>\nFROM NAMED <${G2}>\nWHERE {\n  VALUES ?t { <${P}> <${Q}> }\n  FILTER(EXISTS {\n    GRAPH ?g_s {\n      ?s ?t ?o .\n    }\n  })\n}`,
    );
    // The default graph with a named graph: the store's name for it, through VALUES.
    await TriplesBuilder.withPredicate([{id: P}]).from([graphs.default, G1]).whichExist(store);
    expect(store.last()).toContain(`VALUES ?g_s { <${JENA_DEFAULT}> <${G1}> }`);
    expect(store.last()).toContain('?s ?t ?o .');
  });

  test('a long list goes in parts of 400; an empty list or no graph answers without querying', async () => {
    const store = new StubStore();
    const terms = Array.from({length: 401}, (_, i) => ({id: `https://example.org/ont/c${i}`}));
    store.rows = [{t: uri(terms[0].id)}];
    const found = await TriplesBuilder.toNode(terms).from(G1).whichExist(store);
    expect(store.selects).toHaveLength(2);
    expect(store.selects[1]).toContain(`VALUES ?t { <${terms[400].id}> }`);
    expect(found).toEqual(new Set([terms[0].id]));
    store.selects.length = 0;
    expect(await TriplesBuilder.toNode([]).from(G1).whichExist(store)).toEqual(new Set());
    store.registry = [];
    invalidateGraphRegistry();
    expect(await TriplesBuilder.withPredicate([{id: P}]).from(graphs.allOntologies).whichExist(store)).toEqual(new Set());
    expect(store.selects).toEqual([]);
  });

  test('a terms read answers terms: exec() is refused, exists() asks whether any term occurs', async () => {
    const store = new StubStore();
    await expect(TriplesBuilder.toNode([{id: A}]).from(G1).exec(store)).rejects.toThrow(/whichExist/);
    await expect(store.readQuery({kind: 'triples', objects: [A], graphs: [G1]} as never)).rejects.toThrow(/terms read/);
    await expect(store.readQuery({kind: 'triples_terms', object: A, graphs: [G1]})).rejects.toThrow(/lists none/);
    await expect(TriplesBuilder.toNode({id: A}).from(G1).whichExist(store)).rejects.toThrow(/build the read with a list/);
    store.rows = [];
    expect(await TriplesBuilder.toNode([{id: A}]).from(G1).exists(store)).toBe(false);
    store.rows = [{t: uri(A)}];
    expect(await TriplesBuilder.toNode([{id: A}]).from(G1).exists(store)).toBe(true);
  });

  test("the dispatch: observed, refused without 'triplesTerms' or 'triplesPattern', before it is asked", async () => {
    const asked: TriplesTermsQuery[] = [];
    const base: IDataset = {
      readQuery: async () => [] as never,
      createQuery: async () => ({}) as any,
      updateQuery: async () => ({}) as any,
      deleteQuery: async () => ({deleted: [], count: 0}),
      graphQuery: async () => ({graph: '', changed: false}),
    };
    const answering = (answer: unknown): IDataset => ({
      ...base,
      supports: ['triplesTerms', 'triplesPattern'],
      readQuery: readQueryOf({
        terms: async (q: TriplesTermsQuery) => {
          asked.push(q);
          return answer;
        },
      }),
    });
    const events: QueryDispatchEvent[] = [];
    const off = subscribeQueryDispatch((e) => events.push(e));
    const target = answering([B, A, A]);
    // Only the listed terms, each once, in the list's order.
    expect(await TriplesBuilder.toNode([{id: A}, {id: B}]).from(G1).whichExist(target)).toEqual(new Set([A, B]));
    off();
    expect(events.map((e) => [e.kind, e.target === target])).toEqual([['triplesTerms', true]]);
    await expect(TriplesBuilder.toNode([{id: A}]).from(G1).whichExist(base)).rejects.toThrow(
      /does not declare 'triplesTerms'/,
    );
    await expect(
      TriplesBuilder.toNode([{id: A}]).from(G1).whichExist({...answering([]), supports: ['triplesTerms']}),
    ).rejects.toThrow(/'triplesPattern'/);
    await expect(TriplesBuilder.toNode([{id: A}]).from(G1).whichExist(answering(null))).rejects.toThrow(/array of IRIs/);
    // An empty list is checked like any other, then answered without asking.
    asked.length = 0;
    await expect(TriplesBuilder.toNode([]).from(G1).whichExist(base)).rejects.toThrow(/'triplesTerms'/);
    expect(await TriplesBuilder.toNode([]).from(G1).whichExist(answering([A]))).toEqual(new Set());
    expect(asked).toEqual([]);
  });

  test('through LinkedStorage: every dataset checked first, the answers joined', async () => {
    const asked: string[] = [];
    const base = {
      readQuery: async () => [] as never,
      createQuery: async () => ({}) as any,
      updateQuery: async () => ({}) as any,
      deleteQuery: async () => ({deleted: [], count: 0}),
      graphQuery: async () => ({graph: '', changed: false}),
    };
    const answering = (name: string, answer: string[]): IDataset => ({
      ...base,
      supports: ['triplesTerms', 'triplesPattern'],
      readQuery: readQueryOf({
        terms: async () => {
          asked.push(name);
          return answer;
        },
      }),
    });
    LinkedStorage.setDefaultDataset(answering('main', [B]));
    LinkedStorage.setDatasetForShapes(answering('other', [A]), Person);
    expect(await TriplesBuilder.toNode([{id: A}, {id: B}, {id: Q}]).from(G1).whichExist()).toEqual(new Set([A, B]));
    expect(asked).toEqual(['main', 'other']);
    // Every term found: the next dataset is not asked.
    asked.length = 0;
    expect(await TriplesBuilder.toNode([{id: B}]).from(G1).whichExist()).toEqual(new Set([B]));
    expect(asked).toEqual(['main']);
    // A dataset that cannot answer fails the read wherever it is in the order.
    asked.length = 0;
    LinkedStorage.setDatasetForShapes(base as IDataset, Person);
    await expect(TriplesBuilder.toNode([{id: B}]).from(G1).whichExist()).rejects.toThrow(/'triplesTerms'/);
    expect(asked).toEqual([]);
  });
});
