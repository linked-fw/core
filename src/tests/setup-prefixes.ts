/**
 * The prefixes core's tests assume, loaded as an app loads its prefix map. Core registers no
 * prefix of its own: a test that needs another one adds it in its own setup.
 */
import {Prefix} from '../utils/Prefix';

export const TEST_PREFIXES = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  shacl: 'http://www.w3.org/ns/shacl#',
  sd: 'http://www.w3.org/ns/sparql-service-description#',
  prov: 'http://www.w3.org/ns/prov#',
  core: 'https://linked.cm/ont/core/',
} as const;

Prefix.load(TEST_PREFIXES);
