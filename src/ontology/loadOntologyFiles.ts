/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The `loadData` a package's ontology module passes to `linkedOntology`: reads the package's
 * Turtle data files relative to the module that names them.
 *
 * ```ts
 * // src/ontologies/schema.ts
 * export const loadData = () =>
 *   loadOntologyFiles(import.meta.url, ['../data/schema.ttl', '../data/schema-added.ttl']);
 * ```
 *
 * Every package's ontology module imports this one, and those modules are reachable from a
 * browser bundle, so this module is safe to import anywhere: `node:fs/promises` is imported
 * dynamically through a variable specifier (which keeps it out of bundles, as `loadStores`
 * keeps store modules out), only when the function runs. Calling it in a browser rejects.
 *
 * @module @_linked/core/ontology/loadOntologyFiles
 */

type FsPromises = {readFile(path: URL, encoding: 'utf8'): Promise<string>};

async function loadFs(): Promise<FsPromises> {
  const specifier = 'node:fs/promises';
  return (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as FsPromises;
}

/**
 * Read each of `files` (paths relative to `moduleUrl`, the caller's `import.meta.url`) as UTF-8
 * text, in order. Rejects naming the file when one cannot be read.
 */
export async function loadOntologyFiles(moduleUrl: string, files: string[]): Promise<string[]> {
  const fs = await loadFs();
  const texts: string[] = [];
  for (const file of files) {
    const url = new URL(file, moduleUrl);
    try {
      texts.push(await fs.readFile(url, 'utf8'));
    } catch (error) {
      throw new Error(
        `[linked] Could not read ontology data file ${file} (resolved from ${moduleUrl} to ${url.href}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return texts;
}
