/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Graph-registry records, as a store writes them.
 *
 * A record's subject is the graph IRI. Core fills the automatic fields (`sd:name`,
 * `core:contentHash`, `dcterms:modified`, and `core:feedsHierarchy` on create, from the class's
 * default); the caller passes only the class's own fields. This table is what a store needs to
 * write a record from a {@link GraphQuery} alone (CN's gateway receives one over the wire), so it
 * does not depend on the shape classes in `shapes/NamedGraph.ts`, which read the same terms.
 */
import type {GraphQuery} from './IntermediateRepresentation.js';
import {coreOntology} from '../ontologies/linked-core.js';
import {sd} from '../ontologies/sd.js';
import {xsd} from '../ontologies/xsd.js';
import {sha256Hex} from '../utils/sha256.js';

/** Dublin Core terms the registry uses. */
export const dcterms = {
  modified: 'http://purl.org/dc/terms/modified',
  source: 'http://purl.org/dc/terms/source',
} as const;

/** One caller-settable field of a record class. */
export type GraphRecordField = {
  /** The predicate IRI. */
  path: string;
  /** `xsd:string` or `xsd:boolean`. */
  datatype: string;
  /** Several values allowed (a string or an array of strings). */
  many?: boolean;
};

/** What a store needs to write a record of one class. */
export type GraphRecordClass = {
  /** `core:feedsHierarchy` written on create when the caller does not set it. */
  feedsHierarchy: boolean;
  /** The caller-settable fields, by name. */
  fields: Readonly<Record<string, GraphRecordField>>;
};

const namedGraphFields: Record<string, GraphRecordField> = {
  sources: {path: dcterms.source, datatype: xsd.string.id, many: true},
};
const packageGraphFields: Record<string, GraphRecordField> = {
  ...namedGraphFields,
  package: {path: coreOntology.package.id, datatype: xsd.string.id},
  version: {path: coreOntology.version.id, datatype: xsd.string.id},
  /** A shared graph's parts: `"{package} {hash}"` per package (see `utils/graphTargets.ts`). */
  packageHashes: {path: coreOntology.packageHash.id, datatype: xsd.string.id, many: true},
};
// Only an ontology graph may opt out of feeding the hierarchy; every other kind never feeds it.
const ontologyGraphFields: Record<string, GraphRecordField> = {
  ...packageGraphFields,
  feedsHierarchy: {path: coreOntology.feedsHierarchy.id, datatype: xsd.boolean.id},
};

const recordClasses = new Map<string, GraphRecordClass>([
  [sd.NamedGraph.id, {feedsHierarchy: false, fields: namedGraphFields}],
  [coreOntology.OntologyGraph.id, {feedsHierarchy: true, fields: ontologyGraphFields}],
  [coreOntology.ShapesGraph.id, {feedsHierarchy: false, fields: packageGraphFields}],
  [coreOntology.DraftGraph.id, {feedsHierarchy: false, fields: namedGraphFields}],
]);

/** The fields core fills itself; a caller passing one is refused. */
const AUTOMATIC_FIELDS = new Set(['id', 'name', 'contentHash', 'modified']);

/** Make a record class known to stores (a later graph kind, such as an import graph). */
export function registerGraphRecordClass(classIri: string, definition: GraphRecordClass): void {
  recordClasses.set(classIri, definition);
}

/** The record class for `classIri`; throws for a class no store knows how to record. */
export function getGraphRecordClass(classIri: string): GraphRecordClass {
  const definition = recordClasses.get(classIri);
  if (!definition) {
    throw new Error(
      `<${classIri}> is not a graph record class. Known: ${[...recordClasses.keys()]
        .map((iri) => `<${iri}>`)
        .join(', ')}.`,
    );
  }
  return definition;
}

/** A typed literal value of a record field. */
export type GraphRecordLiteral = {value: string; datatype: string};

/** The literal values of the caller's own fields, by predicate, checked against the class. */
export function graphRecordFieldValues(
  query: Pick<GraphQuery, 'recordClass' | 'record'>,
): Map<string, GraphRecordLiteral[]> {
  const definition = getGraphRecordClass(query.recordClass);
  const values = new Map<string, GraphRecordLiteral[]>();
  for (const [name, raw] of Object.entries(query.record ?? {})) {
    if (raw === undefined) continue;
    if (AUTOMATIC_FIELDS.has(name)) {
      throw new Error(`The record field "${name}" is filled in by core; do not pass it.`);
    }
    const field = definition.fields[name];
    if (!field) {
      throw new Error(
        `<${query.recordClass}> records have no field "${name}". Fields: ${Object.keys(
          definition.fields,
        ).join(', ')}.`,
      );
    }
    const list = Array.isArray(raw) ? raw : [raw];
    if (Array.isArray(raw) && !field.many) {
      throw new Error(`The record field "${name}" takes one value, not a list.`);
    }
    values.set(
      field.path,
      list.map((value) => literalFor(name, field, value)),
    );
  }
  return values;
}

function literalFor(name: string, field: GraphRecordField, value: unknown): GraphRecordLiteral {
  if (field.datatype === xsd.boolean.id) {
    if (typeof value !== 'boolean') {
      throw new Error(`The record field "${name}" is a boolean; got ${JSON.stringify(value)}.`);
    }
    return {value: String(value), datatype: field.datatype};
  }
  if (typeof value !== 'string') {
    throw new Error(`The record field "${name}" is a string; got ${JSON.stringify(value)}.`);
  }
  return {value, datatype: field.datatype};
}

/**
 * The content hash a graph query records: the caller's `contentHash`, else `sha256Hex` of the
 * content text (create, replace; a create without content hashes the empty text). A patch has no
 * whole content text, so its hash is `sha256Hex` of its delete text, a newline and its insert
 * text: a function of what was sent, which changes with every patch. A record-only update and a
 * drop record no hash (`undefined`).
 */
export function graphContentHash(query: GraphQuery): string | undefined {
  if (query.kind === 'graph_drop') return undefined;
  if (query.kind === 'graph_patch' && !hasPatchBody(query)) return undefined;
  if (query.contentHash) return query.contentHash;
  if (query.kind === 'graph_patch') {
    return sha256Hex(`${query.patch?.delete?.text ?? ''}\n${query.patch?.insert?.text ?? ''}`);
  }
  return sha256Hex(query.content?.text ?? '');
}

/** Whether a graph query changes the graph's body (a patch with neither member does not). */
export function hasPatchBody(query: GraphQuery): boolean {
  return !!(query.patch?.insert || query.patch?.delete);
}
