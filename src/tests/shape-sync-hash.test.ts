/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Shape sync skips a shape whose stored `core:shapeHash` equals the hash of what it would write.
 * The store below keeps the hash each create wrote and answers the hash read from it, so a sync
 * after a sync sees what a real store would.
 */
import {describe, expect, test, beforeEach} from '@jest/globals';
import {builtInShapeIris} from '../utils/ShapeCatalog';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {getPropertyShape} from '../shapes/nodeShapeData';
import {syncShapes, syncShape, shapeSyncHash, SHAPE_HASH_VERSION} from '../shapes/syncShapes';
import {lower} from '../queries/lower';
import {sha256Hex} from '../utils/sha256';
import type {IDataset} from '../interfaces/IDataset';
import '../shapes/List';
import '../shapes/PathNode';

const {linkedShape} = linkedPackage('shapehash-test');
const ex = (n: string) => ({id: `https://example.org/h#${n}`});

@linkedShape
class HPerson extends Shape {
  static targetClass = ex('Person');
  @literalProperty({path: ex('name'), minCount: 1, maxCount: 1})
  get name(): string {
    return '';
  }
  @literalProperty({path: ex('status'), in: ['A', 'B']})
  get status(): string {
    return '';
  }
  @objectProperty({path: {seq: [ex('a'), ex('b')]}, shape: HPerson})
  get chain(): HPerson {
    return null;
  }
}

@linkedShape
class HImage extends Shape {
  static targetClass = ex('Image');
  @literalProperty({path: ex('url'), maxCount: 1})
  get url(): string {
    return '';
  }
}

@linkedShape
class HProject extends Shape {
  static targetClass = ex('Project');
  @objectProperty({path: ex('image'), shape: HImage, maxCount: 1, contains: true})
  get image(): HImage {
    return null;
  }
}

const ORPHAN = 'https://linked.cm/shape/shapehash-test/Gone';
// Core's built-ins are synced like any package's shapes.
const userIris = () => [HPerson.shape.id, HImage.shape.id, HProject.shape.id, ...builtInShapeIris()];

type Call = {kind: 'create' | 'delete' | 'select'; id?: string};

/**
 * An IDataset that remembers which NodeShapes exist and the `core:shapeHash` each create wrote.
 * Every select answers with all stored shapes (the hash read and the orphan read both filter by
 * id themselves, so the extra rows only matter to the orphan sweep, as in a real store).
 */
function makeStore(seed: Record<string, string | undefined> = {}) {
  const shapes = new Map<string, string | undefined>(Object.entries(seed));
  const calls: Call[] = [];
  const store: IDataset = {
    askQuery: async () => false,
    selectQuery: async () => {
      calls.push({kind: 'select'});
      return [...shapes].map(([id, shapeHash]) =>
        shapeHash === undefined ? {id} : {id, shapeHash},
      ) as any;
    },
    createQuery: async (q: any) => {
      const ir = lower(q) as any;
      const id = ir?.data?.id;
      const hashField = (ir?.data?.fields ?? []).find((f: any) =>
        String(f.property).endsWith('/shapeHash'),
      );
      shapes.set(id, hashField?.value);
      calls.push({kind: 'create', id});
      return {} as any;
    },
    deleteQuery: async (q: any) => {
      const id = (lower(q) as any)?.ids?.[0]?.id;
      shapes.delete(id);
      calls.push({kind: 'delete', id});
      return {deleted: [], count: 0};
    },
  };
  const ids = (kind: Call['kind']) => calls.filter((c) => c.kind === kind).map((c) => c.id);
  const reset = () => calls.splice(0);
  return {store, shapes, calls, ids, reset};
}

async function run(plan: Array<() => Promise<void>>) {
  for (const t of plan) await t();
}

describe('syncShapes skips unchanged shapes (core:shapeHash)', () => {
  let s: ReturnType<typeof makeStore>;
  beforeEach(() => {
    s = makeStore();
  });

  test('first sync writes every shape and stores a 64-hex hash on each', async () => {
    const plan = await syncShapes(s.store);
    expect(plan).toHaveLength(userIris().length);
    await run(plan);
    expect(s.ids('create').sort()).toEqual(userIris().sort());
    for (const iri of userIris()) expect(s.shapes.get(iri)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('an unchanged second sync plans no thunk and writes nothing', async () => {
    await run(await syncShapes(s.store));
    s.reset();
    const plan = await syncShapes(s.store);
    expect(plan).toEqual([]);
    // exactly one read (the stored hashes of all code shapes), no delete, no create
    expect(s.calls).toEqual([{kind: 'select'}]);
  });

  test('one changed shape → only that shape is rewritten', async () => {
    await run(await syncShapes(s.store));
    const ps = getPropertyShape(HImage.shape, 'url', false);
    const before = ps.maxCount;
    ps.maxCount = 5;
    try {
      s.reset();
      const plan = await syncShapes(s.store);
      expect(plan).toHaveLength(1);
      await run(plan);
      expect(s.ids('delete')).toEqual([HImage.shape.id]);
      expect(s.ids('create')).toEqual([HImage.shape.id]);
      // and the rewrite stored the new hash: the next sync is quiet again
      expect(await syncShapes(s.store)).toEqual([]);
    } finally {
      ps.maxCount = before;
    }
  });

  test('a change to a generated single-owner shape rewrites its owner', async () => {
    // HProject's generated `image.singleOwner` constraint names the owner classes; a new
    // targetClass changes it, even though HProject's own property shapes are untouched.
    await run(await syncShapes(s.store));
    const original = HProject.shape.targetClass;
    HProject.shape.targetClass = ex('Project2');
    try {
      s.reset();
      const plan = await syncShapes(s.store);
      expect(plan).toHaveLength(1);
      await run(plan);
      expect(s.ids('create')).toEqual([HProject.shape.id]);
    } finally {
      HProject.shape.targetClass = original;
    }
  });

  test('a shape stored without a hash is rewritten once, then skipped', async () => {
    await run(await syncShapes(s.store));
    // as every shape written before hashes existed: present, no core:shapeHash
    s.shapes.set(HPerson.shape.id, undefined);
    s.reset();
    const plan = await syncShapes(s.store);
    expect(plan).toHaveLength(1);
    await run(plan);
    expect(s.ids('create')).toEqual([HPerson.shape.id]);
    expect(s.shapes.get(HPerson.shape.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(await syncShapes(s.store)).toEqual([]);
  });

  test('force rewrites every shape and skips the hash read', async () => {
    await run(await syncShapes(s.store));
    s.reset();
    const plan = await syncShapes(s.store, {force: true});
    expect(plan).toHaveLength(userIris().length);
    expect(s.calls).toEqual([]); // no read at plan time
    await run(plan);
    expect(s.ids('create').sort()).toEqual(userIris().sort());
  });

  test('the orphan sweep is unaffected: an orphan is pruned even when every code shape is skipped', async () => {
    await run(await syncShapes(s.store));
    s.shapes.set(ORPHAN, undefined);
    s.reset();
    const plan = await syncShapes(s.store, {orphanScope: 'all'});
    expect(plan).toHaveLength(1);
    await run(plan);
    expect(s.ids('delete')).toEqual([ORPHAN]);
    expect(s.ids('create')).toEqual([]);
    // default scope still leaves it alone
    s.shapes.set(ORPHAN, undefined);
    expect(await syncShapes(s.store)).toEqual([]);
  });

  test('a generated single-owner shape in the store is not mistaken for an orphan or a code shape', async () => {
    await run(await syncShapes(s.store));
    const generated = `${HProject.shape.id}/image.singleOwner`;
    s.shapes.set(generated, undefined);
    s.reset();
    expect(await syncShapes(s.store, {orphanScope: 'all'})).toEqual([]);
  });
});

describe('syncShape skips an unchanged shape', () => {
  test('second run reads the hash and writes nothing; force writes', async () => {
    const s = makeStore();
    await syncShape(HPerson, s.store)();
    expect(s.ids('create')).toEqual([HPerson.shape.id]);
    s.reset();
    await syncShape(HPerson, s.store)();
    expect(s.calls).toEqual([{kind: 'select'}]);
    s.reset();
    await syncShape(HPerson, s.store, {force: true})();
    expect(s.calls.map((c) => c.kind)).toEqual(['delete', 'create']);
  });
});

describe('shapeSyncHash', () => {
  const data = () => ({
    targetClass: {id: 'https://example.org/h#T'},
    closed: true,
    properties: [
      {__id: 'https://s/T/a', path: {id: 'https://example.org/h#a'}, maxCount: 1, label: 'a'},
      {__id: 'https://s/T/b', path: {id: 'https://example.org/h#b'}, minCount: 0, label: 'b'},
    ],
  });

  test('same data built twice → same hash', () => {
    expect(shapeSyncHash(data(), 'https://s/T')).toBe(shapeSyncHash(data(), 'https://s/T'));
  });

  test('property order and object key order do not change the hash', () => {
    const reordered = {
      properties: [...data().properties].reverse().map((p) =>
        Object.fromEntries(Object.entries(p).reverse()),
      ),
      closed: true,
      targetClass: {id: 'https://example.org/h#T'},
    };
    expect(shapeSyncHash(reordered, 'https://s/T')).toBe(shapeSyncHash(data(), 'https://s/T'));
  });

  test('a changed value, IRI, or list order changes the hash', () => {
    const base = shapeSyncHash(data(), 'https://s/T');
    const changed = data();
    changed.properties[0].maxCount = 2;
    expect(shapeSyncHash(changed, 'https://s/T')).not.toBe(base);
    expect(shapeSyncHash(data(), 'https://s/U')).not.toBe(base);
    // rdf:List order is structural (first/rest), so it is kept
    const list = (a: string, b: string) => ({first: a, rest: {first: b, rest: {id: 'nil'}}});
    expect(shapeSyncHash({in: list('x', 'y')}, 'https://s/T')).not.toBe(
      shapeSyncHash({in: list('y', 'x')}, 'https://s/T'),
    );
    // a number and its string form differ (different literal datatypes)
    expect(shapeSyncHash({maxCount: 1}, 'https://s/T')).not.toBe(
      shapeSyncHash({maxCount: '1'}, 'https://s/T'),
    );
  });

  test('is pinned: a fixed input always gives this canonical form (any process, any runtime)', async () => {
    // The documented canonical form: sorted keys, sorted array values, tagged non-string scalars.
    // A change to it rewrites every stored shape once. The prefix follows SHAPE_HASH_VERSION, so a
    // bump (enforced by shape-sync-output-equivalence.test.ts) leaves this test as it is.
    const canonical =
      `linked-shape-sync/${SHAPE_HASH_VERSION}\n` +
      '{"data":{"closed":b:true,"properties":[' +
      '{"__id":"https://s/T/a","label":"a","maxCount":n:1,"path":{"id":"https://example.org/h#a"}},' +
      '{"__id":"https://s/T/b","label":"b","minCount":n:0,"path":{"id":"https://example.org/h#b"}}' +
      '],"targetClass":{"id":"https://example.org/h#T"}},"iri":"https://s/T"}';
    const {createHash} = await import('node:crypto');
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const pinned: Record<number, string> = {
      1: '39faa2449c092aca0bd6d3f11ac0b85a898b67491c3611f10903206bb6653800',
      2: '2bba76066dff5c588e767062cf02bd7c4a0c5ed368633f8ea667b91f83708338',
    };
    if (pinned[SHAPE_HASH_VERSION]) expect(digest).toBe(pinned[SHAPE_HASH_VERSION]);
    expect(shapeSyncHash(data(), 'https://s/T')).toBe(digest);
  });
});

describe('sha256Hex', () => {
  test('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  test('hashes UTF-8 bytes and multi-block input like node:crypto', async () => {
    const {createHash} = await import('node:crypto');
    for (const input of ['é∑😀', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)]) {
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
    }
  });
});
