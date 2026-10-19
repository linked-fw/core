import {describe, expect, it, jest} from '@jest/globals';
import {sharedState, sharedStateKey} from '../utils/sharedState.js';
import {brandLinkedError, isLinkedError, linkedErrorBrand} from '../utils/linkedError.js';

type SharedStateModule = typeof import('../utils/sharedState.js');
type LinkedErrorModule = typeof import('../utils/linkedError.js');

/** A second, independently evaluated copy of a module, as a second loader would produce. */
async function secondCopy<T>(load: () => Promise<T>): Promise<T> {
  let copy: T | undefined;
  await jest.isolateModulesAsync(async () => {
    copy = await load();
  });
  if (!copy) throw new Error('second copy did not load');
  return copy;
}

/** Defines the same error classes a package module would, through the given copy of core. */
function defineErrors(core: Pick<LinkedErrorModule, 'brandLinkedError'>) {
  class DatasetError extends Error {}
  core.brandLinkedError(DatasetError, '@_linked/test', 'DatasetError');
  class UnreachableError extends DatasetError {}
  core.brandLinkedError(UnreachableError, '@_linked/test', 'UnreachableError');
  class UnbrandedError extends DatasetError {}
  return {DatasetError, UnreachableError, UnbrandedError};
}

describe('sharedState', () => {
  it('returns one value to two copies of the module', async () => {
    const other = await secondCopy<SharedStateModule>(() => import('../utils/sharedState.js'));
    expect(other.sharedState).not.toBe(sharedState);

    const a = sharedState('@_linked/test', 'two-copies', () => ({hits: 0}));
    const b = other.sharedState('@_linked/test', 'two-copies', () => ({hits: 100}));
    expect(b).toBe(a);
    a.hits++;
    expect(b.hits).toBe(1);
  });

  it('calls init once, and stores the value under Symbol.for(<pkg>:<name>)', () => {
    const init = jest.fn(() => ({value: 'first'}));
    const first = sharedState('@_linked/test', 'init-once', init);
    const again = sharedState('@_linked/test', 'init-once', init);
    expect(again).toBe(first);
    expect(init).toHaveBeenCalledTimes(1);
    expect(sharedStateKey('@_linked/test', 'init-once')).toBe(Symbol.for('@_linked/test:init-once'));
    expect((globalThis as unknown as Record<symbol, unknown>)[Symbol.for('@_linked/test:init-once')]).toBe(first);
  });

  it('keeps different names apart', () => {
    const a = sharedState('@_linked/test', 'name-a', () => ({}));
    const b = sharedState('@_linked/test', 'name-b', () => ({}));
    expect(a).not.toBe(b);
  });
});

describe('isLinkedError', () => {
  it('matches an error thrown by another copy of the defining module', async () => {
    const otherCore = await secondCopy<LinkedErrorModule>(() => import('../utils/linkedError.js'));
    const mine = defineErrors({brandLinkedError});
    const theirs = defineErrors(otherCore);
    const thrown = new theirs.UnreachableError('unreachable');

    expect(thrown instanceof mine.UnreachableError).toBe(false);
    expect(isLinkedError(thrown, mine.UnreachableError)).toBe(true);
    expect(otherCore.isLinkedError(thrown, mine.UnreachableError)).toBe(true);
  });

  it('matches a subclass instance against its base, as instanceof does', async () => {
    const mine = defineErrors({brandLinkedError});
    const theirs = defineErrors(
      await secondCopy<LinkedErrorModule>(() => import('../utils/linkedError.js')),
    );
    expect(isLinkedError(new theirs.UnreachableError(), mine.DatasetError)).toBe(true);
    expect(isLinkedError(new theirs.DatasetError(), mine.UnreachableError)).toBe(false);
  });

  it('falls back to instanceof for an unbranded class, and does not lend it the base brand', () => {
    const mine = defineErrors({brandLinkedError});
    const theirs = defineErrors({brandLinkedError});
    expect(isLinkedError(new mine.UnbrandedError(), mine.UnbrandedError)).toBe(true);
    expect(isLinkedError(new theirs.UnbrandedError(), mine.UnbrandedError)).toBe(false);
    expect(isLinkedError(new theirs.DatasetError(), mine.UnbrandedError)).toBe(false);
  });

  it('rejects non-errors and unrelated errors', () => {
    const {DatasetError} = defineErrors({brandLinkedError});
    for (const value of [undefined, null, 0, 'DatasetError', {}, new Error('x'), new TypeError('x')]) {
      expect(isLinkedError(value, DatasetError)).toBe(false);
    }
  });

  it('recognises a brand set by hand, without the helper', () => {
    const {DatasetError} = defineErrors({brandLinkedError});
    class HandBranded extends Error {}
    Object.defineProperty(HandBranded.prototype, linkedErrorBrand('@_linked/test', 'DatasetError'), {
      value: true,
    });
    expect(isLinkedError(new HandBranded(), DatasetError)).toBe(true);
    expect(linkedErrorBrand('@_linked/test', 'DatasetError')).toBe(Symbol.for('@_linked/test:DatasetError'));
  });
});
