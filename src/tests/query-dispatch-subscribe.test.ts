/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty} from '../shapes/SHACL';
import {LinkedStorage} from '../utils/LinkedStorage';
import {
  getQueryDispatch,
  setQueryDispatch,
  subscribeQueryDispatch,
} from '../queries/queryDispatch';
import type {QueryDispatchEvent} from '../queries/queryDispatch';
import type {IDataset} from '../interfaces/IDataset';

const {linkedShape} = linkedPackage('dispatch-subscribe-test');

@linkedShape
class DispatchThing extends Shape {
  static targetClass = {id: 'linked://tmp/dispatch/DispatchThing'};

  @literalProperty({path: {id: 'linked://tmp/dispatch/name'}, maxCount: 1})
  get name(): string {
    return '';
  }
}

type StoreCalls = {
  select: number;
  ask: number;
  create: number;
  update: number;
  delete: number;
};

/** A scripted store that counts calls and remembers the last query it received. */
const createStore = () => {
  const calls: StoreCalls = {select: 0, ask: 0, create: 0, update: 0, delete: 0};
  const received: {update?: unknown} = {};
  const store: IDataset = {
    selectQuery: async () => {
      calls.select += 1;
      return [] as any;
    },
    askQuery: async () => {
      calls.ask += 1;
      return false;
    },
    createQuery: async () => {
      calls.create += 1;
      return {id: 'mock'};
    },
    updateQuery: async (q) => {
      calls.update += 1;
      received.update = q;
      return {id: 'mock'};
    },
    deleteQuery: async () => {
      calls.delete += 1;
      return {deleted: [], count: 0};
    },
  };
  return {store, calls, received};
};

const ID = 'linked://tmp/dispatch/x';

describe('subscribeQueryDispatch', () => {
  let main: ReturnType<typeof createStore>;
  const unsubscribes: Array<() => void> = [];
  const subscribe = (listener: (e: QueryDispatchEvent) => void) => {
    const off = subscribeQueryDispatch(listener);
    unsubscribes.push(off);
    return off;
  };

  beforeEach(() => {
    LinkedStorage.getShapeToDatasetMap().clear();
    main = createStore();
    LinkedStorage.setDefaultDataset(main.store);
  });

  afterEach(() => {
    while (unsubscribes.length) unsubscribes.pop()!();
  });

  test('emits select, ask, create, update and delete events in order', async () => {
    const events: QueryDispatchEvent[] = [];
    subscribe((e) => events.push(e));

    await DispatchThing.select();
    await DispatchThing.exists(ID);
    await DispatchThing.create({name: 'a'});
    await DispatchThing.update({name: 'b'}).for(ID);
    await DispatchThing.delete(ID);

    expect(events.map((e) => e.kind)).toEqual([
      'select',
      'ask',
      'create',
      'update',
      'delete',
    ]);
    await expect(events[2].result).resolves.toEqual({id: 'mock'});
    // The event carries the very builder the store received.
    expect(main.received.update).toBeDefined();
    expect(events[3].query).toBe(main.received.update);
  });

  test('exec(target) is observed and routed to the target', async () => {
    const other = createStore();
    const events: QueryDispatchEvent[] = [];
    subscribe((e) => events.push(e));

    await DispatchThing.update({name: 'c'}).for(ID).exec(other.store);

    expect(events.map((e) => e.kind)).toEqual(['update']);
    expect(other.calls.update).toBe(1);
    expect(main.calls.update).toBe(0);
  });

  test('a throwing listener does not break the mutation or other listeners', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const seen: QueryDispatchEvent[] = [];
      subscribe(() => {
        throw new Error('listener boom');
      });
      subscribe((e) => seen.push(e));

      await expect(DispatchThing.update({name: 'd'}).for(ID)).resolves.toEqual({
        id: 'mock',
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].kind).toBe('update');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toBe('[linked] query dispatch listener failed');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('listeners survive a repeated setDefaultDataset', async () => {
    const events: QueryDispatchEvent[] = [];
    subscribe((e) => events.push(e));

    LinkedStorage.setDefaultDataset(main.store);
    LinkedStorage.setDefaultDataset(main.store);
    await DispatchThing.select();

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('select');
  });

  test('unsubscribe stops delivery', async () => {
    const events: QueryDispatchEvent[] = [];
    const off = subscribe((e) => events.push(e));
    off();

    await DispatchThing.select();

    expect(events).toHaveLength(0);
  });

  test('setQueryDispatch never double-wraps', async () => {
    const events: QueryDispatchEvent[] = [];
    subscribe((e) => events.push(e));

    setQueryDispatch(getQueryDispatch());
    await DispatchThing.select();

    expect(events).toHaveLength(1);
    expect(main.calls.select).toBe(1);
  });
});
