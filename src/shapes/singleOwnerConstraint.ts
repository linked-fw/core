/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {getPropertyShapes, type NodeShapeData, type PropertyShapeData} from './nodeShapeData.js';
import {getSimplePathId} from '../paths/normalizePropertyPath.js';
import {serializePathToNodeData} from './serializePathToNodeData.js';
import {NodeShape} from './SHACL.js';

/**
 * The single-owner SHACL constraints generated from `contains` properties.
 *
 * A `contains` property says the subject owns the value node, and only that property does: a
 * plain property on the same predicate is a reference. For every such property, shape sync
 * writes one generated NodeShape stating the matching store-side rule: every object of the
 * property's predicate has at most one subject pointing at it through that predicate *that is
 * an instance of the declaring class* (subclass instances included).
 *
 * ```turtle
 * <…/Thing/image.singleOwner> a sh:NodeShape ;
 *     core:generated true ;
 *     sh:targetObjectsOf schema:image ;
 *     sh:property <…/Thing/image.singleOwner/owners> .
 * <…/Thing/image.singleOwner/owners> a sh:PropertyShape ;
 *     sh:path [ sh:inversePath schema:image ] ;
 *     sh:qualifiedValueShape [ sh:class schema:Thing ] ;
 *     sh:qualifiedMaxCount 1 .
 * ```
 *
 * `sh:class` follows `rdf:type/rdfs:subClassOf*`, and the store infers through the synced
 * ontology hierarchy, so a subclass instance (`ex:Project ⊑ schema:Thing`) counts as an owner.
 *
 * One constraint per accessor, written only by the class that declares it: subclasses inherit
 * the property and are counted as owners, but add no constraint. A declaring shape without a
 * `targetClass` gets none (its owners cannot be named). The declaring shape owns its
 * constraints through `core:generatedShape` (`NodeShape.generatedShapes`, `contains`): shape sync
 * writes them nested in the shape's create and deletes them with the shape; their qualified
 * shape is a blank node, deleted with the property shape that holds it.
 *
 * Ownership through two different `contains` predicates is not counted (a documented
 * limitation). The shapes are built only at sync time and are never registered in the
 * in-memory shape registry.
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
 * The shape's OWN `contains` properties that get a single-owner constraint: those with a simple
 * path (every decorated `contains` property has a value shape), in declaration order.
 *
 * Inherited properties are not included; their declaring shape writes their constraint.
 * Complex paths are skipped, as the owned walk skips them.
 */
export function singleOwnerProperties(nodeShape: NodeShapeData): PropertyShapeData[] {
  return getPropertyShapes(nodeShape, false).filter(
    (ps) => ps.contains && !!ps.valueShape && !!getSimplePathId(ps.path),
  );
}

/** `[ sh:class C ]`: the owners are the instances of the declaring class. Blank once written. */
function ownerShapeData(classId: string): Record<string, unknown> {
  return {shape: NodeShape, class: {id: classId}};
}

const warnedWithoutTargetClass = new Set<string>();

/**
 * Create-pipeline data for the generated single-owner NodeShapes of `nodeShape`, one per
 * {@link singleOwnerProperties} entry. Each is stored at
 * {@link singleOwnerShapeIri}`(${shapeIri}/${label})`: the property shape's IRI exactly as shape
 * sync writes it (`buildPropertyShapeData`). Empty, with one warning per shape, when the shape
 * has `contains` properties but no `targetClass`.
 */
export function buildSingleOwnerConstraints(
  nodeShape: NodeShapeData,
  shapeIri: string,
): Array<{iri: string; data: Record<string, unknown>}> {
  const properties = singleOwnerProperties(nodeShape);
  if (properties.length === 0) return [];
  if (!nodeShape.targetClass?.id) {
    if (!warnedWithoutTargetClass.has(nodeShape.id)) {
      warnedWithoutTargetClass.add(nodeShape.id);
      console.warn(
        `[linked] Shape '${nodeShape.id}' has contains properties but no targetClass, so shape ` +
          'sync writes no single-owner constraint for them: its owners cannot be named.',
      );
    }
    return [];
  }
  const owners = ownerShapeData(nodeShape.targetClass.id);
  return properties.flatMap((ps) => {
    // Always set: `singleOwnerProperties` keeps simple paths only. The guard narrows the type.
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
            path: serializePathToNodeData({inv: {id: predicate}}),
            qualifiedValueShape: owners,
            qualifiedMaxCount: 1,
          },
        ],
      },
    }];
  });
}
