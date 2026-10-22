import {describe, expect, test} from '@jest/globals';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadOntologyFiles} from '../ontology/loadOntologyFiles';

// The module URL a package's ontology module would pass: a file next to the fixtures' parent,
// so the relative paths look like a real package's `../data/<file>.ttl`.
const MODULE_URL = pathToFileURL(
  path.resolve(process.cwd(), 'src/tests/fixtures/ontologies/animals.ts'),
).href;

describe('loadOntologyFiles', () => {
  test('reads files relative to the module URL, in order', async () => {
    const texts = await loadOntologyFiles(MODULE_URL, [
      '../ontology-data/animals.ttl',
      '../ontology-data/pets.ttl',
    ]);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('ex:Dog a owl:Class');
    expect(texts[1]).toContain('ex:Pet rdfs:subClassOf ex:Animal');
  });

  test('a missing file rejects, naming the file', async () => {
    await expect(
      loadOntologyFiles(MODULE_URL, ['../ontology-data/animals.ttl', '../ontology-data/missing.ttl']),
    ).rejects.toThrow(/ontology data file \.\.\/ontology-data\/missing\.ttl/);
  });

  test('no files → no texts', async () => {
    expect(await loadOntologyFiles(MODULE_URL, [])).toEqual([]);
  });

  test('the emitted module has no static node: import (it is imported by browser-reachable modules)', () => {
    const built = path.resolve(process.cwd(), 'lib/esm/ontology/loadOntologyFiles.js');
    if (!existsSync(built)) {
      throw new Error(`${built} is missing: run \`linked build\` before the tests`);
    }
    const source = readFileSync(built, 'utf8');
    expect(source).not.toMatch(/^import .*['"]node:/m);
    expect(source).not.toMatch(/^import .*['"]fs['"]/m);
    expect(source).toMatch(/import\(\s*\/\* @vite-ignore \*\/ \/\* webpackIgnore: true \*\/ specifier\)/);
  });
});
