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

async function nodeModule<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as T;
}

/** Where the cli's build puts a package's ontology modules, relative to the package root. */
const ONTOLOGIES_DIR = ['lib', 'esm', 'ontologies'];
const REGISTER_SUFFIX = '.register.js';

/**
 * Import `<dir>/lib/esm/ontologies/*.register.js` of each of `packageDirs` (package roots), in
 * the order given and, within a package, by file name, so each package registers its ontologies
 * (`linkedOntology`). Returns the names (`package.json` `name`, else the directory's name) of the
 * packages whose register modules were imported. A directory without them is skipped silently;
 * a directory given twice (also through a symlink) is imported once. A register module that
 * throws is reported in one warning naming the file, and its package is left out of the result.
 *
 * Registration is idempotent (keyed by package and prefix), so a package the app already
 * imported registers again without effect.
 */
export async function registerInstalledOntologies(packageDirs: string[]): Promise<string[]> {
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

    const ontologiesDir = path.join(dir, ...ONTOLOGIES_DIR);
    let files: string[];
    try {
      files = (await fs.readdir(ontologiesDir)).filter((f) => f.endsWith(REGISTER_SUFFIX)).sort();
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    let ok = true;
    for (const file of files) {
      const filePath = path.join(ontologiesDir, file);
      try {
        await import(/* @vite-ignore */ /* webpackIgnore: true */ pathToFileURL(filePath).href);
      } catch (error) {
        console.warn(
          `[linked] Could not import the ontology register module ${filePath}; its package's ` +
            `ontology is not registered: ${error instanceof Error ? error.message : String(error)}`,
        );
        ok = false;
      }
    }
    if (ok) registered.push(await packageName(fs, path, dir));
  }
  return registered;
}

async function packageName(fs: Fs, path: Path, dir: string): Promise<string> {
  try {
    const name = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))?.name;
    if (typeof name === 'string' && name) return name;
  } catch {}
  return path.basename(dir);
}
