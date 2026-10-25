/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * What `@_linked/core/ontology/loadOntologyFiles` resolves to in a browser or React Native build
 * (the `browser` and `react-native` export conditions). Ontology data is read from the file
 * system, which a client does not have, so the function rejects. The module holds no `import()`,
 * so nothing server-only reaches a client bundle through the ontology modules that import it.
 *
 * @module @_linked/core/ontology/loadOntologyFiles
 */

/** Rejects: ontology data files are read on a server only. */
export async function loadOntologyFiles(moduleUrl: string, files: string[]): Promise<string[]> {
  throw new Error(
    `[linked] loadOntologyFiles is server only: ontology data files (${files.join(', ')}, from ` +
      `${moduleUrl}) cannot be read in a browser or React Native build.`,
  );
}
