import {afterEach, beforeAll, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `loadStores` and `registerInstalledOntologies` load package modules only through
// `importPackageModule`: with it replaced, every module they load is one it was asked for.
const importPackageModule = jest.fn<(target: string) => Promise<unknown>>();
const installedModuleLoader = jest.fn<() => unknown>();
jest.unstable_mockModule('../utils/importPackageModule', () => ({
  MODULE_LOADER_KEY: Symbol.for('@_linked/core:importModule'),
  importPackageModule,
  installedModuleLoader,
}));

let loadStores: typeof import('../utils/loadStores').loadStores;
let registerInstalledOntologies: typeof import('../ontology/registerInstalled').registerInstalledOntologies;
beforeAll(async () => {
  ({loadStores} = await import('../utils/loadStores'));
  ({registerInstalledOntologies} = await import('../ontology/registerInstalled'));
});

const FIXTURES = path.resolve(process.cwd(), 'src/tests/fixtures/installed');
const SOURCE = path.join(FIXTURES, 'source-only');
const SOURCE_NAME = '@fixture/installed-source-only';

class FixtureStore {
  constructor(public config: unknown) {}
}

beforeEach(() => {
  importPackageModule.mockReset();
  installedModuleLoader.mockReset();
});

describe('callers of importPackageModule', () => {
  test('loadStores imports each store specifier through it, unchanged', async () => {
    importPackageModule.mockImplementation(async () => ({FixtureStore}));
    const stores = await loadStores<FixtureStore>({
      datasets: {
        appData: {store: '@_linked/example/shapes/FixtureStore', config: {url: 'a'}},
      },
    } as unknown as Parameters<typeof loadStores>[0]);
    expect(importPackageModule.mock.calls.map((c) => c[0])).toEqual([
      '@_linked/example/shapes/FixtureStore',
    ]);
    expect(stores.appData).toBeInstanceOf(FixtureStore);
  });

  describe('registerInstalledOntologies with a host loader', () => {
    const originalCwd = process.cwd();
    let app: string;
    beforeEach(() => {
      app = mkdtempSync(path.join(os.tmpdir(), 'import-package-module-callers-'));
    });
    afterEach(() => {
      process.chdir(originalCwd);
      rmSync(app, {recursive: true, force: true});
    });

    test('imports the ontology index by specifier through it', async () => {
      const at = path.join(app, 'node_modules', SOURCE_NAME);
      mkdirSync(path.dirname(at), {recursive: true});
      symlinkSync(SOURCE, at, 'dir');
      process.chdir(app);
      installedModuleLoader.mockReturnValue(async () => ({}));
      importPackageModule.mockImplementation(async () => ({}));

      expect(await registerInstalledOntologies([SOURCE])).toEqual([SOURCE_NAME]);
      expect(importPackageModule.mock.calls.map((c) => c[0])).toEqual([
        `${SOURCE_NAME}/ontologies/index`,
      ]);
    });

    test('without one, it does not go through importPackageModule', async () => {
      process.chdir(app);
      installedModuleLoader.mockReturnValue(undefined);
      await registerInstalledOntologies([SOURCE]);
      expect(importPackageModule).not.toHaveBeenCalled();
    });
  });
});
