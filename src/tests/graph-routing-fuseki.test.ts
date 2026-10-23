/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Graph routing on the inferring store. Albums (and the photos they own) are routed to an albums
 * graph, panoramas to their own graph, persons to a people graph and employees to a staff graph;
 * pets and plain photos are unrouted and live in the default graph. An unrouted named graph and
 * the default graph hold decoys that a routed read must never return and a routed write must
 * never touch.
 *
 * Every read runs on a store with `isolateLinkedTypeChecks` off and one with it on, and both must
 * return identical rows.
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
import {Employee, Person, Pet, employeeClass, personClass, propBase} from '../test-helpers/query-fixtures';
import {GR, GRAlbum, GRPanorama, GRPhoto} from '../test-helpers/graph-routing-fixtures';
import {setShapeGraphs} from '../utils/graphRouting';
import {isGraphQueryError} from '../queries/graphQuery';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {isSparqlSelectResults} from '../sparql/resultMapping';

import '../ontologies/rdf';
import '../ontologies/xsd';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const D = 'https://acme.example/data/';
const G_ALBUMS = `${D}graph/albums`;
const G_PANORAMAS = `${D}graph/panoramas`;
const G_PEOPLE = `${D}graph/people`;
const G_STAFF = `${D}graph/staff`;
const G_OTHER = `${D}graph/other`;
const ALBUM = `${D}album/1`;
const COVER = `${D}album/1/cover`;

/** Rows in a comparable order: by id. */
function sorted<T>(rows: T): T {
  if (!Array.isArray(rows)) return rows;
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))) as T;
}

describeFuseki('graph routing', () => {
  let off: FusekiStore;
  let on: FusekiStore;

  const routes = {
    [GRAlbum.shape.id]: G_ALBUMS,
    [GRPanorama.shape.id]: G_PANORAMAS,
    [Person.shape.id]: G_PEOPLE,
    [Employee.shape.id]: G_STAFF,
  };

  /** The graphs (named, or `default`) holding a triple matching `pattern` with `?s` bound to `subject`. */
  async function graphsOf(subject: string, predicate = '?p'): Promise<string[]> {
    const json = await off.rawQuery(
      `SELECT DISTINCT ?g WHERE { { GRAPH ?g { <${subject}> ${predicate} ?o } } UNION { <${subject}> ${predicate} ?o BIND("default" AS ?g) } }`,
    );
    if (!json || !isSparqlSelectResults(json)) throw new Error('expected a result set');
    return json.results.bindings.map((b) => b.g!.value).sort();
  }

  /** Run a read on both stores, assert identical rows, return them. */
  async function both<T>(run: (store: FusekiStore) => Promise<T>): Promise<T> {
    const [a, b] = [await run(off), await run(on)];
    expect(sorted(b)).toEqual(sorted(a));
    return a;
  }

  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    await executeSparqlUpdate(
      `INSERT DATA { <${employeeClass.id}> <${RDFS_SUBCLASS_OF}> <${personClass.id}> . ` +
        `<${GR}Panorama> <${RDFS_SUBCLASS_OF}> <${GR}Photo> . }`,
    );
    off = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
    on = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME, {isolateLinkedTypeChecks: true});
    setShapeGraphs(off, routes);
    setShapeGraphs(on, routes);
    // Decoys: a person in an unrouted named graph and in the default graph.
    await executeSparqlUpdate(
      `INSERT DATA { GRAPH <${G_OTHER}> { <${D}mallory> a <${personClass.id}> ; <${propBase}name> "Mallory" . } ` +
        `<${D}frank> a <${personClass.id}> ; <${propBase}name> "Frank" . }`,
    );
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  test('a write lands in the routed graph; the album and the photo it owns', async () => {
    await GRAlbum.create({__id: ALBUM, title: 'Holiday', cover: {__id: COVER, caption: 'beach'}} as never).exec(off);
    expect(await graphsOf(ALBUM)).toEqual([G_ALBUMS]);
    expect(await graphsOf(COVER)).toEqual([G_ALBUMS]);
    const rows = await both((s) => GRAlbum.select((a) => [a.title, a.cover.caption]).exec(s));
    expect(rows).toEqual([{id: ALBUM, title: 'Holiday', cover: {id: COVER, caption: 'beach'}}]);
  });

  test('an owned node changed through its own shape is changed in its owner graph; an owned link to a node in another graph is refused', async () => {
    // A photo reads the default graph, the panoramas graph and (owned) the albums graph.
    await GRPhoto.update({caption: 'sand'}).for({id: COVER}).exec(off);
    expect(await graphsOf(COVER)).toEqual([G_ALBUMS]);
    const caption = await off.rawQuery(`SELECT ?g ?c WHERE { GRAPH ?g { <${COVER}> <${GR}caption> ?c } }`);
    if (!caption || !isSparqlSelectResults(caption)) throw new Error('expected a result set');
    expect(caption.results.bindings.map((b) => [b.g!.value, b.c!.value])).toEqual([[G_ALBUMS, 'sand']]);
    // A photo created on its own lives in the default graph: it cannot become an album's cover.
    await GRPhoto.create({__id: `${D}photo/loose`, caption: 'loose'} as never).exec(off);
    await expect(GRAlbum.update({cover: {id: `${D}photo/loose`}}).for({id: ALBUM}).exec(off)).rejects.toThrow(
      /lives in .*not in the graph its owner lives in/,
    );
    expect(await graphsOf(ALBUM, `<${GR}cover>`)).toEqual([G_ALBUMS]);
    expect(await graphsOf(COVER)).toEqual([G_ALBUMS]);
  });

  test('reads join across routed graphs, through a sub-shape graph, and leave the decoys out', async () => {
    await Employee.create({__id: `${D}bob`, name: 'Bob'} as never).exec(off);
    await Person.create({__id: `${D}alice`, name: 'Alice', bestFriend: {id: `${D}bob`}} as never).exec(off);
    expect(await graphsOf(`${D}alice`)).toEqual([G_PEOPLE]);
    expect(await graphsOf(`${D}bob`)).toEqual([G_STAFF]);
    const rows = await both((s) => Person.select((p) => [p.name, p.bestFriend.name]).exec(s));
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual(['Alice', 'Bob']);
    expect(byName.Alice.bestFriend).toMatchObject({id: `${D}bob`, name: 'Bob'});
    expect(await both((s) => Person.select().toCount().exec(s))).toBe(2);
    expect(await both((s) => Person.select().where((p) => p.bestFriend.name.equals('Bob')).exists(s))).toBe(true);
    expect(await both((s) => Person.select().where((p) => p.name.equals('Mallory')).exists(s))).toBe(false);
    // An employee read covers the staff graph only.
    expect((await both((s) => Employee.select((e) => e.name).exec(s))).map((r) => r.name)).toEqual(['Bob']);
  });

  test('an Employee changed or deleted as a Person changes only the staff graph', async () => {
    const BOB = `${D}bob`;
    await Person.update({name: 'Robert'}).for({id: BOB}).exec(off);
    expect(await graphsOf(BOB)).toEqual([G_STAFF]);
    expect((await both((s) => Employee.select((e) => e.name).exec(s))).map((r) => r.name)).toEqual(['Robert']);
    await Person.upsert({name: 'Bob'}).for({id: BOB}).exec(off);
    expect(await graphsOf(BOB)).toEqual([G_STAFF]);
    const names = await off.rawQuery(`SELECT ?g ?n WHERE { GRAPH ?g { <${BOB}> <${propBase}name> ?n } }`);
    if (!names || !isSparqlSelectResults(names)) throw new Error('expected a result set');
    expect(names.results.bindings.map((b) => [b.g!.value, b.n!.value])).toEqual([[G_STAFF, 'Bob']]);
    // An upsert of a person found nowhere creates it in the person's routed graph.
    await Person.upsert({name: 'Nina'}).for({id: `${D}nina`}).exec(off);
    expect(await graphsOf(`${D}nina`)).toEqual([G_PEOPLE]);
    // Deletes through the super-shape, by id and in bulk, reach the staff graph.
    await Employee.create({__id: `${D}carl`, name: 'Carl'} as never).exec(off);
    await Employee.create({__id: `${D}dan`, name: 'Dan'} as never).exec(off);
    await Person.delete([{id: `${D}carl`}, {id: `${D}nina`}]).exec(off);
    expect(await graphsOf(`${D}carl`)).toEqual([]);
    expect(await graphsOf(`${D}nina`)).toEqual([]);
    await DeleteBuilder.from(Person).where((p) => p.name.equals('Dan')).exec(off);
    expect(await graphsOf(`${D}dan`)).toEqual([]);
    // Nothing strayed into the people graph, and the decoys are untouched.
    expect(await graphsOf(BOB)).toEqual([G_STAFF]);
    expect(await graphsOf(`${D}alice`)).toEqual([G_PEOPLE]);
    expect(await graphsOf(`${D}mallory`)).toEqual([G_OTHER]);
    expect((await both((s) => Person.select((p) => p.name).exec(s))).map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
  });

  test('a routed subject joined to a default-graph subject (VALUES, no FROM NAMED)', async () => {
    await Pet.create({__id: `${D}rex`, bestFriend: {id: `${D}tom`}} as never).exec(off);
    expect(await graphsOf(`${D}rex`)).toEqual(['default']);
    await Person.update({pets: {add: [{id: `${D}rex`}]}} as never).for({id: `${D}alice`}).exec(off);
    expect(await graphsOf(`${D}alice`, `<${propBase}hasPet>`)).toEqual([G_PEOPLE]);
    const rows = await both((s) =>
      Person.select((p) => [p.name, p.pets.bestFriend]).where((p) => p.name.equals('Alice')).exec(s),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pets).toEqual([{id: `${D}rex`, bestFriend: {id: `${D}tom`}}]);
  });

  test('a MINUS with the default graph in the set removes default-graph rows (its own VALUES)', async () => {
    // Persons unrouted (default graph), employees in the staff graph: Person reads both.
    const mixed = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
    setShapeGraphs(mixed, {[Employee.shape.id]: G_STAFF});
    await executeSparqlUpdate(`INSERT DATA { <${D}gus> a <${employeeClass.id}> ; <${propBase}name> "Gus" . }`);
    const names = (await Person.select((p) => p.name).exec(mixed)).map((r) => r.name).sort();
    expect(names).toEqual(['Bob', 'Frank', 'Gus']);
    const notEmployees = await Person.select((p) => p.name).minus(Employee).exec(mixed);
    expect(notEmployees.map((r) => r.name)).toEqual(['Frank']);
  });

  test('an update changes only the copy in the routed graph', async () => {
    await executeSparqlUpdate(
      `INSERT DATA { GRAPH <${G_OTHER}> { <${ALBUM}> a <${GR}Album> ; <${GR}title> "Holiday" ; <${GR}cover> <${COVER}> . ` +
        `<${COVER}> a <${GR}Photo> ; <${GR}caption> "beach" . } }`,
    );
    await GRAlbum.update({title: 'Summer'}).for({id: ALBUM}).exec(off);
    const titles = await off.rawQuery(
      `SELECT ?g ?t WHERE { GRAPH ?g { <${ALBUM}> <${GR}title> ?t } } ORDER BY ?g`,
    );
    if (!titles || !isSparqlSelectResults(titles)) throw new Error('expected a result set');
    expect(titles.results.bindings.map((b) => [b.g!.value, b.t!.value])).toEqual([
      [G_ALBUMS, 'Summer'],
      [G_OTHER, 'Holiday'],
    ]);
  });

  test('an owned delete stays in its graph', async () => {
    await GRAlbum.delete({id: ALBUM}).exec(off);
    expect(await graphsOf(ALBUM)).toEqual([G_OTHER]);
    expect(await graphsOf(COVER)).toEqual([G_OTHER]);
    expect(await both((s) => GRAlbum.select((a) => a.title).exec(s))).toEqual([]);
  });

  test('.into() a graph the routing allows; .into() a graph it forbids is refused and writes nothing', async () => {
    // A photo reads the default graph and its sub-shape's panoramas graph.
    await GRPhoto.create({__id: `${D}photo/2`, caption: 'wide'} as never).into(G_PANORAMAS).exec(off);
    expect(await graphsOf(`${D}photo/2`)).toEqual([G_PANORAMAS]);
    const photos = await both((s) => GRPhoto.select((p) => p.caption).exec(s));
    expect(photos.map((p) => p.caption)).toContain('wide');

    const err = await GRAlbum.create({__id: `${D}album/2`, title: 'x'} as never)
      .into(G_PANORAMAS)
      .exec(off)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isGraphQueryError((err as {cause?: unknown})?.cause ?? err, 'graph-not-routed')).toBe(true);
    expect(await graphsOf(`${D}album/2`)).toEqual([]);
  });
});
