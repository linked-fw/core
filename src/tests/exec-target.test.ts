/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test, beforeEach} from '@jest/globals';
import {Person} from '../test-helpers/query-fixtures';
import {SelectBuilder} from '../queries/QueryBuilder';
import {CreateBuilder} from '../queries/CreateBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {setQueryDispatch} from '../queries/queryDispatch';
import type {IDataset} from '../interfaces/IDataset';

/** Records which store received each kind of query. */
type Hit = {kind: string; on: 'global' | 'target'};

let hits: Hit[];

/** A minimal IDataset that records the kinds of queries it receives. */
function makeStore(on: 'global' | 'target', supports: Set<string>): IDataset {
  const record = (kind: string) => {
    hits.push({kind, on});
    return {} as any;
  };
  // Partial on purpose: a dataset class built against an older core may lack the mutation
  // methods, and exec(target) must refuse such a target.
  const store: Partial<IDataset> = {
    askQuery: async () => false,
    selectQuery: async () => record('select'),
  };
  if (supports.has('create')) store.createQuery = async () => record('create');
  if (supports.has('update')) store.updateQuery = async () => record('update');
  if (supports.has('delete')) store.deleteQuery = async () => record('delete');
  return store as IDataset;
}

const ALL = new Set(['create', 'update', 'delete']);

beforeEach(() => {
  hits = [];
  // Install the global dispatch (tagged 'global') — the router's default.
  setQueryDispatch(makeStore('global', ALL) as any);
});

const id = 'linked://tmp/entities/p1';

describe('exec(target) — runs on the given dataset, not the global default', () => {
  test('SelectBuilder', async () => {
    const target = makeStore('target', ALL);
    await SelectBuilder.from(Person).select((p) => p.name).exec(target);
    expect(hits).toEqual([{kind: 'select', on: 'target'}]);
  });

  test('CreateBuilder', async () => {
    const target = makeStore('target', ALL);
    await CreateBuilder.from(Person).set({name: 'Alice'}).withId(id).exec(target);
    expect(hits).toEqual([{kind: 'create', on: 'target'}]);
  });

  test('UpdateBuilder', async () => {
    const target = makeStore('target', ALL);
    await UpdateBuilder.from(Person).set({name: 'Bob'}).for(id).exec(target);
    expect(hits).toEqual([{kind: 'update', on: 'target'}]);
  });

  test('DeleteBuilder', async () => {
    const target = makeStore('target', ALL);
    await DeleteBuilder.from(Person, {id}).exec(target);
    expect(hits).toEqual([{kind: 'delete', on: 'target'}]);
  });
});

describe('exec() — no target is unchanged (global dispatch)', () => {
  test('SelectBuilder', async () => {
    await SelectBuilder.from(Person).select((p) => p.name).exec();
    expect(hits).toEqual([{kind: 'select', on: 'global'}]);
  });

  test('CreateBuilder', async () => {
    await CreateBuilder.from(Person).set({name: 'Alice'}).withId(id).exec();
    expect(hits).toEqual([{kind: 'create', on: 'global'}]);
  });

  test('UpdateBuilder', async () => {
    await UpdateBuilder.from(Person).set({name: 'Bob'}).for(id).exec();
    expect(hits).toEqual([{kind: 'update', on: 'global'}]);
  });

  test('DeleteBuilder', async () => {
    await DeleteBuilder.from(Person, {id}).exec();
    expect(hits).toEqual([{kind: 'delete', on: 'global'}]);
  });

  test('await (PromiseLike path) stays global even when a target could be passed', async () => {
    await SelectBuilder.from(Person).select((p) => p.name);
    expect(hits).toEqual([{kind: 'select', on: 'global'}]);
  });
});

describe('exec(target) — target lacking a mutation method rejects (never a sync throw)', () => {
  const selectOnly = () => makeStore('target', new Set<string>());

  test('create', async () => {
    await expect(
      CreateBuilder.from(Person).set({name: 'A'}).withId(id).exec(selectOnly()),
    ).rejects.toThrow(/does not support create/i);
  });

  test('update', async () => {
    await expect(
      UpdateBuilder.from(Person).set({name: 'B'}).for(id).exec(selectOnly()),
    ).rejects.toThrow(/does not support update/i);
  });

  test('delete', async () => {
    await expect(
      DeleteBuilder.from(Person, {id}).exec(selectOnly()),
    ).rejects.toThrow(/does not support delete/i);
  });
});
