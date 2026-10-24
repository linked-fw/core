/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Writes across graphs on the inferring store: persons are routed to a people graph, articles to
 * an articles graph, albums (and the panorama covers they own) to an albums graph; photos are
 * unrouted. A delete by id removes the links to its subject in every graph that may hold one, and
 * a where clause or a computed field reads a linked node in its own shape's graphs.
 */
import {afterAll, beforeAll, beforeEach, describe, expect, test} from '@jest/globals';
import {
  createTestDataset,
  DATASET_NAME,
  deleteTestDataset,
  executeSparqlUpdate,
  FUSEKI_BASE_URL,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {NG, NGAlbum, NGArticle, NGPerson, NGPhoto} from '../test-helpers/graph-routing-nested-fixtures';
import {Employee, Person, employeeClass, personClass, propBase} from '../test-helpers/query-fixtures';
import {setShapeGraphs} from '../utils/graphRouting';
import {isSparqlSelectResults} from '../sparql/resultMapping';

import '../ontologies/rdf';
import '../ontologies/xsd';

const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const D = 'https://acme.example/data/';
const G_ARTICLES = `${D}graph/articles`;
const G_PEOPLE = `${D}graph/people`;
const G_ALBUMS = `${D}graph/albums`;
const G_STAFF = `${D}graph/staff`;

describeFuseki('writes across graphs', () => {
  let store: FusekiStore;

  /** The graphs (named, or `default`) holding the triple `<s> <p> ?o` (any predicate by default). */
  async function graphsOf(subject: string, predicate = '?p'): Promise<string[]> {
    const json = await store.rawQuery(
      `SELECT DISTINCT ?g WHERE { { GRAPH ?g { <${subject}> ${predicate} ?o } } UNION { <${subject}> ${predicate} ?o BIND("default" AS ?g) } }`,
    );
    if (!json || !isSparqlSelectResults(json)) throw new Error('expected a result set');
    return json.results.bindings.map((b) => b.g!.value).sort();
  }

  /** The values of `<s> <p> ?o` in any graph. */
  async function valuesOf(subject: string, predicate: string): Promise<string[]> {
    const json = await store.rawQuery(
      `SELECT ?o WHERE { { GRAPH ?g { <${subject}> <${predicate}> ?o } } UNION { <${subject}> <${predicate}> ?o } }`,
    );
    if (!json || !isSparqlSelectResults(json)) throw new Error('expected a result set');
    return json.results.bindings.map((b) => b.o!.value).sort();
  }

  /** Every graph's count of triples (named graphs by IRI, `default`), to see a write went nowhere else. */
  async function namedGraphs(): Promise<string[]> {
    const json = await store.rawQuery('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
    if (!json || !isSparqlSelectResults(json)) throw new Error('expected a result set');
    return json.results.bindings.map((b) => b.g!.value).sort();
  }

  beforeAll(async () => {
    await createTestDataset();
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  describe('Person → people, Article → articles', () => {
    const ANN = `${D}person/ann`;
    const BO = `${D}person/bo`;
    const A1 = `${D}article/1`;
    const A2 = `${D}article/2`;

    beforeAll(async () => {
      await executeSparqlUpdate('DROP ALL');
      await executeSparqlUpdate(`INSERT DATA { <${NG}Panorama> <${RDFS_SUBCLASS_OF}> <${NG}Photo> . }`);
      store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
      setShapeGraphs(store, {
        [NGArticle.shape.id]: G_ARTICLES,
        [NGPerson.shape.id]: G_PEOPLE,
        [NGAlbum.shape.id]: G_ALBUMS,
      });
    });

    beforeEach(async () => {
      await executeSparqlUpdate(
        `DELETE WHERE { GRAPH <${G_ARTICLES}> { ?s ?p ?o } } ; DELETE WHERE { GRAPH <${G_PEOPLE}> { ?s ?p ?o } }`,
      );
      await NGPerson.create({__id: ANN, name: 'x'} as never).exec(store);
      await NGPerson.create({__id: BO, name: 'Bo', friends: [{id: ANN}]} as never).exec(store);
      await NGArticle.create({__id: A1, title: 'one', author: {id: ANN}} as never).exec(store);
      await NGArticle.create({__id: A2, title: 'two', author: {id: BO}} as never).exec(store);
      expect(await graphsOf(A1)).toEqual([G_ARTICLES]);
      expect(await graphsOf(ANN)).toEqual([G_PEOPLE]);
    });

    test('Person.delete(id) removes the article\'s author link in the articles graph', async () => {
      await NGPerson.delete({id: ANN}).exec(store);
      expect(await graphsOf(ANN)).toEqual([]);
      // The link in the articles graph and the friend link in the people graph are gone.
      expect(await valuesOf(A1, `${NG}author`)).toEqual([]);
      expect(await valuesOf(BO, `${NG}friend`)).toEqual([]);
      // Everything else is untouched.
      expect(await valuesOf(A1, `${NG}title`)).toEqual(['one']);
      expect(await valuesOf(A2, `${NG}author`)).toEqual([BO]);
      expect(await NGArticle.select((a) => [a.title, a.author.name]).exec(store)).toEqual(
        expect.arrayContaining([
          {id: A1, title: 'one', author: null},
          {id: A2, title: 'two', author: {id: BO, name: 'Bo'}},
        ]),
      );
    });

    test('a delete that keeps incoming links keeps the article\'s author link', async () => {
      const {DeleteBuilder} = await import('../queries/DeleteBuilder');
      await DeleteBuilder.from(NGPerson, {id: ANN})._keepingIncoming().exec(store);
      expect(await graphsOf(ANN)).toEqual([]);
      expect(await valuesOf(A1, `${NG}author`)).toEqual([ANN]);
    });

    test('Article.update(…).where(a => a.author.name.equals(\'x\')) matches the article whose author is in people', async () => {
      await NGArticle.update({title: 'by x'}).where((a) => a.author.name.equals('x')).exec(store);
      expect(await valuesOf(A1, `${NG}title`)).toEqual(['by x']);
      expect(await valuesOf(A2, `${NG}title`)).toEqual(['two']);
      expect(await graphsOf(A1)).toEqual([G_ARTICLES]);
      expect(await graphsOf(ANN)).toEqual([G_PEOPLE]);
    });

    test('Article.deleteWhere(a => a.author.name.equals(\'x\')) matches', async () => {
      await NGArticle.deleteWhere((a) => a.author.name.equals('x')).exec(store);
      expect(await graphsOf(A1)).toEqual([]);
      expect(await graphsOf(A2)).toEqual([G_ARTICLES]);
      // The author herself is not deleted (a bulk delete removes only the matched subjects).
      expect(await graphsOf(ANN)).toEqual([G_PEOPLE]);
    });

    test('a computed update reads the linked value in its own graph', async () => {
      await NGArticle.update((a: any) => ({title: a.author.name.ucase()})).for({id: A2}).exec(store);
      expect(await valuesOf(A2, `${NG}title`)).toEqual(['BO']);
      expect(await graphsOf(A2, `<${NG}title>`)).toEqual([G_ARTICLES]);
      // In bulk, with a where clause through the same link.
      await NGArticle.update((a: any) => ({title: a.author.name.ucase()}))
        .where((a) => a.author.name.equals('x'))
        .exec(store);
      expect(await valuesOf(A1, `${NG}title`)).toEqual(['X']);
      expect(await valuesOf(A2, `${NG}title`)).toEqual(['BO']);
      expect(await namedGraphs()).toEqual([G_ARTICLES, G_PEOPLE]);
    });

    test('an unrouted photo deleted from the default graph loses the links persons hold in people', async () => {
      const PHOTO = `${D}photo/1`;
      await NGPhoto.create({__id: PHOTO, caption: 'sea'} as never).exec(store);
      await NGPerson.update({favoritePhoto: {id: PHOTO}} as never).for({id: BO}).exec(store);
      expect(await graphsOf(PHOTO)).toEqual(['default']);
      expect(await valuesOf(BO, `${NG}favoritePhoto`)).toEqual([PHOTO]);
      await NGPhoto.delete({id: PHOTO}).exec(store);
      expect(await graphsOf(PHOTO)).toEqual([]);
      expect(await valuesOf(BO, `${NG}favoritePhoto`)).toEqual([]);
      expect(await valuesOf(BO, `${NG}name`)).toEqual(['Bo']);
    });

    test('a cover owned in the albums graph, deleted as a photo, loses the links persons hold in people', async () => {
      const ALBUM = `${D}album/1`;
      const COVER = `${D}album/1/cover`;
      await NGAlbum.create({__id: ALBUM, title: 'Holiday', cover: {__id: COVER, caption: 'beach'}} as never).exec(store);
      await NGPerson.update({favoritePhoto: {id: COVER}} as never).for({id: ANN}).exec(store);
      expect(await graphsOf(COVER)).toEqual([G_ALBUMS]);
      // The photo's read set is the default graph and the albums graph: the store finds the cover there.
      await NGPhoto.delete({id: COVER}).exec(store);
      expect(await graphsOf(COVER)).toEqual([]);
      expect(await valuesOf(ALBUM, `${NG}cover`)).toEqual([]);
      expect(await valuesOf(ANN, `${NG}favoritePhoto`)).toEqual([]);
      expect(await valuesOf(ALBUM, `${NG}title`)).toEqual(['Holiday']);
    });
  });

  describe('Person → people, Employee → staff (a subject found at write time)', () => {
    const ANN = `${D}ann`;
    const BOB = `${D}bob`;

    beforeAll(async () => {
      await executeSparqlUpdate('DROP ALL');
      await executeSparqlUpdate(`INSERT DATA { <${employeeClass.id}> <${RDFS_SUBCLASS_OF}> <${personClass.id}> . }`);
      store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
      setShapeGraphs(store, {[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF});
    });

    beforeEach(async () => {
      await executeSparqlUpdate(
        `DELETE WHERE { GRAPH <${G_PEOPLE}> { ?s ?p ?o } } ; DELETE WHERE { GRAPH <${G_STAFF}> { ?s ?p ?o } }`,
      );
      await Person.create({__id: ANN, name: 'Ann'} as never).exec(store);
      await Employee.create({__id: BOB, name: 'Bob'} as never).exec(store);
      // Bob's best friend is a person in the people graph; the link is held in staff.
      await executeSparqlUpdate(`INSERT DATA { GRAPH <${G_STAFF}> { <${BOB}> <${propBase}bestFriend> <${ANN}> . } }`);
      expect(await graphsOf(ANN)).toEqual([G_PEOPLE]);
      expect(await graphsOf(BOB)).toEqual([G_STAFF]);
    });

    test('a computed update of an employee, through the person shape, reads the friend in people', async () => {
      await Person.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).for({id: BOB}).exec(store);
      expect(await valuesOf(BOB, `${propBase}hobby`)).toEqual(['ANN']);
      expect(await graphsOf(BOB, `<${propBase}hobby>`)).toEqual([G_STAFF]);
    });

    test('an update where through a link to another graph, in bulk over the read set', async () => {
      await Person.update({hobby: 'chess'}).where((p) => p.bestFriend.name.equals('Ann')).exec(store);
      expect(await valuesOf(BOB, `${propBase}hobby`)).toEqual(['chess']);
      expect(await graphsOf(BOB, `<${propBase}hobby>`)).toEqual([G_STAFF]);
      expect(await valuesOf(ANN, `${propBase}hobby`)).toEqual([]);
      await Person.deleteWhere((p) => p.bestFriend.name.equals('Ann')).exec(store);
      expect(await graphsOf(BOB)).toEqual([]);
      expect(await graphsOf(ANN)).toEqual([G_PEOPLE]);
    });

    test('a person deleted from people loses the link an employee holds in staff', async () => {
      await Person.delete({id: ANN}).exec(store);
      expect(await graphsOf(ANN)).toEqual([]);
      expect(await valuesOf(BOB, `${propBase}bestFriend`)).toEqual([]);
      expect(await valuesOf(BOB, `${propBase}name`)).toEqual(['Bob']);
      expect(await valuesOf(BOB, RDF_TYPE)).toContain(employeeClass.id);
    });
  });
});
