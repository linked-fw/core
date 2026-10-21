import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {
  autoLoadOntologyData,
  getPackageMirrors,
  getRegisteredOntologies,
  linkedPackage,
} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {readPackageOntologies, registrationsByPackage} from '../ontology/registryData';

const PREFIXES = `
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://example.org/reg/> .
`;

const warned: string[] = [];
const originalWarn = console.warn;
beforeEach(() => {
  warned.length = 0;
  console.warn = (message: unknown) => warned.push(String(message));
});
afterEach(() => {
  console.warn = originalWarn;
});

const ns = createNameSpace('http://example.org/reg/');
const terms = {A: ns('A'), B: ns('B')};

describe('the ontology registry', () => {
  test('records each linkedOntology call with its package, prefix, namespace, loader and files', () => {
    const pkg = linkedPackage('ontology-registry-test-a');
    const load = async () => [`${PREFIXES}ex:A rdfs:subClassOf ex:B .`];
    pkg.linkedOntology(terms, ns, 'reg-a', load, ['../data/reg-a.ttl', '../data/reg-a-added.ttl']);
    pkg.linkedOntology(terms, ns, 'reg-b', load, '../data/reg-b.ttl');
    pkg.linkedOntology(terms, ns, 'reg-c');
    const own = getRegisteredOntologies().filter((r) => r.packageName === 'ontology-registry-test-a');
    expect(own.map((r) => r.prefix)).toEqual(['reg-a', 'reg-b', 'reg-c']);
    expect(own[0]).toMatchObject({
      packageName: 'ontology-registry-test-a',
      prefix: 'reg-a',
      files: ['../data/reg-a.ttl', '../data/reg-a-added.ttl'],
      load,
    });
    expect(own[0].ns('X').id).toBe('http://example.org/reg/X');
    expect(own[1].files).toEqual(['../data/reg-b.ttl']);
    expect(own[2].load).toBeUndefined();
    expect(own[2].files).toEqual([]);
    expect(registrationsByPackage(own).get('ontology-registry-test-a')).toHaveLength(3);
  });

  test('re-registering the same package and prefix replaces the entry (idempotent)', () => {
    const pkg = linkedPackage('ontology-registry-test-idem');
    const first = async () => ['first'];
    const second = async () => ['second'];
    pkg.linkedOntology(terms, ns, 'idem', first, '../data/idem.ttl');
    pkg.linkedOntology(terms, ns, 'idem', second, '../data/idem.ttl');
    const own = getRegisteredOntologies().filter((r) => r.packageName === 'ontology-registry-test-idem');
    expect(own).toHaveLength(1);
    expect(own[0].load).toBe(second);
  });

  test('autoLoadOntologyData(true) loads nothing', () => {
    let calls = 0;
    const pkg = linkedPackage('ontology-registry-test-auto');
    pkg.linkedOntology(terms, ns, 'auto', async () => (calls++, ['']), '../data/auto.ttl');
    autoLoadOntologyData(true);
    pkg.linkedOntology(terms, ns, 'auto2', async () => (calls++, ['']), '../data/auto2.ttl');
    autoLoadOntologyData(false);
    expect(calls).toBe(0);
  });

  test('linkedPackage records the namespaces a package mirrors', () => {
    linkedPackage('ontology-registry-test-mirror-one', {mirrors: 'http://example.org/one/'});
    linkedPackage('ontology-registry-test-mirror-two', {
      mirrors: ['http://example.org/two/', 'http://example.org/three/'],
    });
    linkedPackage('ontology-registry-test-mirror-none');
    expect(getPackageMirrors().get('ontology-registry-test-mirror-one')).toEqual(['http://example.org/one/']);
    expect(getPackageMirrors().get('ontology-registry-test-mirror-two')).toEqual([
      'http://example.org/two/',
      'http://example.org/three/',
    ]);
    expect(getPackageMirrors().has('ontology-registry-test-mirror-none')).toBe(false);
  });
});

describe('readPackageOntologies', () => {
  test('groups a package’s ontologies and parses their hierarchy; packages without data are absent', async () => {
    const pkg = linkedPackage('ontology-registry-test-read');
    pkg.linkedOntology(terms, ns, 'read-a', async () => [`${PREFIXES}ex:A rdfs:subClassOf ex:B .`], '../data/read-a.ttl');
    pkg.linkedOntology(terms, ns, 'read-b', async () => [`${PREFIXES}ex:B rdfs:subClassOf ex:C .`, ''], [
      '../data/read-b.ttl',
      '../data/read-b-added.ttl',
    ]);
    pkg.linkedOntology(terms, ns, 'read-c');
    linkedPackage('ontology-registry-test-read-nodata').linkedOntology(terms, ns, 'nodata');
    const {packages, skipped} = await readPackageOntologies({
      packages: ['ontology-registry-test-read', 'ontology-registry-test-read-nodata'],
    });
    expect(skipped).toEqual([]);
    expect([...packages.keys()]).toEqual(['ontology-registry-test-read']);
    const data = packages.get('ontology-registry-test-read')!;
    expect(data.texts).toHaveLength(3);
    expect(data.sources).toEqual([
      'read-a: ../data/read-a.ttl',
      'read-b: ../data/read-b.ttl',
      'read-b: ../data/read-b-added.ttl',
    ]);
    expect(data.triples).toEqual([
      {s: 'http://example.org/reg/A', o: 'http://example.org/reg/B'},
      {s: 'http://example.org/reg/B', o: 'http://example.org/reg/C'},
    ]);
  });

  test('a loadData that is not Turtle text (an unconverted JSON package) is skipped with one warning', async () => {
    const pkg = linkedPackage('ontology-registry-test-json');
    pkg.linkedOntology(terms, ns, 'json-a', async () => ({'@graph': []}), '../data/json-a.json');
    pkg.linkedOntology(terms, ns, 'json-b', async () => ({'@graph': []}), '../data/json-b.json');
    const {packages, skipped} = await readPackageOntologies({packages: ['ontology-registry-test-json']});
    expect(packages.size).toBe(0);
    expect(skipped).toEqual(['ontology-registry-test-json']);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toBe(
      '[linked] ontology data of ontology-registry-test-json (json-a) is not Turtle text; skipped — convert src/data to .ttl',
    );
  });

  test('a rejected load and a parse error each skip the package, naming package and file', async () => {
    const rejects = linkedPackage('ontology-registry-test-rejects');
    rejects.linkedOntology(terms, ns, 'rej', async () => {
      throw new Error('ENOENT no such file');
    }, '../data/rej.ttl');
    const bad = linkedPackage('ontology-registry-test-bad');
    bad.linkedOntology(terms, ns, 'bad', async () => [`${PREFIXES}ex:A rdfs:subClassOf .`], '../data/bad.ttl');
    const {packages, skipped} = await readPackageOntologies({
      packages: ['ontology-registry-test-rejects', 'ontology-registry-test-bad'],
    });
    expect(packages.size).toBe(0);
    expect(skipped).toEqual(['ontology-registry-test-rejects', 'ontology-registry-test-bad']);
    expect(warned).toHaveLength(2);
    expect(warned[0]).toMatch(/ontology-registry-test-rejects \(rej, \.\.\/data\/rej\.ttl\)/);
    expect(warned[0]).toMatch(/ENOENT/);
    expect(warned[1]).toMatch(/ontology-registry-test-bad does not parse/);
    expect(warned[1]).toMatch(/bad: \.\.\/data\/bad\.ttl/);
  });
});
