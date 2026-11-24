import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {registerTestOntology} from '../test-helpers/register-test-ontology';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  getPackageMirrors,
  getRegisteredOntologies,
  linkedPackage,
  suggestedPrefixes,
  type OntologyRegistration,
} from '../utils/Package';
import {Prefix} from '../utils/Prefix';
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
  test('registerOntologies records each ontology with its package, name, namespace, prefix and data', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'register-ontologies-'));
    try {
      mkdirSync(path.join(dir, 'data'));
      writeFileSync(path.join(dir, 'data', 'reg-a.ttl'), `${PREFIXES}ex:A rdfs:subClassOf ex:B .`);
      writeFileSync(path.join(dir, 'data', 'reg-a-added.ttl'), '');
      const moduleUrl = pathToFileURL(path.join(dir, 'ontologies', 'index.js')).href;
      const pkg = linkedPackage('ontology-registry-test-a');
      const before = Prefix.toMap();
      pkg.registerOntologies(
        [
          {
            name: 'reg-a',
            namespace: 'http://example.org/reg/',
            terms,
            data: ['../data/reg-a.ttl', '../data/reg-a-added.ttl'],
            suggestedPrefix: 'rega',
          },
          {name: 'reg-c', namespace: 'http://example.org/reg-c/', terms: {}},
        ],
        moduleUrl,
      );
      const own = getRegisteredOntologies().filter((r) => r.packageName === 'ontology-registry-test-a');
      expect(own.map((r) => r.name)).toEqual(['reg-a', 'reg-c']);
      expect(own[0]).toMatchObject({
        packageName: 'ontology-registry-test-a',
        name: 'reg-a',
        namespace: 'http://example.org/reg/',
        suggestedPrefix: 'rega',
        files: ['../data/reg-a.ttl', '../data/reg-a-added.ttl'],
        terms: {A: {id: 'http://example.org/reg/A'}},
      });
      expect(await own[0].load!()).toEqual([`${PREFIXES}ex:A rdfs:subClassOf ex:B .`, '']);
      expect(own[1].load).toBeUndefined();
      expect(own[1].files).toEqual([]);
      expect(own[1].suggestedPrefix).toBeUndefined();
      // It registers no prefix: prefixes are the app's.
      expect(Prefix.toMap()).toEqual(before);
      expect(suggestedPrefixes().filter((p) => p.packageName === 'ontology-registry-test-a')).toEqual([
        {packageName: 'ontology-registry-test-a', name: 'reg-a', namespace: 'http://example.org/reg/', prefix: 'rega'},
      ]);
      expect(registrationsByPackage(own).get('ontology-registry-test-a')).toHaveLength(2);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('registerOntologies refuses a bad name, a repeated name, an empty namespace and a bad prefix', () => {
    const pkg = linkedPackage('ontology-registry-test-refuse');
    const url = 'file:///nowhere/ontologies/index.js';
    const ok = {name: 'ok', namespace: 'http://example.org/ok/', terms: {}};
    expect(() => pkg.registerOntologies([{...ok, name: 'Bad Name'}], url)).toThrow('not a valid ontology name');
    expect(() => pkg.registerOntologies([ok, ok], url)).toThrow('declared twice');
    expect(() => pkg.registerOntologies([{...ok, namespace: ''}], url)).toThrow('has no namespace');
    expect(() => pkg.registerOntologies([{...ok, suggestedPrefix: '1x'}], url)).toThrow('not a valid prefix');
    expect(() => pkg.registerOntologies([{...ok, data: []}], url)).toThrow('non-empty array');
    // Nothing of a refused call is registered.
    expect(getRegisteredOntologies().some((r) => r.packageName === 'ontology-registry-test-refuse')).toBe(false);
  });

  test('a name need not equal a module file name, and two packages may use the same name', () => {
    registerTestOntology('ontology-registry-test-name-1', {name: 'shared_name', namespace: ns('').id, terms: terms});
    registerTestOntology('ontology-registry-test-name-2', {name: 'shared_name', namespace: ns('').id, terms: terms});
    const both = getRegisteredOntologies().filter((r) => r.name === 'shared_name');
    expect(both.map((r) => r.packageName)).toEqual([
      'ontology-registry-test-name-1',
      'ontology-registry-test-name-2',
    ]);
  });

  test('an entry an older copy of core wrote (a prefix, no name) is skipped with one warning', () => {
    const namespace = 'http://example.org/reg/';
    const legacy = {packageName: 'ontology-registry-test-legacy', prefix: 'old', ns, files: [], terms: {}};
    const current: OntologyRegistration = {packageName: 'ontology-registry-test-legacy', name: 'new', namespace, files: [], terms: {}};
    const byPackage = registrationsByPackage([legacy as unknown as OntologyRegistration, current]);
    expect(byPackage.get('ontology-registry-test-legacy')).toEqual([current]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('without a name');
    expect(warned[0]).toContain('old');
  });

  test('an entry an older copy of core wrote (a namespace function, no namespace) is skipped with one warning', () => {
    const older = {packageName: 'ontology-registry-test-older', name: 'older', ns, files: [], terms: {}};
    const byPackage = registrationsByPackage([older as unknown as OntologyRegistration]);
    expect(byPackage.has('ontology-registry-test-older')).toBe(false);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('without a namespace');
  });

  test('re-registering the same package and name replaces the entry (idempotent)', () => {
    const pkg = linkedPackage('ontology-registry-test-idem');
    const first = async () => ['first'];
    const second = async () => ['second'];
    registerTestOntology(pkg.packageName, {name: 'idem', namespace: ns('').id, terms: terms, load: first, files: '../data/idem.ttl'});
    registerTestOntology(pkg.packageName, {name: 'idem', namespace: ns('').id, terms: terms, load: second, files: '../data/idem.ttl'});
    const own = getRegisteredOntologies().filter((r) => r.packageName === 'ontology-registry-test-idem');
    expect(own).toHaveLength(1);
    expect(own[0].load).toBe(second);
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
    registerTestOntology(pkg.packageName, {name: 'read-a', namespace: ns('').id, terms: terms, load: async () => [`${PREFIXES}ex:A rdfs:subClassOf ex:B .`], files: '../data/read-a.ttl'});
    registerTestOntology(pkg.packageName, {name: 'read-b', namespace: ns('').id, terms: terms, load: async () => [`${PREFIXES}ex:B rdfs:subClassOf ex:C .`, ''], files: [
      '../data/read-b.ttl',
      '../data/read-b-added.ttl',
    ]});
    registerTestOntology(pkg.packageName, {name: 'read-c', namespace: ns('').id, terms: terms});
    registerTestOntology('ontology-registry-test-read-nodata', {name: 'nodata', namespace: ns('').id, terms: terms});
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
    registerTestOntology(pkg.packageName, {name: 'json-a', namespace: ns('').id, terms: terms, load: async () => ({'@graph': []}), files: '../data/json-a.json'});
    registerTestOntology(pkg.packageName, {name: 'json-b', namespace: ns('').id, terms: terms, load: async () => ({'@graph': []}), files: '../data/json-b.json'});
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
    registerTestOntology(rejects.packageName, {name: 'rej', namespace: ns('').id, terms: terms, load: async () => {
      throw new Error('ENOENT no such file');
    }, files: '../data/rej.ttl'});
    const bad = linkedPackage('ontology-registry-test-bad');
    registerTestOntology(bad.packageName, {name: 'bad', namespace: ns('').id, terms: terms, load: async () => [`${PREFIXES}ex:A rdfs:subClassOf .`], files: '../data/bad.ttl'});
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
