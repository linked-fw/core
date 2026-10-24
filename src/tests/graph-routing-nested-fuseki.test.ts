/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Graph routing on the inferring store, across nested writes and sub-shape owners. Articles are
 * routed to an articles graph, persons (and the avatars they own) to a people graph, albums (and
 * the panorama covers they own) to an albums graph; photos are unrouted.
 */
import {afterAll, beforeAll, expect, test} from '@jest/globals';
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
import {setShapeGraphs} from '../utils/graphRouting';
import {isSparqlSelectResults} from '../sparql/resultMapping';

import '../ontologies/rdf';
import '../ontologies/xsd';

const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const D = 'https://acme.example/data/';
const G_ARTICLES = `${D}graph/articles`;
const G_PEOPLE = `${D}graph/people`;
const G_ALBUMS = `${D}graph/albums`;

describeFuseki('graph routing of nested writes and sub-shape owners', () => {
  let store: FusekiStore;

  /** The graphs (named, or `default`) holding a triple with `subject`. */
  async function graphsOf(subject: string): Promise<string[]> {
    const json = await store.rawQuery(
      `SELECT DISTINCT ?g WHERE { { GRAPH ?g { <${subject}> ?p ?o } } UNION { <${subject}> ?p ?o BIND("default" AS ?g) } }`,
    );
    if (!json || !isSparqlSelectResults(json)) throw new Error('expected a result set');
    return json.results.bindings.map((b) => b.g!.value).sort();
  }

  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    await executeSparqlUpdate(`INSERT DATA { <${NG}Panorama> <${RDFS_SUBCLASS_OF}> <${NG}Photo> . }`);
    store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
    setShapeGraphs(store, {
      [NGArticle.shape.id]: G_ARTICLES,
      [NGPerson.shape.id]: G_PEOPLE,
      [NGAlbum.shape.id]: G_ALBUMS,
    });
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  test('a nested author lands in the people graph, is read through the article and on her own, and is changed there', async () => {
    const ann = `${D}person/ann`;
    const avatar = `${D}image/ann`;
    const created = (await NGArticle.create({
      title: 'Hello',
      author: {__id: ann, name: 'Ann', avatar: {__id: avatar, url: 'ann.png'}},
    } as never).exec(store)) as {id: string};
    const article = created.id;
    expect(await graphsOf(article)).toEqual([G_ARTICLES]);
    expect(await graphsOf(ann)).toEqual([G_PEOPLE]);
    expect(await graphsOf(avatar)).toEqual([G_PEOPLE]);

    const rows = await NGArticle.select((a) => a.author.name).exec(store);
    expect(rows).toEqual([{id: article, author: {id: ann, name: 'Ann'}}]);
    const people = await NGPerson.select((p) => [p.name, p.avatar.url]).exec(store);
    expect(people).toEqual([{id: ann, name: 'Ann', avatar: {id: avatar, url: 'ann.png'}}]);

    await NGPerson.update({name: 'Anna'}).for({id: ann}).exec(store);
    expect(await graphsOf(ann)).toEqual([G_PEOPLE]);
    expect(await NGArticle.select((a) => a.author.name).exec(store)).toEqual([
      {id: article, author: {id: ann, name: 'Anna'}},
    ]);

    // A new author through an update: the link changes in the articles graph, she lands in people.
    await NGArticle.update({author: {__id: `${D}person/bo`, name: 'Bo'}} as never).for({id: article}).exec(store);
    expect(await graphsOf(`${D}person/bo`)).toEqual([G_PEOPLE]);
    expect(await NGArticle.select((a) => a.author.name).exec(store)).toEqual([
      {id: article, author: {id: `${D}person/bo`, name: 'Bo'}},
    ]);
    expect((await NGPerson.select((p) => p.name).exec(store)).map((r) => r.name).sort()).toEqual(['Anna', 'Bo']);
  });

  test('a cover owned by an album as a panorama is found, changed and deleted as a photo', async () => {
    const ALBUM = `${D}album/1`;
    const COVER = `${D}album/1/cover`;
    await NGAlbum.create({__id: ALBUM, title: 'Holiday', cover: {__id: COVER, caption: 'beach'}} as never).exec(store);
    expect(await graphsOf(COVER)).toEqual([G_ALBUMS]);
    await NGPhoto.create({__id: `${D}photo/loose`, caption: 'loose'} as never).exec(store);
    expect(await graphsOf(`${D}photo/loose`)).toEqual(['default']);

    const photos = await NGPhoto.select((p) => p.caption).exec(store);
    expect(photos.map((p) => p.caption).sort()).toEqual(['beach', 'loose']);

    await NGPhoto.update({caption: 'sand'}).for({id: COVER}).exec(store);
    expect(await graphsOf(COVER)).toEqual([G_ALBUMS]);
    expect(await NGAlbum.select((a) => a.cover.caption).exec(store)).toEqual([
      {id: ALBUM, cover: {id: COVER, caption: 'sand'}},
    ]);

    await NGPhoto.delete({id: COVER}).exec(store);
    expect(await graphsOf(COVER)).toEqual([]);
    expect((await NGPhoto.select((p) => p.caption).exec(store)).map((p) => p.caption)).toEqual(['loose']);
  });

  test('a nested author created without an id is returned with the id she is written under', async () => {
    const created = (await NGArticle.create({title: 'No ids', author: {name: 'Eve'}} as never).exec(store)) as {
      id: string;
      author: {id: string};
    };
    const eve = created.author.id;
    expect(eve).not.toBe('');
    expect(await graphsOf(eve)).toEqual([G_PEOPLE]);
    expect(await NGPerson.select((p) => p.name).for({id: eve}).exec(store)).toEqual({id: eve, name: 'Eve'});
    expect(await NGArticle.select((a) => a.author.name).for({id: created.id}).exec(store)).toEqual({
      id: created.id,
      author: {id: eve, name: 'Eve'},
    });
  });

  test('two levels deep: an unrouted article, its author in hers, her photo back in the default graph', async () => {
    // Only persons are routed here: the article and the photo live in the default graph.
    const plain = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
    setShapeGraphs(plain, {[NGPerson.shape.id]: G_PEOPLE});
    const write = async (kind: 'create' | 'update' | 'upsert', n: number) => {
      const article = `${D}deep/article/${kind}`;
      const value = {name: `P${n}`, favoritePhoto: {caption: `photo ${n}`}};
      const result = (await (kind === 'create'
        ? NGArticle.create({__id: article, author: value} as never)
        : NGArticle[kind]({author: value} as never).for({id: article})
      ).exec(plain)) as {author: {id: string; favoritePhoto: {id: string}}};
      const person = result.author.id;
      const photo = result.author.favoritePhoto.id;
      expect(await graphsOf(article)).toEqual(['default']);
      expect(await graphsOf(person)).toEqual([G_PEOPLE]);
      expect(await graphsOf(photo)).toEqual(['default']);
      expect(await NGPhoto.select((p) => p.caption).for({id: photo}).exec(plain)).toEqual({
        id: photo,
        caption: `photo ${n}`,
      });
      expect(
        await NGArticle.select((a) => a.author.favoritePhoto.caption).for({id: article}).exec(plain),
      ).toEqual({id: article, author: {id: person, favoritePhoto: {id: photo, caption: `photo ${n}`}}});
    };
    await write('create', 1);
    await NGArticle.create({__id: `${D}deep/article/update`, title: 'u'} as never).exec(plain);
    await write('update', 2);
    await write('upsert', 3);
  });
});
