import {describe, expect, it, beforeEach, afterAll} from '@jest/globals';
import {Prefix, UnknownPrefixError} from '../utils/Prefix';
import {isLinkedError} from '../utils/linkedError';
import {pathExprToSparql, canonicalPathKey} from '../paths/pathExprToSparql';
import {expandPrefixedName, pathRefIri} from '../paths/propertyPathSafety';
import {resolveNodeId, resolveUriOrThrow} from '../utils/NodeReference';
import {DeleteBuilder} from '../queries/DeleteBuilder';

const EX = 'https://example.org/ns/';
const OTHER = 'https://other.example.org/vocab#';
const saved = Prefix.toMap();

beforeEach(() => Prefix.load({ex: EX}));
afterAll(() => Prefix.load(saved));

describe('Prefix.load: the app map in use', () => {
  it('replaces the map in use', () => {
    Prefix.load({o: OTHER});
    expect(Prefix.toMap()).toEqual({o: OTHER});
    expect(Prefix.toFull('o:Thing')).toBe(`${OTHER}Thing`);
    expect(() => Prefix.toFull('ex:a')).toThrow(UnknownPrefixError);
  });

  it('compacts with the later of two prefixes of one namespace', () => {
    Prefix.load({old: EX, ex: EX});
    expect(Prefix.toPrefixed(`${EX}a`)).toBe('ex:a');
    expect(Prefix.toFull('old:a')).toBe(`${EX}a`);
  });

  it('refuses a prefix that is not a PN_PREFIX, and an empty namespace', () => {
    expect(() => Prefix.load({'1x': EX})).toThrow('not a valid prefix');
    expect(() => Prefix.load({'a b': EX})).toThrow('not a valid prefix');
    expect(() => Prefix.load({x: ''})).toThrow('non-empty');
    // A refused map leaves the map in use as it was.
    expect(Prefix.toMap()).toEqual({ex: EX});
  });

  it('toMap is a copy', () => {
    const map = Prefix.toMap();
    map.y = OTHER;
    expect(Prefix.getFullURI('y')).toBeUndefined();
  });
});

describe('an explicit map (acting for another app)', () => {
  const other = {o: OTHER};

  it('expands and compacts against the map given, not the map in use', () => {
    expect(Prefix.toFull('o:Thing', other)).toBe(`${OTHER}Thing`);
    expect(() => Prefix.toFull('ex:a', other)).toThrow(UnknownPrefixError);
    expect(Prefix.toPrefixed(`${OTHER}Thing`, other)).toBe('o:Thing');
    expect(Prefix.toPrefixed(`${EX}a`, other)).toBeUndefined();
    expect(Prefix.toPrefixedIfPossible(`${EX}a`, other)).toBe(`${EX}a`);
    expect(Prefix.getPrefix(`${OTHER}Thing`, other)).toBe('o');
    expect(resolveUriOrThrow('o:Thing', other)).toBe(`${OTHER}Thing`);
    expect(pathRefIri('o:p', other)).toBe(`${OTHER}p`);
  });

  it('does not read inherited object keys as prefixes', () => {
    expect(() => Prefix.toFull('toString:x', other)).toThrow(UnknownPrefixError);
  });
});

describe('an unknown prefix throws (no silent IRI)', () => {
  it('names the prefix and the value', () => {
    let error: unknown;
    try {
      Prefix.toFull('shcema:name');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnknownPrefixError);
    expect(isLinkedError(error, UnknownPrefixError)).toBe(true);
    expect((error as UnknownPrefixError).prefix).toBe('shcema');
    expect((error as UnknownPrefixError).value).toBe('shcema:name');
    expect((error as Error).message).toContain('Unknown prefix "shcema" in "shcema:name"');
  });

  it('reads a string with an IRI scheme as a full IRI', () => {
    for (const iri of [
      'http://a.example/x',
      'https://a.example/x',
      'urn:isbn:123',
      'URN:isbn:123',
      'mailto:a@example.org',
      'did:web:example.org',
      'file:///tmp/x',
      'data:,hello',
      'ftp://a.example/x',
    ]) {
      expect(Prefix.isFullIri(iri)).toBe(true);
      expect(Prefix.toFull(iri)).toBe(iri);
    }
    expect(Prefix.isFullIri('ex:a')).toBe(false);
    expect(Prefix.isFullIri('tag:a')).toBe(false);
  });

  it('a property path string step with an unknown prefix throws', () => {
    expect(() => pathExprToSparql('nope:name')).toThrow(UnknownPrefixError);
    expect(() => pathExprToSparql({seq: ['ex:a', 'nope:b']})).toThrow('Unknown prefix "nope"');
    expect(() => canonicalPathKey('nope:name')).toThrow(UnknownPrefixError);
    expect(() => expandPrefixedName('nope:name')).toThrow(UnknownPrefixError);
  });

  it('a property path step with an IRI scheme, or in brackets, is an IRI', () => {
    expect(pathExprToSparql('urn:prop:a')).toBe('<urn:prop:a>');
    expect(pathExprToSparql({id: 'tag:example.org,2026:p'})).toBe('<tag:example.org,2026:p>');
    expect(pathExprToSparql('ex:a')).toBe('ex:a');
    expect(canonicalPathKey('ex:a')).toBe(`${EX}a`);
    expect(canonicalPathKey({id: 'ex:a'})).toBe(`${EX}a`);
  });

  it('a mutation id that is a prefixed name expands; an unknown prefix throws; a plain id stays', () => {
    expect(resolveNodeId('ex:alice')).toBe(`${EX}alice`);
    expect(resolveNodeId('plain-id')).toBe('plain-id');
    expect(resolveNodeId('_:b0')).toBe('_:b0');
    expect(resolveNodeId('urn:x:1')).toBe('urn:x:1');
    expect(() => resolveNodeId('nope:alice')).toThrow(UnknownPrefixError);
    expect(DeleteBuilder.forNodes('ex:alice').toJSON()).toMatchObject({ids: [`${EX}alice`]});
    expect(() => DeleteBuilder.forNodes('nope:alice')).toThrow(UnknownPrefixError);
  });
});
