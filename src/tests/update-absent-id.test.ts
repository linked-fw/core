/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * `update().for(id)` changes a node that exists. Its WHERE requires the subject's type, so an
 * update of an absent id, or of an untyped half-node, writes nothing: without routes, with a
 * route to one graph (`WITH <g>`) and with a shape that reads several graphs (`GRAPH ?g_w`, where
 * the lookup finds the subject by its type). An upsert is unchanged: it creates an absent node.
 * Golden SPARQL, then the same updates on the inferring store, where an update that matched no
 * node is said in a development warning.
 */
import {afterAll, beforeAll, describe, expect, jest, test} from '@jest/globals';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {isSparqlSelectResults} from '../sparql/resultMapping';
import {setShapeGraphs} from '../utils/graphRouting';
import {graphs} from '../ontologies/graphs';
import {NG, NGArticle} from '../test-helpers/graph-routing-nested-fixtures';
import {Employee, Person} from '../test-helpers/query-fixtures';
import {createTestDataset, DATASET_NAME, deleteTestDataset, executeSparqlUpdate, FUSEKI_BASE_URL} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';

import '../ontologies/rdf';
import '../ontologies/xsd';
import {Shape} from '../shapes/Shape';
import {literalProperty} from '../shapes/SHACL';
import {linkedPackage} from '../utils/Package';

const {linkedShape} = linkedPackage('update-absent-id-test');

/** A shape without a targetClass (as core's `ClassAxioms`): its nodes carry no type. */
@linkedShape
class UANote extends Shape {
  @literalProperty({path: {id: 'https://example.org/props/text'}, maxCount: 1})
  get text(): string {
    return '';
  }
}

@linkedShape
class UASubNote extends UANote {
  static targetClass = {id: 'https://example.org/props/SubNote'};
}

const D = 'https://acme.example/data/';
const G_ARTICLES = `${D}graph/articles`;
const G_PEOPLE = `${D}graph/people`;
const G_STAFF = `${D}graph/staff`;
const P = 'https://example.org/props/';
const jena = (iri: string) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null);

type Routing = 'unrouted' | 'one graph' | 'several graphs';
const ROUTES: Record<Routing, Record<string, string>> = {
  unrouted: {},
  'one graph': {[NGArticle.shape.id]: G_ARTICLES},
  // Person's read set is people and staff (its sub-shape Employee's graph).
  'several graphs': {[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF},
};

class CaptureStore extends SparqlDataset {
  updates: string[] = [];
  constructor(options?: SparqlOptions) {
    super(options);
  }
  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

function capture(routing: Routing): CaptureStore {
  const s = new CaptureStore({mapGraphName: jena, dataRoot: D.replace(/\/$/, '')});
  if (routing !== 'unrouted') setShapeGraphs(s, ROUTES[routing]);
  return s;
}

/** The update each routing case runs: an article's title, or (several graphs) a person's name. */
const updateOf = (routing: Routing, id: string, s: CaptureStore | FusekiStore) =>
  routing === 'several graphs'
    ? Person.update({name: 'new'}).for({id}).exec(s)
    : NGArticle.update({title: 'new'}).for({id}).exec(s);

async function sparqlOf(routing: Routing, id: string): Promise<string> {
  const s = capture(routing);
  await updateOf(routing, id, s);
  expect(s.updates).toHaveLength(1);
  return s.updates[0];
}

describe('update on an absent id: golden SPARQL', () => {
  const X = `${D}x`;

  test('without routes, the WHERE requires the subject\'s type', async () => {
    expect(await sparqlOf('unrouted', X)).toBe(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  <${X}> <${NG}title> ?old_title .
}
INSERT {
  <${X}> <${NG}title> "new" .
}
WHERE {
  OPTIONAL {
    <${X}> <${NG}title> ?old_title .
  }
  FILTER(EXISTS {
    <${X}> rdf:type ?t .
  })
}`);
  });

  test('with a route to one graph, the type is required in that graph (WITH)', async () => {
    expect(await sparqlOf('one graph', X)).toBe(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${G_ARTICLES}>
DELETE {
  <${X}> <${NG}title> ?old_title .
}
INSERT {
  <${X}> <${NG}title> "new" .
}
WHERE {
  OPTIONAL {
    <${X}> <${NG}title> ?old_title .
  }
  FILTER(EXISTS {
    <${X}> rdf:type ?t .
  })
}`);
  });

  test('with several graphs, the lookup finds the subject by its type, and the type is required in its graph', async () => {
    expect(await sparqlOf('several graphs', X)).toBe(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  GRAPH ?g_w {
    <${X}> <${P}name> ?old_name .
  }
}
INSERT {
  GRAPH ?g_w {
    <${X}> <${P}name> "new" .
  }
}
WHERE {
  { SELECT DISTINCT ?g_w WHERE { VALUES ?g_w { <${G_PEOPLE}> <${G_STAFF}> } GRAPH ?g_w { <${X}> rdf:type ?g_w_o } } }
  GRAPH ?g_w {
    OPTIONAL {
      <${X}> <${P}name> ?old_name .
    }
    FILTER(EXISTS {
      <${X}> rdf:type ?t .
    })
  }
}`);
  });

  test('an upsert\'s WHERE stays bare, and its lookup falls back to the routed graph', async () => {
    const s = capture('several graphs');
    await Person.upsert({name: 'new'}).for({id: X}).exec(s);
    const where = s.updates[0].slice(s.updates[0].indexOf('WHERE {'));
    expect(where).toContain(`OPTIONAL { SELECT DISTINCT ?g_w_found WHERE { VALUES ?g_w_found { <${G_PEOPLE}> <${G_STAFF}> } GRAPH ?g_w_found { <${X}> rdf:type ?g_w_o } } }`);
    expect(where).not.toContain('rdf:type ?t .');
  });

  test('a shape without a targetClass updates any node it names, and its lookup finds the node by any triple', async () => {
    const plain = capture('unrouted');
    await UANote.update({text: 'new'}).for({id: X}).exec(plain);
    expect(plain.updates[0]).not.toContain('rdf:type');
    const s = new CaptureStore({mapGraphName: jena, dataRoot: D.replace(/\/$/, '')});
    setShapeGraphs(s, {[UANote.shape.id]: G_PEOPLE, [UASubNote.shape.id]: G_STAFF});
    await UANote.update({text: 'new'}).for({id: X}).exec(s);
    expect(s.updates[0]).toContain(`GRAPH ?g_w { <${X}> ?g_w_p ?g_w_o } } }`);
    expect(s.updates[0]).not.toContain('rdf:type');
  });

  test('a computed update requires the type in an EXISTS, after its BIND (one solution per node, whatever its types)', async () => {
    const s = capture('unrouted');
    await Person.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).for({id: X}).exec(s);
    const where = s.updates[0].slice(s.updates[0].indexOf('WHERE {'));
    expect(where).toMatch(/BIND\(UCASE\([^)]*\) AS \?computed_hobby\)\n  FILTER\(EXISTS \{\n    <[^>]+> rdf:type \?t \.\n  \}\)\n\}$/);
    expect(s.updates[0].match(/\?t\b/g)).toHaveLength(1);
  });
});

describeFuseki('update on an absent id', () => {
  let store: FusekiStore;
  const ROUTINGS: Routing[] = ['unrouted', 'one graph', 'several graphs'];

  /** Every triple with `subject`, in any graph. */
  async function triplesOf(subject: string): Promise<string[]> {
    const json = await store.rawQuery(
      `SELECT ?p ?o WHERE { { GRAPH ?g { <${subject}> ?p ?o } } UNION { <${subject}> ?p ?o } }`,
    );
    if (!json || !isSparqlSelectResults(json)) throw new Error('expected a result set');
    return json.results.bindings.map((b) => `${b.p!.value} ${b.o!.value}`).sort();
  }

  /** The development warnings `run` printed: the store's check that an update matched no node. */
  async function warningsOf(run: () => Promise<unknown>): Promise<string[]> {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await run();
      return warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }
  }

  async function storeFor(routing: Routing): Promise<FusekiStore> {
    const s = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
    if (routing !== 'unrouted') setShapeGraphs(s, ROUTES[routing]);
    return s;
  }

  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    // Every routed graph exists before the updates run: Jena matches nothing under `WITH <g>` for a
    // graph that does not exist yet, which would hide a write of an absent id.
    await executeSparqlUpdate(
      `INSERT DATA { ${[G_ARTICLES, G_PEOPLE, G_STAFF].map((g) => `GRAPH <${g}> { <${D}seed> <${P}seed> "x" }`).join(' ')} }`,
    );
    store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  test.each(ROUTINGS)('%s: an absent id writes nothing', async (routing) => {
    const s = await storeFor(routing);
    const id = `${D}absent/${routing.replace(/ /g, '-')}`;
    const warnings = await warningsOf(() => updateOf(routing, id, s));
    expect(await triplesOf(id)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`update().for(<${id}>)`);
    expect(warnings[0]).toContain('matched no node');
  });

  test.each(ROUTINGS)('%s: an untyped half-node is not updated', async (routing) => {
    const s = await storeFor(routing);
    const id = `${D}half/${routing.replace(/ /g, '-')}`;
    const graph = routing === 'unrouted' ? undefined : routing === 'one graph' ? G_ARTICLES : G_PEOPLE;
    const predicate = routing === 'several graphs' ? `${P}name` : `${NG}title`;
    const triple = `<${id}> <${predicate}> "old" .`;
    await executeSparqlUpdate(`INSERT DATA { ${graph ? `GRAPH <${graph}> { ${triple} }` : triple} }`);
    const warnings = await warningsOf(() => updateOf(routing, id, s));
    expect(await triplesOf(id)).toEqual([`${predicate} old`]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`<${id}> has no rdf:type`);
  });

  test.each(ROUTINGS)('%s: a present id is still updated', async (routing) => {
    const s = await storeFor(routing);
    const id = `${D}present/${routing.replace(/ /g, '-')}`;
    if (routing === 'several graphs') {
      // An employee lives in the staff graph; the update finds it there.
      await Employee.create({__id: id, name: 'old'} as never).exec(s);
    } else {
      await NGArticle.create({__id: id, title: 'old'} as never).exec(s);
    }
    const warnings = await warningsOf(() => updateOf(routing, id, s));
    const predicate = routing === 'several graphs' ? `${P}name` : `${NG}title`;
    expect((await triplesOf(id)).filter((t) => t.startsWith(predicate))).toEqual([`${predicate} new`]);
    // The check is scoped as the update's WHERE: a node it updated is found.
    expect(warnings).toEqual([]);
  });

  test('an upsert next to an untyped half-node in another graph of the set creates the node in its routed graph', async () => {
    const s = await storeFor('several graphs');
    const id = `${D}upserted-half`;
    await executeSparqlUpdate(`INSERT DATA { GRAPH <${G_STAFF}> { <${id}> <${P}hobby> "chess" } }`);
    await Person.upsert({name: 'new'}).for({id}).exec(s);
    const json = await store.rawQuery(`SELECT ?g WHERE { GRAPH ?g { <${id}> <${P}name> "new" } }`);
    if (!json || !isSparqlSelectResults(json)) throw new Error('expected a result set');
    // The half-node does not decide the graph: the lookup finds no typed subject.
    expect(json.results.bindings.map((b) => b.g!.value)).toEqual([G_PEOPLE]);
  });

  test('an upsert of an absent id still creates it, in its routed graph', async () => {
    const s = await storeFor('several graphs');
    const id = `${D}upserted`;
    await Person.upsert({name: 'new'}).for({id}).exec(s);
    const json = await store.rawQuery(`SELECT ?g WHERE { GRAPH ?g { <${id}> a ?t } }`);
    if (!json || !isSparqlSelectResults(json)) throw new Error('expected a result set');
    expect(json.results.bindings.map((b) => b.g!.value)).toEqual([G_PEOPLE]);
  });
});
