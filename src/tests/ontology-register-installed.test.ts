import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {mkdirSync, symlinkSync, mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {getRegisteredOntologies} from '../utils/Package';
import {readPackageOntologies} from '../ontology/registryData';
import {registerInstalledOntologies} from '../ontology/registerInstalled';

const FIXTURES = path.resolve(process.cwd(), 'src/tests/fixtures/installed');
const WITH = path.join(FIXTURES, 'with-ontology');
const WITHOUT = path.join(FIXTURES, 'without-ontology');
const BROKEN = path.join(FIXTURES, 'broken');
const SOURCE = path.join(FIXTURES, 'source-only');
const WITH_NAME = '@fixture/installed-with-ontology';
const SOURCE_NAME = '@fixture/installed-source-only';
const BROKEN_NAME = '@fixture/installed-broken';
const IMPORT_MODULE = Symbol.for('@_linked/core:importModule');
const globals = globalThis as Record<symbol, unknown>;

const warned: string[] = [];
const originalWarn = console.warn;
beforeEach(() => {
  warned.length = 0;
  console.warn = (message: unknown) => warned.push(String(message));
});
afterEach(() => {
  console.warn = originalWarn;
});

const registeredPrefixes = (packageName: string) =>
  getRegisteredOntologies()
    .filter((r) => r.packageName === packageName)
    .map((r) => r.prefix);

describe('registerInstalledOntologies', () => {
  // Runs first: the deep import must happen before anything evaluated the register module.
  test('a deep-imported shape registers nothing; registering the installed package then reads its data', async () => {
    const shape = (await import(
      pathToFileURL(path.join(WITH, 'lib/esm/shapes/Cat.js')).href
    )) as {CatShape: {packageName: string; targetClass: {id: string}}};
    expect(shape.CatShape.packageName).toBe(WITH_NAME);
    expect(registeredPrefixes(WITH_NAME)).toEqual([]);

    expect(await registerInstalledOntologies([WITH])).toEqual([WITH_NAME]);
    expect(registeredPrefixes(WITH_NAME)).toEqual(['installed-pets']);

    const {packages, skipped} = await readPackageOntologies({packages: [WITH_NAME]});
    expect(skipped).toEqual([]);
    expect(packages.get(WITH_NAME)?.triples).toEqual([
      {s: 'http://example.org/installed-pets/Cat', o: 'http://example.org/installed-pets/Pet'},
    ]);
  });

  test('a directory without register modules is skipped silently', async () => {
    expect(await registerInstalledOntologies([WITHOUT])).toEqual([]);
    expect(await registerInstalledOntologies([path.join(FIXTURES, 'does-not-exist')])).toEqual([]);
    expect(warned).toEqual([]);
  });

  test('registering again is idempotent, and a directory given twice (also through a symlink) counts once', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'register-installed-'));
    try {
      const link = path.join(tmp, 'linked-with');
      symlinkSync(WITH, link, 'dir');
      expect(await registerInstalledOntologies([WITHOUT, WITH, link, WITH])).toEqual([WITH_NAME]);
      expect(registeredPrefixes(WITH_NAME)).toEqual(['installed-pets']);
    } finally {
      rmSync(tmp, {recursive: true, force: true});
    }
  });

  test('a register module that throws is warned about, naming the file, and the rest still register', async () => {
    expect(await registerInstalledOntologies([BROKEN, WITH])).toEqual([WITH_NAME]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/broken\.register\.js/);
    expect(warned[0]).toMatch(/broken register module/);
  });

  describe('a source package (no built register modules)', () => {
    test('is skipped without importModule', async () => {
      expect(await registerInstalledOntologies([SOURCE])).toEqual([]);
      expect(registeredPrefixes(SOURCE_NAME)).toEqual([]);
      expect(warned).toEqual([]);
    });

    test('registers its src/ontologies/*.register.ts through importModule, which built packages do not use', async () => {
      const imported: string[] = [];
      const importModule = async (file: string) => {
        imported.push(file);
        return import(pathToFileURL(file).href);
      };
      expect(await registerInstalledOntologies([WITH, SOURCE, WITHOUT], {importModule})).toEqual([
        WITH_NAME,
        SOURCE_NAME,
      ]);
      expect(imported).toEqual([path.join(SOURCE, 'src/ontologies/birds.register.ts')]);
      expect(registeredPrefixes(SOURCE_NAME)).toEqual(['source-birds']);

      const {packages, skipped} = await readPackageOntologies({packages: [SOURCE_NAME]});
      expect(skipped).toEqual([]);
      expect(packages.get(SOURCE_NAME)?.triples).toEqual([
        {s: 'http://example.org/source-birds/Owl', o: 'http://example.org/source-birds/Bird'},
      ]);
    });

    test('an importModule that throws is warned about, naming the file', async () => {
      const importModule = async () => {
        throw new Error('loader failed');
      };
      expect(await registerInstalledOntologies([SOURCE, WITH], {importModule})).toEqual([WITH_NAME]);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/birds\.register\.ts/);
      expect(warned[0]).toMatch(/loader failed/);
    });
  });

  describe('with a host loader (linked start)', () => {
    const originalCwd = process.cwd();
    let app: string;
    beforeEach(() => {
      app = mkdtempSync(path.join(os.tmpdir(), 'register-installed-app-'));
    });
    afterEach(() => {
      delete globals[IMPORT_MODULE];
      process.chdir(originalCwd);
      rmSync(app, {recursive: true, force: true});
    });
    const install = (name: string, dir: string) => {
      const at = path.join(app, 'node_modules', name);
      mkdirSync(path.dirname(at), {recursive: true});
      symlinkSync(dir, at, 'dir');
    };

    test('a package the app resolves to the directory is imported through it by specifier, never by file', async () => {
      install(BROKEN_NAME, BROKEN);
      install(SOURCE_NAME, SOURCE);
      const nested = path.join(app, 'packages/app');
      mkdirSync(nested, {recursive: true});
      process.chdir(nested); // node_modules is looked up from the working directory upwards
      const specifiers: string[] = [];
      globals[IMPORT_MODULE] = async (specifier: string) => {
        specifiers.push(specifier);
        return {};
      };
      const imported: string[] = [];
      const importModule = async (file: string) => {
        imported.push(file);
        return {};
      };
      // BROKEN's register module throws when it is evaluated: imported by file, it would warn.
      expect(await registerInstalledOntologies([BROKEN, SOURCE], {importModule})).toEqual([
        BROKEN_NAME,
        SOURCE_NAME,
      ]);
      expect(specifiers).toEqual([
        `${BROKEN_NAME}/ontologies/broken.register`,
        `${SOURCE_NAME}/ontologies/birds.register`,
      ]);
      expect(imported).toEqual([]);
      expect(warned).toEqual([]);
    });

    test('a source package the app does not resolve to is skipped without importModule', async () => {
      process.chdir(app);
      const specifiers: string[] = [];
      globals[IMPORT_MODULE] = async (specifier: string) => {
        specifiers.push(specifier);
        return {};
      };
      expect(await registerInstalledOntologies([SOURCE])).toEqual([]);
      expect(specifiers).toEqual([]);
      expect(warned).toEqual([]);
    });

    test('a module the host loader cannot import is warned about, naming the specifier', async () => {
      install(BROKEN_NAME, BROKEN);
      process.chdir(app);
      globals[IMPORT_MODULE] = async () => {
        throw new Error('host failed');
      };
      expect(await registerInstalledOntologies([BROKEN])).toEqual([]);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/@fixture\/installed-broken\/ontologies\/broken\.register \(through the host loader\)/);
      expect(warned[0]).toMatch(/host failed/);
    });

    test('a directory the app does not resolve to is imported by file as without it', async () => {
      install(BROKEN_NAME, WITHOUT); // the app's copy of that name is another directory
      process.chdir(app);
      const specifiers: string[] = [];
      globals[IMPORT_MODULE] = async (specifier: string) => {
        specifiers.push(specifier);
        return {};
      };
      expect(await registerInstalledOntologies([WITH, BROKEN])).toEqual([WITH_NAME]);
      expect(specifiers).toEqual([]);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/broken\.register\.js/);
    });
  });
});
