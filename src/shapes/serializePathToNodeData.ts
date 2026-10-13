/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {PathExpr} from '../paths/PropertyPathExpr.js';
import {isPathRef} from '../paths/PropertyPathExpr.js';
import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {List, type RdfListNodeData} from './List.js';
import {rdf} from '../ontologies/rdf.js';
import {PathNode} from './PathNode.js';

/**
 * Node-data the create pipeline accepts for a `sh:path` value: an IRI reference (simple path),
 * an `rdf:List` (sequence / alternative members), or a `PathNode` operator node.
 */
export type PathNodeData =
  | NodeReferenceValue
  | {shape: typeof List | typeof PathNode; __blank: true; [k: string]: unknown};

/**
 * Translate a `PathExpr` into create-pipeline node-data for `sh:path`.
 *
 * - simple `PathRef` → `{id}` (a shared predicate IRI; NOT owned)
 * - sequence → an `rdf:List` of segments
 * - inverse / alternative / cardinality → a `PathNode` operator node (alt's operand is an `rdf:List`)
 *
 * Every operator node and list cell is written as an untyped blank node (`__blank`), the only
 * form SHACL §2.3.1 defines: an IRI in `sh:path` is a predicate path, and an inverse,
 * alternative or cardinality path is a blank node that is the subject of exactly one triple.
 *
 * ```turtle
 * <ps> sh:path [ sh:inversePath schema:image ] .
 * <ps> sh:path ( schema:knows [ sh:zeroOrMorePath schema:parent ] ) .
 * ```
 *
 * The structure is owned through `contains` edges, so a re-sync's delete removes it (the
 * blank-node block of the containment cascade) before the create writes it again.
 *
 * @param _base ignored. It seeded the IRIs of the nodes this used to mint (`{base}/inv`, …);
 *   blank nodes have none. Kept so existing two-argument calls still compile.
 */
export function serializePathToNodeData(path: PathExpr, _base?: string): PathNodeData {
  const operator = (key: string, operand: unknown): PathNodeData => ({
    shape: PathNode,
    __blank: true,
    [key]: operand,
  });
  const serialize = (e: PathExpr): PathNodeData => {
    if (isPathRef(e)) {
      return {id: typeof e === 'string' ? e : e.id};
    }
    if ('seq' in e) {
      // SHACL §2.3.1: a sequence path is a list with **at least two** members.
      // A 0/1-member sequence is not a list — collapse a singleton to its bare
      // member, reject an empty one. (normalizePropertyPath already collapses
      // these upstream; this keeps the serializer independently spec-correct.)
      if (e.seq.length === 0) {
        throw new Error('Cannot serialize an empty sequence path to SHACL sh:path.');
      }
      if (e.seq.length === 1) return serialize(e.seq[0]);
      return blankList(e.seq.map(serialize)) as PathNodeData;
    }
    if ('inv' in e) return operator('inversePath', serialize(e.inv));
    if ('alt' in e) {
      // SHACL §2.3.2: sh:alternativePath is a list with **at least two** members.
      // Collapse a singleton alternative to its bare member, reject an empty one.
      if (e.alt.length === 0) {
        throw new Error('Cannot serialize an empty alternative path to SHACL sh:path.');
      }
      if (e.alt.length === 1) return serialize(e.alt[0]);
      return operator('alternativePath', blankList(e.alt.map(serialize)));
    }
    if ('zeroOrMore' in e) return operator('zeroOrMorePath', serialize(e.zeroOrMore));
    if ('oneOrMore' in e) return operator('oneOrMorePath', serialize(e.oneOrMore));
    if ('zeroOrOne' in e) return operator('zeroOrOnePath', serialize(e.zeroOrOne));
    if ('negatedPropertySet' in e) {
      throw new Error(
        'negatedPropertySet cannot be serialized to SHACL sh:path — no SHACL representation.',
      );
    }
    throw new Error(`Unknown PathExpr shape: ${JSON.stringify(e)}`);
  };
  return serialize(path);
}

/** An `rdf:List` of blank cells (`rdf:first`/`rdf:rest` only), terminated by `rdf:nil`. */
function blankList(items: PathNodeData[]): RdfListNodeData {
  return items.reduceRight<RdfListNodeData>(
    (rest, first) => ({shape: List, __blank: true, first, rest}),
    {id: rdf.nil.id},
  );
}
