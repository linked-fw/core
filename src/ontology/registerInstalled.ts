/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Registers the ontologies of installed packages, for whoever syncs or checks them.
 *
 * A package registers its ontologies from `ontologies/index.js` (one `registerOntologies` call),
 * which its package entry imports. An app that deep-imports one shape file
 * (`@_linked/schema/shapes/Person`) never evaluates those modules, so the package's data would be
 * missing from the registry the ontology sync and the shape check read. The server's boot and
 * control route, and the cli's build check, therefore import the ontology index of every package
 * directory they know before they sync or check.
 *
 * In `linked start` (dev) the app runs in Vite's SSR module runner, and the cli sets a host loader on
 * `globalThis` (`MODULE_LOADER_KEY`, `Symbol.for('@_linked/core:importModule')`, read through
 * `utils/importPackageModule`, which `loadStores` uses too). An ontology index
 * imported by file path would then be a second copy of its package: Node's next to the
 * runner's, or the built `lib` next to the workspace `src` the app imports. With the host loader
 * set, each index is imported through it by package specifier with `importPackageModule`
 * (`<name>/ontologies/index`), so it is the module the app's own import of it gets.
 *
 * Server only: it reads the file system (imported dynamically, as `loadOntologyFiles` does).
 *
 * @module @_linked/core/ontology/registerInstalled
 */

import {importPackageModule, installedModuleLoader} from '../utils/importPackageModule.js';

type Fs = {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  realpath(path: string): Promise<string>;
};
type Path = {join(...parts: string[]): string; resolve(...parts: string[]): string; basename(p: string): string};
type Url = {pathToFileURL(path: string): URL};

async function nodeModule<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as T;
}

/** Where the cli's build puts a package's ontology modules, relative to the package root. */
const ONTOLOGIES_DIR = ['lib', 'esm', 'ontologies'];
/** The module that registers a package's ontologies, built. */
const INDEX_FILE = 'index.js';
/** Where an unbuilt (source) package keeps them, relative to the package root. */
const SOURCE_ONTOLOGIES_DIR = ['src', 'ontologies'];
const SOURCE_INDEX_FILE = 'index.ts';

export type RegisterInstalledOptions = {
  /**
   * Imports the source ontology index (`src/ontologies/index.ts`) of a package directory that
   * has no built one, e.g. Vite's `ssrLoadModule` in dev. It gets an absolute path with `/`
   * separators (`C:/…` on Windows), a module id rather than a native path. Without it such a
   * directory is skipped.
   */
  importModule?: (file: string) => Promise<unknown>;
};

/**
 * Import `<dir>/lib/esm/ontologies/index.js` of each of `packageDirs` (package roots), in the
 * order given, so each package registers its ontologies (`registerOntologies`). Returns the names
 * (`package.json` `name`, else the directory's name) of the packages whose index was imported. A
 * directory without one is skipped silently; a directory given twice (also through a symlink) is
 * imported once. An index that throws is reported in one warning naming the file, and its package
 * is left out of the result.
 *
 * A directory without a built index but with `src/ontologies/index.ts` (a workspace package in
 * dev, never built) is imported through `options.importModule` when given, and skipped otherwise.
 *
 * When a host loader is set (`linked start`; see the module comment), a package that the app
 * resolves to the given directory (its name, looked up in `node_modules` from the working directory
 * upwards, is that directory) and that exports `./*` or `./ontologies/*` (or has no `exports`) is
 * imported through the host loader by specifier instead, built or not: `<name>/ontologies/index`
 * when `src/ontologies` or `lib/esm/ontologies` has an index. Any other directory (a nested copy,
 * the app itself) is imported as above.
 *
 * Registration is idempotent (keyed by package and ontology name), so a package the app already
 * imported registers again without effect.
 */
export async function registerInstalledOntologies(
  packageDirs: string[],
  options: RegisterInstalledOptions = {},
): Promise<string[]> {
  const fs = await nodeModule<Fs>('node:fs/promises');
  const path = await nodeModule<Path>('node:path');
  const {pathToFileURL} = await nodeModule<Url>('node:url');

  const registered: string[] = [];
  const seen = new Set<string>();
  for (const given of packageDirs) {
    let dir = path.resolve(given);
    try {
      dir = await fs.realpath(dir);
    } catch {
      continue;
    }
    if (seen.has(dir)) continue;
    seen.add(dir);

    const manifest = await readManifest(fs, path, dir);
    const name = manifest.name;
    const viaHost =
      installedModuleLoader() !== undefined &&
      hostCanImport(manifest) &&
      (await resolvesFromCwd(fs, path, name, dir));
    if (viaHost) {
      // The host resolves the specifier as the app's own import of it: to `lib`, or to `src`
      // for a workspace package. Either having an index is enough.
      const hasIndex =
        (await fileExists(fs, path.join(dir, ...SOURCE_ONTOLOGIES_DIR), SOURCE_INDEX_FILE)) ||
        (await fileExists(fs, path.join(dir, ...ONTOLOGIES_DIR), INDEX_FILE));
      if (!hasIndex) continue;
      const specifier = `${name}/ontologies/index`;
      if (await importOne(specifier, importPackageModule, `${specifier} (through the host loader)`)) {
        registered.push(name);
      }
      continue;
    }

    let file: string | undefined;
    let load = (filePath: string): Promise<unknown> =>
      import(/* @vite-ignore */ /* webpackIgnore: true */ pathToFileURL(filePath).href);
    const builtDir = path.join(dir, ...ONTOLOGIES_DIR);
    if (await fileExists(fs, builtDir, INDEX_FILE)) {
      file = path.join(builtDir, INDEX_FILE);
    } else if (options.importModule) {
      const sourceDir = path.join(dir, ...SOURCE_ONTOLOGIES_DIR);
      if (await fileExists(fs, sourceDir, SOURCE_INDEX_FILE)) {
        file = path.join(sourceDir, SOURCE_INDEX_FILE);
        const importModule = options.importModule;
        load = (filePath) => importModule(slashedPath(filePath));
      }
    }
    if (!file) continue;
    if (await importOne(file, load, file)) registered.push(name);
  }
  return registered;
}

/** Imports one module; warns when it throws. Whether it imported. */
async function importOne(
  module: string,
  load: (module: string) => Promise<unknown>,
  description: string,
): Promise<boolean> {
  try {
    await load(module);
    return true;
  } catch (error) {
    console.warn(
      `[linked] Could not import the ontology index ${description}; its package's ` +
        `ontologies are not registered: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * An absolute file path with `/` separators: what module loaders such as Vite's `ssrLoadModule`
 * take as a module id. A POSIX path is returned as is. @internal
 */
export function slashedPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

async function fileExists(fs: Fs, dir: string, file: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).includes(file);
  } catch {
    return false;
  }
}

/**
 * Whether `name`, looked up in `node_modules` from the working directory upwards as Node and Vite
 * resolve a bare specifier, is the package directory `dir` (a real path).
 */
async function resolvesFromCwd(fs: Fs, path: Path, name: string, dir: string): Promise<boolean> {
  let at = path.resolve(process.cwd());
  for (;;) {
    try {
      return (await fs.realpath(path.join(at, 'node_modules', name))) === dir;
    } catch {}
    const parent = path.resolve(at, '..');
    if (parent === at) return false;
    at = parent;
  }
}

type Manifest = {name: string; exports?: unknown};

/** `package.json`'s `name` (else the directory's name) and `exports`. */
async function readManifest(fs: Fs, path: Path, dir: string): Promise<Manifest> {
  try {
    const json = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    const name = json?.name;
    if (typeof name === 'string' && name) return {name, exports: json.exports};
  } catch {}
  return {name: path.basename(dir)};
}

/**
 * Whether `<name>/ontologies/index` can resolve: the package has no `exports`, or
 * exports `./*` or `./ontologies/*` (as every package the cli creates does).
 */
function hostCanImport({exports}: Manifest): boolean {
  if (exports === undefined) return true;
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return false;
  return './*' in exports || './ontologies/*' in exports;
}
