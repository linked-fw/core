import {Prefix, type PrefixMap} from './Prefix.js';

export type NodeReferenceValue = {id: string};

export type NodeReferenceInput = NodeReferenceValue | string;

/**
 * Resolve a URI string strictly: a full IRI (`https://…`, `urn:…`, see `Prefix.isFullIri`) is
 * returned as is, a prefixed name (`foaf:Person`) is expanded against `map` (default: the app's
 * prefix map in use). Throws `UnknownPrefixError` for any other string.
 *
 * Use this at API boundaries where strings are always URIs (never plain IDs).
 */
export function resolveUriOrThrow(str: string, map?: PrefixMap): string {
  return Prefix.toFull(str, map);
}

/**
 * Convert a NodeReferenceInput to a NodeReferenceValue.
 * Simple wrap — no prefix resolution. Use resolveUriOrThrow() for that.
 */
export function toNodeReference(value: NodeReferenceInput): NodeReferenceValue {
  if (typeof value === 'string') {
    return {id: value};
  }
  return {id: value.id};
}

export function isNodeReferenceValue(value: unknown): value is NodeReferenceValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof (value as NodeReferenceValue).id === 'string'
  );
}
