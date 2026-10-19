import {describe, expect, it, jest} from '@jest/globals';
import {sharedState, sharedStateKey} from '../utils/sharedState.js';
import {
  brandLinkedClass,
  brandLinkedError,
  isLinkedError,
  isLinkedInstance,
  linkedErrorBrand,
} from '../utils/linkedError.js';

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

/** Defines the same (non-error) classes a package module would, through the given copy of core. */
function defineClasses(core: Pick<LinkedErrorModule, 'brandLinkedClass'>) {
  class Collection {
    private constructor() {}
    static make() {
      return new Collection();
    }
  }
  core.brandLinkedClass(Collection, '@_linked/test', 'Collection');
  class Base {}
  core.brandLinkedClass(Base, '@_linked/test', 'Base');
  class Sub extends Base {}
  core.brandLinkedClass(Sub, '@_linked/test', 'Sub');
  class Unbranded extends Base {}
  return {Collection, Base, Sub, Unbranded};
}

describe('isLinkedInstance', () => {
  it('matches an instance made by another copy, including a class with a private constructor', async () => {
    const otherCore = await secondCopy<LinkedErrorModule>(() => import('../utils/linkedError.js'));
    const mine = defineClasses({brandLinkedClass});
    const theirs = defineClasses(otherCore);
    const made = theirs.Collection.make();
    expect(made instanceof mine.Collection).toBe(false);
    expect(isLinkedInstance(made, mine.Collection)).toBe(true);
    expect(otherCore.isLinkedInstance(mine.Collection.make(), theirs.Collection)).toBe(true);
  });

  it('matches a subclass instance and a subclass prototype against the base', () => {
    const mine = defineClasses({brandLinkedClass});
    const theirs = defineClasses({brandLinkedClass});
    expect(isLinkedInstance(new theirs.Sub(), mine.Base)).toBe(true);
    expect(isLinkedInstance(theirs.Sub.prototype, mine.Base)).toBe(true);
    expect(isLinkedInstance(new theirs.Base(), mine.Sub)).toBe(false);
    // `X.prototype instanceof X` is false; so is this.
    expect(isLinkedInstance(theirs.Base.prototype, mine.Base)).toBe(false);
  });

  it('falls back to instanceof for an unbranded class', () => {
    const mine = defineClasses({brandLinkedClass});
    const theirs = defineClasses({brandLinkedClass});
    expect(isLinkedInstance(new mine.Unbranded(), mine.Unbranded)).toBe(true);
    expect(isLinkedInstance(new theirs.Unbranded(), mine.Unbranded)).toBe(false);
  });

  it('never reads the brand off the value, so a guarded proxy is not tripped', () => {
    const mine = defineClasses({brandLinkedClass});
    const theirs = defineClasses({brandLinkedClass});
    const guarded = new Proxy(new theirs.Sub(), {
      get(target, key) {
        if (typeof key === 'symbol') throw new Error(`undecorated property ${String(key)}`);
        return Reflect.get(target, key);
      },
    });
    expect(isLinkedInstance(guarded, mine.Base)).toBe(true);
  });

  it('answers repeat checks from its memo, and a brand added later is still seen', () => {
    class Brand {}
    brandLinkedClass(Brand, '@_linked/test', 'LateBrand');
    class Later {}
    const value = Object.create(Later.prototype);
    expect(isLinkedInstance(value, Brand)).toBe(false);
    expect(isLinkedInstance(value, Brand)).toBe(false);
    brandLinkedClass(Later, '@_linked/test', 'LateBrand');
    expect(isLinkedInstance(value, Brand)).toBe(true);
  });

  it('rejects primitives, null and plain objects', () => {
    const {Base} = defineClasses({brandLinkedClass});
    for (const value of [undefined, null, 0, 'Base', {}, Object.create(null), () => {}]) {
      expect(isLinkedInstance(value, Base)).toBe(false);
    }
  });

  it('shares its brand with brandLinkedError, so a branded error is a linked instance too', () => {
    const {DatasetError} = defineErrors({brandLinkedError});
    const theirs = defineErrors({brandLinkedError});
    expect(isLinkedInstance(new theirs.UnreachableError(), DatasetError)).toBe(true);
  });
});
