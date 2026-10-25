/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Writes across graphs, golden SPARQL. Without routes every mutation compiles byte for byte as it
 * did before (the strings below were produced by the compiler before this change). With routes
 * (Article → articles, Person → people): a delete by id removes the links to its subject in every
 * graph that may hold one (`GRAPH ?g_in`), and a where clause or a computed field reads a linked
 * node in its shape's graphs, in a block nested in the mutation's own graph. A link inside the
 * subject's own graph compiles as before.
 */
import {describe, expect, test} from '@jest/globals';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {setShapeGraphs} from '../utils/graphRouting';
import {graphs} from '../ontologies/graphs';
import {isGraphQueryError} from '../queries/graphQuery';
import {NGArticle, NGPerson, NGPhoto} from '../test-helpers/graph-routing-nested-fixtures';
import {mutationEffects} from '../queries/queryDependencies';
import {LinkedStorage} from '../utils/LinkedStorage';
import type {IDataset} from '../interfaces/IDataset';

import '../ontologies/rdf';
import '../ontologies/xsd';

const D = 'https://acme.example/data/';
const G_ARTICLES = `${D}graph/articles`;
const G_PEOPLE = `${D}graph/people`;
const jena = (iri: string) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null);

/** A SPARQL store that records what it is sent and answers empty results. */
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

function store(routed: boolean, options: SparqlOptions = {mapGraphName: jena}): CaptureStore {
  const s = new CaptureStore({...options, dataRoot: D.replace(/\/$/, '')});
  if (routed) setShapeGraphs(s, {[NGArticle.shape.id]: G_ARTICLES, [NGPerson.shape.id]: G_PEOPLE});
  return s;
}

/** The mutations, in the order of the golden strings. */
const mutations: [string, (s: CaptureStore) => Promise<unknown>][] = [
  ['delete by id', (s) => NGPerson.delete({id: `${D}p/ann`}).exec(s)],
  ['update where through a link', (s) => NGArticle.update({title: 'y'}).where((a) => a.author.name.equals('x')).exec(s)],
  ['delete where through a link', (s) => NGArticle.deleteWhere((a) => a.author.name.equals('x')).exec(s)],
  ['computed update by id', (s) => NGArticle.update((a: any) => ({title: a.author.name.ucase()})).for({id: `${D}a/1`}).exec(s)],
  ['delete of two ids', (s) => NGPerson.delete([{id: `${D}p/a`}, {id: `${D}p/b`}] as never).exec(s)],
  [
    'update where through a link in the same graph',
    (s) => NGPerson.update({name: 'q'}).where((p: any) => p.friends.some((f: any) => f.name.equals('x'))).exec(s),
  ],
  [
    'delete where through a link in the same graph',
    (s) => NGPerson.deleteWhere((p: any) => p.friends.some((f: any) => f.name.equals('x'))).exec(s),
  ],
  [
    'computed update where',
    (s) =>
      NGArticle.update((a: any) => ({title: a.author.name.ucase()}))
        .where((a: any) => a.author.name.equals('x'))
        .exec(s),
  ],
];

async function sparqlOf(s: CaptureStore, run: (s: CaptureStore) => Promise<unknown>): Promise<string> {
  const before = s.updates.length;
  await run(s);
  expect(s.updates.length).toBe(before + 1);
  return s.updates[s.updates.length - 1];
}

/** Compiled without routes, before this change. */
const UNROUTED: string[] = [
  // delete by id
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  <${D}p/ann> ?p ?o .
  ?s ?p2 <${D}p/ann> .
  <${D}p/ann> rdf:type <https://example.org/graph-routing-nested/Person> .
  ?c_0_0 ?c_0_p ?c_0_o .
}
WHERE {
  <${D}p/ann> rdf:type <https://example.org/graph-routing-nested/Person> .
  {
    <${D}p/ann> ?p ?o .
  }
  UNION
  {
    ?s ?p2 <${D}p/ann> .
  }
  UNION
  {
    <${D}p/ann> <https://example.org/graph-routing-nested/avatar> ?c_0_0 .
    ?c_0_0 ?c_0_p ?c_0_o .
    FILTER(!(sameTerm(?c_0_0, rdf:nil)))
  }
}`,
  // update where through a link
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
}
INSERT {
  ?a0 <https://example.org/graph-routing-nested/title> "y" .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Article> .
  ?a0 <https://example.org/graph-routing-nested/author> ?a1 .
  ?a1 <https://example.org/graph-routing-nested/name> ?a1_name .
  FILTER(?a1_name = "x")
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
  }
}`,
  // delete where through a link
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  ?a0 ?p ?o .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Article> .
  ?a0 ?p ?o .
  ?a0 <https://example.org/graph-routing-nested/author> ?a1 .
  ?a1 <https://example.org/graph-routing-nested/name> ?a1_name .
  FILTER(?a1_name = "x")
}`,
  // computed update by id
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  <${D}a/1> <https://example.org/graph-routing-nested/title> ?old_title .
}
INSERT {
  <${D}a/1> <https://example.org/graph-routing-nested/title> ?computed_title .
}
WHERE {
  OPTIONAL {
    <${D}a/1> <https://example.org/graph-routing-nested/author> ?__trav_0__ .
    OPTIONAL {
      ?__trav_0__ <https://example.org/graph-routing-nested/name> ?__trav_0___name .
    }
  }
  OPTIONAL {
    <${D}a/1> <https://example.org/graph-routing-nested/title> ?old_title .
  }
  BIND(UCASE(?__trav_0___name) AS ?computed_title)
  FILTER(EXISTS {
    <${D}a/1> rdf:type ?t .
  })
}`,
  // delete of two ids
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  <${D}p/a> ?p_0 ?o_0 .
  ?s_0 ?p2_0 <${D}p/a> .
  <${D}p/a> rdf:type <https://example.org/graph-routing-nested/Person> .
  ?c_0_0_0 ?c_0_0_p ?c_0_0_o .
  <${D}p/b> ?p_1 ?o_1 .
  ?s_1 ?p2_1 <${D}p/b> .
  <${D}p/b> rdf:type <https://example.org/graph-routing-nested/Person> .
  ?c_1_0_0 ?c_1_0_p ?c_1_0_o .
}
WHERE {
  <${D}p/a> rdf:type <https://example.org/graph-routing-nested/Person> .
  <${D}p/b> rdf:type <https://example.org/graph-routing-nested/Person> .
  {
    <${D}p/a> ?p_0 ?o_0 .
  }
  UNION
  {
    ?s_0 ?p2_0 <${D}p/a> .
  }
  UNION
  {
    <${D}p/a> <https://example.org/graph-routing-nested/avatar> ?c_0_0_0 .
    ?c_0_0_0 ?c_0_0_p ?c_0_0_o .
    FILTER(!(sameTerm(?c_0_0_0, rdf:nil)))
  }
  UNION
  {
    <${D}p/b> ?p_1 ?o_1 .
  }
  UNION
  {
    ?s_1 ?p2_1 <${D}p/b> .
  }
  UNION
  {
    <${D}p/b> <https://example.org/graph-routing-nested/avatar> ?c_1_0_0 .
    ?c_1_0_0 ?c_1_0_p ?c_1_0_o .
    FILTER(!(sameTerm(?c_1_0_0, rdf:nil)))
  }
}`,
  // update where through a link in the same graph (some)
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  ?a0 <https://example.org/graph-routing-nested/name> ?old_name .
}
INSERT {
  ?a0 <https://example.org/graph-routing-nested/name> "q" .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Person> .
  FILTER(EXISTS {
    ?a0 <https://example.org/graph-routing-nested/friend> ?a1 .
    ?a1 <https://example.org/graph-routing-nested/name> ?a1_name .
    FILTER(?a1_name = "x")
  })
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/name> ?old_name .
  }
}`,
  // delete where through a link in the same graph (some)
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  ?a0 ?p ?o .
  ?c_0_0 ?c_0_p ?c_0_o .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Person> .
  FILTER(EXISTS {
    ?a0 <https://example.org/graph-routing-nested/friend> ?a1 .
    ?a1 <https://example.org/graph-routing-nested/name> ?a1_name .
    FILTER(?a1_name = "x")
  })
  {
    ?a0 ?p ?o .
  }
  UNION
  {
    ?a0 rdf:type <https://example.org/graph-routing-nested/Person> .
    ?a0 <https://example.org/graph-routing-nested/avatar> ?c_0_0 .
    ?c_0_0 ?c_0_p ?c_0_o .
    FILTER(!(sameTerm(?c_0_0, rdf:nil)))
  }
}`,
  // computed update where
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
}
INSERT {
  ?a0 <https://example.org/graph-routing-nested/title> ?computed_title .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Article> .
  ?a0 <https://example.org/graph-routing-nested/author> ?a1 .
  ?a1 <https://example.org/graph-routing-nested/name> ?a1_name .
  FILTER(?a1_name = "x")
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/author> ?__trav_0__ .
    OPTIONAL {
      ?__trav_0__ <https://example.org/graph-routing-nested/name> ?__trav_0___name .
    }
  }
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
  }
  BIND(UCASE(?__trav_0___name) AS ?computed_title)
}`,
];

/** Compiled with routes. */
const ROUTED: string[] = [
  // delete by id
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/people>
DELETE {
  <${D}p/ann> ?p ?o .
  <${D}p/ann> rdf:type <https://example.org/graph-routing-nested/Person> .
  ?c_0_0 ?c_0_p ?c_0_o .
  GRAPH ?g_in {
    ?s ?p2 <${D}p/ann> .
  }
}
WHERE {
  <${D}p/ann> rdf:type <https://example.org/graph-routing-nested/Person> .
  {
    <${D}p/ann> ?p ?o .
  }
  UNION
  {
    VALUES ?g_in { <urn:x-arq:DefaultGraph> <${D}graph/articles> <${D}graph/people> }
    GRAPH ?g_in {
      ?s ?p2 <${D}p/ann> .
    }
  }
  UNION
  {
    <${D}p/ann> <https://example.org/graph-routing-nested/avatar> ?c_0_0 .
    ?c_0_0 ?c_0_p ?c_0_o .
    FILTER(!(sameTerm(?c_0_0, rdf:nil)))
  }
}`,
  // update where through a link
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/articles>
DELETE {
  ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
}
INSERT {
  ?a0 <https://example.org/graph-routing-nested/title> "y" .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Article> .
  ?a0 <https://example.org/graph-routing-nested/author> ?a1 .
  GRAPH <${D}graph/people> {
    ?a1 <https://example.org/graph-routing-nested/name> ?a1_name .
  }
  FILTER(?a1_name = "x")
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
  }
}`,
  // delete where through a link
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/articles>
DELETE {
  ?a0 ?p ?o .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Article> .
  ?a0 ?p ?o .
  ?a0 <https://example.org/graph-routing-nested/author> ?a1 .
  GRAPH <${D}graph/people> {
    ?a1 <https://example.org/graph-routing-nested/name> ?a1_name .
  }
  FILTER(?a1_name = "x")
}`,
  // computed update by id
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/articles>
DELETE {
  <${D}a/1> <https://example.org/graph-routing-nested/title> ?old_title .
}
INSERT {
  <${D}a/1> <https://example.org/graph-routing-nested/title> ?computed_title .
}
WHERE {
  OPTIONAL {
    <${D}a/1> <https://example.org/graph-routing-nested/author> ?__trav_0__ .
    OPTIONAL {
      GRAPH <${D}graph/people> {
        ?__trav_0__ <https://example.org/graph-routing-nested/name> ?__trav_0___name .
      }
    }
  }
  OPTIONAL {
    <${D}a/1> <https://example.org/graph-routing-nested/title> ?old_title .
  }
  BIND(UCASE(?__trav_0___name) AS ?computed_title)
  FILTER(EXISTS {
    <${D}a/1> rdf:type ?t .
  })
}`,
  // delete of two ids
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/people>
DELETE {
  <${D}p/a> ?p_0 ?o_0 .
  <${D}p/a> rdf:type <https://example.org/graph-routing-nested/Person> .
  ?c_0_0_0 ?c_0_0_p ?c_0_0_o .
  <${D}p/b> ?p_1 ?o_1 .
  <${D}p/b> rdf:type <https://example.org/graph-routing-nested/Person> .
  ?c_1_0_0 ?c_1_0_p ?c_1_0_o .
  GRAPH ?g_in_0 {
    ?s_0 ?p2_0 <${D}p/a> .
  }
  GRAPH ?g_in_1 {
    ?s_1 ?p2_1 <${D}p/b> .
  }
}
WHERE {
  <${D}p/a> rdf:type <https://example.org/graph-routing-nested/Person> .
  <${D}p/b> rdf:type <https://example.org/graph-routing-nested/Person> .
  {
    <${D}p/a> ?p_0 ?o_0 .
  }
  UNION
  {
    VALUES ?g_in_0 { <urn:x-arq:DefaultGraph> <${D}graph/articles> <${D}graph/people> }
    GRAPH ?g_in_0 {
      ?s_0 ?p2_0 <${D}p/a> .
    }
  }
  UNION
  {
    <${D}p/a> <https://example.org/graph-routing-nested/avatar> ?c_0_0_0 .
    ?c_0_0_0 ?c_0_0_p ?c_0_0_o .
    FILTER(!(sameTerm(?c_0_0_0, rdf:nil)))
  }
  UNION
  {
    <${D}p/b> ?p_1 ?o_1 .
  }
  UNION
  {
    VALUES ?g_in_1 { <urn:x-arq:DefaultGraph> <${D}graph/articles> <${D}graph/people> }
    GRAPH ?g_in_1 {
      ?s_1 ?p2_1 <${D}p/b> .
    }
  }
  UNION
  {
    <${D}p/b> <https://example.org/graph-routing-nested/avatar> ?c_1_0_0 .
    ?c_1_0_0 ?c_1_0_p ?c_1_0_o .
    FILTER(!(sameTerm(?c_1_0_0, rdf:nil)))
  }
}`,
  // update where through a link in the same graph (some)
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/people>
DELETE {
  ?a0 <https://example.org/graph-routing-nested/name> ?old_name .
}
INSERT {
  ?a0 <https://example.org/graph-routing-nested/name> "q" .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Person> .
  FILTER(EXISTS {
    ?a0 <https://example.org/graph-routing-nested/friend> ?a1 .
    ?a1 <https://example.org/graph-routing-nested/name> ?a1_name .
    FILTER(?a1_name = "x")
  })
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/name> ?old_name .
  }
}`,
  // delete where through a link in the same graph (some)
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/people>
DELETE {
  ?a0 ?p ?o .
  ?c_0_0 ?c_0_p ?c_0_o .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Person> .
  FILTER(EXISTS {
    ?a0 <https://example.org/graph-routing-nested/friend> ?a1 .
    ?a1 <https://example.org/graph-routing-nested/name> ?a1_name .
    FILTER(?a1_name = "x")
  })
  {
    ?a0 ?p ?o .
  }
  UNION
  {
    ?a0 rdf:type <https://example.org/graph-routing-nested/Person> .
    ?a0 <https://example.org/graph-routing-nested/avatar> ?c_0_0 .
    ?c_0_0 ?c_0_p ?c_0_o .
    FILTER(!(sameTerm(?c_0_0, rdf:nil)))
  }
}`,
  // computed update where
  `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
WITH <${D}graph/articles>
DELETE {
  ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
}
INSERT {
  ?a0 <https://example.org/graph-routing-nested/title> ?computed_title .
}
WHERE {
  ?a0 rdf:type <https://example.org/graph-routing-nested/Article> .
  ?a0 <https://example.org/graph-routing-nested/author> ?a1 .
  GRAPH <${D}graph/people> {
    ?a1 <https://example.org/graph-routing-nested/name> ?a1_name .
  }
  FILTER(?a1_name = "x")
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/author> ?__trav_0__ .
    OPTIONAL {
      GRAPH <${D}graph/people> {
        ?__trav_0__ <https://example.org/graph-routing-nested/name> ?__trav_0___name .
      }
    }
  }
  OPTIONAL {
    ?a0 <https://example.org/graph-routing-nested/title> ?old_title .
  }
  BIND(UCASE(?__trav_0___name) AS ?computed_title)
}`,
];

describe('writes across graphs: golden SPARQL', () => {
  test.each(mutations.map(([name, run], i) => [name, run, i] as const))(
    'without routes, %s compiles byte for byte as before',
    async (_name, run, i) => {
      expect(await sparqlOf(store(false), run)).toBe(UNROUTED[i]);
      // A store without a name for the default graph compiles the same text.
      expect(await sparqlOf(store(false, {}), run)).toBe(UNROUTED[i]);
    },
  );

  test.each(mutations.map(([name, run], i) => [name, run, i] as const))(
    'with routes, %s',
    async (_name, run, i) => {
      expect(await sparqlOf(store(true), run)).toBe(ROUTED[i]);
    },
  );

  test('a link inside the subject\'s own graph reads there, as before (no nested GRAPH block)', () => {
    for (const i of [5, 6]) {
      expect(ROUTED[i]).toContain(`WITH <${G_PEOPLE}>`);
      expect(ROUTED[i]).not.toContain('GRAPH');
    }
  });

  test('the template stays in the subject\'s graph; only the linked node\'s read is nested', () => {
    expect(ROUTED[1].startsWith(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\nWITH <${G_ARTICLES}>\nDELETE {`)).toBe(true);
    expect(ROUTED[1]).toContain(`GRAPH <${G_PEOPLE}> {\n    ?a1 <`);
  });

  test('a delete of an unrouted shape linked from a routed one removes the links in the default graph and there', async () => {
    const sparql = await sparqlOf(store(true), (s) => NGPhoto.delete({id: `${D}photo/1`}).exec(s));
    expect(sparql).not.toContain('WITH');
    expect(sparql).toContain(`VALUES ?g_in { <urn:x-arq:DefaultGraph> <${G_PEOPLE}> }`);
    expect(sparql).toContain('GRAPH ?g_in {\n    ?s ?p2 <https://acme.example/data/photo/1> .\n  }');
  });

  test('a delete that keeps incoming links is unchanged under routing', async () => {
    const {DeleteBuilder} = await import('../queries/DeleteBuilder');
    const sparql = await sparqlOf(store(true), (s) => DeleteBuilder.from(NGPerson, {id: `${D}p/ann`})._keepingIncoming().exec(s));
    expect(sparql).toContain(`WITH <${G_PEOPLE}>`);
    expect(sparql).not.toContain('?p2');
    expect(sparql).not.toContain('g_in');
  });

  test('a routed delete whose links may be in the default graph needs the store\'s name for it', async () => {
    const s = store(true, {});
    const error = await NGPerson.delete({id: `${D}p/ann`}).exec(s).then(() => undefined, (e: unknown) => e);
    expect(isGraphQueryError(error, 'unsupported-query-kind')).toBe(true);
    expect(s.updates).toEqual([]);
  });
});

describe('writes across graphs: live-query effects', () => {
  test('a delete by id that removes links in other graphs names no graph; one that keeps them names its own', async () => {
    const {DeleteBuilder} = await import('../queries/DeleteBuilder');
    const ds = {} as unknown as IDataset;
    LinkedStorage.setDatasetForShapes(ds, [NGArticle], {graph: G_ARTICLES});
    LinkedStorage.setDatasetForShapes(ds, [NGPerson], {graph: G_PEOPLE});
    try {
      expect(mutationEffects(NGPerson.delete({id: `${D}p/ann`})).graph).toBeUndefined();
      expect(mutationEffects(DeleteBuilder.from(NGPerson, {id: `${D}p/ann`})._keepingIncoming()).graph).toBe(G_PEOPLE);
      expect(mutationEffects(NGPerson.update({name: 'x'}).for({id: `${D}p/ann`})).graph).toBe(G_PEOPLE);
    } finally {
      LinkedStorage.unsetDatasetForShape(NGArticle);
      LinkedStorage.unsetDatasetForShape(NGPerson);
    }
  });
});
