import {Prefix} from '../utils/Prefix';
import {toNodeReference, resolveUriOrThrow} from '../utils/NodeReference';

// Register test prefixes before tests run
const FOAF_NS = 'http://xmlns.com/foaf/0.1/';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';

beforeAll(() => {
  Prefix.add('foaf', FOAF_NS);
  Prefix.add('xsd', XSD_NS);
});

afterAll(() => {
  Prefix.delete('foaf');
  Prefix.delete('xsd');
});

// ---------------------------------------------------------------------------
// toNodeReference — simple wrap, no prefix resolution
// ---------------------------------------------------------------------------

describe('toNodeReference (simple wrap)', () => {
  it('wraps string in {id} without resolving prefixes', () => {
    expect(toNodeReference('foaf:Person')).toEqual({id: 'foaf:Person'});
  });

  it('wraps full IRI string in {id}', () => {
    expect(toNodeReference('http://example.org/foo')).toEqual({id: 'http://example.org/foo'});
  });

  it('wraps plain ID string in {id}', () => {
    expect(toNodeReference('my-entity-id')).toEqual({id: 'my-entity-id'});
  });

  it('passes through {id} with prefixed value unchanged', () => {
    expect(toNodeReference({id: 'foaf:Person'})).toEqual({id: 'foaf:Person'});
  });

  it('passes through {id} with full IRI', () => {
    expect(toNodeReference({id: 'http://example.org/foo'})).toEqual({id: 'http://example.org/foo'});
  });
});

// ---------------------------------------------------------------------------
// resolveUriOrThrow — strict resolution
// ---------------------------------------------------------------------------

describe('resolveUriOrThrow', () => {
  it('resolves a registered prefixed name to full IRI', () => {
    expect(resolveUriOrThrow('foaf:Person')).toBe(`${FOAF_NS}Person`);
  });

  it('passes through full IRIs unchanged', () => {
    expect(resolveUriOrThrow('http://example.org/foo')).toBe('http://example.org/foo');
  });

  it('throws on unregistered prefix', () => {
    expect(() => resolveUriOrThrow('unknown:foo')).toThrow('Unknown prefix');
  });

  it('passes through IRIs with a non-hierarchical scheme (urn:, mailto:, did:, data:)', () => {
    expect(resolveUriOrThrow('urn:uuid:12345')).toBe('urn:uuid:12345');
    expect(resolveUriOrThrow('mailto:a@example.org')).toBe('mailto:a@example.org');
    expect(resolveUriOrThrow('did:web:example.org')).toBe('did:web:example.org');
    expect(resolveUriOrThrow('data:,x')).toBe('data:,x');
  });

  it('throws on a plain id without a colon', () => {
    expect(() => resolveUriOrThrow('plain-id')).toThrow('Unknown prefix "plain-id"');
  });

  it('throws on typo prefix', () => {
    expect(() => resolveUriOrThrow('foa:Person')).toThrow('Unknown prefix');
  });
});
