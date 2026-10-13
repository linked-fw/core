/**
 * Regression cover for docs/plans/041 — a prefixed name whose local part is not
 * a legal SPARQL `PN_LOCAL`.
 *
 * The failure mode is silent at generation time and loud only at the store: `#`
 * is not in `PN_LOCAL`, so `create-now:access#PolicyRegistry` is tokenized as
 * `create-now:access` followed by a COMMENT, which eats the triple terminator
 * and makes the store reject the query at the FOLLOWING line. These two queries
 * shipped broken for months because `@_linked/fuseki` 2.x turned the rejection
 * into an empty result set.
 */
import {beforeAll, afterAll, describe, expect, test} from '@jest/globals';
import {Prefix} from '../utils/Prefix';
import {formatUri, collectPrefixes} from '../sparql/sparqlUtils';
import {linkedShape} from '../package';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {createNameSpace} from '../utils/NameSpace';
import {captureQuery} from '../test-helpers/query-capture-store';
import {selectToSparql} from '../sparql/irToAlgebra';
import {createTestDataset, executeSparqlQuery} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';

import '../ontologies/rdf';
import '../ontologies/xsd';

// The backend's registry, reproduced: `create-now:` is registered and is a
// proper STRING PREFIX of the access namespace, whose own prefix is not.
const DATA_ROOT = 'https://data.create.now/';
const ACCESS = 'https://data.create.now/access#';
const ns = createNameSpace(ACCESS);

@linkedShape
class GrantEntity extends Shape {
  static targetClass = ns('AccessGrant');
  @objectProperty({path: ns('assignee'), maxCount: 1}) get assignee(): string { return ''; }
  @literalProperty({path: ns('payload'), maxCount: 1}) get payload(): string { return '{}'; }
}

@linkedShape
class RegistryEntity extends Shape {
  static targetClass = ns('PolicyRegistry');
  @literalProperty({path: ns('version'), maxCount: 1}) get version(): string { return '0'; }
}

beforeAll(() => Prefix.add('create-now', DATA_ROOT));
afterAll(() => Prefix.delete('create-now'));

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

describe('PN_LOCAL validity', () => {
  test('a local part containing `#` is not compacted', () => {
    expect(Prefix.toPrefixed(`${ACCESS}PolicyRegistry`)).toBeUndefined();
    expect(formatUri(`${ACCESS}PolicyRegistry`)).toBe(`<${ACCESS}PolicyRegistry>`);
  });

  test('a legal local part still compacts', () => {
    expect(formatUri(`${DATA_ROOT}Project`)).toBe('create-now:Project');
    expect(formatUri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')).toBe('rdf:type');
  });

  test.each([
    ['slash', `${DATA_ROOT}a/b`],
    ['hash', `${DATA_ROOT}a#b`],
    ['question mark', `${DATA_ROOT}a?b`],
    ['at sign', `${DATA_ROOT}a@b`],
    ['percent escape', `${DATA_ROOT}a%2Fb`],
    ['trailing dot', `${DATA_ROOT}a.`],
  ])('%s in the local part falls back to a full IRI', (_label, uri) => {
    expect(formatUri(uri)).toBe(`<${uri}>`);
  });

  test('collectPrefixes does not declare a prefix the terms will not use', () => {
    expect(collectPrefixes([`${ACCESS}PolicyRegistry`])).toEqual({});
    expect(collectPrefixes([`${DATA_ROOT}Project`])).toEqual({'create-now': DATA_ROOT});
  });
});

// ---------------------------------------------------------------------------
// The two queries that actually broke, at their own altitude
// ---------------------------------------------------------------------------

const golden = async (factory: () => Promise<unknown>): Promise<string> =>
  selectToSparql(await captureQuery(factory));

const readVersion = () =>
  (RegistryEntity as any)
    .select((i: any) => [i.version])
    .where((i: any) => i.equals({id: `${ACCESS}registry`}))
    .exec();

const grantsForActor = () =>
  (GrantEntity as any)
    .select((i: any) => [i.payload])
    .where((i: any) => i.assignee.equals({id: 'https://webid.email/id/51f68968'}))
    .exec();

describe('policy repository queries (plan-041)', () => {
  test('readVersion emits full IRIs, not `create-now:access#...`', async () => {
    const sparql = await golden(readVersion);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_version
WHERE {
  ?a0 rdf:type <${ACCESS}PolicyRegistry> .
  OPTIONAL {
    ?a0 <${ACCESS}version> ?a0_version .
  }
  FILTER(?a0 = <${ACCESS}registry>)
}`);
  });

  test('grantsForActor emits full IRIs, not `create-now:access#...`', async () => {
    const sparql = await golden(grantsForActor);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_payload
WHERE {
  ?a0 rdf:type <${ACCESS}AccessGrant> .
  ?a0 <${ACCESS}assignee> ?a0_assignee .
  OPTIONAL {
    ?a0 <${ACCESS}payload> ?a0_payload .
  }
  FILTER(?a0_assignee = <https://webid.email/id/51f68968>)
}`);
  });
});

/**
 * The assertion that would have caught this originally: no golden string can tell you a query
 * PARSES. Only a SPARQL parser can, so ask one — the test Fuseki, through the shared store.
 */
describeFuseki('policy repository queries parse on a real SPARQL endpoint', () => {
  beforeAll(async () => {
    await createTestDataset();
  });

  test.each([
    ['readVersion', readVersion],
    ['grantsForActor', grantsForActor],
  ])('%s is accepted by Fuseki', async (_label, factory) => {
    await expect(executeSparqlQuery(await golden(factory))).resolves.toHaveProperty('results');
  }, 30000);
});
