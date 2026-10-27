/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Registers the ontologies of installed packages, for whoever syncs or checks them.
 *
 * A package registers its ontology data from `ontologies/<prefix>.register.js`, which its package
 * index and `shapes/index` import. An app that deep-imports one shape file
 * (`@_linked/schema/shapes/Person`) never evaluates those modules, so the package's data would be
 * missing from the registry the ontology sync and the shape check read. The server's boot and
 * control route, and the cli's build check, therefore import every register module of every
 * package directory they know before they sync or check.
 *
 * In `linked start` (dev) the app runs in Vite's SSR module runner, and the cli sets a host loader on
 * `globalThis` (`Symbol.for('@_linked/core:importModule')`, which `loadStores` reads too). A register
 * module imported by file path would then be a second copy of its package: Node's next to the
 * runner's, or the built `lib` next to the workspace `src` the app imports. With the host loader
 * set, each register module is imported through it by package specifier
 * (`<name>/ontologies/<prefix>.register`), so it is the module the app's own import of it gets.
 *
 * Server only: it reads the file system (imported dynamically, as `loadOntologyFiles` does).
 *
 * @module @_linked/core/ontology/registerInstalled
 */

type Fs = {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  realpath(path: string): Promise<string>;
};
type Path = {join(...parts: string[]): string; resolve(...parts: string[]): string; basename(p: string): string};
type Url = {pathToFileURL(path: string): URL};

/** The host loader `linked start` sets; see the module comment and `loadStores`. */
const IMPORT_MODULE = Symbol.for('@_linked/core:importModule');

function hostLoader(): ((specifier: string) => Promise<unknown>) | undefined {
  const hook = (globalThis as Record<symbol, unknown>)[IMPORT_MODULE];
  return typeof hook === 'function' ? (hook as (specifier: string) => Promise<unknown>) : undefined;
}

async function nodeModule<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as T;
}

/** Where the cli's build puts a package's ontology modules, relative to the package root. */
const ONTOLOGIES_DIR = ['lib', 'esm', 'ontologies'];
const REGISTER_SUFFIX = '.register.js';
/** Where an unbuilt (source) package keeps them, relative to the package root. */
const SOURCE_ONTOLOGIES_DIR = ['src', 'ontologies'];
const SOURCE_REGISTER_SUFFIX = '.register.ts';

export type RegisterInstalledOptions = {
  /**
   * Imports a source register module (`src/ontologies/*.register.ts`) of a package directory that
   * has no built ones, e.g. Vite's `ssrLoadModule` in dev. It gets an absolute path with `/`
   * separators (`C:/…` on Windows), a module id rather than a native path. Without it such a
   * directory is skipped.
   */
  importModule?: (file: string) => Promise<unknown>;
};

/**
 * Import `<dir>/lib/esm/ontologies/*.register.js` of each of `packageDirs` (package roots), in
 * the order given and, within a package, by file name, so each package registers its ontologies
 * (`linkedOntology`). Returns the names (`package.json` `name`, else the directory's name) of the
 * packages whose register modules were imported. A directory without them is skipped silently;
 * a directory given twice (also through a symlink) is imported once. A register module that
 * throws is reported in one warning naming the file, and its package is left out of the result.
 *
 * A directory without built register modules but with `src/ontologies/*.register.ts` (a
 * workspace package in dev, never built) is imported through `options.importModule` when given,
 * and skipped otherwise.
 *
 * When a host loader is set (`linked start`; see the module comment), a package that the app
 * resolves to the given directory (its name, looked up in `node_modules` from the working directory
 * upwards, is that directory) and that exports `./*` or `./ontologies/*` (or has no `exports`) is
 * imported through the host loader by specifier instead, built or not:
 * `<name>/ontologies/<prefix>.register` for each register module in `src/ontologies`, else in
 * `lib/esm/ontologies`. Any other directory (a nested copy, the app itself) is imported as above.
 *
 * Registration is idempotent (keyed by package and prefix), so a package the app already
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
    const host = hostLoader();
    if (host && hostCanImport(manifest) && (await resolvesFromCwd(fs, path, name, dir))) {
      // The host resolves each specifier as the app's own import of it: to `lib`, or to `src`
      // for a workspace package. List the register modules from `src` when it has them, so a
      // stale `lib` does not decide which ones exist.
      let ontologiesDir = path.join(dir, ...SOURCE_ONTOLOGIES_DIR);
      let suffix = SOURCE_REGISTER_SUFFIX;
      let files = await registerFiles(fs, ontologiesDir, suffix);
      if (files.length === 0) {
        ontologiesDir = path.join(dir, ...ONTOLOGIES_DIR);
        suffix = REGISTER_SUFFIX;
        files = await registerFiles(fs, ontologiesDir, suffix);
      }
      if (files.length === 0) continue;
      const specifiers = files.map((file) => `${name}/ontologies/${file.slice(0, -suffix.length)}.register`);
      if (await importAll(specifiers, host, (specifier) => `${specifier} (through the host loader)`)) {
        registered.push(name);
      }
      continue;
    }

    let ontologiesDir = path.join(dir, ...ONTOLOGIES_DIR);
    let files = await registerFiles(fs, ontologiesDir, REGISTER_SUFFIX);
    let load = (filePath: string): Promise<unknown> =>
      import(/* @vite-ignore */ /* webpackIgnore: true */ pathToFileURL(filePath).href);
    const importModule = options.importModule;
    if (files.length === 0 && importModule) {
      ontologiesDir = path.join(dir, ...SOURCE_ONTOLOGIES_DIR);
      files = await registerFiles(fs, ontologiesDir, SOURCE_REGISTER_SUFFIX);
      load = (filePath) => importModule(slashedPath(filePath));
    }
    if (files.length === 0) continue;
    const ok = await importAll(
      files.map((file) => path.join(ontologiesDir, file)),
      load,
      (filePath) => filePath,
    );
    if (ok) registered.push(name);
  }
  return registered;
}

/** Imports each module in order; warns once per module that throws. Whether all imported. */
async function importAll(
  modules: string[],
  load: (module: string) => Promise<unknown>,
  describe: (module: string) => string,
): Promise<boolean> {
  let ok = true;
  for (const module of modules) {
    try {
      await load(module);
    } catch (error) {
      console.warn(
        `[linked] Could not import the ontology register module ${describe(module)}; its package's ` +
          `ontology is not registered: ${error instanceof Error ? error.message : String(error)}`,
      );
      ok = false;
    }
  }
  return ok;
}

/**
 * An absolute file path with `/` separators: what module loaders such as Vite's `ssrLoadModule`
 * take as a module id. A POSIX path is returned as is. @internal
 */
export function slashedPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

async function registerFiles(fs: Fs, dir: string, suffix: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(suffix)).sort();
  } catch {
    return [];
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
 * Whether `<name>/ontologies/<prefix>.register` can resolve: the package has no `exports`, or
 * exports `./*` or `./ontologies/*` (as every package the cli creates does).
 */
function hostCanImport({exports}: Manifest): boolean {
  if (exports === undefined) return true;
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return false;
  return './*' in exports || './ontologies/*' in exports;
}
