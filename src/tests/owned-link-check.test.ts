/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test, beforeAll, afterAll, beforeEach} from '@jest/globals';
import {
  createTestDataset,
  executeSparqlQuery,
  executeSparqlUpdate,
  clearAllData,
  FUSEKI_BASE_URL,
  DATASET_NAME,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {CreateBuilder} from '../queries/CreateBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {lower} from '../queries/lower';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {
  assertOwnedLinkTypes,
  collectOwnedLinks,
  ownedLinkTypesQuery,
} from '../sparql/ownedLinkCheck';
import {rdf} from '../ontologies/rdf';
import {updateToSparql} from '../sparql/irToAlgebra';
import '../shapes/List';
import '../shapes/PathNode';

const {linkedShape} = linkedPackage('owned-link-check-test');
const O = 'http://example.org/olc#';
const ex = (n: string) => ({id: `${O}${n}`});
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

@linkedShape
class TPhoto extends Shape {
  static targetClass = ex('Photo');
  @literalProperty({path: ex('caption'), maxCount: 1})
  get caption(): string {
    return null;
  }
}

@linkedShape
class TPanorama extends TPhoto {
  static targetClass = ex('Panorama');
}

@linkedShape
class TPerson extends Shape {
  static targetClass = ex('Person');
}

@linkedShape
class TAlbum extends Shape {
  static targetClass = ex('Album');
  @literalProperty({path: ex('title'), maxCount: 1})
  get title(): string {
    return null;
  }
  @objectProperty({path: ex('cover'), shape: TPhoto, maxCount: 1, contains: true})
  get cover(): TPhoto {
    return null;
  }
  @objectProperty({path: ex('photos'), shape: TPhoto, contains: true})
  get photos(): TPhoto[] {
    return [];
  }
  @objectProperty({path: ex('featured'), shape: TPhoto, maxCount: 1})
  get featured(): TPhoto {
    return null;
  }
  @objectProperty({path: ex('subAlbum'), shape: TAlbum, maxCount: 1, contains: true})
  get subAlbum(): TAlbum {
    return null;
  }
  @objectProperty({path: ex('any'), maxCount: 1})
  get any(): unknown {
    return null;
  }
}

// A plain (non-`contains`) property on a predicate that TAlbum declares `contains`. Ownership
// is per property, so it owns nothing: no class check, no delete on replace.
@linkedShape
class TScrapbook extends Shape {
  static targetClass = ex('Scrapbook');
  @objectProperty({path: ex('cover'), shape: TPhoto, maxCount: 1})
  get cover(): TPhoto {
    return null;
  }
}

// The same shared predicate without a value shape: no expected class.
@linkedShape
class TLooseBook extends Shape {
  static targetClass = ex('LooseBook');
  @objectProperty({path: ex('cover'), maxCount: 1})
  get cover(): unknown {
    return null;
  }
}

const links = (builder: unknown) =>
  collectOwnedLinks(lower(builder as any) as any).map((l) => [l.label, l.id]);

describe('collectOwnedLinks', () => {
  test('single value, array and set add are links; set remove is not', () => {
    expect(links(UpdateBuilder.from(TAlbum).for(`${O}al1`).set({cover: {id: `${O}a`}}))).toEqual([
      ['cover', `${O}a`],
    ]);
    expect(
      links(UpdateBuilder.from(TAlbum).for(`${O}al1`).set({photos: [{id: `${O}b`}, {id: `${O}c`}]} as any)),
    ).toEqual([
      ['photos', `${O}b`],
      ['photos', `${O}c`],
    ]);
    expect(
      links(
        UpdateBuilder.from(TAlbum)
          .for(`${O}al1`)
          .set({photos: {add: [{id: `${O}d`}], remove: [{id: `${O}e`}]}} as any),
      ),
    ).toEqual([['photos', `${O}d`]]);
  });

  test('a nested create is not a link, but its own fields are', () => {
    expect(
      links(UpdateBuilder.from(TAlbum).for(`${O}al1`).set({cover: {id: `${O}n1`, caption: 'x'}} as any)),
    ).toEqual([]);
    expect(
      links(CreateBuilder.from(TAlbum).set({subAlbum: {title: 'inner', cover: {id: `${O}x`}}} as any)),
    ).toEqual([['cover', `${O}x`]]);
  });

  test('non-contains properties and rdf:nil are skipped', () => {
    const b = UpdateBuilder.from(TAlbum)
      .for(`${O}al1`)
      .set({featured: {id: `${O}f`}, any: {id: `${O}p`}, photos: [{id: rdf.nil.id}]} as any);
    expect(links(b)).toEqual([]);
  });

  test('a plain property on a contains predicate is not checked', () => {
    // TScrapbook.cover is plain on the predicate TAlbum.cover declares `contains`.
    expect(links(UpdateBuilder.from(TScrapbook).for(`${O}sb1`).set({cover: {id: `${O}a`}}))).toEqual([]);
    // Without a value shape there is no expected class: not checked.
    expect(links(UpdateBuilder.from(TLooseBook).for(`${O}lb1`).set({cover: {id: `${O}a`}} as any))).toEqual([]);
  });

  test('the check and the replace delete agree on which fields own their value', () => {
    // The `contains` property's replace deletes the old value's own triples, and is checked.
    const owned = updateToSparql(
      lower(UpdateBuilder.from(TAlbum).for(`${O}al1`).set({cover: {id: `${O}a`}})) as any,
    );
    expect(owned).toMatch(/\?old_cover \?uc0_sp \?uc0_so/);
    // The plain property on the same predicate deletes nothing, and is not checked.
    const plain = updateToSparql(
      lower(UpdateBuilder.from(TScrapbook).for(`${O}sb1`).set({cover: {id: `${O}a`}})) as any,
    );
    expect(plain).not.toMatch(/\?old_cover \?uc0_sp \?uc0_so/);
  });

  test('update-where (forAll) is collected', () => {
    expect(links(UpdateBuilder.from(TAlbum).forAll().set({cover: {id: `${O}a`}}))).toEqual([
      ['cover', `${O}a`],
    ]);
  });

  test('accepted classes include registered sub-shapes', () => {
    const [link] = collectOwnedLinks(
      lower(UpdateBuilder.from(TAlbum).for(`${O}al1`).set({cover: {id: `${O}a`}})) as any,
    );
    expect(link.expectedClass).toBe(`${O}Photo`);
    expect(link.acceptedClasses).toEqual(expect.arrayContaining([`${O}Photo`, `${O}Panorama`]));
    expect(link.acceptedClasses).not.toContain(`${O}Person`);
    expect(link.shape).toBe(TAlbum.shape.id);
  });

  test('query lists distinct ids once', () => {
    expect(ownedLinkTypesQuery([`${O}a`, `${O}b`, `${O}a`])).toBe(
      `SELECT ?id ?type WHERE { VALUES ?id { <${O}a> <${O}b> } ?id <${RDF_TYPE}> ?type }`,
    );
    expect(() => ownedLinkTypesQuery(['http://x/a> } DROP ALL #'])).toThrow(/Invalid IRI/);
  });

  test('assertOwnedLinkTypes: untyped passes, typed wrong is refused with every violation', () => {
    const ls = collectOwnedLinks(
      lower(
        UpdateBuilder.from(TAlbum).for(`${O}al1`).set({photos: [{id: `${O}u`}, {id: `${O}p1`}, {id: `${O}alice`}]} as any),
      ) as any,
    );
    const types = new Map([
      [`${O}p1`, new Set([`${O}Photo`])],
      [`${O}alice`, new Set([`${O}Person`])],
    ]);
    expect(() => assertOwnedLinkTypes(ls, types)).toThrow(
      `Cannot link <${O}alice> into the contains property "photos" of <${TAlbum.shape.id}>: ` +
        `it is typed <${O}Person>, but "photos" only owns instances of <${O}Photo>`,
    );
    expect(() => assertOwnedLinkTypes(ls.slice(0, 2), types)).not.toThrow();
  });
});

/** A SPARQL dataset that records what it is asked and answers type queries from a map. */
class StubDataset extends SparqlDataset {
  selects: string[] = [];
  updates: string[] = [];
  constructor(private types: Record<string, string[]> = {}) {
    super();
  }
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    this.selects.push(sparql);
    const bindings = Object.entries(this.types)
      .filter(([id]) => sparql.includes(`<${id}>`))
      .flatMap(([id, ts]) =>
        ts.map((t) => ({id: {type: 'uri' as const, value: id}, type: {type: 'uri' as const, value: t}})),
      );
    return {head: {vars: ['id', 'type']}, results: {bindings}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

describe('SparqlDataset owned-link check (stub store)', () => {
  const alice = `${O}alice`;
  const types = {
    [alice]: [`${O}Person`],
    [`${O}p1`]: [`${O}Photo`],
    [`${O}pano`]: [`${O}Panorama`],
    [`${O}multi`]: [`${O}Person`, `${O}Photo`],
  };

  test('no links: no select', async () => {
    const ds = new StubDataset(types);
    await UpdateBuilder.from(TAlbum).for(`${O}al1`).set({title: 't'}).exec(ds);
    expect(ds.selects).toHaveLength(0);
    expect(ds.updates).toHaveLength(1);
  });

  test('one select for many links', async () => {
    const ds = new StubDataset(types);
    await UpdateBuilder.from(TAlbum)
      .for(`${O}al1`)
      .set({photos: [{id: `${O}a`}, {id: `${O}b`}, {id: `${O}c`}]} as any)
      .exec(ds);
    expect(ds.selects).toHaveLength(1);
    expect(ds.updates).toHaveLength(1);
  });

  test('a wrongly typed id is refused and nothing is written', async () => {
    const ds = new StubDataset(types);
    const run = UpdateBuilder.from(TAlbum).for(`${O}al1`).set({cover: {id: alice}}).exec(ds);
    await expect(run).rejects.toThrow('"cover"');
    await expect(
      UpdateBuilder.from(TAlbum).for(`${O}al1`).set({cover: {id: alice}}).exec(ds),
    ).rejects.toThrow(new RegExp(`<${alice}>[\\s\\S]*<http://example\\.org/olc#Photo>`));
    expect(ds.updates).toHaveLength(0);
  });

  test('a plain property on a contains predicate is not refused', async () => {
    const ds = new StubDataset(types);
    await UpdateBuilder.from(TScrapbook).for(`${O}sb1`).set({cover: {id: alice}}).exec(ds);
    expect(ds.updates).toHaveLength(1);
  });

  test('a sub-shape class, an untyped id and one matching type of several pass', async () => {
    const ds = new StubDataset(types);
    for (const id of [`${O}pano`, `${O}unknown`, `${O}multi`, `${O}p1`]) {
      await UpdateBuilder.from(TAlbum).for(`${O}al1`).set({cover: {id}}).exec(ds);
    }
    expect(ds.updates).toHaveLength(4);
  });

  test('create, upsert and update-where are checked too', async () => {
    const ds = new StubDataset(types);
    await expect(
      CreateBuilder.from(TAlbum).set({cover: {id: alice}}).exec(ds),
    ).rejects.toThrow('Cannot link');
    await expect(
      UpdateBuilder.upsertFrom(TAlbum).for(`${O}al1`).set({cover: {id: alice}}).exec(ds),
    ).rejects.toThrow('Cannot link');
    await expect(
      UpdateBuilder.from(TAlbum).forAll().set({cover: {id: alice}}).exec(ds),
    ).rejects.toThrow('Cannot link');
    expect(ds.updates).toHaveLength(0);
  });
});

describeFuseki('SparqlDataset owned-link check — live Fuseki', () => {
  let store: FusekiStore;
  const RDF = 'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n';

  const coverOf = async (album: string) => {
    const res = await executeSparqlQuery(`SELECT ?c WHERE { <${album}> <${O}cover> ?c }`);
    return res.results.bindings.map((b: any) => b.c.value);
  };

  beforeAll(async () => {
    await createTestDataset();
    store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
  });
  afterAll(async () => {
    await clearAllData();
  });
  beforeEach(async () => {
    await clearAllData();
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { <${O}album1> rdf:type <${O}Album> . <${O}alice> rdf:type <${O}Person> . <${O}p1> rdf:type <${O}Photo> . }`,
    );
  });

  test('linking a Person into a contains slot is refused; a Photo is linked', async () => {
    await expect(
      UpdateBuilder.from(TAlbum).for(`${O}album1`).set({cover: {id: `${O}alice`}}).exec(store),
    ).rejects.toThrow('Cannot link');
    expect(await coverOf(`${O}album1`)).toEqual([]);

    await UpdateBuilder.from(TAlbum).for(`${O}album1`).set({cover: {id: `${O}p1`}}).exec(store);
    expect(await coverOf(`${O}album1`)).toEqual([`${O}p1`]);
  });

  test('a plain property on a contains predicate links without a check, and deletes nothing', async () => {
    await executeSparqlUpdate(`${RDF}INSERT DATA { <${O}sb1> rdf:type <${O}Scrapbook> . }`);
    await UpdateBuilder.from(TScrapbook).for(`${O}sb1`).set({cover: {id: `${O}alice`}}).exec(store);
    expect(await coverOf(`${O}sb1`)).toEqual([`${O}alice`]);
    await UpdateBuilder.from(TScrapbook).for(`${O}sb1`).set({cover: {id: `${O}p1`}}).exec(store);
    expect(await coverOf(`${O}sb1`)).toEqual([`${O}p1`]);
    // alice was referenced, never owned: still there.
    const alice = await executeSparqlQuery(`SELECT ?p ?o WHERE { <${O}alice> ?p ?o }`);
    expect(alice.results.bindings).toHaveLength(1);
  });
});
