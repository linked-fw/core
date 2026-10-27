/*
 * Core's own vocabulary (`core:`): the package kinds are classes under `core:Package`, typed and
 * labelled in `core.ttl`; nothing npm-specific is left in core (no `npm:` registration, no
 * `core:packageName`).
 */
import {describe, expect, test} from '@jest/globals';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {Parser} from 'n3';
import {coreOntology} from '../ontologies/linked-core';
import '../ontologies/linked-core.register';
import {getRegisteredOntologies} from '../utils/Package';

const CORE = 'https://linked.cm/ont/core/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';

const turtle = readFileSync(path.resolve(process.cwd(), 'src/data/core.ttl'), 'utf8');
const quads = new Parser().parse(turtle);
const objects = (subject: string, predicate: string) =>
  quads.filter((q) => q.subject.value === subject && q.predicate.value === predicate).map((q) => q.object.value);

describe('core: package kinds', () => {
  test.each(['OntologyPackage', 'AssetPackage'] as const)('%s is exported and a labelled subclass of core:Package', (name) => {
    expect(coreOntology[name].id).toBe(`${CORE}${name}`);
    expect(objects(`${CORE}${name}`, RDF_TYPE)).toEqual([OWL_CLASS]);
    expect(objects(`${CORE}${name}`, SUBCLASS)).toEqual([coreOntology.Package.id]);
    expect(objects(`${CORE}${name}`, LABEL)).toHaveLength(1);
  });

  test('core names no npm term: no packageName, no ontologyTriples, no npm: registration', () => {
    expect('packageName' in coreOntology).toBe(false);
    expect('ontologyTriples' in coreOntology).toBe(false);
    expect(quads.some((q) => q.subject.value === `${CORE}packageName`)).toBe(false);
    expect(turtle).not.toContain('purl.org/on/npm');
    const coreRegistrations = getRegisteredOntologies().filter((r) => r.packageName === '@_linked/core');
    expect(coreRegistrations.map((r) => r.prefix)).toEqual(['core']);
  });
});
