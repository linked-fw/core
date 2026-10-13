/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {getPropertyShapes, type NodeShapeData, type PropertyShapeData} from './nodeShapeData.js';
import {getSimplePathId} from '../paths/normalizePropertyPath.js';
import {serializePathToNodeData} from './serializePathToNodeData.js';
import {getSubShapes} from '../utils/ShapeClass.js';
import {NodeShape} from './SHACL.js';
import {PathList} from './PathList.js';
import {rdf} from '../ontologies/rdf.js';

/**
 * The single-owner SHACL constraints generated from `contains` properties.
 *
 * A `contains` property says the subject owns the value node, and only that property does: a
 * plain property on the same predicate is a reference. For every such property, shape sync
 * writes one generated NodeShape stating the matching store-side rule: every object of the
 * property's predicate has at most one subject pointing at it through that predicate *that is
 * an instance of the declaring class or of a registered sub-shape's class*.
 *
 * ```turtle
 * <…/Thing/image.singleOwner> a sh:NodeShape ;
 *     core:generated true ;
 *     sh:targetObjectsOf schema:image ;
 *     sh:property <…/Thing/image.singleOwner/owners> .
 * <…/Thing/image.singleOwner/owners> a sh:PropertyShape ;
 *     sh:path [ sh:inversePath schema:image ] ;
 *     sh:qualifiedValueShape [ sh:or ( [ sh:class schema:Thing ] [ sh:class ex:Project ] ) ] ;
 *     sh:qualifiedMaxCount 1 .
 * ```
 *
 * The owner classes are enumerated rather than left to `sh:class` alone, because `sh:class`
 * matches a subclass instance only through `rdfs:subClassOf` triples, which a dataset without
 * inference does not have. With one class the qualified shape is `[ sh:class C ]`. Sub-shapes
 * registered only in another process are missing until a process that knows them syncs.
 *
 * One constraint per accessor, written only by the class that declares it: subclasses inherit
 * the property and are counted as owners, but add no constraint. A declaring shape without a
 * `targetClass` gets none (its owners cannot be named). The declaring shape owns its
 * constraints through `core:generatedShape` (`NodeShape.generatedShapes`, `contains`): shape sync
 * writes them nested in the shape's create and deletes them with the shape; their qualified
 * shape and `sh:or` list are blank nodes, deleted with the property shape that holds them.
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
 * The shape's OWN `contains` properties that get a single-owner constraint: those that declare
 * a value shape and have a simple path, in declaration order.
 *
 * Inherited properties are not included; their declaring shape writes their constraint.
 * Complex paths are skipped, as the owned walk skips them.
 */
export function singleOwnerProperties(nodeShape: NodeShapeData): PropertyShapeData[] {
  return getPropertyShapes(nodeShape, false).filter(
    (ps) => ps.contains && !!ps.valueShape && !!getSimplePathId(ps.path),
  );
}

/** The classes whose instances own through the shape's properties: its own and every sub-shape's. */
function ownerClasses(nodeShape: NodeShapeData): string[] {
  const classes = new Set<string>();
  for (const shape of [nodeShape, ...getSubShapes(nodeShape)]) {
    if (shape.targetClass?.id) classes.add(shape.targetClass.id);
  }
  return [...classes].sort();
}

const warnedWithoutTargetClass = new Set<string>();

/** `[ sh:class C ]`, or `[ sh:or ( [ sh:class A ] … ) ]` for several classes. Blank once written. */
function ownerShapeData(classes: string[]): Record<string, unknown> {
  const classShape = (id: string) => ({shape: NodeShape, class: {id}});
  if (classes.length === 1) return classShape(classes[0]);
  const list = classes.reduceRight<unknown>(
    (rest, id) => ({shape: PathList, first: classShape(id), rest}),
    {id: rdf.nil.id},
  );
  return {shape: NodeShape, orShapes: list};
}

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
  const owners = ownerShapeData(ownerClasses(nodeShape));
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
