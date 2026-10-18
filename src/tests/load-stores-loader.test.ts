import {afterEach, describe, expect, jest, test} from '@jest/globals';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadStores} from '../utils/loadStores';
import type {DatasetsConfig} from '../utils/parseDatasetsConfig';

const IMPORT_MODULE = Symbol.for('@_linked/core:importModule');
const globals = globalThis as Record<symbol, unknown>;

type HostLoader = (specifier: string) => Promise<unknown>;

class NamedStore {
  constructor(public config: unknown) {}
}
class DefaultStore {
  constructor(public config: unknown) {}
}

const config = (
  datasets: Record<string, {store: string; config: Record<string, unknown>}>,
): DatasetsConfig => ({datasets}) as DatasetsConfig;

afterEach(() => {
  delete globals[IMPORT_MODULE];
});

describe('loadStores with a host loader', () => {
  test('calls the loader once per entry with the store specifier unchanged', async () => {
    const loader = jest.fn<HostLoader>(async (specifier) =>
      specifier.endsWith('/NamedStore')
        ? {NamedStore}
        : {default: DefaultStore},
    );
    globals[IMPORT_MODULE] = loader;

    const stores = await loadStores(
      config({
        appData: {
          store: '@_linked/example/shapes/NamedStore',
          config: {url: 'a'},
        },
        other: {store: '@_linked/example/shapes/Other', config: {url: 'b'}},
      }),
    );

    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls.map((c) => c[0])).toEqual([
      '@_linked/example/shapes/NamedStore',
      '@_linked/example/shapes/Other',
    ]);
    expect(stores.appData).toBeInstanceOf(NamedStore);
    expect((stores.appData as NamedStore).config).toEqual({url: 'a'});
    // No export named after the last segment: the default export is constructed.
    expect(stores.other).toBeInstanceOf(DefaultStore);
    expect((stores.other as DefaultStore).config).toEqual({url: 'b'});
  });

  test('prefers the named export over default', async () => {
    globals[IMPORT_MODULE] = async () => ({
      NamedStore,
      default: DefaultStore,
    });
    const stores = await loadStores(
      config({appData: {store: 'x/NamedStore', config: {}}}),
    );
    expect(stores.appData).toBeInstanceOf(NamedStore);
  });

  test('keeps the missing-class error', async () => {
    globals[IMPORT_MODULE] = async () => ({});
    await expect(
      loadStores(config({appData: {store: 'x/Missing', config: {}}})),
    ).rejects.toThrow(
      'loadStores: could not resolve a class export from "x/Missing" for alias "appData"',
    );
  });

  test('a loader that rejects rejects loadStores', async () => {
    globals[IMPORT_MODULE] = async () => {
      throw new Error('loader failed');
    };
    await expect(
      loadStores(config({appData: {store: 'x/NamedStore', config: {}}})),
    ).rejects.toThrow('loader failed');
  });

  test('the loader is read on every call, not at module load', async () => {
    const first = jest.fn<HostLoader>(async () => ({NamedStore}));
    const second = jest.fn<HostLoader>(async () => ({NamedStore}));
    const cfg = config({appData: {store: 'x/NamedStore', config: {}}});

    globals[IMPORT_MODULE] = first;
    await loadStores(cfg);
    globals[IMPORT_MODULE] = second;
    await loadStores(cfg);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('loadStores without a host loader', () => {
  test('loads the store through the native import()', async () => {
    expect(globals[IMPORT_MODULE]).toBeUndefined();
    const specifier = pathToFileURL(
      path.join(
        process.cwd(),
        'src/tests/fixtures/load-stores-fixture-store.mjs',
      ),
    ).href;

    const stores = await loadStores(
      config({appData: {store: specifier, config: {url: 'fixture'}}}),
    );

    const store = stores.appData as {
      constructor: {name: string};
      config: unknown;
    };
    expect(store.constructor.name).toBe('FixtureStore');
    expect(store.config).toEqual({url: 'fixture'});
  });
});
