/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test, beforeEach} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty, NodeShape} from '../shapes/SHACL';
import {setQueryDispatch} from '../queries/queryDispatch';
import {syncShapes, syncShape} from '../shapes/syncShapes';
import {lower} from '../queries/lower';
import type {IDataset} from '../interfaces/IDataset';
import '../shapes/List';
import '../shapes/PathNode';

const {linkedShape} = linkedPackage('syncshapes-test');
const ex = (n: string) => ({id: `https://example.org/u#${n}`});

@linkedShape
class TUser extends Shape {
  static targetClass = ex('User');
  @literalProperty({path: ex('name'), minCount: 1, maxCount: 1})
  get name(): string {
    return '';
  }
  @literalProperty({path: ex('status'), in: ['A', 'B']})
  get status(): string {
    return '';
  }
  @objectProperty({path: {seq: [ex('a'), ex('b')]}, shape: TUser})
  get chain(): TUser {
    return null;
  }
}

@linkedShape
class TOther extends Shape {
  static targetClass = ex('Other');
  @literalProperty({path: ex('label'), maxCount: 1})
  get label(): string {
    return '';
  }
}

const ORPHAN = 'https://linked.cm/shape/syncshapes-test/GoneShape';

type Call = {kind: string; id?: string};
let calls: Call[];

function installMock(existingIds: string[]) {
  calls = [];
  setQueryDispatch({
    selectQuery: async () => existingIds.map((id) => ({id})) as any,
    askQuery: async () => existingIds.length > 0,
    createQuery: async (q: any) => {
      calls.push({kind: 'create', id: (lower(q) as any)?.data?.id});
      return {} as any;
    },
    updateQuery: async () => ({} as any),
    deleteQuery: async (q: any) => {
      calls.push({kind: 'delete', id: (lower(q) as any)?.ids?.[0]?.id});
      return {deleted: [], count: 0};
    },
  });
}

describe('syncShapes', () => {
  const userIri = () => TUser.shape.id;

  beforeEach(() => installMock([userIri(), ORPHAN]));

  test('returns an array of thunks', async () => {
    const plan = await syncShapes();
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.every((t) => typeof t === 'function')).toBe(true);
  });

  test('routes create/delete for user shape, delete for orphan, skips framework shapes', async () => {
    const plan = await syncShapes(undefined, {orphanScope: 'all'});
    for (const run of plan) await run(); // sequential for deterministic ordering

    const creates = calls.filter((c) => c.kind === 'create').map((c) => c.id);
    const deletes = calls.filter((c) => c.kind === 'delete').map((c) => c.id);

    // user shape: delete + create
    expect(creates).toContain(userIri());
    expect(deletes).toContain(userIri());
    // orphan: delete only, no create
    expect(deletes).toContain(ORPHAN);
    expect(creates).not.toContain(ORPHAN);
    // framework shapes never synced
    expect(creates).not.toContain('https://linked.cm/shape/core/NodeShape');
    expect(creates).not.toContain('https://linked.cm/shape/core/List');
    expect(deletes).not.toContain('https://linked.cm/shape/core/PropertyShape');
    // base Shape has no packageName and must also be excluded
    expect(creates).not.toContain('https://linked.cm/shape/core/Shape');
  });

  test('per-shape ordering: delete runs before create', async () => {
    const plan = await syncShapes();
    for (const run of plan) await run();
    const delIdx = calls.findIndex((c) => c.kind === 'delete' && c.id === userIri());
    const createIdx = calls.findIndex((c) => c.kind === 'create' && c.id === userIri());
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(delIdx);
  });

  test('builds without error for shapes with sh:in and complex paths', async () => {
    // Exercises rdfList + serializePathToNodeData through the create build inside the thunk.
    const plan = await syncShapes();
    await expect(Promise.all(plan.map((run) => run()))).resolves.toBeDefined();
  });
});

describe('syncShapes orphanScope (multi-writer, arch-04)', () => {
  const userIri = () => TUser.shape.id;
  // An orphan in the SAME package namespace as the app's shapes (a renamed/removed app shape).
  const OWNED_ORPHAN = 'https://linked.cm/shape/syncshapes-test/GoneShape';
  // An orphan in a DIFFERENT package namespace — a second writer's shape (e.g. a CN
  // capability shape materialized into the same app-data dataset via syncShape).
  const FOREIGN_ORPHAN = 'https://id.linked.cm/shape/documents/SourceDocument';

  beforeEach(() => installMock([userIri(), OWNED_ORPHAN, FOREIGN_ORPHAN]));

  test("default prunes nothing — neither the owned nor the foreign orphan", async () => {
    const plan = await syncShapes();
    for (const run of plan) await run();
    const deletes = calls.filter((c) => c.kind === 'delete').map((c) => c.id);
    const creates = calls.filter((c) => c.kind === 'create').map((c) => c.id);
    // code shapes are still delete→recreated
    expect(creates).toContain(userIri());
    expect(deletes).toContain(userIri());
    expect(deletes).not.toContain(OWNED_ORPHAN);
    expect(deletes).not.toContain(FOREIGN_ORPHAN);
  });

  test("explicit 'all' prunes both the owned and the foreign orphan", async () => {
    const plan = await syncShapes(undefined, {orphanScope: 'all'});
    for (const run of plan) await run();
    const deletes = calls.filter((c) => c.kind === 'delete').map((c) => c.id);
    expect(deletes).toContain(OWNED_ORPHAN);
    expect(deletes).toContain(FOREIGN_ORPHAN);
  });

  test("'ownedNamespaces' prunes the owned orphan but preserves the foreign one", async () => {
    const plan = await syncShapes(undefined, {orphanScope: 'ownedNamespaces'});
    for (const run of plan) await run();
    const deletes = calls.filter((c) => c.kind === 'delete').map((c) => c.id);
    const creates = calls.filter((c) => c.kind === 'create').map((c) => c.id);
    // app's own shape still materialized
    expect(creates).toContain(userIri());
    // renamed/removed shape in the app's own namespace still pruned
    expect(deletes).toContain(OWNED_ORPHAN);
    // the second writer's shape is left untouched — no delete, no create
    expect(deletes).not.toContain(FOREIGN_ORPHAN);
    expect(creates).not.toContain(FOREIGN_ORPHAN);
  });

  test("'none' prunes nothing — purely additive", async () => {
    const plan = await syncShapes(undefined, {orphanScope: 'none'});
    for (const run of plan) await run();
    const deletes = calls.filter((c) => c.kind === 'delete').map((c) => c.id);
    const creates = calls.filter((c) => c.kind === 'create').map((c) => c.id);
    // code shape is still delete→recreated
    expect(creates).toContain(userIri());
    expect(deletes).toContain(userIri());
    // no orphan (owned or foreign) is swept
    expect(deletes).not.toContain(OWNED_ORPHAN);
    expect(deletes).not.toContain(FOREIGN_ORPHAN);
  });
});

describe('syncShapes with a partial registry (deep imports)', () => {
  // The store holds a whole package's worth of shapes, but this process registered only some of
  // them — e.g. it deep-imported one shape file. Shapes it did not load are in the SAME package
  // namespace as the ones it did, so 'ownedNamespaces' cannot tell them apart from removals.
  const NOT_LOADED = [
    'https://linked.cm/shape/syncshapes-test/NotLoadedA',
    'https://linked.cm/shape/syncshapes-test/NotLoadedB',
    'https://linked.cm/shape/syncshapes-test/NotLoadedC',
  ];
  const FOREIGN = 'https://id.linked.cm/shape/documents/SourceDocument';
  const storeIds = () => [TUser.shape.id, TOther.shape.id, ...NOT_LOADED, FOREIGN];

  test('default: every store shape the process did not load survives', async () => {
    const {store, storeCalls} = makeTargetStore(storeIds());
    const plan = await syncShapes(store);
    for (const run of plan) await run();
    const deletes = storeCalls.filter((c) => c.kind === 'delete').map((c) => c.id);
    const creates = storeCalls.filter((c) => c.kind === 'create').map((c) => c.id);
    // only the registered shapes are touched (delete→recreate)
    expect(deletes.sort()).toEqual([TOther.shape.id, TUser.shape.id].sort());
    expect(creates.sort()).toEqual([TOther.shape.id, TUser.shape.id].sort());
  });

  test("explicit 'all' still prunes every store shape the process did not load", async () => {
    const {store, storeCalls} = makeTargetStore(storeIds());
    const plan = await syncShapes(store, {orphanScope: 'all'});
    for (const run of plan) await run();
    const deletes = storeCalls.filter((c) => c.kind === 'delete').map((c) => c.id);
    for (const id of [...NOT_LOADED, FOREIGN]) expect(deletes).toContain(id);
  });
});

describe('syncShape (single)', () => {
  const userIri = () => TUser.shape.id;
  const otherIri = () => TOther.shape.id;

  // Store already contains TUser, TOther, and an orphan not in code.
  beforeEach(() => installMock([userIri(), otherIri(), ORPHAN]));

  test('returns a single thunk (not an array)', () => {
    const t = syncShape(TUser);
    expect(typeof t).toBe('function');
    expect(Array.isArray(t)).toBe(false);
  });

  test('materializes only the target shape — no other shape, no orphan sweep', async () => {
    await syncShape(TUser)();
    const ids = (k: string) => calls.filter((c) => c.kind === k).map((c) => c.id);
    // exactly delete + create for the target
    expect(ids('delete')).toEqual([userIri()]);
    expect(ids('create')).toEqual([userIri()]);
    // the other shape is untouched (no collateral delete/create)
    expect(calls.some((c) => c.id === otherIri())).toBe(false);
    // and crucially NO orphan sweep — the store-only shape survives (unlike syncShapes)
    expect(calls.some((c) => c.id === ORPHAN)).toBe(false);
  });

  test('IRI form resolves to the same result as the class form', async () => {
    await syncShape(userIri())();
    const ids = (k: string) => calls.filter((c) => c.kind === k).map((c) => c.id);
    expect(ids('delete')).toEqual([userIri()]);
    expect(ids('create')).toEqual([userIri()]);
  });

  test('delete runs before create, and is idempotent across runs', async () => {
    const t = syncShape(TUser);
    await t();
    await t();
    // delete→create each run, target only, no duplication of other ids
    expect(calls.map((c) => `${c.kind}:${c.id}`)).toEqual([
      `delete:${userIri()}`,
      `create:${userIri()}`,
      `delete:${userIri()}`,
      `create:${userIri()}`,
    ]);
  });

  test('rejects a framework/meta shape (class and IRI form)', () => {
    expect(() => syncShape(NodeShape)).toThrow(/framework|meta/i);
    expect(() => syncShape('https://linked.cm/shape/core/NodeShape')).toThrow();
  });

  test('rejects an unregistered IRI', () => {
    expect(() => syncShape('https://example.org/not-registered')).toThrow(
      /no registered shape/i,
    );
  });
});

// A recording IDataset used as an explicit target. Its selectQuery returns the seeded
// existing shape ids (for orphan detection); create/delete record what they receive.
function makeTargetStore(existingIds: string[]) {
  const storeCalls: Call[] = [];
  const store: IDataset = {
    askQuery: async () => false,
    selectQuery: async () => existingIds.map((id) => ({id})) as any,
    createQuery: async (q: any) => {
      storeCalls.push({kind: 'create', id: (lower(q) as any)?.data?.id});
      return {} as any;
    },
    deleteQuery: async (q: any) => {
      storeCalls.push({kind: 'delete', id: (lower(q) as any)?.ids?.[0]?.id});
      return {deleted: [], count: 0};
    },
  };
  return {store, storeCalls};
}

describe('dataset threading — sync into an explicit store, global router untouched', () => {
  const userIri = () => TUser.shape.id;

  beforeEach(() => {
    // Global dispatch would record into `calls` if it were ever hit — it must not be.
    installMock([userIri(), ORPHAN]);
  });

  test('syncShape(Shape, store) materializes into store only; global untouched', async () => {
    const {store, storeCalls} = makeTargetStore([userIri()]);
    await syncShape(TUser, store)();

    const ids = (k: string) => storeCalls.filter((c) => c.kind === k).map((c) => c.id);
    expect(ids('delete')).toEqual([userIri()]);
    expect(ids('create')).toEqual([userIri()]);
    // The global store never saw a single query.
    expect(calls).toEqual([]);
  });

  test('syncShapes(store): orphan read + all delete/create hit store; global untouched', async () => {
    // The store's orphan (STORE_ORPHAN) is DISTINCT from the global mock's orphan (ORPHAN).
    // Pruning STORE_ORPHAN — and never ORPHAN — proves the orphan read hit the store, not global.
    const STORE_ORPHAN = 'https://linked.cm/shape/syncshapes-test/StoreOnlyShape';
    const {store, storeCalls} = makeTargetStore([userIri(), TOther.shape.id, STORE_ORPHAN]);
    const plan = await syncShapes(store, {orphanScope: 'all'});
    for (const run of plan) await run();

    const creates = storeCalls.filter((c) => c.kind === 'create').map((c) => c.id);
    const deletes = storeCalls.filter((c) => c.kind === 'delete').map((c) => c.id);

    // in-code shapes recreated in the store
    expect(creates).toContain(userIri());
    expect(creates).toContain(TOther.shape.id);
    // the store's own orphan is pruned — delete only, no create
    expect(deletes).toContain(STORE_ORPHAN);
    expect(creates).not.toContain(STORE_ORPHAN);
    // the global mock's orphan is never touched — the orphan read did not hit global
    expect(deletes).not.toContain(ORPHAN);
    // and the global router recorded no create/delete at all
    expect(calls).toEqual([]);
  });
});
