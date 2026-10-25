/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Routed reads through a complex `sh:path`. A writer reaches the articles naming it as author
 * through `^author`; the stored triple `?article <author> ?writer` lives in the articles graph, so
 * a routed read follows it the stored way round, read with the article. Other complex paths into
 * a node in another graph are refused. Golden SPARQL without routes (unchanged) and with them,
 * then the same reads on the inferring store.
 */
import {afterAll, beforeAll, describe, expect, test} from '@jest/globals';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {isSparqlSelectResults} from '../sparql/resultMapping';
import {setShapeGraphs} from '../utils/graphRouting';
import {graphs} from '../ontologies/graphs';
import {isGraphQueryError} from '../queries/graphQuery';
import {linkedPackage} from '../utils/Package';
import {objectProperty} from '../shapes/SHACL';
import {NG, NGArticle, NGPerson, NGPhoto} from '../test-helpers/graph-routing-nested-fixtures';
import {createTestDataset, DATASET_NAME, deleteTestDataset, executeSparqlUpdate, FUSEKI_BASE_URL} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';

import '../ontologies/rdf';
import '../ontologies/xsd';

const {linkedShape} = linkedPackage('reads-across-graphs-paths-test');

/** A person who reaches the articles naming them as author through an inverse path. */
@linkedShape
class RAWriter extends NGPerson {
  static targetClass = {id: `${NG}RWriter`};

  @objectProperty({path: {inv: {id: `${NG}author`}}, shape: NGArticle})
  get articles(): NGArticle[] {
    return [];
  }

  @objectProperty({path: {seq: [{inv: {id: `${NG}author`}}, {id: `${NG}reviewer`}]}, shape: NGPhoto})
  get reviewedPhotos(): NGPhoto[] {
    return [];
  }

  @objectProperty({path: {inv: {id: `${NG}friend`}}, shape: NGPerson})
  get friendOf(): NGPerson[] {
    return [];
  }
}

const D = 'https://acme.example/data/';
const G_ARTICLES = `${D}graph/articles`;
const G_PEOPLE = `${D}graph/people`;
const jena = (iri: string) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null);
const ROUTES = {
  [NGArticle.shape.id]: G_ARTICLES,
  [NGPerson.shape.id]: G_PEOPLE,
};

class CaptureStore extends SparqlDataset {
  queries: string[] = [];
  constructor(options?: SparqlOptions) {
    super(options);
  }
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    this.queries.push(sparql);
    if (/^ASK/m.test(sparql)) return {head: {}, boolean: false} as SparqlQueryResults;
    if (sparql.includes('COUNT(')) {
      return {head: {vars: ['count']}, results: {bindings: [{count: {type: 'literal', value: '0'}}]}};
    }
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(): Promise<void> {}
}

function capture(routed: boolean): CaptureStore {
  const s = new CaptureStore({mapGraphName: jena, dataRoot: D.replace(/\/$/, '')});
  if (routed) setShapeGraphs(s, ROUTES);
  return s;
}

type Store = CaptureStore | FusekiStore;
const articleTitles = (s: Store) => RAWriter.select((w: any) => w.articles.title).exec(s);
const withArticle = (s: Store) =>
  RAWriter.select((w: any) => w.name).where((w: any) => w.articles.some((a: any) => a.title.equals('one'))).exec(s);
const countWithArticle = (s: Store) =>
  RAWriter.select().where((w: any) => w.articles.some((a: any) => a.title.equals('one'))).count(s as never);
const askWithArticle = (s: Store) =>
  RAWriter.select().where((w: any) => w.articles.some((a: any) => a.title.equals('one'))).exists(s as never);

async function sparqlOf(run: (s: CaptureStore) => Promise<unknown>, routed: boolean): Promise<string> {
  const s = capture(routed);
  await run(s);
  expect(s.queries).toHaveLength(1);
  return s.queries[0];
}

async function errorOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (e: unknown) => e,
  );
}

/** The SPARQL these reads compiled to without routes before routed paths were read the stored way. */
const UNROUTED = {
  articleTitles: `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_title ?a1
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/RWriter> .
  OPTIONAL {
    ?a0 ^<https://example.org/graph-routing-nested/author> ?a1 .
    OPTIONAL {
      ?a1 <https://example.org/graph-routing-nested/title> ?a1_title .
    }
  }
}`,
  withArticle: `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/RWriter> .
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/name> ?a0_name .
  }
  FILTER(EXISTS {
    ?a0 ^<https://example.org/graph-routing-nested/author> ?a1 .
    ?a1 <https://example.org/graph-routing-nested/title> ?a1_title .
    FILTER(?a1_title = "one")
  })
}`,
  countWithArticle: `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT (COUNT(DISTINCT ?a0) AS ?count)
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/RWriter> .
  FILTER(EXISTS {
    ?a0 ^<https://example.org/graph-routing-nested/author> ?a1 .
    ?a1 <https://example.org/graph-routing-nested/title> ?a1_title .
    FILTER(?a1_title = "one")
  })
}`,
  askWithArticle: `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
ASK WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/RWriter> .
  FILTER(EXISTS {
    ?a0 ^<https://example.org/graph-routing-nested/author> ?a1 .
    ?a1 <https://example.org/graph-routing-nested/title> ?a1_title .
    FILTER(?a1_title = "one")
  })
}`,
};

/**
 * The same reads with routes: the inverse step is read as `?a1 <author> ?a0`, with the article. A
 * linked node bound only inside `EXISTS` reads every graph the routing knows (`?g_a1`).
 */
const ROUTED = {
  articleTitles: `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_title ?a1
FROM NAMED <${G_ARTICLES}>
FROM NAMED <${G_PEOPLE}>
WHERE {
  GRAPH <${G_PEOPLE}> {
    ?a0 rdf:type <https://example.org/graph-routing-nested/RWriter> .
  }
  OPTIONAL {
    GRAPH <${G_ARTICLES}> {
      ?a1 <https://example.org/graph-routing-nested/author> ?a0 .
    }
    OPTIONAL {
      GRAPH <${G_ARTICLES}> {
        ?a1 <https://example.org/graph-routing-nested/title> ?a1_title .
      }
    }
  }
}`,
  withArticle: `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  GRAPH <${G_PEOPLE}> {
    ?a0 rdf:type <https://example.org/graph-routing-nested/RWriter> .
  }
  OPTIONAL {
    GRAPH <${G_PEOPLE}> {
      ?a0 <https://example.org/graph-routing-nested/name> ?a0_name .
    }
  }
  FILTER(EXISTS {
    VALUES ?g_a1 { <urn:x-arq:DefaultGraph> <${G_ARTICLES}> <${G_PEOPLE}> }
    GRAPH ?g_a1 {
      ?a1 <https://example.org/graph-routing-nested/author> ?a0 .
    }
    GRAPH ?g_a1 {
      ?a1 <https://example.org/graph-routing-nested/title> ?a1_title .
    }
    FILTER(?a1_title = "one")
  })
}`,
  countWithArticle: `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT (COUNT(DISTINCT ?a0) AS ?count)
WHERE {
  GRAPH <${G_PEOPLE}> {
    ?a0 rdf:type <https://example.org/graph-routing-nested/RWriter> .
  }
  FILTER(EXISTS {
    VALUES ?g_a1 { <urn:x-arq:DefaultGraph> <${G_ARTICLES}> <${G_PEOPLE}> }
    GRAPH ?g_a1 {
      ?a1 <https://example.org/graph-routing-nested/author> ?a0 .
    }
    GRAPH ?g_a1 {
      ?a1 <https://example.org/graph-routing-nested/title> ?a1_title .
    }
    FILTER(?a1_title = "one")
  })
}`,
  askWithArticle: `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
ASK WHERE {
  GRAPH <${G_PEOPLE}> {
    ?a0 rdf:type <https://example.org/graph-routing-nested/RWriter> .
  }
  FILTER(EXISTS {
    VALUES ?g_a1 { <urn:x-arq:DefaultGraph> <${G_ARTICLES}> <${G_PEOPLE}> }
    GRAPH ?g_a1 {
      ?a1 <https://example.org/graph-routing-nested/author> ?a0 .
    }
    GRAPH ?g_a1 {
      ?a1 <https://example.org/graph-routing-nested/title> ?a1_title .
    }
    FILTER(?a1_title = "one")
  })
}`,
};

const reads = {articleTitles, withArticle, countWithArticle, askWithArticle};

describe('routed reads through complex paths: golden SPARQL', () => {
  test.each(Object.keys(reads) as (keyof typeof reads)[])('without routes, %s compiles as before', async (name) => {
    expect(await sparqlOf(reads[name], false)).toBe(UNROUTED[name]);
  });

  test.each(Object.keys(reads) as (keyof typeof reads)[])(
    'with routes, %s reads the inverse step the stored way round, in the articles graph',
    async (name) => {
      expect(await sparqlOf(reads[name], true)).toBe(ROUTED[name]);
    },
  );

  test('an inverse path inside one graph is left as it is', async () => {
    const sparql = await sparqlOf((s) => RAWriter.select((w: any) => w.friendOf.name).exec(s), true);
    expect(sparql).toContain(`GRAPH <${G_PEOPLE}>`);
    expect(sparql).toContain(`^<${NG}friend>`);
  });

  test('a sequence path into a node in another graph is refused before anything is sent', async () => {
    for (const run of [
      (s: CaptureStore) => RAWriter.select((w: any) => w.reviewedPhotos.caption).exec(s),
      (s: CaptureStore) =>
        RAWriter.select().where((w: any) => w.reviewedPhotos.some((p: any) => p.caption.equals('x'))).exec(s),
      (s: CaptureStore) =>
        RAWriter.select().where((w: any) => w.reviewedPhotos.some((p: any) => p.caption.equals('x'))).count(s as never),
    ]) {
      const s = capture(true);
      // A select names the query in its error and keeps the typed one as its `cause`.
      const thrown = await errorOf(run(s));
      const error = (thrown as {cause?: unknown}).cause ?? thrown;
      expect(isGraphQueryError(error, 'unsupported-query-kind')).toBe(true);
      expect(String((error as Error).message)).toContain('property path');
      expect(s.queries).toEqual([]);
    }
  });

  test('without routes, the same sequence path is read as before', async () => {
    const sparql = await sparqlOf((s) => RAWriter.select((w: any) => w.reviewedPhotos.caption).exec(s), false);
    expect(sparql).toContain(`^<${NG}author>/<${NG}reviewer>`);
  });
});

describeFuseki('routed reads through complex paths', () => {
  let store: FusekiStore;
  const W = `${D}writer/w`;
  const V = `${D}writer/v`;

  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    await executeSparqlUpdate(
      `INSERT DATA { <${NG}RWriter> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${NG}Person> . }`,
    );
    store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
    setShapeGraphs(store, ROUTES);
    await RAWriter.create({__id: W, name: 'w'} as never).exec(store);
    await RAWriter.create({__id: V, name: 'v'} as never).exec(store);
    await NGArticle.create({__id: `${D}article/1`, title: 'one', author: {id: W}} as never).exec(store);
    await NGArticle.create({__id: `${D}article/2`, title: 'two', author: {id: W}} as never).exec(store);
    await NGArticle.create({__id: `${D}article/3`, title: 'three', author: {id: V}} as never).exec(store);
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  test('the stored triples are where the routing put them', async () => {
    const json = await store.rawQuery(`SELECT ?g WHERE { GRAPH ?g { <${D}article/1> <${NG}author> <${W}> } }`);
    if (!json || !isSparqlSelectResults(json)) throw new Error('expected a result set');
    expect(json.results.bindings.map((b) => b.g!.value)).toEqual([G_ARTICLES]);
  });

  test('Writer.select(w => w.articles.title) reads the articles in their graph', async () => {
    const rows = (await articleTitles(store)) as unknown as {id: string; articles: {title: string}[]}[];
    const byId = new Map(rows.map((r) => [r.id, r.articles.map((a) => a.title).sort()]));
    expect(byId.get(W)).toEqual(['one', 'two']);
    expect(byId.get(V)).toEqual(['three']);
  });

  test('.where(w => w.articles.some(…)) matches the writer, in select, count and ask', async () => {
    const rows = (await withArticle(store)) as unknown as {id: string; name: string}[];
    expect(rows.map((r) => r.id)).toEqual([W]);
    expect(await countWithArticle(store)).toBe(1);
    expect(await askWithArticle(store)).toBe(true);
  });
  test('a sequence path across graphs is refused, on the live store too', async () => {
    const thrown = await errorOf(RAWriter.select((w: any) => w.reviewedPhotos.caption).exec(store));
    const error = (thrown as {cause?: unknown}).cause ?? thrown;
    expect(isGraphQueryError(error, 'unsupported-query-kind')).toBe(true);
  });
});
