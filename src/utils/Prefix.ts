/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {sharedState} from './sharedState.js';
import {brandLinkedError} from './linkedError.js';

/**
 * A prefix map: prefix → namespace IRI, as the `prefixes` of an app's `linked.app.json`.
 *
 * Prefixes are an app's choice, not a package's: no ontology registers one. The running app loads
 * its map with {@link Prefix.load}; a caller acting for another app passes that app's map to the
 * expansion and compaction methods instead.
 */
export type PrefixMap = Readonly<Record<string, string>>;

/** The map in use, shared so a prefix loaded through one copy of core serialises in all. */
const prefixState = sharedState('@_linked/core', 'Prefix', () => ({
  uriToPrefix: new Map<string, string>(),
  prefixToUri: new Map<string, string>(),
}));

/**
 * IRI schemes a string is read as a full IRI by, never as a prefixed name: `urn:isbn:1` is an
 * IRI even when no prefix `urn` exists. A string containing `://` is a full IRI as well.
 */
const IRI_SCHEMES = new Set(['http', 'https', 'urn', 'mailto', 'did', 'file', 'data']);

/** SPARQL 1.1 / Turtle `PN_PREFIX` (ASCII subset), or empty (the default prefix `:`). */
const PN_PREFIX = /^(?:[A-Za-z](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?)?$/;

/**
 * Thrown when a prefixed name is expanded and its prefix is not in the prefix map: the app's
 * (loaded with `Prefix.load`), or the map the caller passed.
 */
export class UnknownPrefixError extends Error {
  /** The prefix that is not in the map. */
  readonly prefix: string;
  /** The value that was expanded. */
  readonly value: string;

  constructor(prefix: string, value: string) {
    super(
      `Unknown prefix "${prefix}" in "${value}": the prefix map in use has no "${prefix}". ` +
        `Add it to the app's prefix map (linked.app.json "prefixes"), pass the map that has it, ` +
        `or write the full IRI.`,
    );
    this.name = 'UnknownPrefixError';
    this.prefix = prefix;
    this.value = value;
  }
}
brandLinkedError(UnknownPrefixError, '@_linked/core', 'UnknownPrefixError');

export class Prefix {
  static get uriToPrefix(): Map<string, string> {
    return prefixState.uriToPrefix;
  }
  static set uriToPrefix(map: Map<string, string>) {
    prefixState.uriToPrefix = map;
  }
  static get prefixToUri(): Map<string, string> {
    return prefixState.prefixToUri;
  }
  static set prefixToUri(map: Map<string, string>) {
    prefixState.prefixToUri = map;
  }

  static getUriToPrefixMap() {
    return this.uriToPrefix;
  }

  static getPrefixToUriMap() {
    return this.prefixToUri;
  }

  /**
   * Make `map` the prefix map in use, replacing the one before. An app calls it once at start
   * with its own map (the cli does, on the server and in the browser bundle); a test calls it in
   * its setup with the prefixes it assumes. When two prefixes share a namespace, compaction uses
   * the later one.
   *
   * Throws when a prefix is not a SPARQL/Turtle `PN_PREFIX` or a namespace is not a non-empty string.
   */
  static load(map: PrefixMap) {
    const entries = Object.entries(map ?? {});
    for (const [prefix, namespace] of entries) {
      if (!PN_PREFIX.test(prefix)) {
        throw new Error(`Prefix.load: "${prefix}" is not a valid prefix (SPARQL/Turtle PN_PREFIX).`);
      }
      if (typeof namespace !== 'string' || namespace === '') {
        throw new Error(`Prefix.load: the namespace of "${prefix}" must be a non-empty IRI string.`);
      }
    }
    this.clear();
    for (const [prefix, namespace] of entries) this.add(prefix, namespace);
  }

  /** A copy of the prefix map in use, as a plain {@link PrefixMap}. */
  static toMap(): Record<string, string> {
    return Object.fromEntries(this.prefixToUri);
  }

  static add(prefix: string, fullURI: string) {
    this.uriToPrefix.set(fullURI, prefix);
    this.prefixToUri.set(prefix, fullURI);
  }

  static delete(prefix: string) {
    if (this.prefixToUri.has(prefix)) {
      let fullURI = this.getFullURI(prefix);
      this.uriToPrefix.delete(fullURI);
      this.prefixToUri.delete(prefix);
    }
  }

  static clear() {
    this.uriToPrefix = new Map<string, string>();
    this.prefixToUri = new Map<string, string>();
  }

  /** The prefix of a namespace or IRI in `map` (default: the map in use), or undefined. */
  static getPrefix(fullURI: string, map?: PrefixMap): string | undefined {
    if (!map && this.uriToPrefix.has(fullURI)) {
      return this.uriToPrefix.get(fullURI);
    }
    let match = this.findMatch(fullURI, map);
    if (match.length > 0) return match[1];
  }

  /** The namespace of `prefix` in `map` (default: the map in use), or undefined. */
  static getFullURI(prefix: string, map?: PrefixMap): string | undefined {
    if (map) return Object.prototype.hasOwnProperty.call(map, prefix) ? map[prefix] : undefined;
    return this.prefixToUri.get(prefix);
  }

  /**
   * The first namespace in `map` (default: the map in use) that `fullURI` starts with:
   * `[namespace, prefix, local]`, or `[]`. With an explicit map, the later of two prefixes of one
   * namespace is found, as in the map in use.
   */
  static findMatch(fullURI: string, map?: PrefixMap): [string, string, string] | [] {
    const uriToPrefix = map ? new Map(Object.entries(map).map(([p, ns]) => [ns, p])) : this.uriToPrefix;
    for (let [ontologyURI, prefix] of uriToPrefix.entries()) {
      if (fullURI.substring(0, ontologyURI.length) == ontologyURI) {
        return [ontologyURI, prefix, fullURI.substring(ontologyURI.length)];
      }
    }
    return [];
  }

  /**
   * Compact a full IRI to `prefix:local` with `map` (default: the map in use), but ONLY when
   * `local` is a legal SPARQL 1.1 `PN_LOCAL`. Otherwise undefined, so callers emit `<full-iri>`.
   *
   * Returning an invalid prefixed name is not a cosmetic problem: `#` is not in
   * `PN_LOCAL`, so a namespace that merely string-prefixes another one turns
   * `https://data.example.org/access#PolicyRegistry` into
   * `my-app:access#PolicyRegistry`, where the tokenizer ends the name at
   * `my-app:access` and reads `#PolicyRegistry .` as a COMMENT — eating the
   * triple terminator and producing a query the store rejects with a parse
   * error that points at the *next* line.
   *
   * The check is an allowlist on purpose. A blocklist (this used to exclude
   * only `/`) is wrong again the moment another illegal character shows up;
   * over-rejecting only costs a longer full IRI, never correctness.
   */
  static toPrefixed(fullURI: string, map?: PrefixMap): string | undefined {
    let match = this.findMatch(fullURI, map);
    if (match.length > 0) {
      const postFix = fullURI.substring(match[0].length);
      if (Prefix.isValidLocalName(postFix)) {
        return match[1] + ':' + postFix;
      }
    }
  }

  /**
   * Is this a local part we can safely emit after `prefix:`?
   *
   * A conservative ASCII subset of `PN_LOCAL`: no leading/trailing `.`, no `%`
   * escapes, and none of the characters (`#`, `/`, `?`, `@`, ...) that would
   * end the token early. Empty is allowed — `prefix:` is a valid PNAME_LN.
   */
  static isValidLocalName(local: string): boolean {
    if (local === '') return true;
    return /^[A-Za-z0-9_:](?:[A-Za-z0-9_:.-]*[A-Za-z0-9_:-])?$/.test(local);
  }

  static toPrefixedIfPossible(fullURI: string, map?: PrefixMap): string {
    return this.toPrefixed(fullURI, map) || fullURI;
  }

  /**
   * Whether `value` is a full IRI rather than a prefixed name: it contains `://`, or its scheme
   * (the part before the first `:`) is one of `http`, `https`, `urn`, `mailto`, `did`, `file`,
   * `data` (any case).
   */
  static isFullIri(value: string): boolean {
    if (typeof value !== 'string') return false;
    if (value.includes('://')) return true;
    const colon = value.indexOf(':');
    return colon > 0 && IRI_SCHEMES.has(value.slice(0, colon).toLowerCase());
  }

  /**
   * The full IRI `value` names. A full IRI ({@link isFullIri}) is returned as is; `prefix:local`
   * expands against `map` (default: the map in use).
   *
   * @throws UnknownPrefixError when the prefix is not in the map (also for a value without `:`,
   *   whose whole text is then the prefix): never a silent fallback to the value as an IRI.
   */
  static toFull(value: string, map?: PrefixMap): string {
    if (this.isFullIri(value)) return value;
    // Split on the FIRST colon only: the local name may itself contain colons (`ex:foo:bar`).
    const colon = value.indexOf(':');
    const prefix = colon === -1 ? value : value.slice(0, colon);
    const namespace = colon === -1 ? undefined : this.getFullURI(prefix, map);
    if (namespace === undefined) throw new UnknownPrefixError(prefix, value);
    return namespace + value.slice(colon + 1);
  }
}
