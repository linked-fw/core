/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reads a package's ontology data: the Turtle files `registerOntologies` names in an ontology's
 * `data`, relative to the module that registers them.
 *
 * ```ts
 * // src/ontologies/index.ts
 * registerOntologies(
 *   [{name: 'schema', namespace: 'https://schema.org/', terms: schema, data: ['../data/schema.ttl']}],
 *   import.meta.url,
 * );
 * // core then loads them with loadOntologyFiles(import.meta.url, ['../data/schema.ttl'])
 * ```
 *
 * Every package's ontology index reaches this module through core, and that index is reachable
 * from a client bundle. A client build never gets this module: the `browser` and `react-native` export
 * conditions of `@_linked/core/ontology/loadOntologyFiles` resolve to `loadOntologyFiles.browser`,
 * a stub that rejects and holds no `import()`. Import it by that package specifier, never by a
 * relative path (which ignores the conditions). On a server, `node:fs/promises` is imported
 * dynamically through a variable specifier, only when the function runs.
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
