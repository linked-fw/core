/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {afterEach, describe, expect, jest, test} from '@jest/globals';
import {cached, invalidateCached} from '../utils/cached';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('cached() — keyed form', () => {
  test('an inline function hits under the same key and args', () => {
    let calls = 0;
    const load = (id: string) => cached('keyed-inline', () => ++calls, [id], Infinity);
    expect(load('p1')).toBe(1);
    expect(load('p1')).toBe(1);
    expect(calls).toBe(1);
    // Different args miss.
    expect(load('p2')).toBe(2);
  });

  test('two keys with the same args do not collide', () => {
    expect(cached('keyed-a', () => 'A', ['same'], Infinity)).toBe('A');
    expect(cached('keyed-b', () => 'B', ['same'], Infinity)).toBe('B');
    expect(cached('keyed-a', () => 'other', ['same'], Infinity)).toBe('A');
  });

  test('an entry expires after cacheTimeMs', () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let calls = 0;
    const call = () => cached('keyed-expiry', () => ++calls, ['x'], 100);
    expect(call()).toBe(1);
    now += 100; // timeout is inclusive: still cached at exactly the boundary
    expect(call()).toBe(1);
    now += 1;
    expect(call()).toBe(2);
    expect(call()).toBe(2);
  });

  test('cacheTimeMs = 0 never caches', () => {
    let calls = 0;
    expect(cached('keyed-zero', () => ++calls, ['x'], 0)).toBe(1);
    expect(cached('keyed-zero', () => ++calls, ['x'], 0)).toBe(2);
    // ...and stores nothing a later caching call could pick up.
    expect(cached('keyed-zero', () => ++calls, ['x'], Infinity)).toBe(3);
  });

  test('invalidateCached(key) drops every entry of the key, and only that key', () => {
    let calls = 0;
    const call = (key: string, arg: string) => cached(key, () => ++calls, [arg], Infinity);
    expect(call('keyed-inv', 'a')).toBe(1);
    expect(call('keyed-inv', 'b')).toBe(2);
    expect(call('keyed-inv-other', 'a')).toBe(3);
    invalidateCached('keyed-inv');
    expect(call('keyed-inv', 'a')).toBe(4);
    expect(call('keyed-inv', 'b')).toBe(5);
    expect(call('keyed-inv-other', 'a')).toBe(3);
  });

  test('invalidateCached(key, args) drops only that args entry', () => {
    let calls = 0;
    const call = (arg: {id: string}) => cached('keyed-inv-one', () => ++calls, [arg], Infinity);
    expect(call({id: 'a'})).toBe(1);
    expect(call({id: 'b'})).toBe(2);
    // Args are compared the same way as in cached(): an {id} object by its id.
    invalidateCached('keyed-inv-one', [{id: 'a'}]);
    expect(call({id: 'a'})).toBe(3);
    expect(call({id: 'b'})).toBe(2);
    // Unknown keys are a no-op.
    expect(() => invalidateCached('keyed-never-used', ['x'])).not.toThrow();
  });
});

describe('cached() — async rejection', () => {
  test('keyed: a rejected promise is evicted, the caller still sees the rejection', async () => {
    let calls = 0;
    const call = () =>
      cached('keyed-reject', async () => {
        calls++;
        if (calls === 1) throw new Error('first fails');
        return 'ok';
      }, ['x'], Infinity);
    await expect(call()).rejects.toThrow('first fails');
    await expect(call()).resolves.toBe('ok');
    await expect(call()).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  test('keyed: with alsoCacheErrors the rejected promise stays cached', async () => {
    let calls = 0;
    const call = () =>
      cached('keyed-reject-kept', async () => {
        calls++;
        throw new Error('always fails');
      }, ['x'], Infinity, true);
    await expect(call()).rejects.toThrow('always fails');
    await expect(call()).rejects.toThrow('always fails');
    expect(calls).toBe(1);
  });

  test('identity form: a rejected promise is evicted, kept with alsoCacheErrors', async () => {
    let calls = 0;
    const failsOnce = async () => {
      calls++;
      if (calls === 1) throw new Error('identity fails');
      return calls;
    };
    await expect(cached(failsOnce, ['x'], Infinity)).rejects.toThrow('identity fails');
    await expect(cached(failsOnce, ['x'], Infinity)).resolves.toBe(2);
    expect(calls).toBe(2);

    let keptCalls = 0;
    const alwaysFails = async () => {
      keptCalls++;
      throw new Error('identity kept');
    };
    await expect(cached(alwaysFails, ['x'], Infinity, true)).rejects.toThrow('identity kept');
    await expect(cached(alwaysFails, ['x'], Infinity, true)).rejects.toThrow('identity kept');
    expect(keptCalls).toBe(1);
  });

  test('a resolved promise stays cached', async () => {
    let calls = 0;
    const call = () => cached('keyed-resolve', async () => ++calls, ['x'], Infinity);
    await expect(call()).resolves.toBe(1);
    await expect(call()).resolves.toBe(1);
    expect(calls).toBe(1);
  });
});

describe('cached() — identity form inline-function warning', () => {
  test('warns once per source when a new function with an already cached source is passed', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const call = (id: string) => cached(() => `inline-warning-${id}`, [id], Infinity);
    call('a'); // first sighting of this source: no warning
    expect(warn).not.toHaveBeenCalled();
    call('a'); // new object, same source: the inline-function miss
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("cached('some-key'");
    call('b');
    call('a');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('a reused (hoisted) function never warns', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const hoisted = () => 'hoisted-no-warning';
    cached(hoisted, ['a'], Infinity);
    cached(hoisted, ['a'], Infinity);
    cached(hoisted, ['b'], Infinity);
    expect(warn).not.toHaveBeenCalled();
  });

  test('no warning in production', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const call = () => cached(() => 'inline-production-silent', [], Infinity);
      call();
      call();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
