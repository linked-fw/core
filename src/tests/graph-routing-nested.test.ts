/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Graph routing review fixes: a nested node the mutation does not own is written into its own
 * shape's graph; a shape's read set includes the owners of its sub-shapes; routes to graphs a
 * store manages itself are refused; DSL-JSON refuses `.into()`; a delete that keeps incoming links.
 */
import {afterEach, describe, expect, test} from '@jest/globals';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {deleteToSparql} from '../sparql/irToAlgebra';
import {collectOwnedLinks} from '../sparql/ownedLinkCheck';
import {lower} from '../queries/lower';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {lowerMutationJSON} from '../queries/lowerMutationJSON';
import {fromJSON} from '../queries/fromJSON';
import {isGraphQueryError} from '../queries/graphQuery';
import {mutationEffects, queryDependencies} from '../queries/queryDependencies';
import {LinkedStorage} from '../utils/LinkedStorage';
import {graphRoutingFor, setShapeGraphs} from '../utils/graphRouting';
import {dataGraph, graphs} from '../ontologies/graphs';
import type {IDataset} from '../interfaces/IDataset';
import type {IRCreateMutation} from '../queries/IntermediateRepresentation';
import {
  NG,
  NGAlbum,
  NGArticle,
  NGImage,
  NGPanorama,
  NGPerson,
  NGPhoto,
} from '../test-helpers/graph-routing-nested-fixtures';

import {RFImportedRecord, RFLowerNamed} from '../test-helpers/graph-route-forms-fixtures';
import '../ontologies/rdf';
import '../ontologies/xsd';

const D = 'https://acme.example/data/';
const G_ARTICLES = `${D}graph/articles`;
const G_PEOPLE = `${D}graph/people`;
const G_ALBUMS = `${D}graph/albums`;
const jena = (iri: string) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null);

/** A SPARQL store that records what it is sent and answers empty results. */
class CaptureStore extends SparqlDataset {
  selects: string[] = [];
  updates: string[] = [];
  constructor(options?: SparqlOptions) {
    super(options);
  }
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    this.selects.push(sparql);
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
  last(): string {
    return this.updates[this.updates.length - 1];
  }
}

const store = (routes: Record<string, string> = {
  [NGArticle.shape.id]: G_ARTICLES,
  [NGPerson.shape.id]: G_PEOPLE,
}) => {
  const s = new CaptureStore({mapGraphName: jena, dataRoot: D.replace(/\/$/, '')});
  setShapeGraphs(s, routes);
  return s;
};

/** The `GRAPH <g> { … }` blocks of an update, by graph, and what is left outside them. */
function blocks(sparql: string): {graphs: Record<string, string>; outside: string} {
  const out: Record<string, string> = {};
  let outside = sparql;
  for (const m of sparql.matchAll(/GRAPH <([^>]+)> \{\n([\s\S]*?)\n  \}/g)) {
    out[m[1]] = m[2];
    outside = outside.replace(m[0], '');
  }
  return {graphs: out, outside};
}

describe('a nested node the mutation does not own is written into its own shape graph', () => {
  const ARTICLE = `${D}article/1`;
  const ANN = `${D}person/ann`;
  const AVATAR = `${D}image/ann`;

  test('create: the article and its link in its graph, the author and what she owns in hers', async () => {
    const s = store();
    await NGArticle.create({
      __id: ARTICLE,
      title: 'Hello',
      author: {__id: ANN, name: 'Ann', avatar: {__id: AVATAR, url: 'a.png'}},
    } as never).exec(s);
    const {graphs: byGraph} = blocks(s.last());
    expect(Object.keys(byGraph).sort()).toEqual([G_ARTICLES, G_PEOPLE]);
    expect(byGraph[G_ARTICLES]).toContain(`<${ARTICLE}> <${NG}author> <${ANN}>`);
    expect(byGraph[G_ARTICLES]).not.toContain(`<${ANN}> <${NG}name>`);
    expect(byGraph[G_PEOPLE]).toContain(`<${ANN}> rdf:type <${NG}Person>`);
    expect(byGraph[G_PEOPLE]).toContain(`<${ANN}> <${NG}name> "Ann"`);
    // Her avatar is owned (contains): it lives with her.
    expect(byGraph[G_PEOPLE]).toContain(`<${ANN}> <${NG}avatar> <${AVATAR}>`);
    expect(byGraph[G_PEOPLE]).toContain(`<${AVATAR}> <${NG}url> "a.png"`);
  });

  test('.into() names the article graph only; the author still goes to hers', async () => {
    const s = store();
    await NGArticle.create({__id: ARTICLE, author: {__id: ANN, name: 'Ann'}} as never).into(G_ARTICLES).exec(s);
    expect(Object.keys(blocks(s.last()).graphs).sort()).toEqual([G_ARTICLES, G_PEOPLE]);
  });

  test('a nested node of a shape in the same graph stays in one block', async () => {
    const s = store();
    await NGPerson.create({__id: ANN, name: 'Ann', friends: [{__id: `${D}person/bo`, name: 'Bo'}]} as never).exec(s);
    expect(s.last().match(/GRAPH </g)).toHaveLength(1);
    expect(blocks(s.last()).graphs[G_PEOPLE]).toContain(`<${D}person/bo> <${NG}name> "Bo"`);
  });

  test('an unrouted nested shape goes to the default graph (plain triples in INSERT DATA)', async () => {
    const s = store({[NGArticle.shape.id]: G_ARTICLES});
    await NGArticle.create({__id: ARTICLE, author: {__id: ANN, name: 'Ann'}} as never).exec(s);
    const {graphs: byGraph, outside} = blocks(s.last());
    expect(Object.keys(byGraph)).toEqual([G_ARTICLES]);
    expect(outside).toContain(`<${ANN}> <${NG}name> "Ann"`);
    // And the reverse: an unrouted article holding a routed author.
    const r = store({[NGPerson.shape.id]: G_PEOPLE});
    await NGArticle.create({__id: ARTICLE, author: {__id: ANN, name: 'Ann'}} as never).exec(r);
    const rev = blocks(r.last());
    expect(Object.keys(rev.graphs)).toEqual([G_PEOPLE]);
    expect(rev.outside).toContain(`<${ARTICLE}> <${NG}author> <${ANN}>`);
  });

  test('without routes a nested create is unchanged: one plain INSERT DATA', async () => {
    const s = new CaptureStore({mapGraphName: jena});
    await NGArticle.create({__id: ARTICLE, author: {__id: ANN, name: 'Ann'}} as never).exec(s);
    expect(s.last()).not.toContain('GRAPH');
  });

  test('update and upsert: the new author in her graph, the link in the article graph (WITH)', async () => {
    const s = store();
    await NGArticle.update({author: {__id: ANN, name: 'Ann'}} as never).for({id: ARTICLE}).exec(s);
    const update = s.last();
    expect(update).toMatch(new RegExp(`^WITH <${G_ARTICLES}>`, 'm'));
    const insert = update.slice(update.indexOf('INSERT {'), update.indexOf('WHERE {'));
    expect(insert).toContain(`<${ARTICLE}> <${NG}author> <${ANN}>`);
    expect(blocks(insert).graphs[G_PEOPLE]).toContain(`<${ANN}> <${NG}name> "Ann"`);
    await NGArticle.upsert({author: {__id: ANN, name: 'Ann'}} as never).for({id: ARTICLE}).exec(s);
    expect(blocks(s.last()).graphs[G_PEOPLE]).toContain(`<${ANN}> <${NG}name> "Ann"`);
    await NGArticle.update({author: {__id: ANN, name: 'Ann'}} as never).forAll().exec(s);
    expect(blocks(s.last()).graphs[G_PEOPLE]).toContain(`<${ANN}> <${NG}name> "Ann"`);
  });

  test('under WITH <g>, a nested node of the default graph is named by the store name for it', async () => {
    const s = store({[NGArticle.shape.id]: G_ARTICLES});
    await NGArticle.update({author: {__id: ANN, name: 'Ann'}} as never).for({id: ARTICLE}).exec(s);
    expect(blocks(s.last()).graphs['urn:x-arq:DefaultGraph']).toContain(`<${ANN}> <${NG}name> "Ann"`);
    const noName = new CaptureStore({});
    setShapeGraphs(noName, {[NGArticle.shape.id]: G_ARTICLES});
    await expect(
      NGArticle.update({author: {__id: ANN, name: 'Ann'}} as never).for({id: ARTICLE}).exec(noName),
    ).rejects.toThrow(/mapGraphName/);
  });

  test('the owned-link check of a nested node reads that node graph', () => {
    const ir = lower(
      NGArticle.create({author: {name: 'Ann', avatar: {id: AVATAR}}} as never),
    ) as IRCreateMutation;
    expect(collectOwnedLinks(ir).map((l) => [l.id, l.nestedIn])).toEqual([[AVATAR, NGPerson.shape.id]]);
    const direct = lower(NGPerson.create({name: 'Ann', avatar: {id: AVATAR}} as never)) as IRCreateMutation;
    expect(collectOwnedLinks(direct).map((l) => l.nestedIn)).toEqual([undefined]);
  });
});

describe('a nested create without an id', () => {
  const ARTICLE = `${D}article/1`;
  const minted = (label: string) => new RegExp(`^${D}${label}_[0-9A-Z]{26}$`);

  test('returns the id it is written under, in its own shape graph', async () => {
    const s = store();
    const result = (await NGArticle.create({
      title: 'Hello',
      author: {name: 'Ann', avatar: {url: 'a.png'}},
    } as never).exec(s)) as {id: string; author: {id: string; avatar: {id: string}}};
    expect(result.author.id).toMatch(minted('ngperson'));
    expect(result.author.avatar.id).toMatch(minted('ngimage'));
    const {graphs: byGraph} = blocks(s.last());
    expect(byGraph[G_ARTICLES]).toContain(`<${result.id}> <${NG}author> <${result.author.id}>`);
    expect(byGraph[G_PEOPLE]).toContain(`<${result.author.id}> <${NG}name> "Ann"`);
    expect(byGraph[G_PEOPLE]).toContain(`<${result.author.avatar.id}> <${NG}url> "a.png"`);
  });

  test('each run of the same create mints new ids', async () => {
    const s = store();
    const create = NGArticle.create({author: {name: 'Ann'}} as never);
    const first = (await create.exec(s)) as {author: {id: string}};
    const second = (await create.exec(s)) as {author: {id: string}};
    expect(second.author.id).not.toBe(first.author.id);
  });

  test('update and upsert return the minted id they write; a set add writes one', async () => {
    const s = store();
    const updated = (await NGArticle.update({author: {name: 'Bo'}} as never).for({id: ARTICLE}).exec(s)) as {
      author: {id: string};
    };
    expect(updated.author.id).toMatch(minted('ngperson'));
    expect(blocks(s.last()).graphs[G_PEOPLE]).toContain(`<${updated.author.id}> <${NG}name> "Bo"`);
    const upserted = (await NGArticle.upsert({author: {name: 'Cy'}} as never).for({id: ARTICLE}).exec(s)) as {
      author: {id: string};
    };
    expect(upserted.author.id).toMatch(minted('ngperson'));
    expect(blocks(s.last()).graphs[G_PEOPLE]).toContain(`<${upserted.author.id}> <${NG}name> "Cy"`);
    await NGPerson.update({friends: {add: [{name: 'Di'}]}} as never).for({id: `${D}person/ann`}).exec(s);
    expect(s.last()).toMatch(new RegExp(`<${D}person/ann> <${NG}friend> <${D}ngperson_[0-9A-Z]{26}>`));
  });
});

describe('a nested create two levels deep across graphs', () => {
  const ARTICLE = `${D}article/1`;
  const ANN = `${D}person/ann`;
  const PHOTO = `${D}photo/1`;
  // The article and the photo in the default graph, the author between them in hers.
  const routes = {[NGPerson.shape.id]: G_PEOPLE};
  const value = {__id: ANN, name: 'Ann', favoritePhoto: {__id: PHOTO, caption: 'beach'}};

  /** The grandchild in the plan's (default) graph, apart from the author's block. */
  function expectPlaced(sparql: string, holder = `<${ARTICLE}>`): void {
    const {graphs: byGraph, outside} = blocks(sparql);
    expect(Object.keys(byGraph)).toEqual([G_PEOPLE]);
    expect(byGraph[G_PEOPLE]).toContain(`<${ANN}> <${NG}favoritePhoto> <${PHOTO}>`);
    expect(byGraph[G_PEOPLE]).not.toContain(`<${PHOTO}> <${NG}caption>`);
    expect(outside).toContain(`${holder} <${NG}author> <${ANN}>`);
    expect(outside).toContain(`<${PHOTO}> <${NG}caption> "beach"`);
  }

  test('create', async () => {
    const s = store(routes);
    await NGArticle.create({__id: ARTICLE, author: value} as never).exec(s);
    expectPlaced(s.last());
  });

  test('update and upsert', async () => {
    const s = store(routes);
    await NGArticle.update({author: value} as never).for({id: ARTICLE}).exec(s);
    expectPlaced(s.last().slice(s.last().indexOf('INSERT {')));
    await NGArticle.upsert({author: value} as never).for({id: ARTICLE}).exec(s);
    expectPlaced(s.last().slice(s.last().indexOf('INSERT {')));
  });

  test('update-where', async () => {
    const s = store(routes);
    await NGArticle.update({author: value} as never).forAll().exec(s);
    const update = s.last();
    expectPlaced(update.slice(update.indexOf('INSERT {'), update.indexOf('WHERE {')), '?a0');
  });

  test('a grandchild back in a named plan graph gets a block of that graph', async () => {
    const s = store({[NGArticle.shape.id]: G_ARTICLES, [NGPerson.shape.id]: G_PEOPLE, [NGPhoto.shape.id]: G_ARTICLES});
    await NGArticle.create({__id: ARTICLE, author: value} as never).exec(s);
    const created = s.last();
    expect(created).not.toContain('null');
    const articleBlocks = [...created.matchAll(new RegExp(`GRAPH <${G_ARTICLES}> \\{\\n([\\s\\S]*?)\\n  \\}`, 'g'))]
      .map((m) => m[1])
      .join('\n');
    expect(articleBlocks).toContain(`<${ARTICLE}> <${NG}author> <${ANN}>`);
    expect(articleBlocks).toContain(`<${PHOTO}> <${NG}caption> "beach"`);
    await NGArticle.update({author: value} as never).for({id: ARTICLE}).exec(s);
    const update = s.last();
    expect(update).toMatch(new RegExp(`^WITH <${G_ARTICLES}>`, 'm'));
    const insert = update.slice(update.indexOf('INSERT {'), update.indexOf('WHERE {'));
    expect(blocks(insert).graphs[G_PEOPLE]).not.toContain(`<${PHOTO}> <${NG}caption>`);
    expect(blocks(insert).graphs[G_ARTICLES]).toContain(`<${PHOTO}> <${NG}caption> "beach"`);
    expect(update).not.toContain('null');
  });
});

describe('live effects of a write into several graphs', () => {
  afterEach(() => {
    LinkedStorage.unsetDatasetForShape(NGArticle);
    LinkedStorage.unsetDatasetForShape(NGPerson);
  });

  test('a create whose nested author goes elsewhere names no graph; one that stays names it', () => {
    const ds = {} as unknown as IDataset;
    LinkedStorage.setDatasetForShapes(ds, [NGArticle], {graph: G_ARTICLES});
    LinkedStorage.setDatasetForShapes(ds, [NGPerson], {graph: G_PEOPLE});
    expect(mutationEffects(NGArticle.create({title: 'x'})).graph).toBe(G_ARTICLES);
    expect(mutationEffects(NGArticle.create({title: 'x', author: {name: 'Ann'}} as never)).graph).toBeUndefined();
    expect(mutationEffects(NGArticle.create({title: 'x', author: {id: `${D}person/ann`}})).graph).toBe(G_ARTICLES);
    expect(mutationEffects(NGPerson.create({name: 'Ann', avatar: {url: 'a'}} as never)).graph).toBe(G_PEOPLE);
    expect(
      mutationEffects(NGArticle.update({author: {name: 'Ann'}} as never).for({id: `${D}article/1`})).graph,
    ).toBeUndefined();
  });
});

describe('a shape read set includes the owners of its sub-shapes', () => {
  const COVER = `${D}album/1/cover`;
  afterEach(() => {
    LinkedStorage.unsetDatasetForShape(NGAlbum);
    LinkedStorage.unsetDatasetForShape(NGPhoto);
  });

  test('a photo reads the albums graph, which owns panoramas', () => {
    const ds = {} as unknown as IDataset;
    setShapeGraphs(ds, {[NGAlbum.shape.id]: G_ALBUMS});
    const routing = graphRoutingFor(ds)!;
    expect(routing.readGraphsForShape(NGPhoto.shape.id)).toEqual([graphs.default, G_ALBUMS]);
    expect(routing.readGraphsForShape(NGPanorama.shape.id)).toEqual([graphs.default, G_ALBUMS]);
    // An image is owned by persons only.
    expect(routing.readGraphsForShape(NGImage.shape.id)).toEqual([graphs.default]);
  });

  test('select, update and delete of a photo reach the albums graph', async () => {
    const s = store({[NGAlbum.shape.id]: G_ALBUMS});
    await NGPhoto.select((p) => p.caption).exec(s);
    expect(s.selects[s.selects.length - 1]).toContain(`<${G_ALBUMS}>`);
    await NGPhoto.update({caption: 'x'}).for({id: COVER}).exec(s);
    expect(s.last()).toMatch(new RegExp(`VALUES \\?g_w \\{ <urn:x-arq:DefaultGraph> <${G_ALBUMS}> \\}`));
    await NGPhoto.delete({id: COVER}).exec(s);
    expect(s.last()).toMatch(new RegExp(`VALUES \\?g_w \\{ <urn:x-arq:DefaultGraph> <${G_ALBUMS}> \\}`));
  });

  test('the live dependencies of a photo read include the albums graph', () => {
    const ds = {} as unknown as IDataset;
    LinkedStorage.setDatasetForShapes(ds, [NGAlbum], {graph: G_ALBUMS});
    LinkedStorage.setDatasetForShapes(ds, [NGPhoto]);
    expect([...queryDependencies(NGPhoto.select((p) => p.caption)).graphs!].sort()).toEqual(
      [G_ALBUMS, graphs.default].sort(),
    );
  });
});

describe('routes to graphs a store manages itself are refused', () => {
  const ROOT = 'https://acme.example/app';
  const refused = (route: () => unknown, graph: string) => {
    let err: unknown;
    try {
      route();
    } catch (e) {
      err = e;
    }
    expect(isGraphQueryError(err, 'graph-name-read-only')).toBe(true);
    expect((err as Error).message).toContain(`<${NGArticle.shape.id}>`);
    expect((err as Error).message).toContain(graph);
  };

  test("dataGraph('shapes') and dataGraph('import/…'), when the route is set", () => {
    const ds = {} as unknown as IDataset;
    refused(() => setShapeGraphs(ds, {[NGArticle.shape.id]: dataGraph('shapes')}), '{DATA_ROOT}/graph/shapes');
    refused(() => setShapeGraphs(ds, {[NGArticle.shape.id]: dataGraph('import/acme')}), '{DATA_ROOT}/graph/import/acme');
    // A data graph merely named like one is fine.
    setShapeGraphs(ds, {[NGArticle.shape.id]: dataGraph('shapes-archive')});
    setShapeGraphs(ds, {[NGArticle.shape.id]: dataGraph('importers')});
  });

  test("'own' of a package slugged import is its own graph, unless named exactly like an imported graph", () => {
    const s = new CaptureStore({dataRoot: ROOT});
    setShapeGraphs(s, {[RFImportedRecord.shape.id]: 'own'});
    expect(graphRoutingFor(s)!.graphForShape(RFImportedRecord.shape.id)).toBe(`${ROOT}/graph/import/RFImportedRecord`);
    let err: unknown;
    try {
      setShapeGraphs(s, {[RFLowerNamed.shape.id]: 'own'});
    } catch (e) {
      err = e;
    }
    expect(isGraphQueryError(err, 'graph-name-read-only')).toBe(true);
    expect(String(err)).toContain('{DATA_ROOT}/graph/import/wikidata-people');
    // dataGraph() keeps refusing the managed kinds as its top segment.
    expect(() => setShapeGraphs(s, {[RFImportedRecord.shape.id]: dataGraph('import/acme')})).toThrow(/imported graph/);
  });

  test('a package ontology or shape graph, the registry and the portable names, when the route is set', () => {
    const ds = {} as unknown as IDataset;
    refused(() => setShapeGraphs(ds, {[NGArticle.shape.id]: 'https://linked.cm/pkg/schema/graph/shapes'}), 'https://linked.cm/pkg/schema/graph/shapes');
    refused(() => setShapeGraphs(ds, {[NGArticle.shape.id]: 'https://linked.cm/pkg/schema/graph/ontology'}), 'https://linked.cm/pkg/schema/graph/ontology');
    refused(() => setShapeGraphs(ds, {[NGArticle.shape.id]: graphs.registry}), graphs.registry);
    refused(() => setShapeGraphs(ds, {[NGArticle.shape.id]: graphs.union}), graphs.union);
    refused(() => setShapeGraphs(ds, {[NGArticle.shape.id]: graphs.allShapes}), graphs.allShapes);
  });

  test("a full IRI to the app's shape graph or an imported graph, when the routing is read under the store root", () => {
    const s = new CaptureStore({dataRoot: ROOT});
    setShapeGraphs(s, {[NGArticle.shape.id]: `${ROOT}/graph/shapes`});
    refused(() => graphRoutingFor(s), `${ROOT}/graph/shapes`);
    const t = new CaptureStore({dataRoot: ROOT});
    setShapeGraphs(t, {[NGArticle.shape.id]: `${ROOT}/graph/import/acme`});
    refused(() => graphRoutingFor(t), `${ROOT}/graph/import/acme`);
    // The same IRIs under another root are data graphs of that root's owner, not this store's.
    const u = new CaptureStore({dataRoot: 'https://other.example/app'});
    setShapeGraphs(u, {[NGArticle.shape.id]: `${ROOT}/graph/shapes`});
    expect(graphRoutingFor(u)!.graphForShape(NGArticle.shape.id)).toBe(`${ROOT}/graph/shapes`);
  });
});

describe('a delete that keeps incoming links', () => {
  const ID = `${D}person/ann`;

  test('deletes the subject description and owned subtree, not ?s ?p <id>', () => {
    const plain = deleteToSparql(lower(DeleteBuilder.from(NGPerson, {id: ID})) as never);
    const keeping = deleteToSparql(lower(DeleteBuilder.from(NGPerson, {id: ID})._keepingIncoming()) as never);
    expect(plain).toMatch(/\?s \?p2 <https:\/\/acme\.example\/data\/person\/ann>/);
    expect(keeping).not.toMatch(/\?s \?p2/);
    expect(keeping).toContain(`<${ID}> ?p ?o`);
    // The owned avatar still goes.
    expect(keeping).toContain(`<${NG}avatar>`);
  });

  test('is by ids only', () => {
    expect(() => lower(DeleteBuilder.from(NGPerson)._keepingIncoming().all())).toThrow(/by ids/);
    expect(() => DeleteBuilder.from(NGPerson)._keepingIncoming().all().toJSON()).toThrow(/by ids/);
  });

  test('round-trips through DSL-JSON and lowers to the same delete', () => {
    const json = DeleteBuilder.from(NGPerson, {id: ID})._keepingIncoming().toJSON();
    expect(json).toEqual(expect.objectContaining({op: 'delete', mode: 'ids', ids: [ID], keepIncoming: true}));
    const wire = JSON.parse(JSON.stringify(json));
    const back = DeleteBuilder.fromJSON(wire);
    expect(back.toJSON()).toEqual(json);
    expect(lower(back)).toEqual(expect.objectContaining({kind: 'delete', keepIncoming: true}));
    expect(lowerMutationJSON(wire)).toEqual(expect.objectContaining({kind: 'delete', keepIncoming: true}));
    expect(deleteToSparql(lower(back) as never)).toBe(
      deleteToSparql(lower(DeleteBuilder.from(NGPerson, {id: ID})._keepingIncoming()) as never),
    );
    // A plain delete carries no flag.
    const plain = DeleteBuilder.from(NGPerson, {id: ID}).toJSON();
    expect(plain).not.toHaveProperty('keepIncoming');
    expect(lower(DeleteBuilder.fromJSON(plain))).not.toHaveProperty('keepIncoming');
  });

  test('a receiver that refuses keepIncoming refuses it on every inbound path; others accept it', () => {
    const wire = JSON.parse(JSON.stringify(DeleteBuilder.from(NGPerson, {id: ID})._keepingIncoming().toJSON()));
    const refuse = {refuseKeepIncoming: true};
    expect(() => DeleteBuilder.fromJSON(wire, refuse)).toThrow(/trusted service callers/);
    expect(() => fromJSON(wire, refuse)).toThrow(/trusted service callers/);
    expect(() => fromJSON(wire, {...refuse, catalog: undefined})).toThrow(/trusted service callers/);
    expect(() => lowerMutationJSON(wire, refuse)).toThrow(/trusted service callers/);
    // A plain delete passes a refusing receiver; a receiver that does not refuse keeps the flag.
    const plain = JSON.parse(JSON.stringify(DeleteBuilder.from(NGPerson, {id: ID}).toJSON()));
    expect(lowerMutationJSON(plain, refuse)).toEqual(expect.objectContaining({kind: 'delete'}));
    expect(lowerMutationJSON(wire, {refuseKeepIncoming: false})).toEqual(expect.objectContaining({keepIncoming: true}));
  });

  test('a malformed or misplaced flag is refused', () => {
    const base = {op: 'delete', shape: NGPerson.shape.id} as const;
    expect(() => DeleteBuilder.fromJSON({...base, mode: 'ids', ids: [ID], keepIncoming: 'yes'} as never)).toThrow(/boolean/);
    expect(() => DeleteBuilder.fromJSON({...base, mode: 'all', keepIncoming: true} as never)).toThrow(/by ids/);
    expect(() => lowerMutationJSON({...base, mode: 'all', keepIncoming: true} as never)).toThrow(/mode "ids"/);
  });
});
