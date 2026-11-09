import {afterEach, describe, expect, jest, test} from '@jest/globals';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  importPackageModule,
  installedModuleLoader,
  MODULE_LOADER_KEY,
  type ModuleLoader,
} from '../utils/importPackageModule';

const globals = globalThis as Record<symbol, unknown>;
const FIXTURE = path.join(process.cwd(), 'src/tests/fixtures/load-stores-fixture-store.mjs');

afterEach(() => {
  delete globals[MODULE_LOADER_KEY];
});

describe('importPackageModule', () => {
  test('the key is the one linked start installs its loader at', () => {
    expect(MODULE_LOADER_KEY).toBe(Symbol.for('@_linked/core:importModule'));
  });

  describe('installedModuleLoader', () => {
    test('is undefined without a loader, or when the key holds no function', () => {
      expect(installedModuleLoader()).toBeUndefined();
      globals[MODULE_LOADER_KEY] = 'not a loader';
      expect(installedModuleLoader()).toBeUndefined();
    });

    test('returns the installed loader, read on every call', () => {
      const first: ModuleLoader = async () => ({});
      const second: ModuleLoader = async () => ({});
      globals[MODULE_LOADER_KEY] = first;
      expect(installedModuleLoader()).toBe(first);
      globals[MODULE_LOADER_KEY] = second;
      expect(installedModuleLoader()).toBe(second);
    });
  });

  describe('without a loader installed', () => {
    test('imports an absolute file path natively', async () => {
      expect(globals[MODULE_LOADER_KEY]).toBeUndefined();
      const mod = (await importPackageModule(FIXTURE)) as {default: {name: string}};
      expect(mod.default.name).toBe('FixtureStore');
    });

    test('imports a file URL or specifier as given', async () => {
      const mod = (await importPackageModule(pathToFileURL(FIXTURE).href)) as {
        default: {name: string};
      };
      expect(mod.default.name).toBe('FixtureStore');
      const nodePath = (await importPackageModule('node:path')) as {sep: string};
      expect(typeof nodePath.sep).toBe('string');
    });
  });

  describe('with a loader installed', () => {
    test('calls the loader with a specifier unchanged and returns its module', async () => {
      const module = {marker: true};
      const loader = jest.fn<ModuleLoader>(async () => module);
      globals[MODULE_LOADER_KEY] = loader;

      expect(await importPackageModule('@_linked/example/shapes/Thing')).toBe(module);
      expect(loader.mock.calls.map((c) => c[0])).toEqual(['@_linked/example/shapes/Thing']);
    });

    test('imports an absolute path or file URL natively, never through the loader', async () => {
      const loader = jest.fn<ModuleLoader>(async () => ({marker: true}));
      globals[MODULE_LOADER_KEY] = loader;

      const byPath = (await importPackageModule(FIXTURE)) as {default: {name: string}};
      expect(byPath.default.name).toBe('FixtureStore');
      const byUrl = (await importPackageModule(pathToFileURL(FIXTURE).href)) as {
        default: {name: string};
      };
      expect(byUrl.default.name).toBe('FixtureStore');
      expect(loader).not.toHaveBeenCalled();
    });

    test('reads the loader on every call', async () => {
      const first = jest.fn<ModuleLoader>(async () => ({}));
      const second = jest.fn<ModuleLoader>(async () => ({}));
      globals[MODULE_LOADER_KEY] = first;
      await importPackageModule('@_linked/example/shapes/Thing');
      globals[MODULE_LOADER_KEY] = second;
      await importPackageModule('@_linked/example/shapes/Thing');
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    test('a loader that rejects rejects the import', async () => {
      globals[MODULE_LOADER_KEY] = async () => {
        throw new Error('loader failed');
      };
      await expect(importPackageModule('@_linked/example/shapes/Thing')).rejects.toThrow(
        'loader failed',
      );
    });
  });
});
