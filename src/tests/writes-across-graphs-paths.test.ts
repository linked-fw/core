/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Writes across graphs through more than one hop: an inverse property path (`^author`), `EXISTS`
 * patterns, a traversal from a linked node, `contains` below a linked node, a linked node in the
 * default graph under `WITH`, a subject found at write time (`GRAPH ?g_w`), and the refusals. Golden
 * SPARQL, then the same writes on the inferring store.
 */
import {afterAll, beforeAll, describe, expect, test} from '@jest/globals';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {setShapeGraphs} from '../utils/graphRouting';
import {graphs} from '../ontologies/graphs';
import {isGraphQueryError} from '../queries/graphQuery';
import {linkedPackage} from '../utils/Package';
import {objectProperty} from '../shapes/SHACL';
import {NG, NGArticle, NGPerson, NGPhoto} from '../test-helpers/graph-routing-nested-fixtures';
import {Employee, Person} from '../test-helpers/query-fixtures';
import {
  createTestDataset,
  DATASET_NAME,
  deleteTestDataset,
  executeSparqlUpdate,
  FUSEKI_BASE_URL,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {isSparqlSelectResults} from '../sparql/resultMapping';

import '../ontologies/rdf';
import '../ontologies/xsd';

const {linkedShape} = linkedPackage('writes-across-graphs-paths-test');

/** A person who reaches the articles naming them as author through an inverse path. */
@linkedShape
class WAWriter extends NGPerson {
  static targetClass = {id: `${NG}Writer`};

  @objectProperty({path: {inv: {id: `${NG}author`}}, shape: NGArticle})
  get articles(): NGArticle[] {
    return [];
  }

  @objectProperty({path: {inv: {id: `${NG}author`}}, shape: NGArticle, maxCount: 1})
  get firstArticle(): NGArticle {
    return null as unknown as NGArticle;
  }

  @objectProperty({path: {seq: [{inv: {id: `${NG}author`}}, {id: `${NG}reviewer`}]}, shape: NGPhoto})
  get reviewedPhotos(): NGPhoto[] {
    return [];
  }

  @objectProperty({path: {alt: [{id: `${NG}pinned`}, {id: `${NG}featured`}]}, shape: NGArticle})
  get highlighted(): NGArticle[] {
    return [];
  }
}

const D = 'https://acme.example/data/';
const G_ARTICLES = `${D}graph/articles`;
const G_PEOPLE = `${D}graph/people`;
const G_STAFF = `${D}graph/staff`;
const jena = (iri: string) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null);
const ROUTES = {
  [NGArticle.shape.id]: G_ARTICLES,
  [NGPerson.shape.id]: G_PEOPLE,
  [Person.shape.id]: G_PEOPLE,
  [Employee.shape.id]: G_STAFF,
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

function capture(options: SparqlOptions = {mapGraphName: jena}): CaptureStore {
  const s = new CaptureStore({...options, dataRoot: D.replace(/\/$/, '')});
  setShapeGraphs(s, ROUTES);
  return s;
}

async function sparqlOf(run: (s: CaptureStore) => Promise<unknown>, s = capture()): Promise<string> {
  await run(s);
  expect(s.updates).toHaveLength(1);
  return s.updates[0];
}

async function errorOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (e: unknown) => e,
  );
}

const inverseExists = (s: CaptureStore | FusekiStore) =>
  WAWriter.update({name: 'z'}).where((w: any) => w.articles.some((a: any) => a.title.equals('one'))).exec(s);
const defaultUnderWith = (s: CaptureStore | FusekiStore) =>
  NGPerson.update({name: 'z'}).where((p) => p.favoritePhoto.caption.equals('sea')).exec(s);
const nestedExists = (s: CaptureStore | FusekiStore) =>
  NGArticle.update({title: 'z'}).where((a: any) => a.author.friends.some((f: any) => f.name.equals('x'))).exec(s);
const ownedBelowLinked = (s: CaptureStore | FusekiStore) =>
  NGArticle.update({title: 'z'}).where((a: any) => a.author.avatar.url.equals('x')).exec(s);
const computedThroughInverse = (s: CaptureStore | FusekiStore, id = `${D}writer/w`) =>
  WAWriter.update((w: any) => ({name: w.firstArticle.title.ucase()})).for({id}).exec(s);
const computedWhereThroughInverse = (s: CaptureStore | FusekiStore) =>
  WAWriter.update((w: any) => ({name: w.firstArticle.title.lcase()}))
    .where((w: any) => w.firstArticle.title.equals('one'))
    .exec(s);
const computedFoundAtWriteTime = (s: CaptureStore | FusekiStore, id = `${D}bob`) =>
  Person.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).for({id}).exec(s);

describe('writes across graphs through more than one hop: golden SPARQL', () => {
  test('an inverse path into another graph is read the stored way round, in the linked node\'s graph (EXISTS)', async () => {
    expect(await sparqlOf(inverseExists)).toBe(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/people>
DELETE {
  ?a0 <https://example.org/graph-routing-nested/name> ?old_name .
}
INSERT {
  ?a0 <https://example.org/graph-routing-nested/name> "z" .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Writer> .
  FILTER(EXISTS {
    GRAPH <${D}graph/articles> {
      ?a1 <https://example.org/graph-routing-nested/author> ?a0 .
    }
    GRAPH <${D}graph/articles> {
      ?a1 <https://example.org/graph-routing-nested/title> ?a1_title .
    }
    FILTER(?a1_title = "one")
  })
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/name> ?old_name .
  }
}`);
  });

  test('a linked node in the default graph, under WITH <g>, is read in the store\'s default graph', async () => {
    expect(await sparqlOf(defaultUnderWith)).toBe(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/people>
DELETE {
  ?a0 <https://example.org/graph-routing-nested/name> ?old_name .
}
INSERT {
  ?a0 <https://example.org/graph-routing-nested/name> "z" .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Person> .
  ?a0 <https://example.org/graph-routing-nested/favoritePhoto> ?a1 .
  GRAPH <urn:x-arq:DefaultGraph> {
    ?a1 <https://example.org/graph-routing-nested/caption> ?a1_caption .
  }
  FILTER(?a1_caption = "sea")
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/name> ?old_name .
  }
}`);
  });

  test('a traversal from a linked node reads in that node\'s shape\'s graphs (EXISTS)', async () => {
    expect(await sparqlOf(nestedExists)).toBe(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/articles>
DELETE {
  ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
}
INSERT {
  ?a0 <https://example.org/graph-routing-nested/title> "z" .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Article> .
  FILTER(EXISTS {
    ?a0 <https://example.org/graph-routing-nested/author> ?a1 .
    GRAPH <${D}graph/people> {
      ?a1 <https://example.org/graph-routing-nested/friend> ?a2 .
    }
    GRAPH <${D}graph/people> {
      ?a2 <https://example.org/graph-routing-nested/name> ?a2_name .
    }
    FILTER(?a2_name = "x")
  })
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
  }
}`);
  });

  test('a node owned by a linked node is read in its owner\'s graphs', async () => {
    expect(await sparqlOf(ownedBelowLinked)).toBe(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/articles>
DELETE {
  ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
}
INSERT {
  ?a0 <https://example.org/graph-routing-nested/title> "z" .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Article> .
  ?a0 <https://example.org/graph-routing-nested/author> ?a1 .
  GRAPH <${D}graph/people> {
    ?a1 <https://example.org/graph-routing-nested/avatar> ?a2 .
  }
  GRAPH <${D}graph/people> {
    ?a2 <https://example.org/graph-routing-nested/url> ?a2_url .
  }
  FILTER(?a2_url = "x")
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
  }
}`);
  });

  test('a subject found at write time (GRAPH ?g_w) reads its linked node through VALUES nested in it', async () => {
    expect(await sparqlOf((s) => computedFoundAtWriteTime(s))).toBe(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  GRAPH ?g_w {
    <${D}bob> <https://example.org/props/hobby> ?old_hobby .
  }
}
INSERT {
  GRAPH ?g_w {
    <${D}bob> <https://example.org/props/hobby> ?computed_hobby .
  }
}
WHERE {
  { SELECT DISTINCT ?g_w WHERE { VALUES ?g_w { <${D}graph/people> <${D}graph/staff> } GRAPH ?g_w { <${D}bob> rdf:type ?g_w_o } } }
  GRAPH ?g_w {
    OPTIONAL {
      <${D}bob> <https://example.org/props/bestFriend> ?__trav_0__ .
      OPTIONAL {
        VALUES ?g___trav_0__ { <${D}graph/people> <${D}graph/staff> }
        GRAPH ?g___trav_0__ {
          ?__trav_0__ <https://example.org/props/name> ?__trav_0___name .
        }
      }
    }
    OPTIONAL {
      <${D}bob> <https://example.org/props/hobby> ?old_hobby .
    }
    BIND(UCASE(?__trav_0___name) AS ?computed_hobby)
    FILTER(EXISTS {
      <${D}bob> rdf:type ?t .
    })
  }
}`);
  });

  test('a computed field through an inverse path reads the stored triple in the linked node\'s graph', async () => {
    const cases: [(s: CaptureStore) => Promise<unknown>, string][] = [
      [(s) => computedThroughInverse(s), `<${D}writer/w>`],
      [computedWhereThroughInverse, '?a0'],
    ];
    for (const [run, subject] of cases) {
      const sparql = await sparqlOf(run);
      expect(sparql).toContain(`WITH <${G_PEOPLE}>`);
      expect(sparql).not.toContain('^<');
      expect(sparql).toContain(`GRAPH <${G_ARTICLES}> {\n`);
      expect(sparql).toMatch(new RegExp(`\\?__trav_0__ <${NG}author> ${subject.replace(/[?.]/g, '\\$&')} \\.`));
    }
  });

  test('a linked node in the default graph, without a store name for it, is refused before anything is sent', async () => {
    const s = capture({});
    const error = await errorOf(defaultUnderWith(s));
    expect(isGraphQueryError(error, 'unsupported-query-kind')).toBe(true);
    expect(s.updates).toEqual([]);
  });

  test('an alternative of forward IRIs into another graph is read with the subject, the linked node in its graph', async () => {
    const sparql = await sparqlOf((s) =>
      WAWriter.update({name: 'z'}).where((w: any) => w.highlighted.some((a: any) => a.title.equals('one'))).exec(s),
    );
    expect(sparql).toContain(`WITH <${G_PEOPLE}>`);
    expect(sparql).toMatch(new RegExp(`FILTER\\(EXISTS \\{\\n    \\?a0 <${NG}pinned>\\|<${NG}featured> \\?a1 \\.\\n    GRAPH <${G_ARTICLES}> \\{\\n      \\?a1 <${NG}title> \\?a1_title \\.`));
  });

  test('a sequence path into a node in another graph is refused before anything is sent', async () => {
    const s = capture();
    const error = await errorOf(
      WAWriter.update({name: 'z'}).where((w: any) => w.reviewedPhotos.some((p: any) => p.caption.equals('x'))).exec(s),
    );
    expect(isGraphQueryError(error, 'unsupported-query-kind')).toBe(true);
    expect(String((error as Error).message)).toContain('property path');
    expect(s.updates).toEqual([]);
  });
});

describeFuseki('writes across graphs through more than one hop', () => {
  let store: FusekiStore;
  const W = `${D}writer/w`;
  const ANN = `${D}person/ann`;
  const A1 = `${D}article/1`;
  const PHOTO = `${D}photo/1`;

  async function valuesOf(subject: string, predicate: string): Promise<string[]> {
    const json = await store.rawQuery(
      `SELECT ?o WHERE { { GRAPH ?g { <${subject}> <${predicate}> ?o } } UNION { <${subject}> <${predicate}> ?o } }`,
    );
    if (!json || !isSparqlSelectResults(json)) throw new Error('expected a result set');
    return json.results.bindings.map((b) => b.o!.value).sort();
  }

  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    await executeSparqlUpdate(
      `INSERT DATA { <${NG}Writer> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${NG}Person> . ` +
        `<${(Employee as any).targetClass.id}> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${(Person as any).targetClass.id}> . }`,
    );
    store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
    setShapeGraphs(store, ROUTES);
    await WAWriter.create({__id: W, name: 'w'} as never).exec(store);
    await NGPerson.create({__id: ANN, name: 'Ann', friends: [{id: W}], avatar: {url: 'ann.png'}} as never).exec(store);
    await NGArticle.create({__id: A1, title: 'one', author: {id: W}} as never).exec(store);
    await NGArticle.create({__id: `${D}article/2`, title: 'two', author: {id: ANN}} as never).exec(store);
    await NGPhoto.create({__id: PHOTO, caption: 'sea'} as never).exec(store);
    await NGPerson.update({favoritePhoto: {id: PHOTO}} as never).for({id: ANN}).exec(store);
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  test('an inverse path into the articles graph matches the writer', async () => {
    await inverseExists(store);
    expect(await valuesOf(W, `${NG}name`)).toEqual(['z']);
    expect(await valuesOf(ANN, `${NG}name`)).toEqual(['Ann']);
  });

  test('a linked photo in the default graph, under WITH <people>, matches its person', async () => {
    await defaultUnderWith(store);
    expect(await valuesOf(ANN, `${NG}name`)).toEqual(['z']);
  });

  test('a friend of the author (EXISTS, two hops into people) and an owned avatar below the author match', async () => {
    await executeSparqlUpdate(`DELETE WHERE { GRAPH <${G_PEOPLE}> { <${W}> <${NG}name> ?n } }`);
    await executeSparqlUpdate(`INSERT DATA { GRAPH <${G_PEOPLE}> { <${W}> <${NG}name> "x" } }`);
    await nestedExists(store);
    // Article 2's author Ann has the friend w, named "x".
    expect(await valuesOf(`${D}article/2`, `${NG}title`)).toEqual(['z']);
    expect(await valuesOf(A1, `${NG}title`)).toEqual(['one']);
    const avatar = (await valuesOf(ANN, `${NG}avatar`))[0];
    await executeSparqlUpdate(
      `DELETE WHERE { GRAPH <${G_PEOPLE}> { <${avatar}> <${NG}url> ?u } } ; INSERT DATA { GRAPH <${G_PEOPLE}> { <${avatar}> <${NG}url> "x" } }`,
    );
    await NGArticle.update({title: 'two'}).for({id: `${D}article/2`}).exec(store);
    await ownedBelowLinked(store);
    expect(await valuesOf(`${D}article/2`, `${NG}title`)).toEqual(['z']);
    expect(await valuesOf(A1, `${NG}title`)).toEqual(['one']);
  });

  test('a computed field through an inverse path into the articles graph reads the article', async () => {
    await computedThroughInverse(store);
    expect(await valuesOf(W, `${NG}name`)).toEqual(['ONE']);
    await computedWhereThroughInverse(store);
    expect(await valuesOf(W, `${NG}name`)).toEqual(['one']);
  });
});
