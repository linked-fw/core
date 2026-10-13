/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * The class check for nodes linked by `{id}` into a `contains` property.
 *
 * An owner deletes what it contains: on replace, on set-remove and when the owner itself is
 * deleted. Linking an existing node into a `contains` slot is allowed (upload, then attach),
 * so a node of the wrong kind — a Person linked into an `image` slot whose value shape is
 * ImageObject — would later be deleted with it. Nothing validates `sh:class` on write, so the
 * SPARQL dataset checks it here, before the update is sent.
 *
 * A field is checked when it owns its value by the same rule the replace delete applies: the
 * property itself is `contains`, declares a value shape and has a simple path. A plain property
 * on a predicate another shape declares `contains` owns nothing and is not checked. A node is
 * refused only when the store holds at least one `rdf:type` for it and none of them is accepted;
 * an id that does not exist yet, or has no type, is allowed (`rdf:nil`, a node another request
 * creates, an untyped IRI). Collecting the links is a pure walk over the lowered IR; the dataset sends
 * one SELECT for all distinct ids, and none when there is nothing to check.
 */
import type {
  IRCreateMutation,
  IRFieldValue,
  IRNodeData,
  IRUpdateMutation,
  IRUpdateWhereMutation,
  IRUpsertMutation,
} from '../queries/IntermediateRepresentation.js';
import {findPropertyShapeById, type PropertyShapeData} from '../shapes/nodeShapeData.js';
import {getSubShapes, getTargetClassId} from '../utils/ShapeClass.js';
import {rdf} from '../ontologies/rdf.js';
import {assertSafeIri} from './sparqlUtils.js';
import {isBareNodeReference} from './irToAlgebra.js';
import {getSimplePathId} from '../paths/normalizePropertyPath.js';
import {isSparqlSelectResults, type SparqlQueryResults} from './resultMapping.js';

/** One bare `{id}` linked into a `contains` field that declares a value shape. */
export type OwnedLink = {
  id: string;
  /** Property-shape id. */
  property: string;
  /** Property label, for the message. */
  label: string;
  /** The node shape that declares the property. */
  shape: string;
  /** The value shape's targetClass — the class the message names. */
  expectedClass: string;
  /** `expectedClass`, every registered sub-shape's targetClass, and `sh:class` if declared. */
  acceptedClasses: string[];
};

type OwnedLinkMutation =
  | IRCreateMutation
  | IRUpdateMutation
  | IRUpsertMutation
  | IRUpdateWhereMutation;

type OwnedRule = Omit<OwnedLink, 'id'>;

const RDF_NIL = rdf.nil.id;
const RDF_TYPE = rdf.type.id;

function isNodeData(value: unknown): value is IRNodeData {
  return !!value && typeof value === 'object' && 'shape' in value && 'fields' in value;
}

/**
 * The values a field writes: the items of an array overwrite, the `add` items of a set
 * modification (`remove` items unlink, they never link), or the single value.
 */
function writtenValues(value: IRFieldValue): unknown[] {
  if (Array.isArray(value)) return value;
  if (
    value &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !('id' in value) &&
    !('shape' in value) &&
    ('add' in value || 'remove' in value)
  ) {
    return (value as {add?: IRFieldValue[]}).add ?? [];
  }
  return [value];
}

/** The check for a property, or null when the property is not checked. */
function ownedRuleFor(
  propertyId: string,
  fallbackShape: string,
  cache: Map<string, OwnedRule | null>,
): OwnedRule | null {
  if (cache.has(propertyId)) return cache.get(propertyId) ?? null;
  const rule = buildRule(findPropertyShapeById(propertyId), fallbackShape);
  cache.set(propertyId, rule);
  return rule;
}

function buildRule(ps: PropertyShapeData | undefined, fallbackShape: string): OwnedRule | null {
  if (!ps?.contains || !ps.valueShape || !getSimplePathId(ps.path)) return null;
  const expectedClass = getTargetClassId(ps.valueShape.id);
  if (!expectedClass) return null;
  const accepted = new Set<string>([expectedClass]);
  for (const sub of getSubShapes(ps.valueShape.id)) {
    const subClass = getTargetClassId(sub);
    if (subClass) accepted.add(subClass);
  }
  if (ps.class?.id) accepted.add(ps.class.id);
  return {
    property: ps.id,
    label: ps.label,
    shape: ps.parentNodeShape?.id ?? fallbackShape,
    expectedClass,
    acceptedClasses: [...accepted],
  };
}

function walk(data: IRNodeData, cache: Map<string, OwnedRule | null>, out: OwnedLink[]): void {
  for (const field of data.fields) {
    const rule = ownedRuleFor(field.property, data.shape, cache);
    for (const item of writtenValues(field.value)) {
      if (isNodeData(item)) {
        // A nested create is not a link — the mutation writes its type itself — but its
        // own fields can link.
        walk(item, cache, out);
      } else if (rule && isBareNodeReference(item) && item.id !== RDF_NIL) {
        out.push({id: item.id, ...rule});
      }
    }
  }
}

/** Every owned link in a create, update, upsert or update-where mutation. Pure; no I/O. */
export function collectOwnedLinks(ir: OwnedLinkMutation): OwnedLink[] {
  const out: OwnedLink[] = [];
  walk(ir.data, new Map(), out);
  return out;
}

/** `SELECT ?id ?type WHERE { VALUES ?id { … } ?id rdf:type ?type }` for the distinct ids. */
export function ownedLinkTypesQuery(ids: string[]): string {
  const distinct = [...new Set(ids)];
  for (const id of distinct) assertSafeIri(id);
  const values = distinct.map((id) => `<${id}>`).join(' ');
  return `SELECT ?id ?type WHERE { VALUES ?id { ${values} } ?id <${RDF_TYPE}> ?type }`;
}

/** The `rdf:type`s per id from the answer to {@link ownedLinkTypesQuery}. */
export function ownedLinkTypesFromResults(
  json: SparqlQueryResults,
): Map<string, Set<string>> {
  if (!isSparqlSelectResults(json)) {
    throw new Error(
      'Expected a SPARQL SELECT result set for the owned-link type check, got an ASK response.',
    );
  }
  const types = new Map<string, Set<string>>();
  for (const binding of json.results.bindings) {
    const id = binding.id?.value;
    const type = binding.type?.value;
    if (!id || !type) continue;
    let set = types.get(id);
    if (!set) types.set(id, (set = new Set()));
    set.add(type);
  }
  return types;
}

/**
 * Throws when a linked id is typed and none of its types is accepted. Every violation is
 * listed in the one error. An id with no types is allowed.
 */
export function assertOwnedLinkTypes(
  links: OwnedLink[],
  typesById: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const messages: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const types = typesById.get(link.id);
    if (!types || types.size === 0) continue;
    if (link.acceptedClasses.some((c) => types.has(c))) continue;
    const key = `${link.property} ${link.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const typed = [...types].map((t) => `<${t}>`).join(', ');
    const others = link.acceptedClasses.filter((c) => c !== link.expectedClass);
    const alsoAccepted = others.length
      ? ` (or of ${others.map((c) => `<${c}>`).join(', ')}, a registered sub-shape or sh:class)`
      : '';
    messages.push(
      `Cannot link <${link.id}> into the contains property "${link.label}" of <${link.shape}>: ` +
        `it is typed ${typed}, but "${link.label}" only owns instances of ` +
        `<${link.expectedClass}>${alsoAccepted}. An owner deletes what it contains when the ` +
        'value is replaced or removed, or when the owner is deleted.',
    );
  }
  if (messages.length > 0) throw new Error(messages.join('\n'));
}
