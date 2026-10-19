/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {sharedState} from './sharedState.js';

/** The prefix maps, shared so a prefix registered through one copy of core serialises in all. */
const prefixState = sharedState('@_linked/core', 'Prefix', () => ({
  uriToPrefix: new Map<string, string>(),
  prefixToUri: new Map<string, string>(),
}));

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

  static getPrefix(fullURI: string): string {
    if (this.uriToPrefix.has(fullURI)) {
      return this.uriToPrefix.get(fullURI);
    }
    let match = this.findMatch(fullURI);
    if (match.length > 0) return match[1];
  }

  static getFullURI(prefix: string): string {
    return this.prefixToUri.get(prefix);
  }


  static findMatch(fullURI: string): [string, string, string] | [] {
    for (let [ontologyURI, prefix] of this.uriToPrefix.entries()) {
      if (fullURI.substring(0, ontologyURI.length) == ontologyURI) {
        return [ontologyURI, prefix, fullURI.substring(ontologyURI.length)];
      }
    }
    return [];
  }

  /**
   * Compact a full IRI to `prefix:local`, but ONLY when `local` is a legal
   * SPARQL 1.1 `PN_LOCAL`. Otherwise undefined, so callers emit `<full-iri>`.
   *
   * Returning an invalid prefixed name is not a cosmetic problem: `#` is not in
   * `PN_LOCAL`, so a namespace that merely string-prefixes another one turns
   * `https://data.create.now/access#PolicyRegistry` into
   * `create-now:access#PolicyRegistry`, where the tokenizer ends the name at
   * `create-now:access` and reads `#PolicyRegistry .` as a COMMENT — eating the
   * triple terminator and producing a query the store rejects with a parse
   * error that points at the *next* line. See docs/plans/041.
   *
   * The check is an allowlist on purpose. A blocklist (this used to exclude
   * only `/`) is wrong again the moment another illegal character shows up;
   * over-rejecting only costs a longer full IRI, never correctness.
   */
  static toPrefixed(fullURI: string) {
    let match = this.findMatch(fullURI);
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

  static toPrefixedIfPossible(fullURI: string) {
    return this.toPrefixed(fullURI) || fullURI;
  }

  static toFullIfPossible(fullURI: string): string {
    let res = this._toFull(fullURI);
    if(res) {
      return res;
    }
    return fullURI;
  }

  /**
   * Converts a prefixed URI back to its full URI
   * Will return the prefixed URI if no prefix was found
   * @param uri
   */
  static toFull(uri) {
    let res = this._toFull(uri);
    if(res) {
      return res;
    }
    const colon = uri.indexOf(':');
    const prefix = colon === -1 ? uri : uri.slice(0, colon);
    throw new Error(
      'Unknown prefix ' +
        prefix +
        '. Could not convert ' +
        uri +
        ' to a full URI',
    );
  }
  private static _toFull(uri) {
    // Split on the FIRST colon only: the local name may itself contain colons
    // (e.g. `ex:foo:bar`), which `split(':')` would truncate.
    const colon = uri.indexOf(':');
    if (colon === -1) return undefined;
    const prefix = uri.slice(0, colon);
    const rest = uri.slice(colon + 1);
    let ontologyURI = this.getFullURI(prefix);
    if (ontologyURI) {
      return ontologyURI + rest;
    }
  }
}
