/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {getUniquePropertyShapes, type NodeShapeData} from './nodeShapeData.js';
import {getSimplePathId} from '../paths/normalizePropertyPath.js';
import {serializePathToNodeData} from './serializePathToNodeData.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';

/**
 * The single-owner SHACL constraint generated from a shape's `contains` properties.
 *
 * A `contains` property says the subject owns the value node. The generated NodeShape states
 * the matching store-side rule: every object of one of the declaring shape's `contains`
 * predicates has at most one subject pointing at it through any of those predicates.
 *
 * ```turtle
 * <…/Project.singleOwner> a sh:NodeShape ;
 *     core:generated true ;
 *     sh:targetObjectsOf ex:attachments, schema:image ;
 *     sh:property <…/Project.singleOwner/owners> .
 * <…/Project.singleOwner/owners> sh:maxCount 1 ;
 *     sh:path [ sh:inversePath [ sh:alternativePath (ex:attachments schema:image) ] ] .
 * ```
 *
 * Non-owning references to the value through other predicates are not counted. The shape is
 * built only at sync time and is never registered in the in-memory shape registry.
 */

/** Suffix that turns a declaring shape's IRI into its generated single-owner shape's IRI. */
const SINGLE_OWNER_SUFFIX = '.singleOwner';

/** The deterministic IRI of a declaring shape's generated single-owner NodeShape. */
export function singleOwnerShapeIri(shapeIri: string): string {
  return `${shapeIri}${SINGLE_OWNER_SUFFIX}`;
}

/**
 * Sorted simple-path IRIs of the shape's own and inherited `contains` properties that declare a
 * value shape.
 *
 * Inherited properties are flattened exactly as shape sync flattens them. Contains properties
 * with a complex path are skipped, as the containment cascade skips them. Contains properties
 * without a value shape are skipped too: such a slot is polymorphic (like `sh:path`) and its
 * value may be a shared IRI, so the replace, the subject delete and the class check do not treat
 * it as owning that value, and neither does the single-owner rule. Sorting by IRI keeps
 * the stored list independent of declaration order, so a re-sync writes identical triples.
 */
export function ownedPredicateGroup(nodeShape: NodeShapeData): string[] {
  const preds = new Set<string>();
  for (const ps of getUniquePropertyShapes(nodeShape)) {
    if (!ps.contains || !ps.valueShape) continue;
    const predId = getSimplePathId(ps.path);
    if (predId) preds.add(predId);
  }
  return [...preds].sort();
}

/**
 * Create-pipeline data for the generated single-owner NodeShape of `nodeShape` (stored at
 * {@link singleOwnerShapeIri}`(shapeIri)`), or `null` when the shape has no qualifying
 * `contains` property.
 */
export function buildSingleOwnerShapeData(
  nodeShape: NodeShapeData,
  shapeIri: string,
): Record<string, unknown> | null {
  const group = ownedPredicateGroup(nodeShape);
  if (group.length === 0) return null;
  const psIri = `${singleOwnerShapeIri(shapeIri)}/owners`;
  const owners: PathExpr =
    group.length === 1 ? {id: group[0]} : {alt: group.map((id) => ({id}))};
  return {
    generated: true,
    targetObjectsOf: group.map((id) => ({id})),
    properties: [
      {
        __id: psIri,
        label: 'owners',
        maxCount: 1,
        path: serializePathToNodeData({inv: owners}, psIri),
      },
    ],
  };
}
