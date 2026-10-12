/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {getPropertyShapes, type NodeShapeData, type PropertyShapeData} from './nodeShapeData.js';
import {getSimplePathId} from '../paths/normalizePropertyPath.js';
import {serializePathToNodeData} from './serializePathToNodeData.js';

/**
 * The single-owner SHACL constraints generated from `contains` properties.
 *
 * A `contains` property says the subject owns the value node. For every such property, shape
 * sync writes one generated NodeShape stating the matching store-side rule: every object of the
 * property's predicate has at most one subject pointing at it through that predicate.
 *
 * ```turtle
 * <…/Thing/image.singleOwner> a sh:NodeShape ;
 *     core:generated true ;
 *     sh:targetObjectsOf schema:image ;
 *     sh:property <…/Thing/image.singleOwner/owners> .
 * <…/Thing/image.singleOwner/owners> a sh:PropertyShape ;
 *     sh:maxCount 1 ;
 *     sh:path [ sh:inversePath schema:image ] .
 * ```
 *
 * One constraint per accessor, written only by the class that declares it: subclasses inherit
 * the property but add no constraint, since the rule targets the predicate's objects whoever the
 * subject is. Non-owning references through other predicates are not counted, and neither is
 * ownership through two different `contains` predicates (a documented limitation). The shapes
 * are built only at sync time and are never registered in the in-memory shape registry.
 */

/** Suffix that turns a property shape's IRI into its generated single-owner shape's IRI. */
const SINGLE_OWNER_SUFFIX = '.singleOwner';

/**
 * The deterministic IRI of the generated single-owner NodeShape of one property shape:
 * `${propertyShapeIri}.singleOwner`, e.g. `…/shape/my-pkg/Thing/image.singleOwner`.
 */
export function singleOwnerShapeIri(propertyShapeIri: string): string {
  return `${propertyShapeIri}${SINGLE_OWNER_SUFFIX}`;
}

/**
 * The shape's OWN `contains` properties that get a single-owner constraint: those that declare
 * a value shape and have a simple path, in declaration order.
 *
 * Inherited properties are not included; their declaring shape writes their constraint.
 * Complex paths are skipped, as the containment cascade skips them. A `contains` property
 * without a value shape is a polymorphic slot (like `sh:path`) whose value may be a shared IRI,
 * so the replace, the subject delete and the class check do not treat it as owning that value,
 * and neither does the single-owner rule.
 */
export function singleOwnerProperties(nodeShape: NodeShapeData): PropertyShapeData[] {
  return getPropertyShapes(nodeShape, false).filter(
    (ps) => ps.contains && !!ps.valueShape && !!getSimplePathId(ps.path),
  );
}

/**
 * Create-pipeline data for the generated single-owner NodeShapes of `nodeShape`, one per
 * {@link singleOwnerProperties} entry. Each is stored at
 * {@link singleOwnerShapeIri}`(${shapeIri}/${label})`: the property shape's IRI exactly as shape
 * sync writes it (`buildPropertyShapeData`).
 */
export function buildSingleOwnerConstraints(
  nodeShape: NodeShapeData,
  shapeIri: string,
): Array<{iri: string; data: Record<string, unknown>}> {
  return singleOwnerProperties(nodeShape).flatMap((ps) => {
    const predicate = getSimplePathId(ps.path);
    if (!predicate) return [];
    const iri = singleOwnerShapeIri(`${shapeIri}/${ps.label}`);
    const psIri = `${iri}/owners`;
    return [{
      iri,
      data: {
        generated: true,
        targetObjectsOf: [{id: predicate}],
        properties: [
          {
            __id: psIri,
            label: 'owners',
            maxCount: 1,
            path: serializePathToNodeData({inv: {id: predicate}}, psIri),
          },
        ],
      },
    }];
  });
}
